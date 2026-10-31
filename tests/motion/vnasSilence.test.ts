// @vitest-environment node
/**
 * vNAS sends nothing for an aircraft that stands still. When its last sample is under 2 kt the silence is parking:
 * the aircraft is held where that sample put it, with no extrapolation, and the silent interval stays out of the
 * display delay. A moving aircraft that goes quiet, and every VATSIM aircraft, still extrapolate as before.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DYNAMIC_DELAY_JITTER_BUFFER_MS, SOURCE_DISPLAY_DELAYS } from '@/constants/aircraft-timeline'
import type {
  AircraftDataSource,
  AircraftMetadata,
  AircraftObservation,
  DynamicDelayState,
  TimelineInterpolationResult,
} from '@/types/aircraft-timeline'
import { resetRestingHeightsForTests } from '@/utils/aircraft/restingHeight'
import { knotsToMps } from '@/utils/coordinates'

const T0= Date.UTC(2026, 0, 1, 12, 0, 0)
const FRAME_MS = 1000 / 60
const CS = 'AAL1'
const METADATA = { cid: 1, aircraftType: 'B738', transponder: '1200', departure: null, arrival: null }
const KTS = knotsToMps(1)
const LAT = 37.72
const LON = -122.22
const M_PER_DEG_LAT = 111320
const M_PER_DEG_LON = 111320 * Math.cos((LAT * Math.PI) / 180)
const VNAS_RECEIVE_LAG_MS = 80
const VATSIM_RECEIVE_LAG_MS = 500
const PARKED_SILENCE_MS = 25_000
const HOLD_TOLERANCE_M = 0.01
const EXTRAPOLATION_TOLERANCE_M = 0.05
// 15 kt moves 0.13 m per 60 fps frame; catching up the 7.7 m the repeated sample cost at about twice that is
// smooth. A hold at the repeated sample would stand still for the gap and then cover about 31 m in 1 s.
const RESUME_STEP_MAX_M = 0.3
// A 1 Hz stream received at a constant lag has every receive interval at exactly 1000 ms, so calculateTargetDelay
// (maximum interval plus the jitter buffer) gives 1150 ms. The 25 s silence counted as an interval would give
// min(20 s, 25.15 s) = 20 s.
const ONE_HZ_TARGET_MS = 1000 + DYNAMIC_DELAY_JITTER_BUFFER_MS

// The store graph loads cold at the top level, where collection runs it with no timeout (tests/setup/hookBudget.ts).
// vnasStore registers a removal listener at module init; loading it first resolves the store import cycle in the same
// order the app does.
await import('@/stores/vnasStore')
const tl = await import('@/stores/aircraftTimelineStore')

beforeEach(() => {
  tl.useAircraftTimelineStore.getState().clear()
  resetRestingHeightsForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

/** One eastbound sample `eastM` metres from the origin at scenario second `t`. */
function sample(source: AircraftDataSource, t: number, eastM: number, groundspeed: number): AircraftObservation {
  const observedAt = T0 + t * 1000
  return {
    latitude: LAT,
    longitude: LON + eastM / M_PER_DEG_LON,
    altitude: 10,
    heading: 90,
    groundspeed,
    groundTrack: source === 'vnas' ? 90 : null,
    headingIsTrue: true,
    onGround: true,
    pitch: null,
    roll: null,
    verticalRate: null,
    observedAt,
    receivedAt: observedAt + (source === 'vnas' ? VNAS_RECEIVE_LAG_MS : VATSIM_RECEIVE_LAG_MS),
    source,
    displayDelay: SOURCE_DISPLAY_DELAYS[source],
    ...(source === 'vnas' ? { heightAboveGround: 0 } : {}),
  }
}

/** A vNAS stream at 1 Hz for seconds 0..lastT, moving east at a constant speed. */
function steadyVnas(lastT: number, speedKts: number): AircraftObservation[] {
  const out: AircraftObservation[] = []
  for (let t = 0; t <= lastT; t++) out.push(sample('vnas', t, speedKts * KTS * t, speedKts))
  return out
}

