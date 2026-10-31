// @vitest-environment node
/**
 * The contact hold (TC3D-371): an aircraft that leaves ground contact on a bracket whose earlier sample shows it
 * stopped (`bracketStartStopped`, a stop carried across a vNAS silence) and steps under 500 m stays in contact until
 * its height has stayed over the exit height for 5 s, so a short burst of high vNAS samples (a simulator reposition or
 * reload: FDX772, a B77L at rest at 13.58 ft, read 24.5, 21.4, 21.1 and 15.1 ft) never lifts a parked aircraft. A
 * takeoff, whose exit bracket starts moving, and a rotorcraft type follow the source; a seek, a playback mode change
 * and removal clear the hold, and a null height ends it but keeps whether the aircraft was in contact. Each case feeds
 * 1 Hz vNAS samples to the timeline store as they are received, interpolates 60 Hz frames and decides contact as the
 * interpolation hook does (`updateContact` on the displayed frame). Times are scenario ms.
 */
import { expect, it, vi } from 'vitest'
import { CONTACT_EXIT_HEIGHT_METERS, CONTACT_HOLD_MS, SOURCE_DISPLAY_DELAYS } from '@/constants'
import type { AircraftObservation } from '@/types/aircraft-timeline'
import type { InterpolatedAircraftState, PilotData } from '@/types/vatsim'

vi.mock('react', () => {
  const api = {
    useEffect: (fn: () => unknown) => {
      fn()
    },
    useState: <T>(v: T) => [v, () => {}],
  }
  return { ...api, default: api }
})

// The interpolation loop re-arms itself through requestAnimationFrame; each loop frame runs the armed callback once
let rafCallback: ((t: number) => void) | null = null
;(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: (t: number) => void) => {
  rafCallback = cb
  return 1
}
;(globalThis as Record<string, unknown>).cancelAnimationFrame = () => {}

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0)
const FRAME_MS = 1000 / 60
const FT = 0.3048
const LAT = 37.72
const LON = -122.22
const M_PER_DEG_LON = 111320 * Math.cos((LAT * Math.PI) / 180)
const VNAS_RECEIVE_LAG_MS = 80
const G_MPS2 = 9.80665
const KT_PER_MPS = 1 / 0.514444
const EXIT_FT = CONTACT_EXIT_HEIGHT_METERS / FT
// A takeoff leaves contact within this long of liftoff when nothing holds it (5 ft over its resting height)
const LIFTOFF_EXIT_MAX_MS = 1500
// Frames are checked from here, once the resting height is learned and contact entered
const SETTLED_MS = 10_000

const REST_FT = 13.58
// The samples at rest before a sustained burst, scenario seconds 0 to 19
const PARKED_S = 20
// The recorded shape: a stop of 5 samples at rest, a vNAS silence, then a few samples at rest and the burst
const STOP_SAMPLES = 5
const RECORDED_SILENCE_S = 40
const RECORDED_REST_SAMPLES = 3
const FDX772_BURST_FT = [24.5, 21.4, 21.1, 15.1]
// vnasStore's groundspeeds for the burst: a 5-sample window over position steps
const FDX772_BURST_GS_KTS = [3, 71, 72, 72]
// The burst's inferred position steps (m, east): about 8 m (15 kt), the 175 m reload jump, then about 5 kt
const FDX772_JUMP_STEPS_M = [8, 175, 2.6, 0]
const SUSTAINED_FT = 24.5
const SUSTAINED_UNTIL_S = 35
// A clearing event during a sustained burst, about 1 s after its exit started
const EVENT_MS = 20_500
const EVENT_NULL_MS = 500
const SEEK_JUMP_MS = 3000
// A 3-sample burst whose end falls in a null-height gap, and the gap
const SHORT_BURST_SAMPLES = 3
const SHORT_BURST_GAP_FROM_MS = 22_500
const SHORT_BURST_GAP_TO_MS = 23_700
// The type turns out to be a rotorcraft's 2 s into a sustained burst's hold
const ROTORCRAFT_ARRIVES_MS = 21_500
// Probe row S15: a STOL type at rest at 4.1 ft whose roll from a stop is the last 3 s of the flat, then 8 ft/s
const STOL_REST_FT = 4.1
const STOL_ROLL_S = 3
const STOL_ACCEL_G = 0.3
const STOL_LIFTOFF_S = 20
const STOL_CLIMB_FT_PER_S = 8
// A normal takeoff: 0.2 g from a stop at 19 s, liftoff 30 s later, then 10 ft/s; vNAS repeats its position at the
// liftoff sample, the earlier sample of the bracket its exit falls in: one slow step after a fast one
const NORMAL_REST_FT = 9
const NORMAL_ROLL_FROM_S = 19
const NORMAL_ACCEL_G = 0.2
const NORMAL_LIFTOFF_S = 49
const NORMAL_REPEATED_S = NORMAL_LIFTOFF_S
const NORMAL_CLIMB_FT_PER_S = 10
const HELI_REST_FT = 3
const HELI_CLIMB_FT_PER_S = 8
// No case teaches this type, and its samples report 140 kt, so no resting height is learned and lane B decides
const UNLEARNED_TYPE = 'C5M'
const UNLEARNED_GS_KTS = 140
// First seen (in range) this long after its samples start, so its first frame's bracket starts on a stopped sample
const FIRST_SIGHT_FROM_MS = 6000
const LANE_B_REST_FT = 4
const LANE_B_BURST_FT = [60, 124, 60]
// A burst whose samples move 20 m a second (39 kt)
const MOVING_BURST_STEP_M = 20
// Taxiing 5 m/s through a gap of vNAS samples without a height, then back with a height 4 ft over its resting height:
// over the 3 ft entry, under the 5 ft exit
const GAP_TAXI_STEP_M = 5
const GAP_SAMPLES = 10
const GAP_RETURN_OVER_REST_FT = 4
// A parked aircraft repositioned onto final: its next sample 2 km away and 1000 ft up
const REPOSITION_STEP_M = 2000
const REPOSITION_FT = 1000
// A VATSIM report is observed this long before it is received
const VATSIM_FEED_LAG_MS = 3000
// GHOST41 (F35, TC3D-396): VATSIM's pilot list holds a report observed 11.5 s before it was received, taken on the
// roll; the vNAS hub then disconnects the aircraft after liftoff, between two samples, and vNAS carries on
const LATE_VATSIM_LAG_MS = 11_500
const LATE_VATSIM_RECEIVED_MS = (NORMAL_LIFTOFF_S + 3) * 1000
const VNAS_DISCONNECT_MS = (NORMAL_LIFTOFF_S + 5) * 1000 + 300
const VATSIM_PERIOD_MS = 15_000
// GHOST41 held at its last vNAS sample: frames run until display time passes this (scenario ms), past the first
// VATSIM report observed after that sample
const GHOST_HELD_END_MS = 60_000
// A held aircraft is drawn within this of its hold point, and at its height within this
const HELD_TOLERANCE_M = 1
const HELD_TOLERANCE_FT = 1
// A departure VATSIM saw first: VATSIM's reports of it at rest, 15 s apart, all received before its first vNAS sample,
// since vNAS is silent while it is parked
const VATSIM_FIRST_RECEIVED_MS = [4000, 19_000]
// An aircraft first seen parked on VATSIM alone: its vNAS samples start here, and the third shows the stop
const SNAP_VNAS_FROM_S = 30
const SNAP_VNAS_SAMPLES = 8
// The delay's snap from VATSIM's to vNAS's moves display time forward by more than this
const SNAP_MIN_MOVE_MS = 10_000

