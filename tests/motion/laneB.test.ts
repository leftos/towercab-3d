// @vitest-environment node
/**
 * Lane B: ground contact while an aircraft has no resting height of its own or of its type (TC3D-369). Contact is
 * entered at or below 16 ft, after a descent, on the shortest run of height samples ending at the bracket's `after`
 * sample that holds 3 samples spanning 2.5 s and moves no more than 3 ft; the run's second-lowest height becomes a
 * provisional resting height, and from there contact is the learned path's: left more than 5 ft over it, re-entered
 * under 3 ft over it. Each case drives `updateContact` at 60 Hz drawn frames over vNAS samples, with the run the
 * timeline store builds from the samples buffered at that frame. Heights are in feet, times in milliseconds. The last
 * cases draw an aircraft through the interpolation loop and check what is taken off its drawn height, the provisional
 * resting height faded from 25 to 100 ft, across every event that changes it.
 */
import { expect, it, vi } from 'vitest'
import {
  DROP_CONTACT_SEEK_MS,
  RESTING_HEIGHT_EASE_MS,
  RESTING_HEIGHT_MIN_SAMPLES,
  RESTING_HEIGHT_SAMPLE_WINDOW,
  VNAS_PREFERENCE_THRESHOLD_MS,
} from '@/constants'
import type { AircraftObservation, SettleRun } from '@/types/aircraft-timeline'

vi.mock('react', () => {
  const api = {
    useEffect: (fn: () => unknown) => {
      fn()
    },
    useState: <T>(v: T) => [v, () => {}],
  }
  return { ...api, default: api }
})

// The store graph loads as the harness loads it: vNAS store first, which registers with the timeline store
await import('@/stores/vnasStore')
const { settleRunEndingAt, useAircraftTimelineStore } = await import('@/stores/aircraftTimelineStore')
const { updateContact, useAircraftInterpolation } = await import('@/hooks/useAircraftInterpolation')
const { useReplayStore } = await import('@/stores/replayStore')
const { useVatsimStore } = await import('@/stores/vatsimStore')
const { recordRestingSample } = await import('@/utils/aircraft/restingHeight')

/** What `updateContact` reads of a frame, with no bracket step, as these cases drive it. */
const frameOf = (heightAboveGround: number, aircraftType: string, displayTime: number, settleRun: SettleRun | undefined) => ({
  heightAboveGround,
  aircraftType,
  displayTime,
  settleRun,
  bracketStartStopped: false,
  displayAnchorOffsetMs: 0,
})

// The interpolation loop re-arms itself through requestAnimationFrame; each drawn frame runs the armed callback once
let rafCallback: ((t: number) => void) | null = null
;(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: (t: number) => void) => {
  rafCallback = cb
  return 1
}
;(globalThis as Record<string, unknown>).cancelAnimationFrame = () => {}

const FT = 0.3048
// No test in this file teaches this type, so its resting height is never learned and lane B decides
const UNLEARNED_TYPE = 'C5M'
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0)
// The drawn frames' clock reads whole milliseconds, so frames are 16 or 17 ms apart
const FRAME_MS = Math.ceil(1000 / 60)
// An arrival whose type has no resting height enters contact within this long of its drawn touchdown (TC3D-246)
const TOUCHDOWN_LAG_MAX_MS = 2500
// A settled aircraft first seen enters contact once its samples span the run: at +2.0 s at 1 Hz
const FIRST_SIGHT_ENTRY_MS = 2000

interface Rec {
  time: number
  ft: number
  inContact: boolean | null
  /** The extra frame drawn `backStep.byMs` earlier than the frame before it */
  backStep?: true
}

/** One frame drawn `byMs` back in time, inserted before the first frame at or after `atMs` */
interface BackStep {
  atMs: number
  byMs: number
}

/** A vNAS sample at `t` ms after T0 reporting `ft` above ground. */
function sample(t: number, ft: number): AircraftObservation {
  const observedAt = T0 + t
  return {
    latitude: 37.72,
    longitude: -122.22,
    altitude: 10,
    heading: 90,
    groundspeed: 140,
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
    heightAboveGround: ft * FT,
  }
}

/**
 * Drive lane B at 60 Hz drawn frames over samples `spacingMs` apart, from the first sample's instant to the last. Each
 * frame is bracketed as the store brackets it (the first pair holding the instant), its height lerped between the two
 * samples, with the bracket's `after` sample buffered and nothing beyond it. With `backStep`, one frame is drawn back
 * in time first, as a shift of the store's anchor draws it.
 */
function replay(callsign: string, samplesFt: number[], spacingMs = 1000, backStep?: BackStep): Rec[] {
  const samples = samplesFt.map((ft, i) => sample(i * spacingMs, ft))
  const last = (samplesFt.length - 1) * spacingMs
  const frameAt = (time: number): Rec => {
    const k = Math.max(0, Math.ceil(time / spacingMs) - 1)
    const ft = samplesFt[k] + ((samplesFt[k + 1] - samplesFt[k]) * (time - k * spacingMs)) / spacingMs
    const run = settleRunEndingAt(samples.slice(0, k + 2), samples[k + 1])
    return { time, ft, inContact: updateContact(callsign, frameOf(ft * FT, UNLEARNED_TYPE, T0 + time, run)) }
  }
  const recs: Rec[] = []
  let stepped = false
  for (let i = 0; ; i++) {
    const time = Math.round((i * 1000) / 60)
    if (time > last) break
    if (backStep !== undefined && !stepped && time >= backStep.atMs) {
      stepped = true
      recs.push({ ...frameAt(recs[recs.length - 1].time - backStep.byMs), backStep: true })
    }
    recs.push(frameAt(time))
  }
  return recs
}

/** Drawn time (ms) of the first frame in contact at or after `fromMs`, NaN if none. */
function firstContactMs(recs: Rec[], fromMs = 0): number {
  return recs.find((r) => r.time >= fromMs && r.inContact === true)?.time ?? Number.NaN
}

/** Drawn time (ms) of the first frame out of contact at or after `fromMs`, NaN if none. */
function firstOutMs(recs: Rec[], fromMs: number): number {
  return recs.find((r) => r.time >= fromMs && r.inContact === false)?.time ?? Number.NaN
}

const inContactFrames = (recs: Rec[]) => recs.filter((r) => r.inContact === true).length
const inContactBefore = (recs: Rec[], ms: number) => recs.filter((r) => r.time < ms && r.inContact === true).length
const outOfContactFrom = (recs: Rec[], ms: number) => recs.filter((r) => r.time >= ms && r.inContact !== true).length

/** Small deterministic rest jitter (ft) by sample index, as the design probe's. */
const JITTER_PATTERN = [0, 0.2, -0.1, 0.3, -0.2, 0.1, -0.3, 0.15, -0.05, 0.25, -0.15, 0.05]
const restAt = (restFt: number, count: number, scale: number) =>
  Array.from({ length: count }, (_, i) => restFt + JITTER_PATTERN[i % JITTER_PATTERN.length] * scale)