interface Frame {
  now: number
  result: TimelineInterpolationResult
  delay: DynamicDelayState | undefined
}

/** Feeds each sample once its receive time has passed and interpolates a 60 fps frame, up to `untilMs` after T0. */
function run(samples: AircraftObservation[], untilMs: number): Frame[] {
  return runAs(METADATA, samples, untilMs)
}

/** `run` for an aircraft with the given metadata. */
function runAs(metadata: AircraftMetadata, samples: AircraftObservation[], untilMs: number): Frame[] {
  const store = tl.useAircraftTimelineStore
  const frames: Frame[] = []
  let next = 0
  for (let f = 0; f * FRAME_MS <= untilMs; f++) {
    const now = T0 + f * FRAME_MS
    while (next < samples.length && samples[next].receivedAt <= now) {
      store.getState().addObservation(CS, samples[next], metadata)
      next++
    }
    const result = store.getState().getInterpolatedStates(now).get(CS)
    if (result) frames.push({ now, result, delay: store.getState().dynamicDelays.get(CS) })
  }
  return frames
}

function eastOf(position: { longitude: number }): number {
  return (position.longitude - LON) * M_PER_DEG_LON
}

function metresBetween(result: TimelineInterpolationResult, obs: AircraftObservation): number {
  const east = (result.longitude - obs.longitude) * M_PER_DEG_LON
  const north = (result.latitude - obs.latitude) * M_PER_DEG_LAT
  return Math.hypot(east, north)
}

/** Frames whose displayed instant is past the given sample, up to the end of the silence after it. */
function pastSample(frames: Frame[], last: AircraftObservation): Frame[] {
  return frames.filter((f) => f.result.displayTime > last.observedAt && f.now <= last.receivedAt + PARKED_SILENCE_MS)
}

function expectHeldAt(frames: Frame[], last: AircraftObservation): void {
  const held = pastSample(frames, last)
  expect(held.length, 'frames displayed past the last sample').toBeGreaterThan(60)
  const drift = held.reduce((m, f) => Math.max(m, metresBetween(f.result, last)), 0)
  expect(drift, `drawn up to ${drift.toFixed(2)} m from the last sample`).toBeLessThanOrEqual(HOLD_TOLERANCE_M)
  expect(held.filter((f) => f.result.groundspeed !== 0).length, 'held frames with a groundspeed').toBe(0)
  expect(held.filter((f) => f.result.groundTrack !== null).length, 'held frames with a ground track').toBe(0)
  expect(held.filter((f) => f.result.isExtrapolating).length, 'held frames marked as extrapolating').toBe(0)
}

it('a vNAS aircraft whose last sample is 1.5 kt is held there through 25 s of silence (TC3D-51)', () => {
  const samples = steadyVnas(19, 1.5)
  const last = samples[samples.length - 1]
  const frames = run(samples, last.receivedAt - T0 + PARKED_SILENCE_MS)
  expectHeldAt(frames, last)
})

it(`the silence after a stopped vNAS sample stays out of the display delay: target ${ONE_HZ_TARGET_MS} ms (TC3D-51)`, () => {
  const samples = steadyVnas(19, 1.5)
  const last = samples[samples.length - 1]
  const moving = sample('vnas', 19 + PARKED_SILENCE_MS / 1000, eastOf(last) + 2, 4)
  const frames = run([...samples, moving], moving.receivedAt - T0 + 100)

  const silent = frames.filter((f) => f.now > last.receivedAt && f.now < moving.receivedAt)
  expect(silent.length).toBeGreaterThan(1000)
  const maxDelay = silent.reduce((m, f) => Math.max(m, f.result.displayDelay), 0)
  expect(maxDelay, `display delay rose to ${maxDelay.toFixed(0)} ms during the silence`).toBeLessThanOrEqual(
    ONE_HZ_TARGET_MS + 1e-6,
  )

  const after = frames[frames.length - 1].delay
  expect(after).toBeDefined()
  expect(after?.targetDelayMs, 'target delay once the first sample after the silence arrives').toBeCloseTo(
    ONE_HZ_TARGET_MS,
    6,
  )
  expect(Math.max(...(after?.intervalHistory ?? [])), 'longest interval kept in the statistics').toBe(1000)
})

