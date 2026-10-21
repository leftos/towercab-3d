// @vitest-environment node
/**
 * A vNAS observation without a height above ground (a replay recorded before the field existed) keeps its 50/80 ft
 * ground flag for labels only: the arrival is drawn by the landing blend a VATSIM arrival gets on the same path, not
 * snapped to the runway from 50 ft with its angle of attack dropped.
 */
import { beforeAll, expect, it, vi } from 'vitest'
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

const CHECK_AGL_M = 12 // about 40 ft, under the 50 ft at which the label flag says ground
const CHECK_AGL_TOLERANCE_M = 0.5
const HEIGHT_DIFF_MAX_M = 0.01
const PITCH_DIFF_MAX_DEG = 0.01

let flagged: ScenarioResult
let unflagged: ScenarioResult

beforeAll(async () => {
  const base = { fps: 60, useVnas: true, vnasFirst: false, durationS: 720, vnasWithoutHeight: true }
  flagged = await runScenario(base)
  unflagged = await runScenario({ ...base, vnasWithoutGroundFlag: true })
}, 300_000)

function arrival(result: ScenarioResult): FrameRecord[] {
  return (result.frames.get('ARR1') ?? []).filter((r) => r.truth.segment === 'glide' || r.truth.segment === 'flare')
}

it(`a vNAS arrival without a height is drawn by the landing blend at ${CHECK_AGL_M} m, not snapped by its label flag`, () => {
  const check = arrival(flagged).reduce((best, r) =>
    Math.abs(r.truth.agl - CHECK_AGL_M) < Math.abs(best.truth.agl - CHECK_AGL_M) ? r : best,
  )
  expect(Math.abs(check.truth.agl - CHECK_AGL_M)).toBeLessThan(CHECK_AGL_TOLERANCE_M)
  // The same feed without the flag is what a VATSIM arrival on this path gets: the landing blend
  const reference = arrival(unflagged).find((r) => r.frameTime === check.frameTime)
  expect(reference).toBeDefined()
  const ref = reference as FrameRecord
  expect(
    Math.abs(check.agl - ref.agl),
    `drawn ${check.agl.toFixed(3)} m, landing blend ${ref.agl.toFixed(3)} m`,
  ).toBeLessThanOrEqual(HEIGHT_DIFF_MAX_M)
  expect(
    Math.abs(check.pitch - ref.pitch),
    `pitch ${check.pitch.toFixed(2)} deg, landing blend ${ref.pitch.toFixed(2)} deg`,
  ).toBeLessThanOrEqual(PITCH_DIFF_MAX_DEG)
  expect(check.onGroundTimeline, 'the label flag is not a drawing input without a height').toBeNull()
})