interface Sample {
  /** Scenario second */
  t: number
  ft: number
  eastM: number
  /** Reported groundspeed (kt) */
  gs: number
  /** A vNAS sample without a height above ground */
  noHeight?: true
}

/** The vNAS observation of a sample. */
function observation(s: Sample): AircraftObservation {
  const observedAt = T0 + s.t * 1000
  return {
    latitude: LAT,
    longitude: LON + s.eastM / M_PER_DEG_LON,
    altitude: 10 + s.ft * FT,
    heading: 90,
    groundspeed: s.gs,
    groundTrack: 90,
    headingIsTrue: true,
    onGround: true,
    pitch: null,
    roll: null,
    verticalRate: null,
    observedAt,
    receivedAt: observedAt + VNAS_RECEIVE_LAG_MS,
    source: 'vnas',
    displayDelay: SOURCE_DISPLAY_DELAYS.vnas,
    ...(s.noHeight ? {} : { heightAboveGround: s.ft * FT }),
  }
}

/** A VATSIM report of an aircraft standing at rest, received at scenario ms `receivedMs` and observed `lagMs` before. */
function vatsimReport(receivedMs: number, lagMs: number): AircraftObservation {
  const receivedAt = T0 + receivedMs
  return {
    latitude: LAT,
    longitude: LON,
    altitude: 10 + REST_FT * FT,
    heading: 90,
    groundspeed: 0,
    groundTrack: 90,
    headingIsTrue: true,
    onGround: true,
    pitch: null,
    roll: null,
    verticalRate: null,
    observedAt: receivedAt - lagMs,
    receivedAt,
    source: 'vatsim',
    displayDelay: SOURCE_DISPLAY_DELAYS.vatsim,
  }
}

/** A VATSIM report where the newest of `samples` at its observed time put the aircraft, with that sample's speed. */
function vatsimOnTrack(samples: Sample[], receivedMs: number, lagMs: number): AircraftObservation {
  const report = vatsimReport(receivedMs, lagMs)
  const observedS = (report.observedAt - T0) / 1000
  const at = samples.filter((s) => s.t <= observedS).pop() ?? samples[0]
  return {
    ...report,
    longitude: LON + at.eastM / M_PER_DEG_LON,
    altitude: 10 + at.ft * FT,
    groundspeed: at.gs,
  }
}

/** VATSIM's pilot list entry for a report, as the feed lists it (altitude in feet). */
function pilotOf(callsign: string, report: AircraftObservation): PilotData {
  return {
    cid: 1,
    name: callsign,
    callsign,
    server: 'TEST',
    pilot_rating: 0,
    latitude: report.latitude,
    longitude: report.longitude,
    altitude: report.altitude / FT,
    groundspeed: report.groundspeed,
    transponder: '',
    heading: report.heading,
    qnh_i_hg: 29.92,
    qnh_mb: 1013,
    flight_plan: null,
    logon_time: '',
    last_updated: '',
  }
}

/** Samples 1 s apart from scenario second `fromS`, one per height, at `eastM` and reporting `gs`. */
function steady(fromS: number, heightsFt: number[], eastM = 0, gs = 0): Sample[] {
  return heightsFt.map((ft, i) => ({ t: fromS + i, ft, eastM, gs }))
}

const repeat = (ft: number, count: number) => Array.from({ length: count }, () => ft)

/** What `updateContact` is given on a frame, as a scenario may change it. */
interface ContactInput {
  height: number | null
  type: string
  displayTime: number
}

/** The interpolation hook's loop and its drawn states, for the events that act through it. */
interface Hook {
  map: Map<string, InterpolatedAircraftState>
  runLoopFrame: () => void
  setPlaybackMode: (mode: 'live' | 'replay', now: number) => void
}

interface Frame {
  ms: number
  ft: number | null
  inContact: boolean | null
  /** Lane B's provisional resting height after the frame (ft), or null */
  restFt: number | null
  /** Whether the interpolation loop draws the aircraft on the frame; set only for a scenario it draws */
  drawn?: boolean
  /** Metres east of the origin the aircraft is drawn; set only for a scenario the loop draws */
  eastM?: number
}

