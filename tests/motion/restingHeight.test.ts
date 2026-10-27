// @vitest-environment node
/**
 * vNAS reports the height above ground of a reference point, so an aircraft at rest reads its resting height, which
 * varies by type and by simulator (TC3D-316, TC3D-354): one A320 was measured live at 9.0 ft and another at -0.31 ft;
 * the scenarios here use A320 9.0 ft, B77L 13.6 ft and C17 5.9 ft. Contact is decided on the height over the
 * aircraft's own resting height, else its type's, once one is learned from slow vNAS samples. With neither, the drop
 * rule decides: contact at or below 16 ft once the rate has stayed flat for 1 s after a descent, the drawn height
 * easing over 1 s of display time.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { DROP_CONTACT_EASE_MS, DROP_CONTACT_FLAT_MS, DROP_CONTACT_RATE_WINDOW_MS } from '@/constants'
import type { AircraftMetadata, AircraftObservation } from '@/types/aircraft-timeline'
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

/** The departing A320 teaches its type during the pushback, before the arriving A320 lands. */
let learned: ScenarioResult
/** No A320 is on the ground before the arriving one lands; the departing B77L teaches its type. */
let unlearned: ScenarioResult
/** Every flight a B738 that reads 0 ft at rest. */
let zeroRest: ScenarioResult
/** GA1, an A320, is airborne when the arriving A320 stops and teaches the type. */
let learnedMidFlight: ScenarioResult
/** DEP1, the only B77L, is first seen by vNAS on its takeoff roll, so its type is never learned. */
let lateFeed: ScenarioResult

/** GA1, an A320 reading 0 ft at rest whose type nothing teaches, holds a level pass at 18 ft before going around. */
let levelPass: ScenarioResult

// DEP1's vNAS feed starts this far into its takeoff roll, past every sample under 5 kt (taxi start, line-up stop)
const LATE_FEED_ROLL_S = 3
const LEVEL_PASS = { ft: 18, seconds: 8 }

beforeAll(async () => {
  learned = await runScenario({ ...BASE, aircraftTypes: { DEP1: 'A320', ARR1: 'A320', GA1: 'C17' } })
  unlearned = await runScenario({ ...BASE, aircraftTypes: { DEP1: 'B77L', ARR1: 'A320', GA1: 'B77L' } })
  zeroRest = await runScenario({ ...BASE, restingHeightsFt: {} })
  learnedMidFlight = await runScenario({ ...BASE, aircraftTypes: { DEP1: 'B77L', ARR1: 'A320', GA1: 'A320' } })
  const dep = buildFlights(LOW_PASS_FT).flights.find((f) => f.callsign === 'DEP1') as Flight
  lateFeed = await runScenario({
    ...BASE,
    aircraftTypes: { DEP1: 'B77L', ARR1: 'A320', GA1: 'C17' },
    vnasFromS: { DEP1: dep.offset + dep.events.takeoff_roll + LATE_FEED_ROLL_S },
  })
  levelPass = await runScenario({
    ...BASE,
    aircraftTypes: { DEP1: 'B77L', ARR1: 'B77L', GA1: 'A320' },
    restingByCallsignFt: { GA1: 0 },
    levelPass: LEVEL_PASS,
  })
}, 300_000)

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