/** Heights 1 s apart climbing from `fromFt` at `ftPerS` up to `untilFt`. */
function climb(fromFt: number, ftPerS: number, untilFt: number): number[] {
  const out: number[] = []
  for (let h = fromFt + ftPerS; h <= untilFt; h += ftPerS) out.push(h)
  return out
}

// Live vNAS samples, 1 s apart, of arrivals whose type had no resting height (tc3d246 live rounds 2 and 3). Constructed
// parts: N3368K's tail after 4.2 ft and UAL1320's -0.31/-0.34 tail are expanded from reported ranges; UAL1320's low
// pass climb after the 12.9 ft dip (16.0 ft on) is invented ("then climbed away"); the samples put before UAL1320's
// 16.1 ft (17.6 and 18 ft below) are invented, since the live report does not have them
const SWA4785_FT = [16.3, 13.8, 9.46, 9.29, 8.52, 8.26, 8.2, 8.3, 8.2, 8.3, 8.2]
const FDX772_FT = [24.3, 19.8, 15.77, 15.43, 14.43, 13.68, 13.6, 13.7, 13.6, 13.7, 13.6]
const NORMAL_TOUCHDOWN_MS = 2000
const N3368K_FT = [12.0, 10.6, 9.07, 6.13, 7.24, 7.45, 6.71, 5.66, 4.2, 4.1, 4.4, 4.2, 4.3, 4.1, 4.4]
const N3368K_TOUCHDOWN_MS = 3000
const UAL1320_FLARE_FT = [16.1, 15.3, 14.6, 12.1, 10.2, 8.3, 6.1, 3.4, 1.2, 0.6, -0.31, -0.34, -0.31, -0.34, -0.31]
// The 1.2 ft sample, 8 s into the flare; one sample later with a sample before 16.1 ft
const UAL1320_TOUCHDOWN_MS = 8000
const UAL1320_LOW_PASS_FT = [18.9, 20.0, 21.7, 20.7, 21.5, 23.8, 17.9, 12.9, 16.0, 21.0, 28.0, 36.0]

// Constructed: the design probe's LP5, 7 ft/s down to 6 ft, 1 ft/s to 5 ft, then a 2.5 ft/s climb-out
const LP5_FT = [20, 13, 6, 5, 7.5, 10, 12.5, 15, 17.5, 20, 22.5, 25, 27.5, 30]
// Constructed: a steady 1.8 ft/s sink from 16 ft down to 1.6 ft
const SINK_FT = Array.from({ length: 9 }, (_, k) => 16 - 1.8 * k)
// Constructed: N3368K's settled 4.1-4.4 ft, a bounce to 8 ft and back in 2 s, then settled again
const BOUNCE1_FT = [4.2, 4.1, 4.4, 4.2, 4.3, 8.0, 4.3, 4.2, 4.1, 4.4, 4.2, 4.3]
const BOUNCE1_RISE_MS = 4000
// Constructed: a climb at 6 ft/s from 5 ft, then 3.5 s level at 11 ft, samples 0.5 s apart
const CLIMB1_FT = [5, 8, 11, 11, 11, 11, 11, 11, 11, 11]

const G_FTS2 = 32.174
/**
 * Constructed (aviation r2 S6b): a go-around reversal at `g` bottoming at 8 ft with no touchdown, h = 8 + a t^2 / 2,
 * sampled at 1 Hz with a sample on the bottom (`centred`) or the bottom midway between two samples, up to 30 ft.
 */
function goAroundBottomFt(g: number, phase: 'centred' | 'midway'): number[] {
  const half = (g * G_FTS2) / 2
  const reach = Math.ceil(Math.sqrt((30 - 8) / half))
  const shift = phase === 'midway' ? 0.5 : 0
  const out: number[] = []
  for (let k = -reach; k <= reach; k++) out.push(Math.round((8 + half * (k - shift) ** 2) * 1000) / 1000)
  return out
}

// Constructed (design probe): a 9 ft rest with +-0.09 ft jitter, a +2.9 ft rotation over 3 s, then a steady climb
const ROTATION_FT = [9.97, 10.93, 11.9]
const ROLL_FT = restAt(9.0, 10, 0.3)
const liftoffFt = (ftPerS: number) => [
  ...ROLL_FT,
  ...ROTATION_FT,
  ...climb(ROTATION_FT[2], ftPerS, ROTATION_FT[2] + Math.max(20, ftPerS * 6)),
]
// The end of the rotation, at 11.9 ft
const LIFTOFF_MS = (ROLL_FT.length + ROTATION_FT.length - 1) * 1000

// Constructed (aviation r2 S16): a 9 ft rollout with one sample at 6.5 ft, R - 2.5, then a rotation and a 5 ft/s
// climb. A resting height taken from that lowest sample would leave contact over 11.5 ft, inside the rotation
const S16_FT = [25, 18, 13, 10.5, 9.6, 9.2, 9.0, 9.1, 6.5, 9.0, 9.1, 9.0, 9.0, 9.1, 9.0, 9.0, ...ROTATION_FT]
const S16_LIFTOFF_MS = (S16_FT.length - 1) * 1000
// Constructed: S16 with its 6.5 ft sample moved into the run contact is entered on, as that run's lowest (9.2, 6.5,
// 9.0 and 9.1 ft). A resting height taken from that lowest sample would leave contact over 11.5 ft, inside the rotation
const S16_ENTRY_FT = [25, 18, 13, 10.5, 9.6, 9.2, 6.5, 9.0, 9.1, 9.0, 9.0, 9.1, 9.0, 9.0, ...ROTATION_FT]
const S16_ENTRY_LIFTOFF_MS = (S16_ENTRY_FT.length - 1) * 1000
// The run ending at the 9.1 ft sample is the first that settles, so contact is entered on the frame past 7 s
const S16_ENTRY_MS = 7000 + FRAME_MS

// Constructed: settled at 4 ft, a 20 ft/s climb to 124 ft, past the 100 ft the provisional resting height is dropped
// above, then a 20 ft/s descent back to 4 ft, settled there again
const CLIMB_AND_BACK_FT = [4, 4.1, 4, 4.1, 4, 24, 44, 64, 84, 104, 124, 104, 84, 64, 44, 24, 4, 4.1, 4, 4.1, 4, 4.1]
// The first 4 ft sample after the descent
const BACK_AT_REST_MS = 16000

// Constructed: N3368K's arrival, then a bounce to 10 ft, 5.8 ft over its settled 4.2 ft but 2.8 ft over the 7.24 ft
// it entered on, and settled again
const N3368K_BOUNCE_FT = [...N3368K_FT, 10.0, 4.3, 4.2, 4.1, 4.4]
const N3368K_BOUNCE_MS = N3368K_FT.length * 1000

// Constructed: FDX772's flare, then 30 s settled at 13.6-13.7 ft, drawn live to the end and replayed from 19.8 ft
const REPLAYED_ARRIVAL_FT = [...FDX772_FT, ...Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 13.7 : 13.6))]
const REPLAY_FROM_MS = 1000
const REPLAY_TO_MS = 6000

// Constructed: a steady fall 1 s apart, so the run ending at each sample has its own lowest, second-lowest and highest
const STORE_RUN_FT = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0.5]

