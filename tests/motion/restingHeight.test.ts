// @vitest-environment node
/**
 * vNAS reports the height above ground of a reference point, so an aircraft at rest reads its resting height, which
 * varies by type and by simulator (TC3D-316, TC3D-354): one A320 was measured live at 9.0 ft and another at -0.31 ft;
 * the scenarios here use A320 9.0 ft, B77L 13.6 ft and C17 5.9 ft. Contact is decided on the height over the
 * aircraft's own resting height, else its type's, once one is learned from slow vNAS samples. With neither, the drop
 * rule decides: contact at or below 16 ft once the rate has stayed flat for 1 s after a descent, the drawn height
 * easing over 1 s of display time.
 */
import { describe, expect, it, vi } from 'vitest'
import { DROP_CONTACT_EASE_MS, DROP_CONTACT_FLAT_MS, DROP_CONTACT_RATE_WINDOW_MS } from '@/constants'
import type { AircraftDataSource, AircraftMetadata, AircraftObservation } from '@/types/aircraft-timeline'
import type { PilotData } from '@/types/vatsim'
import {
  buildFlights,
  type Flight,
  type FrameRecord,
  runScenario,
  type ScenarioOptions,
  type ScenarioResult,
} from './harness'

vi.mock('react', () => {
  const api = {
    useEffect: (fn: () => unknown) => {
      fn()
    },
    useState: <T>(v: T) => [v, () => {}],
  }
  return { ...api, default: api }
})

const RESTING_HEIGHTS_FT = { A320: 9.0, B77L: 13.6, C17: 5.9 }
const LOW_PASS_FT = 40
const LOW_PASS_CHECK_MAX_AGL_M = 100 * 0.3048
// The 3 ft entry is reached before touchdown: the sim's flare sinks at 2 ft/s below 4.8 ft (measured lead 1.53 s)
const LEARNED_TOUCHDOWN_LAG_MAX_S = 1.6
// The drop rule waits for the rate window to fill, then for the rate to stay within 1 ft/s of 0 for its flat time
const DROP_RULE_TOUCHDOWN_LAG_MAX_S = (DROP_CONTACT_RATE_WINDOW_MS + DROP_CONTACT_FLAT_MS) / 1000
const FLARE_CHECK_MAX_AGL_M = 15 // FLARE_START_ALTITUDE_METERS
const FLARE_PITCH_DIFF_MAX_DEG = 0.01
const TAXI_SEGMENTS = ['taxi_straight1', 'taxi_turn_left', 'taxi_straight2', 'taxi_turn_right_lineup']

const BASE: ScenarioOptions = {
  fps: 60,
  useVnas: true,
  vnasFirst: false,
  durationS: 720,
  restingHeightsFt: RESTING_HEIGHTS_FT,
  goAroundFt: LOW_PASS_FT,
}

// DEP1's vNAS feed starts this far into its takeoff roll, past every sample under 5 kt (taxi start, line-up stop)
const LATE_FEED_ROLL_S = 3
const LEVEL_PASS = { ft: 18, seconds: 8 }

const dep = buildFlights(LOW_PASS_FT).flights.find((f) => f.callsign === 'DEP1') as Flight

// The scenarios run at the top level, where collection has no timeout (tests/setup/hookBudget.ts).
/** The departing A320 teaches its type during the pushback, before the arriving A320 lands. */
const learned: ScenarioResult = await runScenario({
  ...BASE,
  aircraftTypes: { DEP1: 'A320', ARR1: 'A320', GA1: 'C17' },
})
/** No A320 is on the ground before the arriving one lands; the departing B77L teaches its type. */
const unlearned: ScenarioResult = await runScenario({
  ...BASE,
  aircraftTypes: { DEP1: 'B77L', ARR1: 'A320', GA1: 'B77L' },
})
/** Every flight a B738 that reads 0 ft at rest. */
const zeroRest: ScenarioResult = await runScenario({ ...BASE, restingHeightsFt: {} })
/** GA1, an A320, is airborne when the arriving A320 stops and teaches the type. */
const learnedMidFlight: ScenarioResult = await runScenario({
  ...BASE,
  aircraftTypes: { DEP1: 'B77L', ARR1: 'A320', GA1: 'A320' },
})
/** DEP1, the only B77L, is first seen by vNAS on its takeoff roll, so its type is never learned. */
const lateFeed: ScenarioResult = await runScenario({
  ...BASE,
  aircraftTypes: { DEP1: 'B77L', ARR1: 'A320', GA1: 'C17' },
  vnasFromS: { DEP1: dep.offset + dep.events.takeoff_roll + LATE_FEED_ROLL_S },
})
/** GA1, an A320 reading 0 ft at rest whose type nothing teaches, holds a level pass at 18 ft before going around. */
const levelPass: ScenarioResult = await runScenario({
  ...BASE,
  aircraftTypes: { DEP1: 'B77L', ARR1: 'B77L', GA1: 'A320' },
  restingByCallsignFt: { GA1: 0 },
  levelPass: LEVEL_PASS,
})

function frames(result: ScenarioResult, callsign: string): FrameRecord[] {
  const recs = result.frames.get(callsign) ?? []
  expect(recs.length, `${callsign} frames`).toBeGreaterThan(1000)
  return recs
}

