// @vitest-environment node
/**
 * vNAS reports the height above ground of a reference point, so an aircraft at rest reads its resting height, which
 * varies by type and by simulator (TC3D-316, TC3D-354): one A320 was measured live at 9.0 ft and another at -0.31 ft;
 * the scenarios here use A320 9.0 ft, B77L 13.6 ft, C17 5.9 ft and MD11 16.44 ft. Contact is decided on the height over
 * the aircraft's own resting height, once learned from slow vNAS samples, else its type's once two consecutive samples
 * of its own sit within 1 ft of it (TC3D-397); only then is it taken off the drawn height. Until then lane B
 * decides (`laneB.test.ts`): contact at or below 16 ft once a run of samples has settled after a descent, then over a
 * provisional resting height taken from the run, the drawn height easing over 1 s of display time.
 */
import { describe, expect, it, vi } from 'vitest'
import { DROP_CONTACT_EASE_MS } from '@/constants'
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

/** What `updateContact` reads of a frame with a height and nothing else, as these cases drive it. */
const heightOnly = (heightAboveGround: number, aircraftType: string | null, displayTime: number) => ({
  heightAboveGround,
  aircraftType,
  displayTime,
  settleRun: undefined,
  bracketStartStopped: false,
  displayAnchorOffsetMs: 0,
})

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
// An arrival whose type has no resting height enters contact within this long of its displayed touchdown (TC3D-246)
const LANE_B_TOUCHDOWN_LAG_MAX_S = 2.5
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
/** As `learned`, over drawn terrain 1.5 m below the simulator's ground: a change of contact moves the drawn height. */
const learnedLowTerrain: ScenarioResult = await runScenario({
  ...BASE,
  aircraftTypes: { DEP1: 'A320', ARR1: 'A320', GA1: 'C17' },
  terrainOffsetM: -1.5,
})
/** DEP1 and ARR1 are MD11s resting at 16.44 ft, over 16 ft, each first seen by VATSIM. */
const TALL: ScenarioOptions = { ...BASE, aircraftTypes: { DEP1: 'MD11', ARR1: 'MD11' }, restingHeightsFt: { MD11: 16.44 } }
const tallVatsimFirst: ScenarioResult = await runScenario(TALL)
/** As `TALL`, each first seen by vNAS, as the live MD11s were: DEP1 teaches the type on its pushback. */
const tall: ScenarioResult = await runScenario({ ...TALL, vnasFirst: true })
/** DEP1's own resting height at the end of `tall` (metres), its type not consulted. */
const tallDepOwnRest = (await import('@/utils/aircraft/restingHeight')).restingHeightFor('DEP1', null)
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

const LEARNED_ROLLOUT_TITLE =
  'a learned A320 rollout enters contact on the frame a 0 ft aircraft does, ' +
  `within ${LEARNED_TOUCHDOWN_LAG_MAX_S} s of its reported touchdown`

it(LEARNED_ROLLOUT_TITLE, () => {
  const lag = touchdownLag(learned)
  expect(lag, 'contact entry against an aircraft that reads 0 ft at rest').toBe(touchdownLag(zeroRest))
  expect(Math.abs(lag), `contact ${lag.toFixed(2)} s after the reported touchdown`).toBeLessThanOrEqual(
    LEARNED_TOUCHDOWN_LAG_MAX_S,
  )
})

describe('an MD11 resting at 16.44 ft (TC3D-395)', () => {
  it(`its arrival enters contact within ${LEARNED_TOUCHDOWN_LAG_MAX_S} s of its reported touchdown`, () => {
    const lag = touchdownLag(tall)
    expect(Math.abs(lag), `contact ${lag.toFixed(2)} s after the reported touchdown`).toBeLessThanOrEqual(
      LEARNED_TOUCHDOWN_LAG_MAX_S,
    )
  })

  it.each([
    ['first seen by vNAS on its pushback', () => tall],
    ['first seen by VATSIM at the gate', () => tallVatsimFirst],
  ])('%s, it stays in contact while taxiing', (_name, result) => {
    const taxi = frames(result(), 'DEP1').filter((r) => TAXI_SEGMENTS.includes(r.truth.segment) && r.gs > 5)
    expect(taxi.length).toBeGreaterThan(1000)
    expect(taxi.filter((r) => r.inContact !== true).length, 'taxi frames out of contact').toBe(0)
  })

  it('parked, it learns its own resting height and is in contact', () => {
    expect((tallDepOwnRest ?? Number.NaN) / 0.3048, 'its own resting height (ft)').toBeCloseTo(16.44, 6)
    const parked = vnasFrames(tall, 'DEP1').filter((r) => r.truth.segment === 'lined_up' && r.truth.gs === 0)
    expect(parked.length).toBeGreaterThan(300)
    expect(parked.filter((r) => r.inContact !== true).length, 'parked frames out of contact').toBe(0)
  })
})