const METADATA = { cid: 0, aircraftType: UNLEARNED_TYPE, transponder: '', departure: null, arrival: null }

/** Run one frame of the interpolation loop. */
function runLoopFrame(): void {
  const cb = rafCallback
  rafCallback = null
  if (!cb) throw new Error('interpolation loop did not re-arm requestAnimationFrame')
  cb(0)
}

/** A snapshot bounding buffer replay at a source-clock instant. */
const replaySnapshot = (timestamp: number) => ({
  timestamp,
  vatsimTimestamp: timestamp,
  aircraftStates: [],
  lastUpdateInterval: 15000,
})

/** One frame of the interpolation loop; the aircraft's drawn record, or undefined while the loop does not draw it. */
function drawFrame(map: ReturnType<typeof useAircraftInterpolation>, callsign: string): Rec | undefined {
  runLoopFrame()
  const entry = map.get(callsign)
  if (entry === undefined) return undefined
  return { time: entry.displayTime - T0, ft: (entry.heightAboveGround ?? Number.NaN) / FT, inContact: entry.inContact }
}

/**
 * Feed the arrival's samples to the timeline store as they are received and draw it live at 60 Hz until its samples
 * end, then enter buffer replay and draw it from REPLAY_FROM_MS to REPLAY_TO_MS of its drawn time.
 */
function liveThenReplay(callsign: string): { live: Rec | undefined; recs: Rec[] } {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    useVatsimStore.setState({ referencePosition: { latitude: 37.72, longitude: -122.22 } })
    // biome-ignore lint/correctness/useHookAtTopLevel: this is the interpolation singleton, driven outside React
    const map = useAircraftInterpolation()
    const samples = REPLAYED_ARRIVAL_FT.map((ft, i) => sample(i * 1000, ft))
    const liveEnd = samples.length * 1000
    let fed = 0
    let live: Rec | undefined
    for (let i = 0; Math.round((i * 1000) / 60) <= liveEnd; i++) {
      const now = T0 + Math.round((i * 1000) / 60)
      vi.setSystemTime(now)
      while (fed < samples.length && samples[fed].receivedAt <= now) {
        useAircraftTimelineStore.getState().addObservation(callsign, samples[fed++], METADATA)
      }
      live = drawFrame(map, callsign)
    }
    // Drawn time trails the source's clock by a fixed offset while the samples and the display delay stand
    const offsetMs = (live?.time ?? Number.NaN) - liveEnd
    const start = T0 + REPLAY_FROM_MS - offsetMs
    const end = T0 + REPLAY_TO_MS - offsetMs
    useReplayStore.setState({
      playbackMode: 'replay',
      snapshots: [replaySnapshot(start), replaySnapshot(end)],
      currentIndex: 0,
    })
    const recs: Rec[] = []
    for (let i = 0; Math.round((i * 1000) / 60) <= end - start; i++) {
      useReplayStore.setState({ segmentProgress: Math.round((i * 1000) / 60) / (end - start) })
      const rec = drawFrame(map, callsign)
      if (rec !== undefined) recs.push(rec)
    }
    useReplayStore.setState({ playbackMode: 'live', snapshots: [], currentIndex: 0, segmentProgress: 0 })
    return { live, recs }
  } finally {
    vi.useRealTimers()
  }
}

/**
 * Add STORE_RUN_FT's samples to the timeline store and read the run its interpolation hands lane B at drawn instants
 * (ms after T0).
 */
function storeRunsAt(callsign: string, drawnMs: number[]) {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(T0 + STORE_RUN_FT.length * 1000)
    for (const [i, ft] of STORE_RUN_FT.entries()) {
      useAircraftTimelineStore.getState().addObservation(callsign, sample(i * 1000, ft), METADATA)
    }
    const probeNow = T0 + STORE_RUN_FT.length * 1000
    const probe = useAircraftTimelineStore.getState().getInterpolatedState(callsign, probeNow)
    const offsetMs = (probe?.displayTime ?? Number.NaN) - probeNow
    return drawnMs.map((ms) => {
      const state = useAircraftTimelineStore.getState().getInterpolatedState(callsign, T0 + ms - offsetMs)
      return { displayMs: (state?.displayTime ?? Number.NaN) - T0, settleRun: state?.settleRun }
    })
  } finally {
    vi.useRealTimers()
  }
}

/** A run's heights given in feet, as the store holds them in metres. */
const runOf = (lowestFt: number, secondLowestFt: number, highestFt: number) => ({
  lowest: lowestFt * FT,
  secondLowest: secondLowestFt * FT,
  highest: highestFt * FT,
})

// Constructed: an unlearned heavy's roll at 13.6 ft, its provisional resting height, then a 10 ft/s climb through the
// 25-100 ft fade and on to 193.6 ft
const CLIMB_OUT_FT_PER_S = 10
const CLIMB_OUT_FT = [...Array.from({ length: 5 }, () => 13.6), ...climb(13.6, CLIMB_OUT_FT_PER_S, 200)]
const CLIMB_OUT_REST_M = 13.6 * FT
// The fade takes 13.6 ft x (the climb) / 75 ft more off a frame: what is taken off moves this much with the motion
const FADE_STEP_MAX_M = (CLIMB_OUT_REST_M * (CLIMB_OUT_FT_PER_S * FRAME_MS)) / 1000 / 75 + 1e-6
// Each event happens on the first frame drawn at or above this raw height, mid-fade
const MID_FADE_FT = 60
// Taught mid-fade, as another of the type parked at the field completes its resting height; nothing else here uses it
const TAUGHT_TYPE = 'B77L'
// Buffer replay draws from here, on the roll, before the provisional resting height is taken
const REPLAY_CLIMB_FROM_MS = 2500
// The replayed span: a power of two, so a drawn instant in whole milliseconds maps to the source clock exactly
const REPLAY_SPAN_MS = 2 ** 15
// A seek in drawn time, past the 2 s a step may move without being one
const SEEK_MS = DROP_CONTACT_SEEK_MS + 1000
// A change has eased in by this many frames after it: frames are at least 16 ms apart
const EASE_FRAMES = Math.ceil(RESTING_HEIGHT_EASE_MS / 16)
const OFFSET_ERR_MAX_M = 1e-6

/** A frame as the interpolation loop draws it. */
interface Drawn {
  /** Drawn time, ms after T0 */
  time: number
  /** Raw height above ground (ft), null when the source reports none */
  rawFt: number | null
  /** What is taken off the reported height (m): the shown altitude less the drawn one */
  offsetM: number
  inContact: boolean | null
}

/** The share of the provisional resting height lane B takes off at a frame's raw height (m): all to 25 ft, none from 100 ft. */
const fadedRest = (rec: Drawn) => CLIMB_OUT_REST_M * Math.min(1, Math.max(0, (100 - (rec.rawFt ?? Number.NaN)) / 75))

/** Largest change of what is taken off between consecutive frames (m). */
function largestOffsetStep(recs: Drawn[]): number {
  let largest = 0
  for (let i = 1; i < recs.length; i++) largest = Math.max(largest, Math.abs(recs[i].offsetM - recs[i - 1].offsetM))
  return largest
}