/** Seconds from the arrival's reported touchdown to its first frame in contact. */
function touchdownLag(result: ScenarioResult): number {
  const touchdown = result.flights.find((f) => f.callsign === 'ARR1')?.events.rollout ?? Number.NaN
  const first = frames(result, 'ARR1').find((r) => r.inContact === true)
  expect(first, 'a frame in contact').toBeDefined()
  return (first?.tLocal ?? Number.NaN) - touchdown
}

it('a taxiing B77L reporting 13.6 ft at rest is in contact', () => {
  const taxi = frames(unlearned, 'DEP1').filter((r) => TAXI_SEGMENTS.includes(r.truth.segment) && r.gs > 5)
  expect(taxi.length).toBeGreaterThan(1000)
  expect(taxi.filter((r) => r.inContact !== true).length, 'taxi frames out of contact').toBe(0)
})

it(`a learned A320 rollout enters contact on the frame a 0 ft aircraft does, within ${LEARNED_TOUCHDOWN_LAG_MAX_S} s of its reported touchdown`, () => {
  const lag = touchdownLag(learned)
  expect(lag, 'contact entry against an aircraft that reads 0 ft at rest').toBe(touchdownLag(zeroRest))
  expect(Math.abs(lag), `contact ${lag.toFixed(2)} s after the reported touchdown`).toBeLessThanOrEqual(
    LEARNED_TOUCHDOWN_LAG_MAX_S,
  )
})

it(`an unlearned type's first arrival enters contact by the drop rule within ${DROP_RULE_TOUCHDOWN_LAG_MAX_S} s of touchdown`, () => {
  const lag = touchdownLag(unlearned)
  expect(lag, 'contact before the reported touchdown').toBeGreaterThanOrEqual(0)
  expect(lag, `contact ${lag.toFixed(2)} s after the reported touchdown`).toBeLessThanOrEqual(
    DROP_RULE_TOUCHDOWN_LAG_MAX_S,
  )
})

describe.each([
  ['an unlearned C17', () => learned],
  ['a learned B77L', () => unlearned],
])(`a low pass at ${LOW_PASS_FT} ft over the runway by %s`, (_name, result) => {
  it('never enters contact', () => {
    const low = frames(result(), 'GA1').filter((r) => r.truth.agl < LOW_PASS_CHECK_MAX_AGL_M)
    expect(low.length).toBeGreaterThan(100)
    expect(low.filter((r) => r.inContact === true).length, 'low-pass frames in contact').toBe(0)
  })
})

it("a learned A320's flare and its release at touchdown match an aircraft that reads 0 ft at rest", () => {
  const low = (result: ScenarioResult) =>
    frames(result, 'ARR1').filter(
      (r) => r.truth.segment === 'rollout' || (r.truth.segment === 'flare' && r.truth.agl < FLARE_CHECK_MAX_AGL_M),
    )
  const reference = new Map(low(zeroRest).map((r) => [r.frameTime, r.pitch]))
  const compared = low(learned).filter((r) => reference.has(r.frameTime))
  expect(compared.length).toBeGreaterThan(1000)
  const worst = compared.reduce((m, r) => Math.max(m, Math.abs(r.pitch - (reference.get(r.frameTime) ?? Number.NaN))), 0)
  expect(worst, `pitch differs by ${worst.toFixed(3)} deg`).toBeLessThanOrEqual(FLARE_PITCH_DIFF_MAX_DEG)
})

const FT = 0.3048
const A320_REST_M = RESTING_HEIGHTS_FT.A320 * FT
const B77L_REST_M = RESTING_HEIGHTS_FT.B77L * FT
const AIRBORNE_CHECK_MIN_AGL_M = 30 // above the 30 m over which the ground offset fades
const DRAWN_HEIGHT_DIFF_MAX_M = 1e-6
// The longest frame: the harness's 60 fps clock reads whole milliseconds, so frames are 16 or 17 ms apart
const FRAME_MS = Math.ceil(1000 / 60)
const EASE_MS = 250 // RESTING_HEIGHT_EASE_MS
// Leaving contact 5 ft over rest, the clamp transition eases the 5 ft catch-up by 7% a frame, with the climb on top
const LIFTOFF_STEP_MAX_M = 5 * FT * 0.07 + 0.1
const HEIGHTLESS_ERR_MAX_M = 0.05
// vNAS has taken over from VATSIM once two of its samples are in and the display time has passed them
const VNAS_TAKEOVER_S = 5

/** Scenario second at which the harness starts a flight's vNAS feed: 20 s after its first VATSIM report. */
function vnasStartS(result: ScenarioResult, callsign: string): number {
  const flight = result.flights.find((f) => f.callsign === callsign)
  expect(flight, callsign).toBeDefined()
  return 3 + 15 * Math.ceil(((flight?.offset ?? 0) - 3) / 15) + 20
}

/** Frames once the vNAS feed, with its height, has taken over from VATSIM (two samples and the display delay). */
function vnasFrames(result: ScenarioResult, callsign: string): FrameRecord[] {
  const start = vnasStartS(result, callsign) + VNAS_TAKEOVER_S
  return frames(result, callsign).filter((r) => r.frameTime >= start)
}