it(`an unlearned type's first arrival enters contact by lane B within ${LANE_B_TOUCHDOWN_LAG_MAX_S} s of touchdown`, () => {
  const lag = touchdownLag(unlearned)
  expect(lag, 'contact before the reported touchdown').toBeGreaterThanOrEqual(0)
  expect(lag, `contact ${lag.toFixed(2)} s after the reported touchdown`).toBeLessThanOrEqual(
    LANE_B_TOUCHDOWN_LAG_MAX_S,
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
  it("an airborne vNAS A320 with only its type's resting height, unconfirmed by its own samples, is drawn at its raw height", () => {
    // The 0 ft aircraft reads its raw height too, so the A320 is drawn its 9 ft resting height over it
    const airborne = drawnOverZeroRest(learned, 'ARR1').filter(
      ({ rec }) => rec.truth.agl > AIRBORNE_CHECK_MIN_AGL_M && rec.inContact === false,
    )
    expect(airborne.length).toBeGreaterThan(1000)
    const worst = airborne.reduce((m, { diff }) => Math.max(m, Math.abs(diff - A320_REST_M)), 0)
    expect(worst, `drawn ${worst.toFixed(3)} m off its raw height`).toBeLessThanOrEqual(DRAWN_HEIGHT_DIFF_MAX_M)
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

  it('an airborne A320 is not drawn lower when another A320 teaches its type', () => {
    const airborne = drawnOverZeroRest(learnedMidFlight, 'GA1').filter(
      ({ rec }) => rec.truth.agl > AIRBORNE_CHECK_MIN_AGL_M && rec.inContact === false,
    )
    expect(airborne.length).toBeGreaterThan(1000)
    const worst = airborne.reduce((m, { diff }) => Math.max(m, Math.abs(diff - A320_REST_M)), 0)
    expect(worst, `drawn ${worst.toFixed(3)} m off its raw height`).toBeLessThanOrEqual(DRAWN_HEIGHT_DIFF_MAX_M)
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

// The fast ease, HEIGHT_TRANSITION_LERP_FACTOR a frame, is done in about 15 frames; the 1 s smoothstep is 22% in here
const FAST_EASE_DONE_S = 0.3
const LOW_TERRAIN_GROUND_M = -1.5 + CLAMPED_GROUND_M

const CONFIRMED_EASE_TITLE =
  `an arrival whose own samples confirm its type's resting height eases onto the drawn runway within ` +
  `${FAST_EASE_DONE_S} s of contact, as one with its own does`

it(CONFIRMED_EASE_TITLE, () => {
  const recs = frames(learnedLowTerrain, 'ARR1')
  const entry = recs.findIndex((r) => r.inContact === true)
  expect(entry, 'a frame in contact').toBeGreaterThan(0)
  const contactAt = recs[entry].frameTime
  const leave = recs.findIndex((r, i) => i > entry && r.inContact !== true)
  const settled = recs
    .slice(entry, leave < 0 ? recs.length : leave)
    .filter((r) => r.frameTime >= contactAt + FAST_EASE_DONE_S)
  expect(settled.length).toBeGreaterThan(100)
  const worst = settled.reduce((m, r) => Math.max(m, Math.abs(r.agl - LOW_TERRAIN_GROUND_M)), 0)
  expect(worst, `drawn ${worst.toFixed(3)} m off the drawn runway`).toBeLessThanOrEqual(EASED_ERR_MAX_M)
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
  expect(updateContact('REST0', heightOnly(6 * FT, type, 0)), 'REST0 at a raw 6 ft').toBe(false)
  expect(updateContact('REST9', heightOnly(6 * FT, type, 0)), 'REST9 at a raw 6 ft').toBe(true)
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

// 115 kt east along the 37.72 degree parallel, in degrees of longitude a second
const LANDING_LONGITUDE_DEG_PER_S = (115 * 1852) / 3600 / (111_320 * Math.cos((37.72 * Math.PI) / 180))

/**
 * A vNAS sample at second `t` of an aircraft landing east at 115 kt, too fast to be a resting-height sample and moving,
 * so no bracket starts stopped.
 */
const landingVnasSample = (t: number, heightFt: number): AircraftObservation => ({
  ...stoppedVnasSample(t, heightFt),
  longitude: -122.22 + t * LANDING_LONGITUDE_DEG_PER_S,
  groundspeed: 115,
})

/** Teach `type` a resting height of `ft` through nine parked samples of `teacher`, which fill its sample window. */
async function teachTypeAt(teacher: string, type: string, ft: number): Promise<void> {
  const store = await timelineStore()
  for (let t = 0; t < 9; t++) store.getState().addObservation(teacher, stoppedSample('vnas', t, ft), typed(type))
}

/**
 * Land `callsign` of `type` on 1 Hz vNAS samples from second `fromS`, driving `updateContact` once per sample with the
 * frame the timeline store draws at its instant (`getInterpolatedState`): the settle run and the last two heights
 * ending at the sample.
 *
 * @returns Per sample, whether it is in contact and what is taken off its drawn height before any ease (m)
 */
async function landOnSamples(
  callsign: string,
  type: string,
  heightsFt: number[],
  fromS: number,
): Promise<{ inContact: boolean; offset: number }[]> {
  const store = await timelineStore()
  const { restOffsetTarget, updateContact } = await import('@/hooks/useAircraftInterpolation')
  const drawnAt = (now: number) => store.getState().getInterpolatedState(callsign, now)
  return heightsFt.map((ft, i) => {
    const observation = landingVnasSample(fromS + i, ft)
    store.getState().addObservation(callsign, observation, typed(type))
    // Display time trails the clock by the display delay, which a frame drawn at the sample's instant measures
    const lag = observation.observedAt - (drawnAt(observation.observedAt)?.displayTime ?? Number.NaN)
    const frame = drawnAt(observation.observedAt + lag)
    if (frame === null || frame.displayTime !== observation.observedAt) {
      throw new Error(`${callsign} is not drawn at its sample ${fromS + i} s in (display time ${frame?.displayTime})`)
    }
    const inContact = updateContact(callsign, frame) === true
    const target = restOffsetTarget(callsign, frame)
    return { inContact, offset: target.rest * target.share }
  })
}

// QXE504's landing (tc3d246 live round 4): an E75L whose own simulator rests at 0.24 ft, while other E75Ls taught
// 6.78 ft
const QXE504_FT = [14.96, 8.5, 5.43, 2.87, 1.07, 0.77, 0.54]
const E75L_TYPE_REST_FT = 6.78
// An A320 resting at 9.1 ft lands, touching down on the 9.1 ft sample 3 s in
const A320_LANDING_FT = [20, 15, 11, 9.1, 9.2, 9.1]

describe("a resting height learned only from the aircraft's type (TC3D-397)", () => {
  it('lets an aircraft resting elsewhere enter contact only once it settles, and is not taken off its drawn height', async () => {
    const store = await timelineStore()
    for (let t = 0; t < 9; t++) {
      store.getState().addObservation('TEACHE75L', stoppedSample('vnas', t, E75L_TYPE_REST_FT), typed('E75L'))
    }
    const samples = await landOnSamples('QXE504', 'E75L', QXE504_FT, 0)
    // 8.5 and 5.43 ft are under the type's 6.78 ft plus the 3 ft entry
    expect(samples[1].inContact, 'in contact at 8.5 ft').toBe(false)
    expect(samples[2].inContact, 'in contact at 5.43 ft').toBe(false)
    // 0.77 and 0.54 ft are 0.23 ft apart but not within 1 ft of 6.78 ft, so lane B's settle on 2.87-0.54 ft enters
    expect(samples[samples.length - 1].inContact, 'in contact at the last sample, 0.54 ft').toBe(true)
    expect(samples[1].offset, 'taken off the drawn height at 8.5 ft (m)').toBe(0)
    expect(samples[2].offset, 'taken off the drawn height at 5.43 ft (m)').toBe(0)
  })

  it(`lets an aircraft resting at it enter contact within ${LEARNED_TOUCHDOWN_LAG_MAX_S} s of touchdown`, async () => {
    await teachType('A320')
    // Touchdown on the 9.1 ft sample, 3 s in
    const samples = await landOnSamples('ROLL397', 'A320', A320_LANDING_FT, 0)
    const first = samples.findIndex((s) => s.inContact)
    expect(first, 'a sample in contact').toBeGreaterThanOrEqual(0)
    expect(first - 3, 'seconds from touchdown to contact').toBeLessThanOrEqual(LEARNED_TOUCHDOWN_LAG_MAX_S)
    expect(samples[samples.length - 1].offset / FT, 'taken off the drawn height once settled (ft)').toBeCloseTo(9, 9)
  })

  it('drops a confirmation when the type changes, until two of its own samples confirm the new type', async () => {
    await teachTypeAt('SWAPTEACHA', 'A320', 9)
    await teachTypeAt('SWAPTEACHB', 'B77L', 13.6)
    const landed = await landOnSamples('SWAP397', 'A320', A320_LANDING_FT, 0)
    expect(landed[landed.length - 1].offset / FT, 'taken off as a confirmed A320 (ft)').toBeCloseTo(9, 9)
    // The simulator swaps to a B77L on the runway, still resting at 9.1 ft, then lifts off past 15 ft
    const swapped = await landOnSamples('SWAP397', 'B77L', [9.1, 15, 13.5, 13.6], A320_LANDING_FT.length)
    expect(swapped[0].offset / FT, 'taken off at 9.1 ft as a B77L (ft)').toBeLessThanOrEqual(9.1 + 1e-6)
    // 15 ft is 1.4 ft over the B77L's 13.6 ft but 5.9 ft over the 9.1 ft it rested at
    expect(swapped[1].inContact, 'in contact at 15 ft as a B77L').toBe(false)
    expect(swapped[1].offset / FT, 'taken off at 15 ft as a B77L (ft)').toBeLessThanOrEqual(9.1 + 1e-6)
    expect(swapped[3].offset / FT, 'taken off once 13.5 and 13.6 ft confirm the B77L (ft)').toBeCloseTo(13.6, 9)
  })

  it("drops a confirmation when other aircraft of the type move the type's resting height over 1 ft", async () => {
    await teachTypeAt('MOVETEACHA', 'A320', 9)
    const landed = await landOnSamples('MOVE397', 'A320', A320_LANDING_FT, 0)
    expect(landed[landed.length - 1].offset / FT, 'taken off as a confirmed A320 (ft)').toBeCloseTo(9, 9)
    await teachTypeAt('MOVETEACHB', 'A320', 11)
    const rolling = await landOnSamples('MOVE397', 'A320', [9.1, 9.1], A320_LANDING_FT.length)
    // Its own 9.1 ft samples are 1.9 ft under the A320's 11 ft, so they confirm nothing
    for (const [i, s] of rolling.entries()) {
      expect(s.offset / FT, `taken off at its ${i + 1}th 9.1 ft sample after the move (ft)`).toBeLessThanOrEqual(9.1 + 1e-6)
    }
  })

  it("drops a confirmation when the type changes to one whose resting height is within 1 ft of the confirmed one", async () => {
    await teachTypeAt('KEYTEACHA', 'A320', 9)
    await teachTypeAt('KEYTEACHB', 'A21N', 9.8)
    const landed = await landOnSamples('KEY397', 'A320', A320_LANDING_FT, 0)
    expect(landed[landed.length - 1].offset / FT, 'taken off as a confirmed A320 (ft)').toBeCloseTo(9, 9)
    // The A21N's 9.8 ft is 0.8 ft over the A320's confirmed 9 ft; its own 8.6 ft samples are 1.2 ft under it
    const swapped = await landOnSamples('KEY397', 'A21N', [8.6, 8.6], A320_LANDING_FT.length)
    for (const [i, s] of swapped.entries()) {
      expect(s.offset / FT, `taken off at its ${i + 1}th 8.6 ft sample as an A21N (ft)`).toBeLessThanOrEqual(9.2 + 1e-6)
    }
  })
})

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
    expect(updateContact('WAT2918', heightOnly(6 * FT, typeOf(), 0)), 'WAT2918 at a raw 6 ft').toBe(false)
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

it(`an unlearned B77L first seen by vNAS on its takeoff roll leaves contact by lane B within ${LIFTOFF_EXIT_LAG_MAX_S} s of liftoff`, () => {
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

// Out of contact, the full provisional resting height is taken off the drawn height up to this raw height
// (DROP_CONTACT_EXIT_HEIGHT_METERS), fading to none at the raw height it is dropped above (100 ft)
const PROVISIONAL_REST_DROP_M = 25 * FT
const PROVISIONAL_REST_FADE_TOP_M = 100 * FT
// The flying offset the drawn height carries near the ground (GROUND_AIRCRAFT_TERRAIN_OFFSET)
const FLYING_OFFSET_MAX_M = 0.1
// The 1 s contact-change smoothstep from the clamped ground adds at most 1.5 x 17 ms / 1 s of its gap to the target
// (under 5 m on this climb-out) to one frame's step: 0.13 m
const EXIT_EASE_STEP_MAX_M = 0.15

it('an unlearned B77L climbing out by lane B rises no faster than its climb plus the fade, and is drawn at its raw height above 100 ft', () => {
  const recs = frames(lateFeed, 'DEP1')
  const liftoff = lateFeed.flights.find((f) => f.callsign === 'DEP1')?.events.initial_climb ?? Number.NaN
  const leave = recs.findIndex((r) => r.tLocal >= liftoff && r.inContact === false)
  expect(leave, 'a frame out of contact after liftoff').toBeGreaterThan(0)
  const rawOf = (r: FrameRecord) => r.truth.agl + B77L_REST_M
  const top = recs.findIndex((r, i) => i >= leave && rawOf(r) > PROVISIONAL_REST_FADE_TOP_M)
  expect(top, 'a frame above 100 ft raw').toBeGreaterThan(leave)
  // Drawn height is the raw height less 13.6 ft x the fade, so it climbs (1 + 13.6 ft / 75 ft) times as fast as raw
  const fadeSlope = 1 + B77L_REST_M / (PROVISIONAL_REST_FADE_TOP_M - PROVISIONAL_REST_DROP_M)
  let worst = Number.NEGATIVE_INFINITY
  for (let i = leave + 1; i <= top; i++) {
    const allowed = Math.max(0, rawOf(recs[i]) - rawOf(recs[i - 1])) * fadeSlope + EXIT_EASE_STEP_MAX_M
    worst = Math.max(worst, recs[i].agl - recs[i - 1].agl - allowed)
  }
  expect(worst, `a frame rose ${worst.toFixed(3)} m past its climb and the fade`).toBeLessThanOrEqual(0)
  const above = recs.slice(top).filter((r) => r.inContact === false && r.truth.agl < AIRBORNE_CHECK_MIN_AGL_M * 3)
  expect(above.length, 'frames above 100 ft raw').toBeGreaterThan(30)
  // The shown altitude adds back what is taken off the drawn height, so the two agree once nothing is taken off
  const off = above.reduce((m, r) => Math.max(m, Math.abs(r.agl - r.reportedAgl)), 0)
  expect(off, `drawn ${off.toFixed(3)} m under its raw height above 100 ft`).toBeLessThanOrEqual(DRAWN_HEIGHT_DIFF_MAX_M)
})

it('an unlearned B77L leaving contact by lane B is drawn its provisional resting height lower, not lifted by it', () => {
  const recs = frames(lateFeed, 'DEP1')
  const liftoff = lateFeed.flights.find((f) => f.callsign === 'DEP1')?.events.initial_climb ?? Number.NaN
  const leave = recs.findIndex((r) => r.tLocal >= liftoff && r.inContact === false)
  expect(leave, 'a frame out of contact after liftoff').toBeGreaterThan(0)
  // vNAS reports the truth's height plus the type's 13.6 ft; the roll read 13.6 ft, the provisional resting height
  const rawOf = (r: FrameRecord) => r.truth.agl + B77L_REST_M
  const end = recs.findIndex((r, i) => i >= leave && rawOf(r) > PROVISIONAL_REST_DROP_M)
  const out = recs.slice(leave, end < 0 ? recs.length : end)
  expect(out.length, 'frames out of contact below the drop height').toBeGreaterThan(5)
  // The exit eases up toward the raw height less the provisional resting height, the truth's height
  const worst = out.reduce((m, r) => Math.max(m, r.agl - r.truth.agl), Number.NEGATIVE_INFINITY)
  expect(worst, `drawn ${worst.toFixed(3)} m over the reported height less 13.6 ft`).toBeLessThanOrEqual(
    FLYING_OFFSET_MAX_M + DRAWN_HEIGHT_DIFF_MAX_M,
  )
})