/** Largest distance over the frames of what is taken off from what `expectedM` gives (m). */
const largestOffsetOff = (recs: Drawn[], expectedM: (rec: Drawn) => number) =>
  recs.reduce((m, r) => Math.max(m, Math.abs(r.offsetM - expectedM(r))), 0)

/** A climb-out sample, 1000 m up, so that drawn without a height it is never blended toward the field. */
const climbOutSample = (t: number, ft: number): AircraftObservation => ({ ...sample(t, ft), altitude: 1000 + ft * FT })

/** One frame of the interpolation loop; the aircraft as drawn, or undefined while the loop does not draw it. */
function drawOffset(map: ReturnType<typeof useAircraftInterpolation>, callsign: string): Drawn | undefined {
  runLoopFrame()
  const entry = map.get(callsign)
  if (entry === undefined) return undefined
  const raw = entry.heightAboveGround
  return {
    time: entry.displayTime - T0,
    rawFt: raw === null ? null : raw / FT,
    offsetM: entry.reportedAltitude - entry.interpolatedAltitude,
    inContact: entry.inContact,
  }
}

/** Drawing CLIMB_OUT_FT: its samples not yet received, oldest first, and the live frames drawn so far. */
interface ClimbOut {
  map: ReturnType<typeof useAircraftInterpolation>
  callsign: string
  metadata: typeof METADATA
  pending: AircraftObservation[]
  frame: number
}

/** Start drawing an aircraft of `type` over `heightsFt` at 1 Hz, with nothing else in the timeline store. */
function startClimbOut(callsign: string, type: string, heightsFt: number[]): ClimbOut {
  useAircraftTimelineStore.getState().clear()
  useVatsimStore.setState({ referencePosition: { latitude: 37.72, longitude: -122.22 } })
  // biome-ignore lint/correctness/useHookAtTopLevel: this is the interpolation singleton, driven outside React
  const map = useAircraftInterpolation()
  const pending = heightsFt.map((ft, i) => climbOutSample(i * 1000, ft))
  return { map, callsign, metadata: { ...METADATA, aircraftType: type }, pending, frame: 0 }
}

/** Draw the next live frame, 1/60 s on, once the samples received by then are fed to the timeline store. */
function liveFrame(climbOut: ClimbOut): Drawn | undefined {
  const now = T0 + Math.round((climbOut.frame++ * 1000) / 60)
  vi.setSystemTime(now)
  while (climbOut.pending.length > 0 && climbOut.pending[0].receivedAt <= now) {
    const observation = climbOut.pending.shift() as AircraftObservation
    useAircraftTimelineStore.getState().addObservation(climbOut.callsign, observation, climbOut.metadata)
  }
  return drawOffset(climbOut.map, climbOut.callsign)
}

/** Draw live frames up to the first drawn at or above MID_FADE_FT raw, which comes last. */
function liveToMidFade(climbOut: ClimbOut): Drawn[] {
  const recs: Drawn[] = []
  while (climbOut.frame < CLIMB_OUT_FT.length * 60) {
    const rec = liveFrame(climbOut)
    if (rec === undefined) continue
    recs.push(rec)
    if ((rec.rawFt ?? 0) >= MID_FADE_FT) return recs
  }
  throw new Error(`${climbOut.callsign} was never drawn at ${MID_FADE_FT} ft`)
}

/** Teach a type a 13.6 ft resting height, as another of the type parked at the field completes it. */
function teachType(type: string): void {
  for (let i = 0; i < RESTING_HEIGHT_MIN_SAMPLES; i++) {
    recordRestingSample(`${type}PARKED`, type, CLIMB_OUT_REST_M, 0, 'vnas')
  }
}

/**
 * Draw an unlearned aircraft live over CLIMB_OUT_FT to its first frame mid-fade, then teach its type (`teach`) or stop
 * its vNAS feed (`loseFeed`), and draw it `tailMs` more. The frames, and the index of the first after the event.
 */
function climbOutLive(callsign: string, event: 'teach' | 'loseFeed', tailMs: number) {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const climbOut = startClimbOut(callsign, event === 'teach' ? TAUGHT_TYPE : UNLEARNED_TYPE, CLIMB_OUT_FT)
    const recs = liveToMidFade(climbOut)
    const eventIndex = recs.length
    if (event === 'teach') teachType(TAUGHT_TYPE)
    else climbOut.pending = []
    const end = climbOut.frame + Math.round((tailMs * 60) / 1000)
    while (climbOut.frame < end) {
      const rec = liveFrame(climbOut)
      if (rec !== undefined) recs.push(rec)
    }
    return { recs, eventIndex }
  } finally {
    vi.useRealTimers()
  }
}

// Constructed: an arrival of a type taught 13.6 ft that first settles at 15.2 ft, which lane B takes as its provisional
// resting height, then steps down onto the type's 13.6 ft, where two of its own samples confirm the type's
const CONFIRM_FT = [25, 20, 15.2, 15.2, 15.2, 15.2, 13.6, 13.6, 13.6, 13.6, 13.6]
const CONFIRM_PROVISIONAL_M = 15.2 * FT
// Taught 13.6 ft before the arrival is first drawn; nothing else here uses it
const CONFIRMED_TYPE = 'B763'
// Frames drawn past the last sample, so the display delay has passed it
const CONFIRM_TAIL_FRAMES = 3 * 60
// Drawn time of the last sample: the frames checked end there, before the drawing extrapolates past it
const CONFIRM_LAST_SAMPLE_MS = (CONFIRM_FT.length - 1) * 1000

// Taught 13.6 ft before its climb-out is first drawn, which two of its own roll samples confirm; moved mid-fade
const MOVED_TYPE = 'B764'
// The type's resting height once moved: 1.4 ft over the one confirmed
const MOVED_REST_FT = 15
// CLIMB_OUT_FT after two samples that settle on nothing, so lane B decides its first frames
const MOVED_FT = [20, 18, ...CLIMB_OUT_FT]
// 140 kt east along the 37.72 degree parallel, in degrees of longitude a second
const MOVED_LONGITUDE_DEG_PER_S = (140 * 1852) / 3600 / (111_320 * Math.cos((37.72 * Math.PI) / 180))

/**
 * Draw an aircraft of MOVED_TYPE, its type taught 13.6 ft first, live over MOVED_FT to its first frame mid-fade,
 * then move the type's resting height to MOVED_REST_FT, as a full window of others of the type parked there would, and
 * draw it 1 s more. The frames, and the index of the first after the move.
 */