/** Drawn height minus the same flight's drawn height in the 0 ft scenario, per frame both drew. */
function drawnOverZeroRest(result: ScenarioResult, callsign: string): { rec: FrameRecord; diff: number }[] {
  const reference = new Map(frames(zeroRest, callsign).map((r) => [r.frameTime, r.agl]))
  return vnasFrames(result, callsign)
    .filter((r) => reference.has(r.frameTime))
    .map((rec) => ({ rec, diff: rec.agl - (reference.get(rec.frameTime) ?? Number.NaN) }))
}

describe('lane C: drawn at the reported height less the resting height', () => {
  it('an airborne vNAS A320 whose resting height is learned is drawn where an aircraft reading 0 ft at rest is', () => {
    const airborne = drawnOverZeroRest(learned, 'ARR1').filter(
      ({ rec }) => rec.truth.agl > AIRBORNE_CHECK_MIN_AGL_M && rec.inContact === false,
    )
    expect(airborne.length).toBeGreaterThan(1000)
    const worst = airborne.reduce((m, { diff }) => Math.max(m, Math.abs(diff)), 0)
    expect(worst, `drawn ${worst.toFixed(3)} m off`).toBeLessThanOrEqual(DRAWN_HEIGHT_DIFF_MAX_M)
  })

  it('leaving contact, the A320 catches up no more than an aircraft reading 0 ft at rest, eased', () => {
    const recs = vnasFrames(learned, 'DEP1')
    const leave = recs.findIndex((r, i) => i > 0 && recs[i - 1].inContact === true && r.inContact === false)
    expect(leave, 'a frame leaving contact').toBeGreaterThan(0)
    const leaveAt = recs[leave].frameTime
    const around = drawnOverZeroRest(learned, 'DEP1').filter(({ rec }) => Math.abs(rec.frameTime - leaveAt) <= 1)
    expect(around.length).toBeGreaterThan(100)
    const worst = around.reduce((m, { diff }) => Math.max(m, Math.abs(diff)), 0)
    expect(worst, `drawn ${worst.toFixed(3)} m off the 0 ft aircraft`).toBeLessThanOrEqual(DRAWN_HEIGHT_DIFF_MAX_M)
    let maxStep = 0
    for (let i = 1; i < around.length; i++) maxStep = Math.max(maxStep, Math.abs(around[i].rec.agl - around[i - 1].rec.agl))
    expect(maxStep, `largest step between frames ${maxStep.toFixed(3)} m`).toBeLessThanOrEqual(LIFTOFF_STEP_MAX_M)
  })

  it('an airborne A320 drops by the resting height over 0.25 s when another A320 teaches it, never in one frame', () => {
    const airborne = drawnOverZeroRest(learnedMidFlight, 'GA1').filter(
      ({ rec }) => rec.truth.agl > AIRBORNE_CHECK_MIN_AGL_M && rec.inContact === false,
    )
    expect(airborne.length).toBeGreaterThan(1000)
    const offset = airborne.map(({ diff }) => diff)
    expect(offset[0], 'drawn the resting height high before it is learned').toBeCloseTo(A320_REST_M, 6)
    expect(offset[offset.length - 1], 'drawn at the true height once it is learned').toBeCloseTo(0, 6)
    let maxStep = 0
    for (let i = 1; i < offset.length; i++) maxStep = Math.max(maxStep, Math.abs(offset[i] - offset[i - 1]))
    expect(maxStep, `largest step ${maxStep.toFixed(3)} m`).toBeLessThanOrEqual((A320_REST_M * FRAME_MS) / EASE_MS + 1e-6)
  })

  it('a climbing B77L whose resting height is learned shows its reported altitude and is drawn the resting height lower', () => {
    const reported = new Map(frames(zeroRest, 'DEP1').map((r) => [r.frameTime, r.agl]))
    const airborne = vnasFrames(unlearned, 'DEP1').filter(
      (r) => r.truth.agl > AIRBORNE_CHECK_MIN_AGL_M && r.inContact === false && reported.has(r.frameTime),
    )
    expect(airborne.length).toBeGreaterThan(1000)
    const shownOff = airborne.reduce(
      (m, r) => Math.max(m, Math.abs(r.reportedAgl - ((reported.get(r.frameTime) ?? Number.NaN) + B77L_REST_M))),
      0,
    )
    expect(shownOff, `shown ${shownOff.toFixed(3)} m off the reported altitude`).toBeLessThanOrEqual(
      DRAWN_HEIGHT_DIFF_MAX_M,
    )
    const drawnOff = airborne.reduce((m, r) => Math.max(m, Math.abs(r.agl - (r.reportedAgl - B77L_REST_M))), 0)
    expect(drawnOff, `drawn ${drawnOff.toFixed(3)} m off the reported altitude less the resting height`).toBeLessThanOrEqual(
      DRAWN_HEIGHT_DIFF_MAX_M,
    )
  })

  it('a learned A320 seen only by VATSIM, without a height, is drawn at its reported height as before', () => {
    const heightless = frames(learned, 'ARR1').filter((r) => r.frameTime < vnasStartS(learned, 'ARR1'))
    expect(heightless.length).toBeGreaterThan(100)
    const worst = heightless.reduce((m, r) => Math.max(m, Math.abs(r.agl - (r.truth.agl + A320_REST_M))), 0)
    expect(worst, `drawn ${worst.toFixed(3)} m off its reported height`).toBeLessThanOrEqual(HEIGHTLESS_ERR_MAX_M)
  })
})