it('control: a vNAS aircraft whose last sample is 15 kt still extrapolates through a 3 s gap', () => {
  const samples = steadyVnas(19, 15)
  const last = samples[samples.length - 1]
  const frames = run(samples, last.receivedAt - T0 + 3000)
  const past = frames.filter((f) => f.result.displayTime > last.observedAt)
  expect(past.length, 'frames displayed past the last sample').toBeGreaterThan(60)
  expect(past.filter((f) => !f.result.isExtrapolating).length, 'frames past the last sample not extrapolating').toBe(0)
  for (const f of past) {
    const expected = eastOf(last) + 15 * KTS * ((f.result.displayTime - last.observedAt) / 1000)
    expect(Math.abs(eastOf(f.result) - expected)).toBeLessThanOrEqual(EXTRAPOLATION_TOLERANCE_M)
  }
})

/** `samples` followed by one vNAS sample per entry of `stepsM`, 1 s apart, each that many metres east of the one before. */
function thenSteps(samples: AircraftObservation[], stepsM: number[], groundspeeds: number[]): AircraftObservation[] {
  const out = [...samples]
  stepsM.forEach((step, i) => {
    const prev = out[out.length - 1]
    const t = (prev.observedAt - T0) / 1000 + 1
    out.push(sample('vnas', t, eastOf(prev) + step, groundspeeds[i]))
  })
  return out
}

it('a stopped vNAS aircraft whose windowed groundspeed still reads 3 kt is held after moving 1.5 m in its last 3 s (TC3D-51)', () => {
  const samples = thenSteps(steadyVnas(15, 3), [0.5, 0.5, 0.5], [3, 3, 3])
  const last = samples[samples.length - 1]
  const frames = run(samples, last.receivedAt - T0 + PARKED_SILENCE_MS)
  expectHeldAt(frames, last)
})

it('a 15 kt vNAS taxi repeating its last position extrapolates through a 3 s gap, with no jump on resuming (TC3D-51)', () => {
  const samples = thenSteps(steadyVnas(18, 15), [0], [15])
  const last = samples[samples.length - 1]
  const resumed = [22, 23, 24, 25].map((t) => sample('vnas', t, 15 * KTS * t, 15))
  const frames = run([...samples, ...resumed], resumed[resumed.length - 1].receivedAt - T0)

  const gap = frames.filter((f) => f.result.displayTime > last.observedAt && f.now < resumed[0].receivedAt)
  expect(gap.length, 'frames displayed past the repeated sample before samples resume').toBeGreaterThan(60)
  expect(gap.filter((f) => !f.result.isExtrapolating).length, 'gap frames not extrapolating').toBe(0)

  let maxStep = 0
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].now < last.receivedAt) continue
    maxStep = Math.max(maxStep, Math.abs(eastOf(frames[i].result) - eastOf(frames[i - 1].result)))
  }
  expect(maxStep, `largest step between frames ${maxStep.toFixed(3)} m`).toBeLessThanOrEqual(RESUME_STEP_MAX_M)
})

/**
 * Decelerating from 8 kt to a stop with one stationary sample: the last step is 0 kt, the step before 2.9 kt, and the
 * last 3 s cover 4 m (2.6 kt), straddling the stop.
 */
function straddlingStop(): AircraftObservation[] {
  return thenSteps(steadyVnas(10, 8), [3, 2.5, 1.5, 0], [6, 3, 1, 0])
}

