// @vitest-environment node
/**
 * What happens in the first seconds after a VATSIM-only aircraft appears: it converges on truth once its
 * display delay settles, it is never drawn ahead and then pulled back, and the delay ramp does not play it
 * at a fraction of real speed.
 */
import { beforeAll, expect, it, vi } from 'vitest'
import { type Flight, type FrameRecord, runScenario, type ScenarioResult } from './harness'
import { type TruthSample, truthAt } from './sim'

vi.mock('react', () => {
  const api = {
    useEffect: (fn: () => unknown) => {
      fn()
    },
    useState: <T>(v: T) => [v, () => {}],
  }
  return { ...api, default: api }
})

const SPAWN_CONVERGED_POS_ERR_M = 15
const SPAWN_DURATION_S = 150
const SPAWN_SETTLE_S = 2
const MAX_BACKWARD_STEP_M = 2
const PLAYBACK_WINDOW_S = 2
const MIN_PLAYBACK_RATE = 0.8
const HELD_HEIGHT_ERR_MAX_M = 15

let res: ScenarioResult
let arr1: FrameRecord[]

beforeAll(async () => {
  res = await runScenario({ fps: 60, useVnas: false, vnasFirst: false, durationS: SPAWN_DURATION_S })
  arr1 = res.frames.get('ARR1') ?? []
}, 120_000)

/** Local time of a flight's first VATSIM report: the harness feed reports at scenario seconds 3 + 15 n. */
function firstReportLocal(flight: Flight): number {
  return Math.ceil((flight.offset - 3) / 15) * 15 + 3 - flight.offset
}

/** Frames drawn while display time is still before the flight's first report. */
function heldFrames(callsign: string): FrameRecord[] {
  const flight = res.flights.find((f) => f.callsign === callsign)
  if (!flight) return []
  const firstReport = firstReportLocal(flight)
  return (res.frames.get(callsign) ?? []).filter((r) => r.tLocal < firstReport)
}

/** Frames after the first SPAWN_SETTLE_S seconds of the aircraft's life. */
function afterSpawn(recs: FrameRecord[]): FrameRecord[] {
  const firstWall = recs[0].frameTime
  return recs.filter((r) => r.frameTime >= firstWall + SPAWN_SETTLE_S)
}

/** Largest frame-to-frame step backward along the true course, in metres (0 when it never steps back). */
function maxBackwardStep(recs: FrameRecord[]): { metres: number; at: number } {
  let worst = { metres: 0, at: Number.NaN }
  for (let i = 1; i < recs.length; i++) {
    const c = (recs[i].truth.course * Math.PI) / 180
    const along = (recs[i].x - recs[i - 1].x) * Math.sin(c) + (recs[i].y - recs[i - 1].y) * Math.cos(c)
    if (-along > worst.metres) worst = { metres: -along, at: recs[i].frameTime }
  }
  return worst
}

/** Slowest displayed-time rate over any PLAYBACK_WINDOW_S window whose ends both have the aircraft moving. */
function minPlaybackRate(recs: FrameRecord[]): { rate: number; at: number } {
  let worst = { rate: Number.POSITIVE_INFINITY, at: Number.NaN }
  let j = 0
  for (let i = 0; i < recs.length; i++) {
    while (j < recs.length && recs[j].frameTime - recs[i].frameTime < PLAYBACK_WINDOW_S) j++
    if (j >= recs.length) break
    if (recs[i].truth.gs < 1 || recs[j].truth.gs < 1) continue
    const rate = (recs[j].tLocal - recs[i].tLocal) / (recs[j].frameTime - recs[i].frameTime)
    if (rate < worst.rate) worst = { rate, at: recs[i].frameTime }
  }
  return worst
}

it(`ARR1 converges on truth within ${SPAWN_CONVERGED_POS_ERR_M} m once its delay settles (measured 2 m)`, () => {
  expect(arr1.length).toBeGreaterThan(0)
  const firstWall = arr1[0].frameTime
  const settled = arr1.filter((r) => r.frameTime >= firstWall + 20)
  expect(settled.length).toBeGreaterThan(0)
  const maxErr = settled.reduce((m, r) => Math.max(m, Math.hypot(r.x - r.truth.x, r.y - r.truth.y)), 0)
  expect(maxErr).toBeLessThanOrEqual(SPAWN_CONVERGED_POS_ERR_M)
})

it('1.1 a new VATSIM aircraft is not drawn ahead and then pulled back, and its delay ramp does not play it at a fraction of speed (TC3D-49)', () => {
  expect(arr1.length).toBeGreaterThan(0)
  const recs = afterSpawn(arr1)
  expect(recs.length).toBeGreaterThan(1000)
  const back = maxBackwardStep(recs)
  expect(back.metres, `stepped ${back.metres.toFixed(1)} m back at scenario ${back.at.toFixed(2)} s`).toBeLessThanOrEqual(
    MAX_BACKWARD_STEP_M,
  )
  const slow = minPlaybackRate(recs)
  expect(slow.rate, `played at ${slow.rate.toFixed(2)}x from scenario ${slow.at.toFixed(2)} s`).toBeGreaterThanOrEqual(
    MIN_PLAYBACK_RATE,
  )
})

it('an aircraft held before its first report is reported standing still (groundspeed 0) until display time reaches it', () => {
  const held = heldFrames('DEP1')
  expect(held.length).toBeGreaterThan(30)
  const fastest = held.reduce((m, r) => Math.max(m, r.gs), 0)
  expect(fastest, 'groundspeed reported while held at the first position').toBe(0)
})

it(`an aircraft first seen in the air is held within ${HELD_HEIGHT_ERR_MAX_M} m of its first report's height, not on the ground`, () => {
  const flight = res.flights.find((f) => f.callsign === 'ARR1') as Flight
  const firstReport = truthAt(flight.samples, firstReportLocal(flight)) as TruthSample
  const held = heldFrames('ARR1')
  expect(held.length).toBeGreaterThan(30)
  const worst = held.reduce((m, r) => Math.max(m, Math.abs(r.agl - firstReport.agl)), 0)
  expect(worst, `held frames vs first report at ${firstReport.agl.toFixed(0)} m AGL`).toBeLessThanOrEqual(
    HELD_HEIGHT_ERR_MAX_M,
  )
})