it(`an unlearned A320 on a level pass at ${LEVEL_PASS.ft} ft never enters contact`, () => {
  const low = frames(levelPass, 'GA1').filter((r) => r.truth.agl < LOW_PASS_CHECK_MAX_AGL_M)
  expect(low.filter((r) => r.truth.segment === 'level_pass').length, 'level-pass frames').toBeGreaterThan(400)
  expect(low.filter((r) => r.inContact === true).length, 'low-pass frames in contact').toBe(0)
})

describe('lane B: contact while the aircraft has no resting height', () => {
  // No scenario flies this type, so its resting height is never learned and the drop rule decides
  const UNLEARNED_TYPE = 'C5M'

  it('a climb, then 3.5 s level at 11 ft, does not enter contact: the last rate that was not flat was not a descent', async () => {
    const { updateContact } = await import('@/hooks/useAircraftInterpolation')
    expect(updateContact('CLIMB1', 5 * FT, UNLEARNED_TYPE, 0)).toBe(false)
    expect(updateContact('CLIMB1', 8 * FT, UNLEARNED_TYPE, 500)).toBe(false)
    expect(updateContact('CLIMB1', 11 * FT, UNLEARNED_TYPE, 1_000), 'climbing at 6 ft/s').toBe(false)
    for (let t = 1_500; t <= 4_500; t += 500) {
      expect(updateContact('CLIMB1', 11 * FT, UNLEARNED_TYPE, t), `level at 11 ft, ${t} ms`).toBe(false)
    }
  })
})

// The terrain clamp draws an aircraft in contact this far over the ground (GROUND_AIRCRAFT_TERRAIN_OFFSET)
const CLAMPED_GROUND_M = 0.1
const EASE_QUARTER_S = 0.25
const EASE_QUARTER_LEFT_MIN = 0.5
const EASE_END_S = 1.0
const EASED_ERR_MAX_M = 0.05

it('an unlearned arrival eases down over 1 s once in contact', () => {
  const recs = frames(unlearned, 'ARR1')
  const entry = recs.findIndex((r) => r.inContact === true)
  expect(entry, 'a frame in contact').toBeGreaterThan(0)
  const contactAt = recs[entry].frameTime
  const d0 = recs[entry].agl
  const quarter = recs.find((r) => r.frameTime >= contactAt + EASE_QUARTER_S)
  expect(quarter?.agl, `drawn ${d0.toFixed(2)} m up on the contact frame`).toBeGreaterThan(EASE_QUARTER_LEFT_MIN * d0)
  const leave = recs.findIndex((r, i) => i > entry && r.inContact !== true)
  const settled = recs.slice(entry, leave < 0 ? recs.length : leave).filter((r) => r.frameTime >= contactAt + EASE_END_S)
  expect(settled.length).toBeGreaterThan(100)
  const worst = settled.reduce((m, r) => Math.max(m, Math.abs(r.agl - CLAMPED_GROUND_M)), 0)
  expect(worst, `drawn ${worst.toFixed(3)} m off the clamped ground`).toBeLessThanOrEqual(EASED_ERR_MAX_M)
})

it.each([
  [0.5, 0.5],
  [1, 1],
])('the ease without a resting height is at the same progress %s of its time at 20 fps and at 40 fps', async (part, expected) => {
  const { transitionProgress } = await import('@/hooks/useAircraftInterpolation')
  const progressAt = (frameMs: number) => {
    const transition = { progress: 0, easeStartedAt: 0 }
    for (let t = frameMs; t <= part * DROP_CONTACT_EASE_MS; t += frameMs) {
      transition.progress = transitionProgress(transition, t)
    }
    return transition.progress
  }
  expect(progressAt(50), 'at 20 fps').toBeCloseTo(expected, 9)
  expect(progressAt(25), 'at 40 fps').toBeCloseTo(expected, 9)
})

/** A stationary vNAS sample at second `t` reporting `heightFt`, as the timeline store takes it. */
function stoppedVnasSample(t: number, heightFt: number): AircraftObservation {
  const observedAt = Date.UTC(2026, 0, 1, 12, 0, 0) + t * 1000
  return {
    latitude: 37.72,
    longitude: -122.22,
    altitude: 10,
    heading: 90,
    groundspeed: 0,
    groundTrack: 90,
    headingIsTrue: true,
    onGround: true,
    pitch: null,
    roll: null,
    verticalRate: null,
    observedAt,
    receivedAt: observedAt + 80,
    source: 'vnas',
    displayDelay: 1500,
    heightAboveGround: heightFt * FT,
  }
}