interface Scenario {
  callsign: string
  type: string
  samples: Sample[]
  /** Scenario ms at which VATSIM reports of the aircraft at rest are received; none by default */
  vatsimReceivedMs?: number[]
  /** How long before its receipt each VATSIM report is observed; VATSIM_FEED_LAG_MS by default */
  vatsimLagMs?: number
  /** VATSIM reports reach the store in batches, as the VATSIM feed delivers them; one at a time by default */
  vatsimBatch?: true
  /**
   * Scenario ms at which the vNAS hub disconnects the aircraft, while VATSIM's pilot list holds its newest VATSIM report
   */
  vnasDisconnectMs?: number
  /** vNAS sends nothing from the hub disconnect on; by default its samples carry on */
  vnasEndsAtDisconnect?: true
  /** VATSIM reports the aircraft where its samples put it when observed; at rest at the origin by default */
  vatsimAlongTrack?: true
  /** The displayed instant (scenario ms) frames run to; the last sample's by default */
  endMs?: number
  /** The frame's input, from what the store displays; may act on the hook first */
  input?: (base: ContactInput, ms: number, hook: Hook) => ContactInput
  /** Drawn in contact before its first frame, as a source without height leaves it */
  drawnInContact?: boolean
  /** The first displayed instant contact is decided on (the aircraft comes into range); 0 by default */
  fromMs?: number
  /**
   * The interpolation loop draws the aircraft (in range of the reference position) every frame, and each frame's
   * contact is the drawn entry's; by default no aircraft is in range and contact is decided outside the loop
   */
  drawnByLoop?: true
}

/** Run one frame of the interpolation loop. */
function runLoopFrame(): void {
  const cb = rafCallback
  rafCallback = null
  if (!cb) throw new Error('interpolation loop did not re-arm requestAnimationFrame')
  cb(0)
}

/**
 * Feed the samples to a fresh timeline store as they are received and decide contact at 60 Hz frames until the
 * displayed instant passes the last sample. The interpolation loop runs no aircraft (no reference position), so it only
 * acts when a scenario runs it.
 */
async function run(scenario: Scenario): Promise<Frame[]> {
  vi.resetModules()
  // vnasStore registers with the timeline store at module init: load it first, as the app does
  await import('@/stores/vnasStore')
  const { useAircraftTimelineStore } = await import('@/stores/aircraftTimelineStore')
  const { updateContact, provisionalRestFor, useAircraftInterpolation } = await import('@/hooks/useAircraftInterpolation')
  const { useReplayStore } = await import('@/stores/replayStore')
  const { useVatsimStore } = await import('@/stores/vatsimStore')
  const store = useAircraftTimelineStore
  const cs = scenario.callsign
  const metadata = { cid: 1, aircraftType: scenario.type, transponder: '', departure: null, arrival: null }
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(T0)
    useVatsimStore.setState({ referencePosition: scenario.drawnByLoop ? { latitude: LAT, longitude: LON } : null })
    // biome-ignore lint/correctness/useHookAtTopLevel: this is the interpolation singleton, driven outside React
    const map = useAircraftInterpolation()
    const snapshot = (timestamp: number) => ({
      timestamp,
      vatsimTimestamp: timestamp,
      aircraftStates: [],
      lastUpdateInterval: 15000,
    })
    const hook: Hook = {
      map,
      runLoopFrame,
      setPlaybackMode: (mode, now) =>
        useReplayStore.setState(
          mode === 'replay'
            ? {
                playbackMode: 'replay',
                snapshots: [snapshot(now), snapshot(now + 1000)],
                currentIndex: 0,
                segmentProgress: 0,
              }
            : { playbackMode: 'live', snapshots: [], currentIndex: 0, segmentProgress: 0 },
        ),
    }
    if (scenario.drawnInContact) map.set(cs, { callsign: cs, inContact: true } as InterpolatedAircraftState)
    const lagMs = scenario.vatsimLagMs ?? VATSIM_FEED_LAG_MS
    const disconnectMs = scenario.vnasDisconnectMs ?? Number.POSITIVE_INFINITY
    const vnasSent = scenario.vnasEndsAtDisconnect
      ? scenario.samples.filter((s) => s.t * 1000 < disconnectMs)
      : scenario.samples
    const vatsimOf = (ms: number) =>
      scenario.vatsimAlongTrack ? vatsimOnTrack(scenario.samples, ms, lagMs) : vatsimReport(ms, lagMs)
    const samples = [...vnasSent.map(observation), ...(scenario.vatsimReceivedMs ?? []).map(vatsimOf)].sort(
      (a, b) => a.receivedAt - b.receivedAt,
    )
    const endMs = scenario.endMs ?? scenario.samples[scenario.samples.length - 1].t * 1000
    const frames: Frame[] = []
    let next = 0
    let newestVatsim: AircraftObservation | null = null
    let disconnected = false
    for (let f = 0; ; f++) {
      const now = T0 + f * FRAME_MS
      vi.setSystemTime(now)
      if (!disconnected && scenario.vnasDisconnectMs !== undefined && now >= T0 + scenario.vnasDisconnectMs) {
        disconnected = true
        const listed = newestVatsim ? [pilotOf(cs, newestVatsim)] : []
        const listTimes = newestVatsim ? { lastVatsimTimestamp: newestVatsim.observedAt, lastUpdate: new Date(newestVatsim.receivedAt) } : {}
        useVatsimStore.setState({ allPilots: listed, isPolling: true, ...listTimes })
        store.getState().dropSourceObservations('vnas', [cs])
      }
      while (next < samples.length && samples[next].receivedAt <= now) {
        const sample = samples[next++]
        if (sample.source === 'vatsim') newestVatsim = sample
        if (sample.source === 'vatsim' && scenario.vatsimBatch) {
          store.getState().addObservationBatch([{ callsign: cs, observation: sample, metadata }])
        } else {
          store.getState().addObservation(cs, sample, metadata)
        }
      }
      if (scenario.drawnByLoop) runLoopFrame()
      const result = store.getState().getInterpolatedStates(now).get(cs)
      if (!result) continue
      const ms = result.displayTime - T0
      if (ms > endMs) break
      if (ms < (scenario.fromMs ?? 0)) continue
      if (scenario.drawnByLoop) {
        const entry = map.get(cs)
        const ft = result.heightAboveGround === null ? null : result.heightAboveGround / FT
        const eastM = (result.longitude - LON) * M_PER_DEG_LON
        frames.push({ ms, ft, inContact: entry?.inContact ?? null, restFt: null, drawn: entry !== undefined, eastM })
        continue
      }
      const base: ContactInput = {
        height: result.heightAboveGround,
        type: scenario.type,
        displayTime: result.displayTime,
      }
      const input = scenario.input ? scenario.input(base, ms, hook) : base
      const inContact = updateContact(cs, {
        heightAboveGround: input.height,
        aircraftType: input.type,
        displayTime: input.displayTime,
        settleRun: result.settleRun,
        bracketStartStopped: result.bracketStartStopped,
        displayAnchorOffsetMs: result.displayAnchorOffsetMs,
      })
      const rest = provisionalRestFor(cs)
      frames.push({
        ms,
        ft: input.height === null ? null : input.height / FT,
        inContact,
        restFt: rest === null ? null : rest / FT,
      })
    }
    return frames
  } finally {
    vi.useRealTimers()
  }
}