function moveTypeLive(callsign: string) {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    teachType(MOVED_TYPE)
    const climbOut = startClimbOut(callsign, MOVED_TYPE, MOVED_FT)
    // Moving east at 140 kt, so no bracket starts stopped and no contact hold keeps it in contact once airborne
    climbOut.pending = climbOut.pending.map((o, i) => ({ ...o, longitude: o.longitude + i * MOVED_LONGITUDE_DEG_PER_S }))
    const recs = liveToMidFade(climbOut)
    const eventIndex = recs.length
    for (let i = 0; i < RESTING_HEIGHT_SAMPLE_WINDOW; i++) {
      recordRestingSample(`${MOVED_TYPE}MOVED`, MOVED_TYPE, MOVED_REST_FT * FT, 0, 'vnas')
    }
    const end = climbOut.frame + 60
    while (climbOut.frame < end) {
      const rec = liveFrame(climbOut)
      if (rec !== undefined) recs.push(rec)
    }
    return { recs, eventIndex }
  } finally {
    vi.useRealTimers()
  }
}

/** Draw an arrival of CONFIRMED_TYPE live over CONFIRM_FT, its type taught first, to past its last sample. */
function confirmLive(callsign: string): Drawn[] {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    teachType(CONFIRMED_TYPE)
    const arrival = startClimbOut(callsign, CONFIRMED_TYPE, CONFIRM_FT)
    const recs: Drawn[] = []
    while (arrival.frame < CONFIRM_FT.length * 60 + CONFIRM_TAIL_FRAMES) {
      const rec = liveFrame(arrival)
      if (rec !== undefined) recs.push(rec)
    }
    return recs
  } finally {
    vi.useRealTimers()
  }
}

/**
 * Draw an unlearned aircraft live over CLIMB_OUT_FT to its first frame mid-fade, then enter buffer replay at the
 * instant drawn and draw it 1 s on. The frames, and the index of the first replay frame.
 */
function climbOutIntoReplay(callsign: string) {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const climbOut = startClimbOut(callsign, UNLEARNED_TYPE, CLIMB_OUT_FT)
    const recs = liveToMidFade(climbOut)
    const eventIndex = recs.length
    const start = T0 + Math.round(((climbOut.frame - 1) * 1000) / 60)
    useReplayStore.setState({
      playbackMode: 'replay',
      snapshots: [replaySnapshot(start), replaySnapshot(start + 1000)],
      currentIndex: 0,
    })
    for (let i = 0; i <= 60; i++) {
      useReplayStore.setState({ segmentProgress: i / 60 })
      const rec = drawOffset(climbOut.map, callsign)
      if (rec !== undefined) recs.push(rec)
    }
    return { recs, eventIndex }
  } finally {
    useReplayStore.setState({ playbackMode: 'live', snapshots: [], currentIndex: 0, segmentProgress: 0 })
    vi.useRealTimers()
  }
}

/**
 * Buffer CLIMB_OUT_FT's samples as received by its end, then draw it in buffer replay at 60 Hz from
 * REPLAY_CLIMB_FROM_MS to its first frame mid-fade, then one frame `stepMs` of drawn time from that one, and 1 s on
 * from there. The frames, and the index of the one after the step.
 */
function climbOutReplayed(callsign: string, stepMs: number) {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const climbOut = startClimbOut(callsign, UNLEARNED_TYPE, CLIMB_OUT_FT)
    const endMs = CLIMB_OUT_FT.length * 1000
    vi.setSystemTime(T0 + endMs)
    for (const observation of climbOut.pending) {
      useAircraftTimelineStore.getState().addObservation(callsign, observation, climbOut.metadata)
    }
    // Drawn time trails the source's clock by a fixed lag; the source's clock at drawn instant T0 starts the replay
    const probe = useAircraftTimelineStore.getState().getInterpolatedState(callsign, T0 + endMs)
    const start = T0 + (T0 + endMs - (probe?.displayTime ?? Number.NaN))
    useReplayStore.setState({
      playbackMode: 'replay',
      snapshots: [replaySnapshot(start), replaySnapshot(start + REPLAY_SPAN_MS)],
      currentIndex: 0,
    })
    const drawAt = (drawnMs: number) => {
      useReplayStore.setState({ segmentProgress: drawnMs / REPLAY_SPAN_MS })
      return drawOffset(climbOut.map, callsign)
    }
    const recs: Drawn[] = []
    let drawnMs = REPLAY_CLIMB_FROM_MS
    for (let i = 0; recs.length === 0 || (recs[recs.length - 1].rawFt ?? 0) < MID_FADE_FT; i++) {
      if (i > CLIMB_OUT_FT.length * 60) throw new Error(`${callsign} was never replayed at ${MID_FADE_FT} ft`)
      drawnMs = REPLAY_CLIMB_FROM_MS + Math.round((i * 1000) / 60)
      const rec = drawAt(drawnMs)
      if (rec !== undefined) recs.push(rec)
    }
    const stepIndex = recs.length
    for (let i = 0; i <= 60; i++) {
      const rec = drawAt(drawnMs + stepMs + Math.round((i * 1000) / 60))
      if (rec !== undefined) recs.push(rec)
    }
    return { recs, stepIndex }
  } finally {
    useReplayStore.setState({ playbackMode: 'live', snapshots: [], currentIndex: 0, segmentProgress: 0 })
    vi.useRealTimers()
  }
}

// The scenarios run at the top level, where collection has no timeout (tests/setup/hookBudget.ts).
const swa = replay('SWA4785', SWA4785_FT)
const fdx = replay('FDX772', FDX772_FT)
const n3368k = replay('N3368K', N3368K_FT)
const ualFlare = {
  none: replay('UAL1320A', UAL1320_FLARE_FT),
  18: replay('UAL1320B', [18, ...UAL1320_FLARE_FT]),
  17.6: replay('UAL1320C', [17.6, ...UAL1320_FLARE_FT]),
}
const ualLowPass = replay('UAL1320LP', UAL1320_LOW_PASS_FT)
const lp5 = replay('LP5', LP5_FT)
const goAround = {
  centred: replay('GA15C', goAroundBottomFt(0.15, 'centred')),
  midway: replay('GA15M', goAroundBottomFt(0.15, 'midway')),
}
const sink = replay('SINK18', SINK_FT)
const bounce = replay('BOUNCE1', BOUNCE1_FT)
// Back steps in drawn time on the bounce's rise, while in contact at 3.8 ft over the provisional resting height
const bounceBack = {
  small: replay('BOUNCE1B20', BOUNCE1_FT, 1000, { atMs: 5000, byMs: 20 }),
  seek: replay('BOUNCE1B3S', BOUNCE1_FT, 1000, { atMs: 5000, byMs: 3000 }),
}
const climb1 = replay('CLIMB1', CLIMB1_FT, 500)
const s16 = replay('S16', [...S16_FT, ...climb(ROTATION_FT[2], 5, 40)])
const s16Entry = replay('S16E', [...S16_ENTRY_FT, ...climb(ROTATION_FT[2], 5, 40)])
const climbAndBack = replay('CLIMBBACK', CLIMB_AND_BACK_FT)
const liftoff = { 2: replay('LIFT2', liftoffFt(2)), 1: replay('LIFT1', liftoffFt(1)) }
const firstSight = { FIRST4: replay('FIRST4', Array(8).fill(4.07)), FIRST13: replay('FIRST13', Array(8).fill(13.6)) }
const n3368kBounce = replay('N3368KB', N3368K_BOUNCE_FT)
// The interpolation loop's scenario runs after the direct ones: entering replay clears every aircraft's contact memory
const replayed = liveThenReplay('REPLAY1')
// Mid-bracket between the 4 ft and 3 ft samples, and extrapolating past the last
const [storeMidBracket, storeExtrapolating] = storeRunsAt('STORERUN', [5500, 9500])
// The drawn offset's scenarios, each alone in the timeline store
const taught = climbOutLive('TAUGHT1', 'teach', 1000)
const confirmed = confirmLive('CONFIRM1')
const typeMoved = moveTypeLive('MOVED1')
const feedLost = climbOutLive('FEEDLOST1', 'loseFeed', VNAS_PREFERENCE_THRESHOLD_MS + 1000)
const intoReplay = climbOutIntoReplay('INTOREPLAY1')
const seeks = { forward: climbOutReplayed('SEEKFWD', SEEK_MS), back: climbOutReplayed('SEEKBACK', -SEEK_MS) }
const backStep = climbOutReplayed('BACK2S', -DROP_CONTACT_SEEK_MS)