it("an aircraft decides contact by its own resting height, not its type's", async () => {
  // No scenario flies this type, so the two aircraft below are the only ones to teach it
  const type = 'A20N'
  const metadata: AircraftMetadata = { cid: 1, aircraftType: type, transponder: '1200', departure: null, arrival: null }
  const store = (await import('@/stores/aircraftTimelineStore')).useAircraftTimelineStore.getState()
  for (let t = 0; t < 9; t++) store.addObservation('REST9', stoppedVnasSample(t, 9), metadata)
  for (let t = 0; t < 3; t++) store.addObservation('REST0', stoppedVnasSample(t, 0), metadata)
  const updateContact = (await import('@/hooks/useAircraftInterpolation')).updateContact
  // 6 ft over its own 0 ft is out of contact; over the type's 9 ft (median of six 9s and three 0s) it is -3 ft, in it
  expect(updateContact('REST0', 6 * FT, type, 0), 'REST0 at a raw 6 ft').toBe(false)
  expect(updateContact('REST9', 6 * FT, type, 0), 'REST9 at a raw 6 ft').toBe(true)
})

/** A stationary sample at second `t` from `source`, reporting `heightFt`; only a vNAS sample reports a height. */
function stoppedSample(source: AircraftDataSource, t: number, heightFt = 0): AircraftObservation {
  const observation: AircraftObservation = { ...stoppedVnasSample(t, heightFt), source }
  if (source !== 'vnas') delete observation.heightAboveGround
  return observation
}

/** A vNAS sample at second `t` of an aircraft rolling too fast to be a resting-height sample. */
const rollingVnasSample = (t: number): AircraftObservation => ({ ...stoppedVnasSample(t, 0), groundspeed: 10 })

const typed = (aircraftType: string | null): AircraftMetadata => ({
  cid: 1,
  aircraftType,
  transponder: '1200',
  departure: null,
  arrival: null,
})

const timelineStore = async () => (await import('@/stores/aircraftTimelineStore')).useAircraftTimelineStore
const restOf = async (callsign: string, type: string | null) =>
  (await import('@/utils/aircraft/restingHeight')).restingHeightFor(callsign, type)
// NaN while none is learned, so a closeness check cannot pass on null
const learnedRestOf = async (callsign: string, type: string | null) => (await restOf(callsign, type)) ?? Number.NaN

/**
 * Teach a type 9 ft through its own callsign, so an aircraft of that type that forgets its own 0 ft reads 9 ft: three
 * 0 ft samples of the aircraft leave the type's median of its last 9 samples at 9 ft.
 */
async function teachType(type: string): Promise<void> {
  const store = await timelineStore()
  for (let t = 0; t < 9; t++) store.getState().addObservation(`TEACH${type}`, stoppedSample('vnas', t, 9), typed(type))
}