it('a vNAS aircraft with one stationary step after a 2.9 kt step and a 2.6 kt window is not held yet: it extrapolates', () => {
  const samples = straddlingStop()
  const last = samples[samples.length - 1]
  const past = pastSample(run(samples, last.receivedAt - T0 + PARKED_SILENCE_MS), last)
  expect(past.length, 'frames displayed past the last sample').toBeGreaterThan(60)
  expect(past.filter((f) => !f.result.isExtrapolating).length, 'frames past the last sample not extrapolating').toBe(0)
})

it('the same stop is held once a second stationary step follows (TC3D-51)', () => {
  const samples = thenSteps(straddlingStop(), [0], [0])
  const last = samples[samples.length - 1]
  expectHeldAt(run(samples, last.receivedAt - T0 + PARKED_SILENCE_MS), last)
})

it('control: a VATSIM aircraft whose last report is 1.5 kt still extrapolates; its 15 s intervals at 1.5 kt carry no cadence', () => {
  const samples = [0, 15, 30, 45].map((t) => sample('vatsim', t, 1.5 * KTS * t, 1.5))
  const last = samples[samples.length - 1]
  const frames = run(samples, last.receivedAt - T0 + PARKED_SILENCE_MS)
  const past = frames.filter((f) => f.result.displayTime > last.observedAt)
  expect(past.length, 'frames displayed past the last report').toBeGreaterThan(60)
  expect(past.filter((f) => !f.result.isExtrapolating).length, 'frames past the last report not extrapolating').toBe(0)
  const lastFrame = past[past.length - 1]
  expect(lastFrame.result.groundspeed).toBe(1.5)
  expect(metresBetween(lastFrame.result, last), 'distance extrapolated past the last report').toBeGreaterThan(1)
  expect(lastFrame.delay?.intervalHistory, 'intervals kept in the statistics').toEqual([])
})

it('a held vNAS-only aircraft is still there at 29 s of silence and pruned at 35 s, as before the hold', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const samples = steadyVnas(19, 1.5)
  const last = samples[samples.length - 1]
  const frames = run(samples, last.receivedAt - T0 + 29_000)
  expectHeldAt(frames, last)
  const store = tl.useAircraftTimelineStore

  vi.setSystemTime(last.receivedAt + 29_000)
  store.getState().pruneStaleAircraft()
  expect(store.getState().timelines.has(CS), 'present at 29 s of silence').toBe(true)

  vi.setSystemTime(last.receivedAt + 35_000)
  store.getState().pruneStaleAircraft()
  expect(store.getState().timelines.has(CS), 'present at 35 s of silence').toBe(false)
})

it('a vNAS aircraft that resumes taxiing at 15 kt after a 25 s stop and then goes quiet for 4 s extrapolates, and the 4 s counts (TC3D-51)', () => {
  const parked = steadyVnas(19, 0)
  const resumed = sample('vnas', 44, 4, 15)
  const next = sample('vnas', 48, 4 + 15 * KTS * 4, 15)
  const frames = run([...parked, resumed, next], next.receivedAt - T0 + 100)

  const gap = frames.filter((f) => f.result.displayTime > resumed.observedAt && f.now < next.receivedAt)
  expect(gap.length, 'frames displayed past the resumed sample before the next').toBeGreaterThan(60)
  expect(gap.filter((f) => !f.result.isExtrapolating).length, 'gap frames not extrapolating').toBe(0)
  const history = frames[frames.length - 1].delay?.intervalHistory ?? []
  expect(Math.max(...history), 'longest interval kept in the statistics').toBe(4000)
})