/** Run `act` once, on the first frame at or after `atMs`. */
function onceAt(atMs: number, act: (base: ContactInput, hook: Hook) => void) {
  let done = false
  return (base: ContactInput, ms: number, hook: Hook): ContactInput => {
    if (!done && ms >= atMs) {
      done = true
      act(base, hook)
    }
    return base
  }
}

/** A null height on the frames from `fromMs` up to `toMs`. */
const nullBetween = (fromMs: number, toMs: number) => (base: ContactInput, ms: number) =>
  ms >= fromMs && ms < toMs ? { ...base, height: null } : base

const between = (frames: Frame[], fromMs: number, toMs: number) => frames.filter((f) => f.ms >= fromMs && f.ms < toMs)
const outOfContact = (frames: Frame[]) => frames.filter((f) => f.inContact !== true)
const firstOutMs = (frames: Frame[], fromMs: number) =>
  frames.find((f) => f.ms >= fromMs && f.inContact === false)?.ms ?? Number.NaN
/** The first frame (ms) at or after SETTLED_MS whose height is over the exit height above `restFt`. */
const exitStartMs = (frames: Frame[], restFt: number) =>
  frames.find((f) => f.ms >= SETTLED_MS && f.ft !== null && f.ft - restFt > EXIT_FT)?.ms ?? Number.NaN

/**
 * FDX772's recorded shape: stopped at rest, a vNAS silence of `silenceS`, `restSamples` samples at rest, its burst with
 * the given position steps, then at rest again.
 */
function recorded(callsign: string, silenceS: number, restSamples: number, stepsM: number[]): Scenario {
  const resumeS = STOP_SAMPLES - 1 + silenceS
  const burstS = resumeS + restSamples
  let east = 0
  const burst = FDX772_BURST_FT.map((ft, i) => {
    east += stepsM[i]
    return { t: burstS + i, ft, eastM: east, gs: FDX772_BURST_GS_KTS[i] }
  })
  return {
    callsign,
    type: 'B77L',
    samples: [
      ...steady(0, repeat(REST_FT, STOP_SAMPLES)),
      ...steady(resumeS, repeat(REST_FT, restSamples)),
      ...burst,
      ...steady(burstS + burst.length, repeat(REST_FT, 10), east),
    ],
  }
}

/** A B77L at rest, then its height over the exit height from PARKED_S to SUSTAINED_UNTIL_S, standing still. */
function sustained(callsign: string, input?: Scenario['input']): Scenario {
  const burst = steady(PARKED_S, repeat(SUSTAINED_FT, SUSTAINED_UNTIL_S - PARKED_S + 1))
  return { callsign, type: 'B77L', samples: [...steady(0, repeat(REST_FT, PARKED_S)), ...burst], input }
}

/** A takeoff from a stop at `fromS` accelerating at `accelG`, lifting off at `liftoffS` and climbing at `ftPerS`. */
function takeoff(
  restFt: number,
  roll: { fromS: number; accelG: number; liftoffS: number },
  ftPerS: number,
  repeatedS?: number,
): Sample[] {
  const accel = roll.accelG * G_MPS2
  const eastAt = (t: number) => (t > roll.fromS ? 0.5 * accel * (t - roll.fromS) ** 2 : 0)
  return Array.from({ length: roll.liftoffS + 11 }, (_, t) => ({
    t,
    ft: t <= roll.liftoffS ? restFt : restFt + ftPerS * (t - roll.liftoffS),
    eastM: t === repeatedS ? eastAt(t - 1) : eastAt(t),
    gs: t > roll.fromS ? accel * (t - roll.fromS) * KT_PER_MPS : 0,
  }))
}