/** Each case below flies its own callsign and types, which no scenario teaches. */
describe("a vNAS aircraft's type while VATSIM files another", () => {
  it('a vNAS/VATSIM type flip keeps the vNAS type and its own resting height', async () => {
    const store = await timelineStore()
    const typeOf = () => store.getState().timelines.get('WAT2918')?.metadata.aircraftType ?? null
    for (let t = 0; t < 9; t++) store.getState().addObservation('B77LREST', stoppedSample('vnas', t, 13.6), typed('B77L'))
    await teachType('B77W')
    for (let t = 0; t < 3; t++) store.getState().addObservation('WAT2918', stoppedSample('vnas', t, 0), typed('B77W'))
    for (let t = 3; t <= 60; t++) {
      if (t % 15 === 0) {
        const observation = stoppedSample('vatsim', t + 0.5)
        store.getState().addObservationBatch([{ callsign: 'WAT2918', observation, metadata: typed('B77L') }])
      } else {
        store.getState().addObservation('WAT2918', rollingVnasSample(t), typed('B77W'))
      }
      expect(typeOf(), `the type at ${t} s`).toBe('B77W')
      expect(await learnedRestOf('WAT2918', typeOf()), `its resting height at ${t} s`).toBeCloseTo(0, 9)
    }
    const { updateContact } = await import('@/hooks/useAircraftInterpolation')
    // Over its own 0 ft, 6 ft is out of contact; over B77W's 9 ft it would be -3 ft, in contact
    expect(updateContact('WAT2918', 6 * FT, typeOf(), 0), 'WAT2918 at a raw 6 ft').toBe(false)
  })

  it("vNAS samples feed the vNAS type's pool while VATSIM reports another type", async () => {
    const store = await timelineStore()
    store.getState().addObservation('POOL370', stoppedSample('vnas', 0, 7), typed('B744'))
    const observation = stoppedSample('vatsim', 0.5)
    store.getState().addObservationBatch([{ callsign: 'POOL370', observation, metadata: typed('B748') }])
    for (let t = 1; t < 3; t++) store.getState().addObservation('POOL370', stoppedSample('vnas', t, 7), typed(null))
    expect(await restOf('NONE370', 'B744'), "the vNAS type's").toBeCloseTo(7 * FT, 9)
    expect(await restOf('NONE370', 'B748'), "the flight-plan type's").toBeNull()
  })

  it('a vNAS sim swap forgets the resting height', async () => {
    const store = await timelineStore()
    const fileB762 = (t: number) => {
      const observation = stoppedSample('vatsim', t)
      store.getState().addObservationBatch([{ callsign: 'SWAP370', observation, metadata: typed('B762') }])
    }
    fileB762(0)
    for (let t = 1; t < 4; t++) store.getState().addObservation('SWAP370', stoppedSample('vnas', t, 0), typed('B762'))
    expect(await learnedRestOf('SWAP370', 'B762'), 'before the swap').toBeCloseTo(0, 9)
    store.getState().addObservation('SWAP370', stoppedSample('vnas', 4, 0), typed('B763'))
    expect(await restOf('SWAP370', 'B763'), 'after the swap').toBeNull()
    fileB762(4.5)
    expect(store.getState().timelines.get('SWAP370')?.metadata.aircraftType, 'the drawn type').toBe('B763')
    expect(await restOf('SWAP370', 'B763'), 'after the next flight plan').toBeNull()
  })

  it('a VATSIM refile while vNAS reports forgets nothing and keeps the drawn type', async () => {
    const store = await timelineStore()
    const file = (t: number, type: string) => {
      const observation = stoppedSample('vatsim', t)
      store.getState().addObservationBatch([{ callsign: 'REFILE370', observation, metadata: typed(type) }])
    }
    await teachType('A332')
    file(0, 'A332')
    for (let t = 1; t < 4; t++) store.getState().addObservation('REFILE370', stoppedSample('vnas', t, 0), typed('A332'))
    file(4, 'A333')
    expect(store.getState().timelines.get('REFILE370')?.metadata.aircraftType, 'the drawn type').toBe('A332')
    expect(await learnedRestOf('REFILE370', 'A332'), 'its resting height').toBeCloseTo(0, 9)
  })

  it('a VATSIM refile after vNAS has gone silent forgets nothing and keeps the vNAS type', async () => {
    const store = await timelineStore()
    const file = (t: number, type: string) => {
      const observation = stoppedSample('vatsim', t)
      store.getState().addObservationBatch([{ callsign: 'STALE370', observation, metadata: typed(type) }])
    }
    await teachType('A342')
    file(0, 'A342')
    for (let t = 1; t < 4; t++) store.getState().addObservation('STALE370', stoppedSample('vnas', t, 0), typed('A342'))
    file(15, 'A342')
    file(40, 'A343')
    expect(store.getState().timelines.get('STALE370')?.metadata.aircraftType, 'the drawn type').toBe('A342')
    expect(await learnedRestOf('STALE370', 'A342'), 'its resting height').toBeCloseTo(0, 9)
  })

  it('a VATSIM refile of an aircraft vNAS never named forgets and draws the new type', async () => {
    const store = await timelineStore()
    const file = (t: number, type: string) => {
      const observation = stoppedSample('vatsim', t)
      store.getState().addObservationBatch([{ callsign: 'UNNAMED370', observation, metadata: typed(type) }])
    }
    await teachType('A346')
    file(0, 'A346')
    for (let t = 1; t < 4; t++) store.getState().addObservation('UNNAMED370', stoppedSample('vnas', t, 0), typed(null))
    expect(await learnedRestOf('UNNAMED370', 'A346'), 'before the refile').toBeCloseTo(0, 9)
    file(4, 'A345')
    expect(store.getState().timelines.get('UNNAMED370')?.metadata.aircraftType, 'the drawn type').toBe('A345')
    expect(await restOf('UNNAMED370', 'A345'), 'after the refile').toBeNull()
  })

  it('vNAS going silent keeps the vNAS type and its resting height while VATSIM files another', async () => {
    const store = await timelineStore()
    const typeOf = () => store.getState().timelines.get('QUIET370')?.metadata.aircraftType ?? null
    const file = (t: number) => {
      const observation = stoppedSample('vatsim', t)
      store.getState().addObservationBatch([{ callsign: 'QUIET370', observation, metadata: typed('A359') }])
    }
    await teachType('A35K')
    file(0)
    for (let t = 1; t < 4; t++) store.getState().addObservation('QUIET370', stoppedSample('vnas', t, 0), typed('A35K'))
    // The last vNAS sample is at 3 s, so the last batch arrives after 62 s of vNAS silence
    for (let t = 15; t <= 65; t += 10) {
      file(t)
      expect(typeOf(), `the drawn type at ${t} s`).toBe('A35K')
      expect(await learnedRestOf('QUIET370', typeOf()), `its resting height at ${t} s`).toBeCloseTo(0, 9)
    }
  })

  it("the second source's first appearance with another type is not a change", async () => {
    const store = await timelineStore()
    await teachType('B39M')
    for (let t = 0; t < 3; t++) store.getState().addObservation('FIRST370', stoppedSample('vnas', t, 0), typed('B39M'))
    const observation = stoppedSample('vatsim', 3)
    store.getState().addObservationBatch([{ callsign: 'FIRST370', observation, metadata: typed('B38M') }])
    expect(store.getState().timelines.get('FIRST370')?.metadata.aircraftType, 'the drawn type').toBe('B39M')
    expect(await learnedRestOf('FIRST370', 'B39M'), 'its resting height').toBeCloseTo(0, 9)
  })

  it('a placeholder between two vNAS types keeps the drawn type through it', async () => {
    const store = await timelineStore()
    await teachType('E170')
    for (let t = 0; t < 3; t++) store.getState().addObservation('UNKN370', stoppedSample('vnas', t, 0), typed('E170'))
    store.getState().addObservation('UNKN370', stoppedSample('vnas', 3, 0), typed('UNKN'))
    expect(store.getState().timelines.get('UNKN370')?.metadata.aircraftType, 'the drawn type').toBe('E170')
    expect(await learnedRestOf('UNKN370', 'E170'), 'its resting height').toBeCloseTo(0, 9)
  })

  it('a placeholder between two vNAS types forgets the resting height at the second type', async () => {
    const store = await timelineStore()
    for (let t = 0; t < 3; t++) store.getState().addObservation('SWAP2370', stoppedSample('vnas', t, 0), typed('E190'))
    store.getState().addObservation('SWAP2370', stoppedSample('vnas', 3, 0), typed('UNKN'))
    store.getState().addObservation('SWAP2370', stoppedSample('vnas', 4, 0), typed('E195'))
    expect(store.getState().timelines.get('SWAP2370')?.metadata.aircraftType, 'the drawn type').toBe('E195')
    expect(await restOf('SWAP2370', 'E195'), 'its resting height').toBeNull()
  })

  it('VATSIM and RealTraffic types alternating on an aircraft vNAS never named forget nothing', async () => {
    const store = await timelineStore()
    const typeOf = () => store.getState().timelines.get('MIXED370')?.metadata.aircraftType ?? null
    const report = (source: AircraftDataSource, t: number, type: string) => {
      const observation = stoppedSample(source, t)
      store.getState().addObservationBatch([{ callsign: 'MIXED370', observation, metadata: typed(type) }])
    }
    await teachType('B37M')
    await teachType('B3XM')
    report('vatsim', 0, 'B37M')
    for (let t = 1; t < 4; t++) store.getState().addObservation('MIXED370', stoppedSample('vnas', t, 0), typed(null))
    // vNAS never names a type here, so each source's report is compared with that source's own last type only
    for (let t = 40; t < 46; t++) {
      if (t % 2 === 0) report('realtraffic', t, 'B3XM')
      else report('vatsim', t, 'B37M')
      expect(typeOf(), `the drawn type at ${t} s`).toBe(t % 2 === 0 ? 'B3XM' : 'B37M')
      expect(await learnedRestOf('MIXED370', typeOf()), `its resting height at ${t} s`).toBeCloseTo(0, 9)
    }
  })

  it("vNAS naming its first type after VATSIM's is not a change", async () => {
    const store = await timelineStore()
    await teachType('CRJ9')
    const observation = stoppedSample('vatsim', 0)
    store.getState().addObservationBatch([{ callsign: 'LATE370', observation, metadata: typed('CRJ7') }])
    for (let t = 1; t < 4; t++) store.getState().addObservation('LATE370', stoppedSample('vnas', t, 0), typed(null))
    store.getState().addObservation('LATE370', rollingVnasSample(4), typed('CRJ9'))
    expect(store.getState().timelines.get('LATE370')?.metadata.aircraftType, 'the drawn type').toBe('CRJ9')
    expect(await learnedRestOf('LATE370', 'CRJ9'), 'its resting height').toBeCloseTo(0, 9)
  })

  it('a vNAS drop of an aircraft VATSIM still lists keeps the vNAS type and its resting height', async () => {
    const store = await timelineStore()
    const { useVatsimStore } = await import('@/stores/vatsimStore')
    await teachType('B78X')
    for (let t = 0; t < 3; t++) store.getState().addObservation('KEEP370', stoppedSample('vnas', t, 0), typed('B78X'))
    const flightPlan = { aircraft_short: 'B789' } as PilotData['flight_plan']
    const pilot = { callsign: 'KEEP370', cid: 1, latitude: 37.72, longitude: -122.22, altitude: 30, heading: 90 }
    useVatsimStore.setState({
      allPilots: [{ ...pilot, groundspeed: 0, transponder: '1200', flight_plan: flightPlan } as PilotData],
      lastVatsimTimestamp: stoppedVnasSample(10, 0).observedAt,
      isPolling: true,
      lastUpdate: new Date(),
    })
    try {
      store.getState().dropSourceObservations('vnas', ['KEEP370'])
      const kept = store.getState().timelines.get('KEEP370')
      expect(kept?.observations.map((o) => o.source), 'the kept timeline').toEqual(['vatsim'])
      expect(kept?.metadata.aircraftType, 'the drawn type').toBe('B78X')
      expect(await learnedRestOf('KEEP370', 'B78X'), 'its resting height').toBeCloseTo(0, 9)
    } finally {
      useVatsimStore.setState({ allPilots: [], lastVatsimTimestamp: 0, isPolling: false, lastUpdate: null })
    }
  })

  it('a callsign dropped with its vNAS feed and seen again forgets the type vNAS named', async () => {
    const store = await timelineStore()
    for (let t = 0; t < 3; t++) store.getState().addObservation('DROP370', stoppedSample('vnas', t, 0), typed('B788'))
    store.getState().dropSourceObservations('vnas', ['DROP370'])
    expect(store.getState().timelines.has('DROP370'), 'its timeline').toBe(false)
    expect(await restOf('DROP370', null), 'its resting height').toBeNull()
    store.getState().addObservation('DROP370', stoppedSample('vnas', 10, 0), typed(null))
    expect(store.getState().timelines.get('DROP370')?.metadata.aircraftType, 'the drawn type').toBeNull()
  })

  it('a single vNAS sample is relayed with the type vNAS named, not the drawn one', async () => {
    const { registerBroadcastCallbacks } = await import('@/stores/aircraftTimelineStore')
    const store = await timelineStore()
    const relayed: (string | null)[] = []
    registerBroadcastCallbacks(
      (observations) => {
        for (const o of observations) if (o.callsign === 'RELAY370') relayed.push(o.metadata.aircraftType)
      },
      () => {},
    )
    try {
      const observation = stoppedSample('vatsim', 0)
      store.getState().addObservationBatch([{ callsign: 'RELAY370', observation, metadata: typed('B752') }])
      store.getState().addObservation('RELAY370', stoppedSample('vnas', 1, 0), typed(null))
      expect(store.getState().timelines.get('RELAY370')?.metadata.aircraftType, 'the drawn type').toBe('B752')
      expect(relayed, 'the relayed types').toEqual(['B752', null])
    } finally {
      registerBroadcastCallbacks(
        () => {},
        () => {},
      )
    }
  })
})

