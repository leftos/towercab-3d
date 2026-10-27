// @vitest-environment node
/**
 * Ground contact from the vNAS height above ground does not flicker when the drawn (Cesium) terrain and the
 * simulator's terrain disagree, the KRNO case the 50/80 ft flag hysteresis was added for. Contact is decided on
 * the simulator's height, so a 1.5 m mismatch either way leaves one change of contact per flight, and the
 * aircraft sits on the drawn runway through the roll.
 */
import { describe, expect, it, vi } from 'vitest'
import { type FrameRecord, runScenario, type ScenarioResult } from './harness'

vi.mock('react', () => {
  const api = {
    useEffect: (fn: () => unknown) => {
      fn()
    },
    useState: <T>(v: T) => [v, () => {}],
  }
  return { ...api, default: api }
})

const TERRAIN_MISMATCH_M = 1.5
const GROUND_OFFSET_M = 0.1 // GROUND_AIRCRAFT_TERRAIN_OFFSET: the clamp draws the wheels this far above the terrain
const ROLLOUT_HEIGHT_ERR_MAX_M = 0.05 // measured 0.000 m
// Wider than the 2 ft (0.61 m) between the 3 ft entry and the 5 ft exit only together with the sink between samples
const HEIGHT_JITTER_M = 0.5
// The reference airport sits this far below a field the aircraft rolls on without a terrain sample
const UNSAMPLED_REFERENCE_OFFSET_M = -300
const UNSAMPLED_ROLL_HEIGHT_ERR_MAX_M = 0.2 // measured 0.063 m (299.9 m when drawn at the reference airport)
const FLARE_CHECK_MAX_AGL_M = 15 // FLARE_START_ALTITUDE_METERS
const FLARE_PITCH_DIFF_MAX_DEG = 0.01 // measured 0.000 deg

// The scenarios run at the top level, where collection has no timeout (tests/setup/hookBudget.ts).
const scenarios = new Map<number, ScenarioResult>()
for (const offset of [TERRAIN_MISMATCH_M, -TERRAIN_MISMATCH_M]) {
  scenarios.set(offset, await runScenario({ fps: 60, useVnas: true, vnasFirst: false, durationS: 720, terrainOffsetM: offset }))
}
const jittered: ScenarioResult = await runScenario({
  fps: 60,
  useVnas: true,
  vnasFirst: false,
  durationS: 720,
  vnasHeightJitterM: HEIGHT_JITTER_M,
})
const unsampled: ScenarioResult = await runScenario({
  fps: 60,
  useVnas: true,
  vnasFirst: false,
  durationS: 240,
  unsampledReferenceOffsetM: UNSAMPLED_REFERENCE_OFFSET_M,
})

/** Number of times contact changes between frames that carry it. */
function contactChanges(recs: FrameRecord[]): number {
  let changes = 0
  let last: boolean | null = null
  for (const r of recs) {
    if (r.inContact === null) continue
    if (last !== null && r.inContact !== last) changes++
    last = r.inContact
  }
  return changes
}

describe.each([TERRAIN_MISMATCH_M, -TERRAIN_MISMATCH_M])('drawn terrain %f m from the simulator ground', (offset) => {
  it('the arrival enters contact once and stays in it through the roll', () => {
    const recs = (scenarios.get(offset) as ScenarioResult).frames.get('ARR1') ?? []
    expect(recs.some((r) => r.inContact === true)).toBe(true)
    expect(contactChanges(recs)).toBe(1)
  })

  it('the departure leaves contact once', () => {
    const recs = (scenarios.get(offset) as ScenarioResult).frames.get('DEP1') ?? []
    expect(recs.some((r) => r.inContact === false)).toBe(true)
    expect(contactChanges(recs)).toBe(1)
  })

  it(`the arrival is drawn on the drawn runway through the rollout, within ${ROLLOUT_HEIGHT_ERR_MAX_M} m`, () => {
    const recs = ((scenarios.get(offset) as ScenarioResult).frames.get('ARR1') ?? []).filter(
      (r) => r.truth.segment === 'rollout',
    )
    expect(recs.length).toBeGreaterThan(100)
    const worst = recs.reduce((m, r) => Math.max(m, Math.abs(r.agl - (offset + GROUND_OFFSET_M))), 0)
    expect(worst, `rollout height off the drawn runway by ${worst.toFixed(3)} m`).toBeLessThanOrEqual(
      ROLLOUT_HEIGHT_ERR_MAX_M,
    )
  })
})

describe(`a vNAS height jittering by ${HEIGHT_JITTER_M} m between samples`, () => {
  it.each(['ARR1', 'DEP1'])('%s changes contact exactly once', (callsign) => {
    const recs = jittered.frames.get(callsign) ?? []
    expect(recs.length).toBeGreaterThan(1000)
    expect(contactChanges(recs)).toBe(1)
  })
})

it('a rolling vNAS aircraft without a terrain sample keeps its reported height, not the reference airport', () => {
  const recs = (unsampled.frames.get('DEP1') ?? []).filter((r) => r.truth.segment === 'takeoff_roll' && r.gs > 10)
  expect(recs.length).toBeGreaterThan(100)
  const worst = recs.reduce((m, r) => Math.max(m, Math.abs(r.agl - r.truth.agl)), 0)
  expect(worst, `drawn ${worst.toFixed(3)} m off its reported height`).toBeLessThanOrEqual(UNSAMPLED_ROLL_HEIGHT_ERR_MAX_M)
})

it(`the vNAS arrival's flare pitch does not depend on the drawn terrain (±${TERRAIN_MISMATCH_M} m)`, () => {
  const low = (offset: number) =>
    ((scenarios.get(offset) as ScenarioResult).frames.get('ARR1') ?? []).filter(
      (r) => ['glide', 'flare'].includes(r.truth.segment) && r.truth.agl < FLARE_CHECK_MAX_AGL_M,
    )
  const above = new Map(low(TERRAIN_MISMATCH_M).map((r) => [r.frameTime, r.pitch]))
  const below = low(-TERRAIN_MISMATCH_M).filter((r) => above.has(r.frameTime))
  expect(below.length).toBeGreaterThan(100)
  const worst = below.reduce((m, r) => Math.max(m, Math.abs(r.pitch - (above.get(r.frameTime) ?? Number.NaN))), 0)
  expect(worst, `flare pitch differs by ${worst.toFixed(3)} deg`).toBeLessThanOrEqual(FLARE_PITCH_DIFF_MAX_DEG)
})
