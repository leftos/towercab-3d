// @vitest-environment node
/**
 * What happens in the first seconds after a VATSIM-only aircraft appears: it converges on truth once its
 * display delay settles, it is never drawn ahead and then pulled back, and the delay ramp does not play it
 * at a fraction of real speed.
 */
import { expect, it, vi } from 'vitest'
import type { AircraftObservation } from '@/types/aircraft-timeline'
import { type Flight, type FrameRecord, LAT0, LON0, runScenario, type ScenarioResult, T0, toLatLon } from './harness'
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
const SPAWN_DURATION_S = 180
const SPAWN_SETTLE_S = 2
const MAX_BACKWARD_STEP_M = 2
const PLAYBACK_WINDOW_S = 2
const MIN_PLAYBACK_RATE = 0.8
const HELD_HEIGHT_ERR_MAX_M = 15
const MAX_PLAYBACK_RATE = 1.11
const TAXI_GS_KT = 15
const TAXI_RUN_S = 25

// The scenario runs at the top level, where collection has no timeout (tests/setup/hookBudget.ts).
const res: ScenarioResult = await runScenario({ fps: 60, useVnas: false, vnasFirst: false, durationS: SPAWN_DURATION_S })
const arr1: FrameRecord[] = res.frames.get('ARR1') ?? []

/** One VATSIM ground report, received at T0, with no on-ground flag (VATSIM sends none). */
function taxiObservation(): AircraftObservation {
  const { lat, lon } = toLatLon(0, 0)
  return {
    latitude: lat,
    longitude: lon,
    altitude: 10,
    heading: 90,
    groundspeed: 0,
    groundTrack: null,
    headingIsTrue: true,
    onGround: null,
    pitch: null,
    roll: null,
    verticalRate: null,
    observedAt: T0 - 1000,
    receivedAt: T0,
    source: 'vatsim',
    displayDelay: 17000,
  }
}

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

/** Displayed-time rate over every PLAYBACK_WINDOW_S window, optionally only those whose ends both have the aircraft moving. */
function playbackRates(recs: FrameRecord[], movingOnly: boolean): { rate: number; at: number }[] {
  const rates: { rate: number; at: number }[] = []
  let j = 0
  for (let i = 0; i < recs.length; i++) {
    while (j < recs.length && recs[j].frameTime - recs[i].frameTime < PLAYBACK_WINDOW_S) j++
    if (j >= recs.length) break
    if (movingOnly && (recs[i].truth.gs < 1 || recs[j].truth.gs < 1)) continue
    rates.push({ rate: (recs[j].tLocal - recs[i].tLocal) / (recs[j].frameTime - recs[i].frameTime), at: recs[i].frameTime })
  }
  return rates
}

/** Slowest displayed-time rate over any PLAYBACK_WINDOW_S window whose ends both have the aircraft moving. */
function minPlaybackRate(recs: FrameRecord[]): { rate: number; at: number } {
  return playbackRates(recs, true).reduce((m, r) => (r.rate < m.rate ? r : m), {
    rate: Number.POSITIVE_INFINITY,
    at: Number.NaN,
  })
}

/** Fastest displayed-time rate over any PLAYBACK_WINDOW_S window. */
function maxPlaybackRate(recs: FrameRecord[]): { rate: number; at: number } {
  return playbackRates(recs, false).reduce((m, r) => (r.rate > m.rate ? r : m), {
    rate: Number.NEGATIVE_INFINITY,
    at: Number.NaN,
  })
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

it(`1.1 after a new VATSIM aircraft's third report, display time never runs faster than ${MAX_PLAYBACK_RATE}x real time (TC3D-49)`, () => {
  const flight = res.flights.find((f) => f.callsign === 'ARR1') as Flight
  const thirdReport = flight.offset + firstReportLocal(flight) + 30
  const recs = arr1.filter((r) => r.frameTime >= thirdReport)
  expect(recs.length).toBeGreaterThan(1000)
  const fast = maxPlaybackRate(recs)
  expect(fast.rate, `played at ${fast.rate.toFixed(3)}x from scenario ${fast.at.toFixed(2)} s`).toBeLessThanOrEqual(
    MAX_PLAYBACK_RATE,
  )
})

it('a VATSIM aircraft first seen taxiing is not drawn until its second report, not shown held and then hidden (TC3D-49)', async () => {
  const savedRaf = globalThis.requestAnimationFrame
  let frame: ((t: number) => void) | null = null
  globalThis.requestAnimationFrame = (cb: (t: number) => void) => {
    frame = cb
    return 1
  }
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(T0)
    vi.resetModules()
    // vnasStore registers a removal listener at module init; loading it first resolves the store import cycle.
    await import('@/stores/vnasStore')
    const tl = await import('@/stores/aircraftTimelineStore')
    const vat = await import('@/stores/vatsimStore')
    const interp = await import('@/hooks/useAircraftInterpolation')
    vat.useVatsimStore.setState({ referencePosition: { latitude: LAT0, longitude: LON0 } })
    // biome-ignore lint/correctness/useHookAtTopLevel: this is the interpolation singleton, driven outside React
    const map = interp.useAircraftInterpolation()
    tl.useAircraftTimelineStore.getState().addObservationBatch([
      {
        callsign: 'TAXI1',
        observation: { ...taxiObservation(), groundspeed: TAXI_GS_KT },
        metadata: { cid: 1, aircraftType: 'B738', transponder: '1200', departure: null, arrival: null },
      },
    ])
    let drawnFrames = 0
    for (let f = 0; f < TAXI_RUN_S * 60; f++) {
      const now = T0 + (f * 1000) / 60
      vi.setSystemTime(now)
      const cb = frame as ((t: number) => void) | null
      frame = null
      if (!cb) throw new Error('interpolation loop did not re-arm requestAnimationFrame')
      cb(now)
      if (map.has('TAXI1')) drawnFrames++
    }
    expect(drawnFrames, 'frames TAXI1 was drawn with one observation').toBe(0)
  } finally {
    vi.useRealTimers()
    globalThis.requestAnimationFrame = savedRaf
  }
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