const LIFTOFF_EXIT_LAG_MAX_S = 1.1

it(`an unlearned B77L first seen by vNAS on its takeoff roll leaves contact by the drop rule within ${LIFTOFF_EXIT_LAG_MAX_S} s of liftoff`, () => {
  const recs = frames(lateFeed, 'DEP1')
  const airborne = recs.filter((r) => r.truth.agl > AIRBORNE_CHECK_MIN_AGL_M && r.inContact === false)
  expect(airborne.length).toBeGreaterThan(1000)
  const learnedOff = airborne.reduce((m, r) => Math.max(m, Math.abs(r.reportedAgl - r.agl)), 0)
  expect(learnedOff, 'drawn at its reported height, so its type is not learned').toBeLessThanOrEqual(
    DRAWN_HEIGHT_DIFF_MAX_M,
  )
  const liftoff = lateFeed.flights.find((f) => f.callsign === 'DEP1')?.events.initial_climb ?? Number.NaN
  expect(recs.find((r) => r.tLocal >= liftoff)?.inContact, 'in contact at liftoff').toBe(true)
  const leave = recs.find((r) => r.tLocal >= liftoff && r.inContact === false)
  expect(leave, 'a frame out of contact after liftoff').toBeDefined()
  const lag = (leave?.tLocal ?? Number.NaN) - liftoff
  expect(lag, `contact left ${lag.toFixed(2)} s after liftoff`).toBeLessThanOrEqual(LIFTOFF_EXIT_LAG_MAX_S)
})