// The scenarios run at the top level, where collection has no timeout (tests/setup/hookBudget.ts).
const stationaryBurst = await run(recorded('FDX772A', RECORDED_SILENCE_S, RECORDED_REST_SAMPLES, [0, 0, 0, 0]))
const jumpBurst = await run(recorded('FDX772B', RECORDED_SILENCE_S, RECORDED_REST_SAMPLES, FDX772_JUMP_STEPS_M))
const plausibleFirstStep = await run(recorded('FDX772C', RECORDED_SILENCE_S, RECORDED_REST_SAMPLES, [8, 0, 0, 0]))
const afterLongSilence = await run(recorded('FDX772D', 60, 0, [0, 0, 0, 0]))
const afterShortSilence = await run(recorded('FDX772E', 25, 0, [0, 0, 0, 0]))
const oneRestSample = await run(recorded('FDX772F', RECORDED_SILENCE_S, 1, [0, 0, 0, 0]))
const twoRestSamples = await run(recorded('FDX772G', RECORDED_SILENCE_S, 2, [0, 0, 0, 0]))
const repositioned = await run({
  callsign: 'MOVE1',
  type: 'B77L',
  samples: [...steady(0, repeat(REST_FT, PARKED_S)), ...steady(PARKED_S, repeat(REPOSITION_FT, 10), REPOSITION_STEP_M)],
})
const heldFull = await run(sustained('HOLD1'))
const stol = await run({
  callsign: 'STOL1',
  type: 'PC6',
  samples: takeoff(
    STOL_REST_FT,
    { fromS: STOL_LIFTOFF_S - STOL_ROLL_S, accelG: STOL_ACCEL_G, liftoffS: STOL_LIFTOFF_S },
    STOL_CLIMB_FT_PER_S,
  ),
})
const repeatBeforeLiftoff = await run({
  callsign: 'ROLL1',
  type: 'A320',
  samples: takeoff(
    NORMAL_REST_FT,
    { fromS: NORMAL_ROLL_FROM_S, accelG: NORMAL_ACCEL_G, liftoffS: NORMAL_LIFTOFF_S },
    NORMAL_CLIMB_FT_PER_S,
    NORMAL_REPEATED_S,
  ),
})
const heliLiftoff = await run({
  callsign: 'HELI1',
  type: 'R22',
  samples: [
    ...steady(0, repeat(HELI_REST_FT, PARKED_S)),
    ...steady(
      PARKED_S,
      Array.from({ length: 10 }, (_, i) => HELI_REST_FT + HELI_CLIMB_FT_PER_S * (i + 1)),
    ),
  ],
})
const rotorcraftArrives = await run(
  sustained('HOLD2', (base, ms) => (ms >= ROTORCRAFT_ARRIVES_MS ? { ...base, type: 'R22' } : base)),
)
const firstSight = await run({
  callsign: 'SPAWN1',
  type: UNLEARNED_TYPE,
  samples: steady(0, repeat(40, 15), 0, UNLEARNED_GS_KTS),
  drawnInContact: true,
  fromMs: FIRST_SIGHT_FROM_MS,
})
const nullHeight = await run(sustained('HOLD3', nullBetween(EVENT_MS, EVENT_MS + EVENT_NULL_MS)))
const nullAfterBurst = await run({
  callsign: 'HOLD7',
  type: 'B77L',
  samples: [
    ...steady(0, repeat(REST_FT, PARKED_S)),
    ...steady(PARKED_S, repeat(SUSTAINED_FT, SHORT_BURST_SAMPLES)),
    ...steady(PARKED_S + SHORT_BURST_SAMPLES, repeat(REST_FT, 10)),
  ],
  input: nullBetween(SHORT_BURST_GAP_FROM_MS, SHORT_BURST_GAP_TO_MS),
})
const movedInGap = await run({
  callsign: 'GAP1',
  type: 'B77L',
  samples: [
    ...steady(0, repeat(REST_FT, STOP_SAMPLES)),
    ...Array.from({ length: 2 * GAP_SAMPLES }, (_, i) => ({
      t: STOP_SAMPLES + i,
      ft: REST_FT + GAP_RETURN_OVER_REST_FT,
      eastM: GAP_TAXI_STEP_M * (i + 1),
      gs: GAP_TAXI_STEP_M * KT_PER_MPS,
      ...(i < GAP_SAMPLES ? { noHeight: true as const } : {}),
    })),
  ],
})
const seek = await run(
  sustained('HOLD4', (base, ms) => (ms >= EVENT_MS ? { ...base, displayTime: base.displayTime + SEEK_JUMP_MS } : base)),
)
const modeSwitch = await run(
  sustained(
    'HOLD5',
    onceAt(EVENT_MS, (base, hook) => {
      hook.setPlaybackMode('replay', base.displayTime)
      hook.runLoopFrame()
      hook.setPlaybackMode('live', base.displayTime)
      hook.runLoopFrame()
    }),
  ),
)
const removal = await run(
  sustained(
    'HOLD6',
    onceAt(EVENT_MS, (_base, hook) => {
      hook.map.set('HOLD6', { callsign: 'HOLD6', inContact: true } as InterpolatedAircraftState)
      hook.runLoopFrame()
    }),
  ),
)

/** At rest, then a moving burst of 8 s released by the hold, then `between` samples, then a 3 s burst at rest. */
function twoBursts(callsign: string, betweenSamples: Sample[]): Scenario {
  // Steps of 20 m and 60 m in turn
  const firstBurst = Array.from({ length: 8 }, (_, i) => ({
    t: PARKED_S + i,
    ft: SUSTAINED_FT,
    eastM: MOVING_BURST_STEP_M * (2 * (i + 1) + 2 * Math.floor((i + 1) / 2) - (i + 1)),
    gs: MOVING_BURST_STEP_M * KT_PER_MPS,
  }))
  const restEastM = firstBurst[firstBurst.length - 1].eastM
  const secondFromS = PARKED_S + 8 + betweenSamples.length
  return {
    callsign,
    type: 'B77L',
    samples: [
      ...steady(0, repeat(REST_FT, PARKED_S)),
      ...firstBurst,
      ...betweenSamples,
      ...steady(secondFromS, repeat(SUSTAINED_FT, 3), restEastM),
      ...steady(secondFromS + 3, repeat(REST_FT, 10), restEastM),
    ],
  }
}

// The first burst ends at 27 s; one sample back at rest, moved on from the burst's last spot, starts the second burst
const secondBurstStraightAfter = await run(
  twoBursts('TWICE1', [{ t: 28, ft: REST_FT, eastM: MOVING_BURST_STEP_M * 17, gs: 39 }]),
)
// Back at rest for 3 samples at the burst's last spot before the second burst
const secondBurstAfterRest = await run(twoBursts('TWICE2', steady(28, repeat(REST_FT, 3), MOVING_BURST_STEP_M * 16)))
const laneBBurst = await run({
  callsign: 'LANEB1',
  type: UNLEARNED_TYPE,
  samples: [
    ...steady(0, repeat(LANE_B_REST_FT, 15), 0, UNLEARNED_GS_KTS),
    ...steady(15, LANE_B_BURST_FT, 0, UNLEARNED_GS_KTS),
    ...steady(18, repeat(LANE_B_REST_FT, 8), 0, UNLEARNED_GS_KTS),
  ],
})