it('a slow vNAS aircraft climbing at 500 fpm is not held in the air through a 4 s gap (TC3D-51)', () => {
  const climbMps = (500 * 0.3048) / 60
  const samples: AircraftObservation[] = []
  for (let t = 0; t <= 9; t++) {
    const height = 30 + climbMps * t
    samples.push({ ...sample('vnas', t, KTS * t, 1), altitude: 10 + height, heightAboveGround: height, onGround: false })
  }
  const last = samples[samples.length - 1]
  const frames = run(samples, last.receivedAt - T0 + 4000)
  const past = frames.filter((f) => f.result.displayTime > last.observedAt)
  expect(past.length, 'frames displayed past the last sample').toBeGreaterThan(60)
  expect(past.filter((f) => !f.result.isExtrapolating).length, 'frames past the last sample not extrapolating').toBe(0)
  for (const f of past) {
    expect(f.result.groundspeed).toBe(1)
    expect(f.result.verticalRate).toBeCloseTo(500, 3)
  }
})

it('a vNAS aircraft 1.5 s into a 3.5 kt/s roll extrapolates through a 2 s dropout, though its 3 s window reads 1.3 kt (TC3D-51)', () => {
  const rollStartT = 20.5
  const rollEast = (t: number) => 0.5 * knotsToMps(3.5) * (t - rollStartT) ** 2
  const samples = [...steadyVnas(20, 0), sample('vnas', 21, rollEast(21), 1.75), sample('vnas', 22, rollEast(22), 5.25)]
  const last = samples[samples.length - 1]
  const frames = run(samples, last.receivedAt - T0 + 2000)
  const past = frames.filter((f) => f.result.displayTime > last.observedAt)
  expect(past.length, 'frames displayed past the last sample').toBeGreaterThan(30)
  expect(past.filter((f) => !f.result.isExtrapolating).length, 'frames past the last sample not extrapolating').toBe(0)
})

it('a vNAS aircraft that stops and sends two stationary samples is held, though its 3 s window straddles the stop (TC3D-51)', () => {
  const samples = thenSteps(steadyVnas(10, 15), [4, 0, 0], [8, 0, 0])
  const last = samples[samples.length - 1]
  expectHeldAt(run(samples, last.receivedAt - T0 + PARKED_SILENCE_MS), last)
})

it('a vNAS aircraft hovering at 40 ft with the ground flag set and no height above ground is not held (TC3D-51)', () => {
  const samples = steadyVnas(19, 0).map((s) => {
    const { heightAboveGround: _height, ...rest } = s
    return { ...rest, altitude: 10 + 40 * 0.3048, onGround: true }
  })
  const last = samples[samples.length - 1]
  const frames = run(samples, last.receivedAt - T0 + 5000)
  const past = frames.filter((f) => f.result.displayTime > last.observedAt)
  expect(past.length, 'frames displayed past the last sample').toBeGreaterThan(60)
  expect(past.filter((f) => !f.result.isExtrapolating).length, 'frames past the last sample not extrapolating').toBe(0)
})

it('a late vNAS packet received out of order does not decide whether the newest sample is stopped (TC3D-51)', () => {
  // Stopped at t = 10 after 15 kt; the stationary samples report a lagging 3 kt. The packet for t = 5 arrives between
  // those for t = 19 and t = 20, so it sits just before t = 20 in the timeline.
  const stopEast = 15 * KTS * 10
  const samples = [...steadyVnas(10, 15)]
  for (let t = 11; t <= 19; t++) samples.push(sample('vnas', t, stopEast, 3))
  const late = { ...sample('vnas', 5, 15 * KTS * 5, 15), receivedAt: T0 + 19_500 }
  const last = sample('vnas', 20, stopEast, 3)
  samples.push(late, last)
  expectHeldAt(run(samples, last.receivedAt - T0 + PARKED_SILENCE_MS), last)
})

it('a stop decided while the sample before it was missing is decided again when that sample arrives late (TC3D-51)', () => {
  const store = tl.useAircraftTimelineStore
  const stopped = [6, 7, 8, 10].map((t) => sample('vnas', t, 0, 0))
  for (const s of stopped) store.getState().addObservation(CS, s, METADATA)
  const decide = () => {
    const observations = store.getState().timelines.get(CS)?.observations ?? []
    return tl.isStoppedVnasSample(observations, observations.indexOf(stopped[3]), CS, METADATA.aircraftType)
  }
  expect(decide(), 'stopped while t = 9 is missing').toBe(true)

  const fastStep = { ...sample('vnas', 9, 8, 15), receivedAt: stopped[3].receivedAt + 500 }
  store.getState().addObservation(CS, fastStep, METADATA)
  expect(decide(), 'stopped once t = 9 arrives 8 m away').toBe(false)
})