it.each([
  ['SWA4785', swa],
  ['FDX772', fdx],
])('a normal flare enters contact after the drawn touchdown, within 2.5 s, and stays in (%s)', (_name, recs) => {
  expect(inContactBefore(recs, NORMAL_TOUCHDOWN_MS), 'frames in contact before touchdown').toBe(0)
  const entry = firstContactMs(recs)
  expect(entry - NORMAL_TOUCHDOWN_MS, 'entry after the drawn touchdown (ms)').toBeLessThanOrEqual(TOUCHDOWN_LAG_MAX_MS)
  expect(outOfContactFrom(recs, entry), 'frames out of contact after entry').toBe(0)
})

it('a slowly sinking arrival after a 1.3 ft rise enters within 2.5 s of the drawn 6.13 ft sample and stays in (N3368K)', () => {
  expect(inContactBefore(n3368k, N3368K_TOUCHDOWN_MS), 'frames in contact before touchdown').toBe(0)
  const entry = firstContactMs(n3368k)
  expect(entry - N3368K_TOUCHDOWN_MS, 'entry after the drawn touchdown (ms)').toBeLessThanOrEqual(TOUCHDOWN_LAG_MAX_MS)
  expect(outOfContactFrom(n3368k, entry), 'frames out of contact after entry').toBe(0)
})

it.each([
  ['none', ualFlare.none, UAL1320_TOUCHDOWN_MS],
  ['18', ualFlare[18], UAL1320_TOUCHDOWN_MS + 1000],
])('a shallow flare with the sample before 16.1 ft at %s ft enters after its touchdown, within 2.5 s (UAL1320)', (_x, recs, touchdownMs) => {
  expect(inContactBefore(recs, touchdownMs), 'frames in contact before touchdown').toBe(0)
  const entry = firstContactMs(recs)
  expect(entry - touchdownMs, 'entry after the drawn touchdown (ms)').toBeLessThanOrEqual(TOUCHDOWN_LAG_MAX_MS)
  expect(outOfContactFrom(recs, entry), 'frames out of contact after entry').toBe(0)
})

it('a flare whose run from 17.6 ft to 14.6 ft moves exactly 3 ft enters on the drawn 15.3 ft sample (UAL1320)', () => {
  // The boundary of "at most 3 ft": the flare entry is accepted
  const recs = ualFlare[17.6]
  const entry = recs.find((r) => r.inContact === true)
  expect(entry?.time, 'the first frame past the 15.3 ft sample, 2 s in').toBe(2000 + FRAME_MS)
  expect(entry?.ft, 'drawn height at entry (ft)').toBeCloseTo(15.3, 1)
  expect(outOfContactFrom(recs, entry?.time ?? Number.NaN), 'frames out of contact after entry').toBe(0)
})

it.each([
  ['a low pass dipping to 12.9 ft (UAL1320)', ualLowPass],
  ['a low pass bottoming at 5 ft and climbing away at 2.5 ft/s (LP5)', lp5],
  ['a 0.15 g go-around with a sample on its 8 ft bottom', goAround.centred],
  ['a 0.15 g go-around with its 8 ft bottom between two samples', goAround.midway],
  ['a steady 1.8 ft/s sink from 16 ft to 1.6 ft', sink],
  ['a 6 ft/s climb, then 3.5 s level at 11 ft', climb1],
])('%s never enters contact', (_name, recs) => {
  expect(recs.length, 'frames').toBeGreaterThan(60)
  expect(inContactFrames(recs), 'frames in contact').toBe(0)
})

it('a 20 ms step back in drawn time on the bounce keeps contact (BOUNCE1)', () => {
  const recs = bounceBack.small
  expect(recs.find((r) => r.backStep)?.inContact, 'the frame drawn 20 ms back').toBe(true)
  expect(outOfContactFrom(recs, firstContactMs(recs)), 'frames out of contact after entry').toBe(0)
})

it('a 3 s step back in drawn time on the bounce restarts lane B as at first sight (BOUNCE1)', () => {
  // Drawn 3 s back, the samples buffered then span no run, so there is nothing to enter on
  expect(bounceBack.seek.find((r) => r.backStep)?.inContact, 'the frame drawn 3 s back').toBe(false)
})

it('a bounce to 8 ft, 3.8 ft over the provisional resting height, stays in contact through it (BOUNCE1)', () => {
  expect(firstContactMs(bounce), 'entry (ms)').toBeLessThanOrEqual(FIRST_SIGHT_ENTRY_MS + FRAME_MS)
  expect(bounce.find((r) => r.time === BOUNCE1_RISE_MS)?.inContact, 'in contact before the bounce').toBe(true)
  expect(outOfContactFrom(bounce, firstContactMs(bounce)), 'frames out of contact after entry').toBe(0)
})

it('one rollout sample 2.5 ft under the rest does not pull the provisional resting height down: out no earlier than liftoff (S16)', () => {
  const entry = firstContactMs(s16)
  expect(entry, 'entry before liftoff (ms)').toBeLessThan(S16_LIFTOFF_MS)
  expect(firstOutMs(s16, entry), 'first frame out of contact (ms)').toBeGreaterThanOrEqual(S16_LIFTOFF_MS)
})

it('an entry run whose lowest sample is 2.5 ft under the rest takes its second-lowest: out no earlier than liftoff (S16 at entry)', () => {
  const entry = firstContactMs(s16Entry)
  expect(entry, 'entry on the run holding the 6.5 ft sample (ms)').toBe(S16_ENTRY_MS)
  expect(firstOutMs(s16Entry, entry), 'first frame out of contact (ms)').toBeGreaterThanOrEqual(S16_ENTRY_LIFTOFF_MS)
})

it('a climb past 100 ft drops the provisional resting height: back at rest, contact waits for a settled run as at first sight', () => {
  const entry = firstContactMs(climbAndBack)
  const out = firstOutMs(climbAndBack, entry)
  expect(out, 'out on the climb (ms)').toBeLessThan(BACK_AT_REST_MS)
  // Under 3 ft over the 4 ft entered on, the descent would re-enter before its 4 ft sample, on no run
  const reentry = firstContactMs(climbAndBack, out) - BACK_AT_REST_MS
  expect(reentry, 're-entry after the 4 ft sample (ms)').toBeGreaterThanOrEqual(FIRST_SIGHT_ENTRY_MS)
  expect(reentry, 're-entry after the 4 ft sample (ms)').toBeLessThanOrEqual(FIRST_SIGHT_ENTRY_MS + FRAME_MS)
})