/** A normal takeoff that VATSIM reports late, then the vNAS hub disconnects (GHOST41's shape). */
function lateVatsimTakeoff(callsign: string, vatsimBatch: boolean): Scenario {
  return {
    callsign,
    type: 'A320',
    samples: takeoff(
      NORMAL_REST_FT,
      { fromS: NORMAL_ROLL_FROM_S, accelG: NORMAL_ACCEL_G, liftoffS: NORMAL_LIFTOFF_S },
      NORMAL_CLIMB_FT_PER_S,
    ),
    vatsimReceivedMs: [LATE_VATSIM_RECEIVED_MS],
    vatsimLagMs: LATE_VATSIM_LAG_MS,
    ...(vatsimBatch ? { vatsimBatch: true as const } : {}),
    vnasDisconnectMs: VNAS_DISCONNECT_MS,
    drawnByLoop: true,
  }
}

const lateVatsimBatch = await run(lateVatsimTakeoff('GHOST1', true))
const lateVatsimSingle = await run(lateVatsimTakeoff('GHOST2', false))
// GHOST41 as recorded: vNAS ends at the hub disconnect, and VATSIM's reports, 11.5 s late every 15 s, follow the takeoff
const ghostHeld = await run({
  ...lateVatsimTakeoff('GHOST3', true),
  vatsimReceivedMs: [0, 1, 2].map((i) => LATE_VATSIM_RECEIVED_MS + i * VATSIM_PERIOD_MS),
  vatsimAlongTrack: true,
  vnasEndsAtDisconnect: true,
  endMs: GHOST_HELD_END_MS,
})
// The normal takeoff's vNAS from its first moving sample, after VATSIM's reports at rest, drawn by the loop
const vatsimSeenFirst = await run({
  callsign: 'VSEEN1',
  type: 'A320',
  samples: takeoff(
    NORMAL_REST_FT,
    { fromS: NORMAL_ROLL_FROM_S, accelG: NORMAL_ACCEL_G, liftoffS: NORMAL_LIFTOFF_S },
    NORMAL_CLIMB_FT_PER_S,
  ).filter((s) => s.t > NORMAL_ROLL_FROM_S),
  vatsimReceivedMs: VATSIM_FIRST_RECEIVED_MS,
  drawnByLoop: true,
})
// Drawn in contact from VATSIM, with no resting height, when its vNAS samples at rest snap its display delay
const delaySnap = await run({
  callsign: 'SNAP1',
  type: UNLEARNED_TYPE,
  samples: steady(SNAP_VNAS_FROM_S, repeat(LANE_B_REST_FT, SNAP_VNAS_SAMPLES), 0, UNLEARNED_GS_KTS),
  vatsimReceivedMs: VATSIM_FIRST_RECEIVED_MS,
  drawnInContact: true,
})

/**
 * Frames with a height after the stop: the burst is shown over the exit height, and contact is never left. More than
 * 300 frames are drawn from `resumeMs` (5 s).
 */
function expectBurstHeld(frames: Frame[], resumeMs: number): void {
  const shown = frames.filter((f) => f.ms >= STOP_SAMPLES * 1000 && f.ft !== null)
  expect(shown.filter((f) => f.ms >= resumeMs).length, 'frames drawn after the silence').toBeGreaterThan(300)
  const overExit = shown.filter((f) => f.ft !== null && f.ft - REST_FT > EXIT_FT)
  expect(overExit.length, 'frames whose displayed height is over the exit height').toBeGreaterThan(0)
  const out = outOfContact(shown)
  expect(out.length, `frames out of contact (${((out.length * FRAME_MS) / 1000).toFixed(2)} s)`).toBe(0)
}

/** In contact from SETTLED_MS up to EVENT_MS (held), and out of contact on every frame from `fromMs`. */
function expectHeldThenCleared(frames: Frame[], fromMs = EVENT_MS): void {
  expect(outOfContact(between(frames, SETTLED_MS, EVENT_MS)).length, 'frames out of contact before the event').toBe(0)
  const after = frames.filter((f) => f.ms >= fromMs)
  expect(after.length, 'frames after the event').toBeGreaterThan(60)
  expect(after.filter((f) => f.inContact !== false).length, 'frames still in contact after the event').toBe(0)
}

const recordedResumeMs = (silenceS: number) => (STOP_SAMPLES - 1 + silenceS) * 1000

it('a parked B77L keeps contact through a 3-sample height burst', () => {
  expectBurstHeld(stationaryBurst, recordedResumeMs(RECORDED_SILENCE_S))
})

it('a parked B77L keeps contact through a burst with a 175 m position jump', () => {
  expectBurstHeld(jumpBurst, recordedResumeMs(RECORDED_SILENCE_S))
})

it('a burst whose first step is a plausible 15 kt move is still held', () => {
  expectBurstHeld(plausibleFirstStep, recordedResumeMs(RECORDED_SILENCE_S))
})

it('a parked B77L keeps contact through a burst that ends a 60 s vNAS silence', () => {
  expectBurstHeld(afterLongSilence, recordedResumeMs(60))
})

it('a parked B77L keeps contact through a burst that ends a 25 s vNAS silence', () => {
  expectBurstHeld(afterShortSilence, recordedResumeMs(25))
})

it('a parked B77L keeps contact through a burst one sample after a 40 s vNAS silence', () => {
  expectBurstHeld(oneRestSample, recordedResumeMs(RECORDED_SILENCE_S))
})

it('a parked B77L keeps contact through a burst two samples after a 40 s vNAS silence', () => {
  expectBurstHeld(twoRestSamples, recordedResumeMs(RECORDED_SILENCE_S))
})

// Red until the parked-silence bracket holds the stopped sample (booked separately): the bracket lerps the burst back across the silence.
it.todo('a parked B77L keeps contact through a burst that ends a 60 s vNAS silence with VATSIM reports every 15 s')

it('a parked aircraft repositioned 2 km away into the air is not held', () => {
  const exitMs = exitStartMs(repositioned, REST_FT)
  expect(exitMs, 'exit start').toBeGreaterThan(SETTLED_MS)
  expect(firstOutMs(repositioned, exitMs) - exitMs, 'first frame out after the exit started').toBeLessThanOrEqual(FRAME_MS + 1)
})