const A320_REST_M = 9 * 0.3048
const A320: AircraftMetadata = { ...METADATA, aircraftType: 'A320' }

/** `samples` as an A320 whose vNAS height reads its 9 ft resting height on the ground. */
function atA320Rest(samples: AircraftObservation[]): AircraftObservation[] {
  return samples.map((s) => ({ ...s, heightAboveGround: A320_REST_M }))
}

it('a stopped A320 reporting its 9 ft resting height is held through 25 s of silence (TC3D-316)', () => {
  const samples = atA320Rest(steadyVnas(19, 1.5))
  const last = samples[samples.length - 1]
  expectHeldAt(runAs(A320, samples, last.receivedAt - T0 + PARKED_SILENCE_MS), last)
})

it('a stop decided before its type rests at a known height is decided again once it does (TC3D-316)', () => {
  const store = tl.useAircraftTimelineStore
  // Stationary, but reporting 5 kt: no resting-height sample, so A320's resting height stays unknown
  const stopped = atA320Rest([6, 7, 8, 10].map((t) => sample('vnas', t, 0, 5)))
  for (const s of stopped) store.getState().addObservation(CS, s, A320)
  const decide = () => {
    const observations = store.getState().timelines.get(CS)?.observations ?? []
    return tl.isStoppedVnasSample(observations, observations.indexOf(stopped[3]), CS, 'A320')
  }
  expect(decide(), 'stopped at 9 ft before the resting height is known').toBe(false)

  for (const s of atA320Rest([0, 1, 2].map((t) => sample('vnas', t, 0, 0)))) store.getState().addObservation('ACA4LG', s, A320)
  expect(decide(), 'stopped at 9 ft once another A320 has rested at 9 ft').toBe(true)
})

it('one slow 3 s step from the only sample in range is not enough to hold (TC3D-51)', () => {
  const samples = [...steadyVnas(16, 15), sample('vnas', 19, 15 * KTS * 16 + 1, 15)]
  const last = samples[samples.length - 1]
  const past = pastSample(run(samples, last.receivedAt - T0 + 5000), last)
  expect(past.length, 'frames displayed past the last sample').toBeGreaterThan(60)
  expect(past.filter((f) => !f.result.isExtrapolating).length, 'frames past the last sample not extrapolating').toBe(0)
})

it('an isolated vNAS sample reporting 1 kt, with no sample in the 6 s before it, is not held (TC3D-51)', () => {
  const samples = [...steadyVnas(5, 0), sample('vnas', 12, 0, 1)]
  const last = samples[samples.length - 1]
  const past = pastSample(run(samples, last.receivedAt - T0 + 5000), last)
  expect(past.length, 'frames displayed past the last sample').toBeGreaterThan(60)
  expect(past.filter((f) => !f.result.isExtrapolating).length, 'frames past the last sample not extrapolating').toBe(0)
})

it('in a list that mixes sources, the interval from a stopped vNAS sample to a VATSIM report does not count (TC3D-51)', () => {
  const vnasSample = sample('vnas', 20, 0, 0)
  const samples = [sample('vatsim', 0, 0, 0), sample('vatsim', 15, 0, 0), vnasSample, sample('vatsim', 30, 0, 0)]
  const last = samples[samples.length - 1]
  const frames = run(samples, last.receivedAt - T0 + 100)
  const history = frames[frames.length - 1].delay?.intervalHistory ?? []
  expect(history, 'intervals kept in the statistics').not.toContain(last.receivedAt - vnasSample.receivedAt)
})