it.each([
  [2, 1100],
  [1, 2500],
])('a liftoff climbing at %s ft/s leaves contact within %s ms of liftoff', (ftPerS, boundMs) => {
  const recs = liftoff[ftPerS as 1 | 2]
  const entry = firstContactMs(recs)
  expect(entry, 'entry on the roll (ms)').toBeLessThan(LIFTOFF_MS)
  expect(firstOutMs(recs, entry), 'no exit before liftoff').toBeGreaterThanOrEqual(LIFTOFF_MS)
  expect(firstOutMs(recs, entry) - LIFTOFF_MS, 'exit after liftoff (ms)').toBeLessThanOrEqual(boundMs)
})

it.each(['FIRST4', 'FIRST13'] as const)('first sight flat on the ground enters within 2.0 s and stays in (%s)', (name) => {
  const recs = firstSight[name]
  const entry = firstContactMs(recs)
  expect(entry, 'entry (ms)').toBeLessThanOrEqual(FIRST_SIGHT_ENTRY_MS + FRAME_MS)
  expect(outOfContactFrom(recs, entry), 'frames out of contact after entry').toBe(0)
})

/** Run of three 4 ft samples 1.25 s apart ending at drawn time `t`, enough to enter on. */
function settledRunAt(t: number) {
  const samples = [sample(t - 2500, 4), sample(t - 1250, 4.1), sample(t, 4)]
  return settleRunEndingAt(samples, samples[2])
}

it.each([
  ['goes back more than 2 s', -5000],
  ['jumps forward more than 2 s', 2100],
])('drawn time that %s drops the provisional resting height and restarts as at first sight', (_name, jumpMs) => {
  const callsign = `SEEK${jumpMs}`
  const enterAt = T0 + 10_000
  expect(updateContact(callsign, frameOf(4 * FT, UNLEARNED_TYPE, enterAt, settledRunAt(10_000))), 'entered').toBe(true)
  expect(updateContact(callsign, frameOf(5 * FT, UNLEARNED_TYPE, enterAt + 1000, undefined)), '1 s later, 1 ft up').toBe(true)
  const seekAt = enterAt + 1000 + jumpMs
  // 1 ft over the dropped 4 ft would keep contact; at first sight there is no run to enter on
  expect(updateContact(callsign, frameOf(5 * FT, UNLEARNED_TYPE, seekAt, undefined)), 'the frame after the seek').toBe(false)
  expect(updateContact(callsign, frameOf(5 * FT, UNLEARNED_TYPE, seekAt + 16, undefined)), 'still no run').toBe(false)
  expect(
    updateContact(callsign, frameOf(4 * FT, UNLEARNED_TYPE, seekAt + 32, settledRunAt(seekAt - T0 + 32))),
    'a run to enter on',
  ).toBe(true)
})

it.each([
  ['forward', 2000],
  ['back', -2000],
])('drawn time stepping %s 2 s or less keeps the provisional resting height and contact', (_way, stepMs) => {
  const callsign = `NOSEEK${stepMs}`
  const enterAt = T0 + 10_000
  expect(updateContact(callsign, frameOf(4 * FT, UNLEARNED_TYPE, enterAt, settledRunAt(10_000))), 'entered').toBe(true)
  expect(updateContact(callsign, frameOf(5 * FT, UNLEARNED_TYPE, enterAt + stepMs, undefined)), 'after the step').toBe(true)
})

it('the provisional resting height follows the rest down in contact, so a later bounce to 10 ft leaves contact (N3368K)', () => {
  const entry = firstContactMs(n3368kBounce)
  expect(entry, 'entry before the bounce (ms)').toBeLessThan(N3368K_BOUNCE_MS - 1000)
  const out = firstOutMs(n3368kBounce, entry)
  expect(out, 'first frame out, on the rise to the 10 ft sample (ms)').toBeGreaterThan(N3368K_BOUNCE_MS - 1000)
  expect(out, 'first frame out, on the rise to the 10 ft sample (ms)').toBeLessThanOrEqual(N3368K_BOUNCE_MS)
})

it('an arrival replayed from 19.8 ft on final, after live drew it in contact, enters after its touchdown, within 2.5 s', () => {
  expect(replayed.live?.inContact, 'in contact on the last live frame').toBe(true)
  expect(replayed.recs[0]?.ft, 'drawn height on the first replay frame (ft)').toBeGreaterThan(19)
  expect(inContactBefore(replayed.recs, NORMAL_TOUCHDOWN_MS), 'replay frames in contact before touchdown').toBe(0)
  const entry = firstContactMs(replayed.recs)
  expect(entry - NORMAL_TOUCHDOWN_MS, 'entry after the drawn touchdown (ms)').toBeLessThanOrEqual(TOUCHDOWN_LAG_MAX_MS)
})

it("the store hands lane B the run ending at the bracket's after sample while interpolating, never reading past it", () => {
  expect(storeMidBracket.displayMs, 'drawn time (ms)').toBeCloseTo(5500, 0)
  // The run ending at the 3 ft sample: 6, 5, 4 and 3 ft
  expect(storeMidBracket.settleRun, 'run mid-bracket').toEqual(runOf(3, 4, 6))
})

it('the store hands lane B the run ending at the last sample while extrapolating past it', () => {
  expect(storeExtrapolating.displayMs, 'drawn time (ms)').toBeCloseTo(9500, 0)
  expect(storeExtrapolating.settleRun, 'run extrapolating').toEqual(runOf(0.5, 1, 3))
})

it('a run ends at the sample it is asked for and reads no sample after it', () => {
  const samples = [sample(0, 5), sample(1000, 6), sample(2000, 7), sample(3000, 8), sample(4000, 1), sample(5000, 2)]
  expect(settleRunEndingAt(samples, samples[3])).toEqual(runOf(5, 6, 8))
})

it('a sample without a height inside the run gives no run', () => {
  const samples = [sample(0, 4), { ...sample(1000, 4.1), heightAboveGround: undefined }, sample(2000, 4), sample(3000, 4.1)]
  expect(settleRunEndingAt(samples, samples[3])).toBeUndefined()
})

it('samples 2.5 s apart need three for a run: two span 2.5 s but are too few', () => {
  const samples = [sample(0, 4), sample(2500, 4.1), sample(5000, 4)]
  expect(settleRunEndingAt(samples.slice(1), samples[2]), 'two samples').toBeUndefined()
  expect(settleRunEndingAt(samples, samples[2]), 'three samples').toEqual(runOf(4, 4, 4.1))
})