it('a stopped aircraft whose height stays above the exit leaves contact 5 s after the exit first held', () => {
  const exitMs = exitStartMs(heldFull, REST_FT)
  expect(exitMs, 'exit start').toBeGreaterThan(SETTLED_MS)
  expect(outOfContact(between(heldFull, SETTLED_MS, exitMs + CONTACT_HOLD_MS)).length, 'frames out while held').toBe(0)
  const outMs = firstOutMs(heldFull, exitMs)
  expect(outMs - (exitMs + CONTACT_HOLD_MS), 'first frame out after the hold').toBeGreaterThanOrEqual(0)
  expect(outMs - (exitMs + CONTACT_HOLD_MS), 'first frame out after the hold').toBeLessThanOrEqual(FRAME_MS + 1)
})

it('a STOL takeoff with a 3 s roll from a stop leaves contact within 1.5 s of liftoff', () => {
  const liftoffMs = STOL_LIFTOFF_S * 1000
  expect(outOfContact(between(stol, SETTLED_MS, liftoffMs)).length, 'frames out on the roll').toBe(0)
  expect(firstOutMs(stol, liftoffMs) - liftoffMs).toBeLessThanOrEqual(LIFTOFF_EXIT_MAX_MS)
})

it('a takeoff whose vNAS sample repeats a position at liftoff leaves contact within 1.5 s of liftoff', () => {
  const liftoffMs = NORMAL_LIFTOFF_S * 1000
  expect(outOfContact(between(repeatBeforeLiftoff, SETTLED_MS, liftoffMs)).length, 'frames out on the roll').toBe(0)
  expect(firstOutMs(repeatBeforeLiftoff, liftoffMs) - liftoffMs).toBeLessThanOrEqual(LIFTOFF_EXIT_MAX_MS)
})

it('a helicopter lifting from a stand follows the source', () => {
  const liftoffMs = (PARKED_S - 1) * 1000
  expect(outOfContact(between(heliLiftoff, SETTLED_MS, liftoffMs)).length, 'frames out at rest').toBe(0)
  expect(firstOutMs(heliLiftoff, liftoffMs) - liftoffMs).toBeLessThanOrEqual(LIFTOFF_EXIT_MAX_MS)
})

it('a rotorcraft type arriving mid-hold releases the hold', () => {
  const exitMs = exitStartMs(rotorcraftArrives, REST_FT)
  expect(exitMs, 'exit start').toBeLessThan(ROTORCRAFT_ARRIVES_MS)
  expect(
    outOfContact(between(rotorcraftArrives, SETTLED_MS, ROTORCRAFT_ARRIVES_MS)).length,
    'frames out while held',
  ).toBe(0)
  const arrived = rotorcraftArrives.find((f) => f.ms >= ROTORCRAFT_ARRIVES_MS)
  expect(arrived?.inContact, 'the first frame with the rotorcraft type').toBe(false)
})

it('first sight above the exit is not held', () => {
  expect(firstSight.length, 'frames').toBeGreaterThan(60)
  expect(firstSight.filter((f) => f.inContact === true).length, 'frames in contact').toBe(0)
})

it('a null height during a hold clears it', () => {
  const gap = between(nullHeight, EVENT_MS, EVENT_MS + EVENT_NULL_MS)
  expect(gap.length, 'frames without a height').toBeGreaterThan(0)
  expect(
    gap.every((f) => f.inContact === null),
    'contact without a height',
  ).toBe(true)
  expect(outOfContact(between(nullHeight, SETTLED_MS, EVENT_MS)).length, 'frames out before the gap').toBe(0)
  // Back over the exit on a stopped bracket start, it was in contact at its last height: a new hold starts there
  const returnMs = nullHeight.find((f) => f.ms >= EVENT_MS + EVENT_NULL_MS)?.ms ?? Number.NaN
  const outMs = firstOutMs(nullHeight, returnMs)
  expect(outMs - (returnMs + CONTACT_HOLD_MS), 'first frame out after the new hold').toBeGreaterThanOrEqual(0)
  expect(outMs - (returnMs + CONTACT_HOLD_MS), 'first frame out after the new hold').toBeLessThanOrEqual(FRAME_MS + 1)
  // Back under the exit on a stopped bracket start: in contact
  const back = nullAfterBurst.filter((f) => f.ms >= SHORT_BURST_GAP_TO_MS)
  expect(back.length, 'frames after the gap').toBeGreaterThan(60)
  expect(outOfContact(back).length, 'frames out after the gap').toBe(0)
})

it('an aircraft that moved during a null-height gap re-enters as at first sight', () => {
  const back = movedInGap.filter((f) => f.ms >= (STOP_SAMPLES + GAP_SAMPLES) * 1000 && f.ft !== null)
  expect(back.length, 'frames with a height after the gap').toBeGreaterThan(60)
  expect(back.filter((f) => f.inContact !== false).length, 'frames in contact 4 ft over its resting height').toBe(0)
})

it('a seek of more than 2 s during a hold clears it', () => {
  expectHeldThenCleared(seek)
})

it('a mode switch during a hold clears it', () => {
  expectHeldThenCleared(modeSwitch)
})

it('a second burst after a release is held only after fresh stillness', () => {
  for (const frames of [secondBurstStraightAfter, secondBurstAfterRest]) {
    const firstExitMs = exitStartMs(frames, REST_FT)
    expect(firstOutMs(frames, firstExitMs), 'the first burst released after the hold').toBeGreaterThanOrEqual(
      firstExitMs + CONTACT_HOLD_MS,
    )
  }
  // The second bursts run from about 28.5 s and 30.5 s
  const straight = between(secondBurstStraightAfter, 28_400, 32_000)
  expect(outOfContact(straight).length, 'frames out in a burst straight after the first').toBeGreaterThan(0)
  const afterRest = between(secondBurstAfterRest, 29_000, 45_000)
  expect(outOfContact(afterRest).length, 'frames out in a burst after 3 samples at rest').toBe(0)
})