describe('the drop rule over a jump in the displayed time', () => {
  // No scenario flies this type, so its resting height is never learned and the drop rule decides
  const UNLEARNED_TYPE = 'C5M'
  const contact = async () => (await import('@/hooks/useAircraftInterpolation')).updateContact

  it('a jump forward past twice the rate window does not enter contact on that frame', async () => {
    const updateContact = await contact()
    expect(updateContact('JUMP1', 100 * FT, UNLEARNED_TYPE, 0)).toBe(false)
    expect(updateContact('JUMP1', 15 * FT, UNLEARNED_TYPE, 600_000), 'the frame after a 10 min jump').toBe(false)
    expect(updateContact('JUMP1', 15 * FT, UNLEARNED_TYPE, 601_000), 'steady at 15 ft over the next 1 s').toBe(false)
    expect(updateContact('JUMP1', 15 * FT, UNLEARNED_TYPE, 602_000), 'its rate flat for 1 s').toBe(true)
  })

  it('display time going back restarts the rate: no contact until 1 s of frames is in again and its rate is flat for 1 s', async () => {
    const updateContact = await contact()
    expect(updateContact('BACK1', 19 * FT, UNLEARNED_TYPE, 10_000)).toBe(false)
    expect(updateContact('BACK1', 17 * FT, UNLEARNED_TYPE, 10_500)).toBe(false)
    expect(updateContact('BACK1', 15 * FT, UNLEARNED_TYPE, 11_000), 'sinking at 4 ft/s').toBe(false)
    expect(updateContact('BACK1', 10 * FT, UNLEARNED_TYPE, 5_000), 'the frame after going back').toBe(false)
    expect(updateContact('BACK1', 10 * FT, UNLEARNED_TYPE, 5_500), 'half the window refilled').toBe(false)
    expect(updateContact('BACK1', 10 * FT, UNLEARNED_TYPE, 6_000), 'the window refilled').toBe(false)
    expect(updateContact('BACK1', 10 * FT, UNLEARNED_TYPE, 6_500), 'its rate flat for 0.5 s').toBe(false)
    expect(updateContact('BACK1', 10 * FT, UNLEARNED_TYPE, 7_000), 'its rate flat for 1 s').toBe(true)
  })
})