it("a type resting height learned mid-fade, which the aircraft's own samples have not confirmed, leaves the faded provisional one taken off", () => {
  const { recs, eventIndex } = taught
  const before = recs[eventIndex - 1]
  expect(before.rawFt, 'raw height when the type is taught (ft)').toBeCloseTo(MID_FADE_FT, 0)
  const around = recs.slice(eventIndex - 1)
  expect(around.length, 'frames from the type taught on').toBeGreaterThan(30)
  const off = largestOffsetOff(around, fadedRest)
  expect(off, 'taken off from the type taught on, off the faded provisional resting height (m)').toBeLessThanOrEqual(
    OFFSET_ERR_MAX_M,
  )
})

it("a type resting height the aircraft's own samples confirm replaces the provisional one taken off over 0.25 s, never in one frame", () => {
  const from = confirmed.findIndex((r) => Math.abs(r.offsetM - CONFIRM_PROVISIONAL_M) <= OFFSET_ERR_MAX_M)
  expect(from, 'a frame taking off the 15.2 ft provisional resting height').toBeGreaterThanOrEqual(0)
  const after = confirmed.slice(from).filter((r) => r.time <= CONFIRM_LAST_SAMPLE_MS)
  // The 0.25 s ease moves what is taken off by at most its frame's share of the swap a frame
  const swapM = CONFIRM_PROVISIONAL_M - CLIMB_OUT_REST_M
  const step = largestOffsetStep(after)
  expect(step, `largest step ${step.toFixed(4)} m`).toBeLessThanOrEqual((swapM * FRAME_MS) / RESTING_HEIGHT_EASE_MS + 1e-6)
  const last = after[after.length - 1]
  expect(last.offsetM, "taken off at the end: the type's 13.6 ft, confirmed (m)").toBeCloseTo(CLIMB_OUT_REST_M, 6)
})

it("an airborne aircraft whose type's resting height moves over 1 ft from the confirmed one eases it out over 0.25 s, never in one frame", () => {
  const { recs, eventIndex } = typeMoved
  const before = recs[eventIndex - 1]
  expect(before.time, 'drawn time of the move, long after the roll confirmed the type (ms)').toBeGreaterThan(
    DROP_CONTACT_SEEK_MS + 1000,
  )
  expect(before.offsetM, "taken off before: the type's confirmed 13.6 ft (m)").toBeCloseTo(CLIMB_OUT_REST_M, 6)
  // Lane B takes over with no provisional resting height: the 0.25 s ease moves its frame's share of 13.6 ft a frame
  const step = largestOffsetStep(recs.slice(eventIndex - 1))
  expect(step, `largest step ${step.toFixed(4)} m`).toBeLessThanOrEqual(
    (CLIMB_OUT_REST_M * FRAME_MS) / RESTING_HEIGHT_EASE_MS + 1e-6,
  )
  const eased = recs.slice(eventIndex + EASE_FRAMES)
  expect(eased.length, 'frames once eased').toBeGreaterThan(30)
  expect(largestOffsetOff(eased, () => 0), 'taken off once eased (m)').toBeLessThanOrEqual(OFFSET_ERR_MAX_M)
})

it('a vNAS feed lost mid-fade, drawn without a height 30 s on, eases the faded provisional resting height out over 0.25 s', () => {
  const { recs } = feedLost
  const lost = recs.findIndex((r) => r.rawFt === null)
  expect(lost, 'a frame drawn without a height').toBeGreaterThan(0)
  const before = recs[lost - 1]
  expect(before.rawFt, 'raw height held before the loss (ft)').toBeGreaterThan(MID_FADE_FT)
  expect(before.rawFt, 'raw height held before the loss (ft)').toBeLessThan(100)
  expect(before.offsetM, 'taken off before: the provisional resting height, faded (m)').toBeCloseTo(fadedRest(before), 6)
  // On the first frame without a height nothing moves what is taken off; from there the ease takes it out
  const onto = Math.abs(recs[lost].offsetM - before.offsetM)
  expect(onto, `step onto the first frame without a height ${onto.toFixed(3)} m`).toBeLessThanOrEqual(FADE_STEP_MAX_M)
  const after = recs.slice(lost)
  const step = largestOffsetStep(after)
  expect(step, `largest step ${step.toFixed(3)} m`).toBeLessThanOrEqual(
    (recs[lost].offsetM * FRAME_MS) / RESTING_HEIGHT_EASE_MS + 1e-6,
  )
  const eased = after.slice(EASE_FRAMES)
  expect(eased.length, 'frames once eased').toBeGreaterThan(30)
  expect(largestOffsetOff(eased, () => 0), 'taken off once eased (m)').toBeLessThanOrEqual(OFFSET_ERR_MAX_M)
})

it.each([
  ['forward', SEEK_MS],
  ['back', -SEEK_MS],
] as const)('a seek %s more than 2 s mid-fade restarts lane B as at first sight: nothing is taken off from there', (way, stepMs) => {
  const { recs, stepIndex } = seeks[way]
  const before = recs[stepIndex - 1]
  const seek = recs[stepIndex]
  expect(seek.time - before.time, 'drawn time step (ms)').toBe(stepMs)
  expect(before.offsetM, 'taken off before: the provisional resting height, faded (m)').toBeCloseTo(fadedRest(before), 6)
  expect(seek.rawFt, 'raw height after the seek (ft)').toBeGreaterThan(25)
  expect(seek.rawFt, 'raw height after the seek (ft)').toBeLessThan(100)
  expect(seek.inContact, 'in contact after the seek').toBe(false)
  const off = largestOffsetOff(recs.slice(stepIndex), () => 0)
  expect(off, 'taken off from the seek on, with no provisional resting height (m)').toBeLessThanOrEqual(OFFSET_ERR_MAX_M)
})

it('entering buffer replay mid-fade restarts lane B as at first sight: nothing is taken off from the first replay frame', () => {
  const { recs, eventIndex } = intoReplay
  const before = recs[eventIndex - 1]
  const first = recs[eventIndex]
  expect(Math.abs(first.time - before.time), 'the first replay frame draws the last live instant (ms)').toBeLessThanOrEqual(
    FRAME_MS,
  )
  expect(before.offsetM, 'taken off live: the provisional resting height, faded (m)').toBeCloseTo(fadedRest(before), 6)
  expect(first.inContact, 'in contact on the first replay frame').toBe(false)
  const off = largestOffsetOff(recs.slice(eventIndex), () => 0)
  expect(off, 'taken off in replay, with no provisional resting height (m)').toBeLessThanOrEqual(OFFSET_ERR_MAX_M)
})

it('a 2 s step back in drawn time mid-fade keeps the provisional resting height: its share follows the raw height, with no jump', () => {
  const { recs, stepIndex } = backStep
  const step = recs[stepIndex]
  expect(step.time - recs[stepIndex - 1].time, 'drawn time step (ms)').toBe(-DROP_CONTACT_SEEK_MS)
  expect(step.rawFt, 'raw height after the step (ft)').toBeGreaterThan(25)
  const off = largestOffsetOff(recs.slice(stepIndex - 1), fadedRest)
  expect(off, 'taken off around the step, off the faded provisional resting height (m)').toBeLessThanOrEqual(
    OFFSET_ERR_MAX_M,
  )
})