it("an unlearned type's burst above 100 ft during a hold leaves R-hat unchanged", () => {
  const shown = laneBBurst.filter((f) => f.ms >= SETTLED_MS)
  expect(
    shown.some((f) => f.ft !== null && f.ft > 100),
    'the burst shown above 100 ft',
  ).toBe(true)
  expect(outOfContact(shown).length, 'frames out of contact').toBe(0)
  for (const f of shown) {
    expect(f.restFt, `provisional resting height at ${f.ms.toFixed(0)} ms`).toBeCloseTo(LANE_B_REST_FT, 6)
  }
})

it('removing an aircraft clears its hold', () => {
  expectHeldThenCleared(removal)
})

/**
 * Display time never steps back, and no frame from the displayed liftoff on is in contact without a height or over the
 * exit height above the resting height.
 */
function expectNoStepBackAfterLiftoff(frames: Frame[], restFt: number, liftoffMs: number): void {
  const back = frames.findIndex((f, i) => i > 0 && f.ms < frames[i - 1].ms)
  const step = back === -1 ? null : `${frames[back - 1].ms.toFixed(0)} -> ${frames[back].ms.toFixed(0)} ms`
  expect(step, 'display time stepping back').toBeNull()
  const fromLiftoff = frames.filter((f) => f.ms >= liftoffMs)
  expect(fromLiftoff.length, 'frames from the displayed liftoff').toBeGreaterThan(60)
  const wrong = fromLiftoff.filter((f) => f.inContact === true && (f.ft === null || f.ft - restFt > EXIT_FT))
  expect(wrong.length, 'frames after liftoff in contact without a height or over the exit height').toBe(0)
}

it('a VATSIM report 11.5 s late, batched before a vNAS hub disconnect after liftoff, never moves display time back (TC3D-396)', () => {
  expectNoStepBackAfterLiftoff(lateVatsimBatch, NORMAL_REST_FT, NORMAL_LIFTOFF_S * 1000)
})

it('a VATSIM report 11.5 s late, added on its own before a vNAS hub disconnect after liftoff, never moves display time back (TC3D-396)', () => {
  expectNoStepBackAfterLiftoff(lateVatsimSingle, NORMAL_REST_FT, NORMAL_LIFTOFF_S * 1000)
})

it('a departure VATSIM saw first stays drawn and in contact when its first vNAS sample arrives (TC3D-396)', () => {
  const beforeLiftoff = vatsimSeenFirst.filter((f) => f.ms < NORMAL_LIFTOFF_S * 1000)
  expect(beforeLiftoff.length, 'frames before the displayed liftoff').toBeGreaterThan(60)
  const absent = beforeLiftoff.filter((f) => f.drawn !== true)
  expect(absent.length, 'frames before the displayed liftoff the loop does not draw').toBe(0)
  const outOfContactOnGround = beforeLiftoff.filter((f) => f.inContact !== true)
  expect(outOfContactOnGround.length, 'frames before the displayed liftoff out of contact').toBe(0)
})

it('a parked aircraft with no resting height keeps contact across the snap of its display delay', () => {
  const moves = delaySnap.slice(1).map((f, i) => f.ms - delaySnap[i].ms)
  expect(Math.max(...moves), 'largest forward move of display time (ms)').toBeGreaterThan(SNAP_MIN_MOVE_MS)
  const snapAt = moves.findIndex((move) => move > SNAP_MIN_MOVE_MS)
  const beforeSnap = delaySnap.slice(0, snapAt + 1).filter((f) => f.ft !== null)
  expect(beforeSnap.length, 'frames with a height before the snap').toBeGreaterThan(30)
  expect(beforeSnap.filter((f) => f.restFt === null).length, 'frames before the snap without lane B').toBe(0)
  const withHeight = delaySnap.filter((f) => f.ft !== null)
  expect(withHeight.length, 'frames with a height').toBeGreaterThan(120)
  expect(outOfContact(withHeight).length, 'frames with a height out of contact').toBe(0)
})

it('GHOST41 is drawn every frame at its last vNAS position (within 1 m, at its height, out of contact) until display time reaches the first report observed after it, then moves toward that report with no frame-to-frame jump over one frame of speed (TC3D-396)', () => {
  const samples = lateVatsimTakeoff('GHOST3', true).samples
  const point = samples.filter((s) => s.t * 1000 < VNAS_DISCONNECT_MS).pop() as Sample
  const pointMs = point.t * 1000
  const reportMs = [0, 1, 2]
    .map((i) => LATE_VATSIM_RECEIVED_MS + i * VATSIM_PERIOD_MS - LATE_VATSIM_LAG_MS)
    .find((ms) => ms > pointMs) as number

  const fromDrop = ghostHeld.filter((f) => f.ms >= pointMs - 1000)
  expect(fromDrop.filter((f) => f.drawn !== true).length, 'frames from the drop the loop does not draw').toBe(0)

  const held = ghostHeld.filter((f) => f.ms === pointMs)
  expect(held.length, 'frames held at the last vNAS position').toBeGreaterThan(60)
  const offPoint = held.filter((f) => Math.abs((f.eastM ?? Number.NaN) - point.eastM) > HELD_TOLERANCE_M)
  expect(offPoint.length, 'held frames off the last vNAS position').toBe(0)
  const offHeight = held.filter((f) => f.ft === null || Math.abs(f.ft - point.ft) > HELD_TOLERANCE_FT)
  expect(offHeight.length, 'held frames off its height').toBe(0)
  expect(held.filter((f) => f.inContact !== false).length, 'held frames in contact').toBe(0)

  const toReport = ghostHeld.filter((f) => f.ms >= pointMs && f.ms <= reportMs)
  expect(toReport.length - held.length, 'frames moving toward the report').toBeGreaterThan(10)
  const frameOfSpeedM = (point.gs / KT_PER_MPS) * (FRAME_MS / 1000)
  const steps = toReport.slice(1).map((f, i) => Math.abs((f.eastM ?? Number.NaN) - (toReport[i].eastM ?? Number.NaN)))
  const worst = Math.max(...steps)
  expect(worst, `largest frame-to-frame step (one frame of speed ${frameOfSpeedM.toFixed(2)} m)`).toBeLessThanOrEqual(
    frameOfSpeedM,
  )
})
