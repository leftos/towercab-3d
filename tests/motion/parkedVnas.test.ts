// @vitest-environment node
/**
 * A parked vNAS aircraft through a vNAS silence. vNAS sends nothing while it stands still, and after 30 s of that
 * silence the timeline falls back to the mixed VATSIM list. The display delay counts only intervals that carry
 * cadence: two samples of one source, at most 30 s apart, and at most 3 s apart or moved across (2 kt for vNAS, 5 kt for
 * VATSIM). So its next vNAS samples show within the vNAS display delay however it stopped and whether or not VATSIM
 * reports it through the silence (TC3D-373: FDX772, a B77L at rest at 13.58 ft, shown 18 s late after resuming). An
 * aircraft VATSIM shows moving away from its last vNAS spot is drawn from VATSIM at VATSIM's delay.
 */
import { expect, it, vi } from 'vitest'
import { DYNAMIC_DELAY_JITTER_BUFFER_MS, SOURCE_DISPLAY_DELAYS } from '@/constants/aircraft-timeline'
import type {
  AircraftDataSource,
  AircraftMetadata,
  AircraftObservation,
  DynamicDelayState,
} from '@/types/aircraft-timeline'
import { knotsToMps } from '@/utils/coordinates'

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0)
const FRAME_MS = 1000 / 60
const CS = 'FDX772'
const METADATA: AircraftMetadata = { cid: 1, aircraftType: 'B77L', transponder: '1200', departure: null, arrival: null }
const FT = 0.3048
const REST_FT = 13.58
const LAT = 37.72
const LON = -122.22
const M_PER_DEG_LON = 111320 * Math.cos((LAT * Math.PI) / 180)
const VNAS_RECEIVE_LAG_MS = 80
const VATSIM_RECEIVE_LAG_MS = 500
const VATSIM_PERIOD_S = 15
const PARKED_S = 19
const TAXI_S = 30
const TAXI_KTS = 10
// Metres moved in each 1 s step of a stop the stop test misses: one 0 kt step after a 2.9 kt one
const MISSED_STOP_STEPS_M = [3, 2.5, 1.5, 0]
const RESUMED_AT_REST = 3
// VATSIM shows the aircraft taxiing away from its last vNAS spot from this scenario second, 100 m per report (13 kt)
const TAXI_AWAY_AT_S = 60
const TAXI_AWAY_STEP_M = 100
const TAXI_AWAY_KTS = 13
// The aircraft is drawn from VATSIM at VATSIM's delay from here on, so it lerps between reports
const TAXI_AWAY_CHECK_FROM_S = 120
const TAXI_AWAY_MAX_EXTRAPOLATING_SHARE = 0.1
const MPS_TO_KT = 1 / knotsToMps(1)
// vnasStore's groundspeed: the mean of the last 5 measured steps, seeded from the newest observation after a gap
const AVERAGED_STEPS = 5
const AVERAGE_RESEED_GAP_MS = 5000
// A keyboard stop: the last step before the silence is 4 m (7.8 kt), then 2 m of residual roll when vNAS resumes
const KEYBOARD_STOP_STEP_M = 4
const KEYBOARD_RESUMED_STEPS_M = [2, 0, 0]
// A taxi-queue crawl: 5 steps of 3 m (5.8 kt) and a sudden stop before each pause
const CRAWL_PAUSES_S = [4, 8, 12, 20, 6, 15, 10, 5]
const CRAWL_STEP_M = 3
const CRAWL_STEPS = 5
// Holding short: a 15 kt taxi, a firm stop the stop test misses, the hold, then 5 s of 15 kt taxi
const HOLD_TAXI_KTS = 15
const HOLD_STOP_STEPS_M = [4.5, 3, 1.5, 0]
const HOLD_GO_STEPS = 5
// VATSIM's first report after the stop, taken 6 s or 7 s before it (17-24 m short of the parked spot)
const STALE_VATSIM_FROM_S = 35
const VATSIM_MOVING_KTS = 20
const VATSIM_ONLY_REPORTS = 8
const TAXI_DROPOUT_KTS = 15
const TAXI_DROPOUT_MS = 4000
// A resumed sample shows at the 1150 ms 1 Hz target, plus a 200 ms extrapolation bump while drawn from VATSIM, less
// the 80 ms receive lag (about 1270 ms): under the 1500 ms vNAS source delay, so settling there fails
const RESUMED_MAX_LAG_MS = 1400
// A taxi at 7.7 m/s whose vNAS goes quiet for 60 s: a gap past the 30 s source fallback, moved across
const OUTAGE_TAXI_MPS = 7.7
const OUTAGE_BEFORE_S = 20
const OUTAGE_BACK_S = 80
const ONE_HZ_TARGET_MS = 1000 + DYNAMIC_DELAY_JITTER_BUFFER_MS
// A parked aircraft's still samples at vNAS's irregular 1-3 s gaps (TC3D-398)
const PARKED_GAPS_S = [1, 2, 3, 1, 1, 3, 2, 1, 3, 1]
const PARKED_GAPS_SILENCE_S = 60
const HOLD_SHORT_3_MIN_S = 180
// First seen parked with only VATSIM reports (TC3D-382), then vNAS from this scenario second
const FIRST_SEEN_VNAS_FROM_S = 62
const FIRST_SEEN_VNAS_SAMPLES = 10
// The stop test needs two still steps, so the third vNAS sample is the first that can show a stop
const FIRST_STOPPED_SAMPLE = 2
// The commonest real shape whose display delay settled near 3.2 s: 43 of run 4's 258 parked resumptions had a target
// of 2.9-3.4 s, each after still samples at irregular 1-5 s gaps and a 10-46 s silence, resumed at rest. SMX9750 at
// t 522.2 s (gaps 1, 3, 1, 4, 5 s, then 10 s of silence), delay.jsonl:
// [1793144845782,"SMX9750",3230,3030,[1123,2880,998],200]
const REAL_PARKED_GAPS_S = [1, 3, 1, 4, 5]
const REAL_PARKED_SILENCE_S = 10
// vNAS can repeat a moving aircraft's position: a gap this long counts at its length whether or not it moved
const REPEATED_GAP_S = 3

/** One sample `eastM` metres east of the origin at scenario second `t`; a vNAS one reads the resting height. */
function sample(source: AircraftDataSource, t: number, eastM = 0, groundspeed = 0): AircraftObservation {
  const observedAt = T0 + t * 1000
  return {
    latitude: LAT,
    longitude: LON + eastM / M_PER_DEG_LON,
    altitude: 10 + REST_FT * FT,
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
    ...(source === 'vnas' ? { heightAboveGround: REST_FT * FT } : {}),
  }
}

function eastOf(s: { longitude: number }): number {
  return (s.longitude - LON) * M_PER_DEG_LON
}

/** PARKED_S seconds of 1 Hz vNAS standing at the origin: a stop the stop test sees. */
function heldStop(): AircraftObservation[] {
  return Array.from({ length: PARKED_S + 1 }, (_, t) => sample('vnas', t))
}

/** A 10 kt taxi east, then a stop the stop test misses. */
function missedStop(): AircraftObservation[] {
  const taxiMps = knotsToMps(TAXI_KTS)
  const samples: AircraftObservation[] = []
  for (let t = 0; t <= TAXI_S; t++) samples.push(sample('vnas', t, taxiMps * t, TAXI_KTS))
  let east = taxiMps * TAXI_S
  MISSED_STOP_STEPS_M.forEach((step, i) => {
    east += step
    samples.push(sample('vnas', TAXI_S + 1 + i, east, step * 1.94))
  })
  return samples
}

interface Frame {
  now: number
  displayTime: number
  displayDelay: number
  isExtrapolating: boolean
  /** Metres east of the origin the aircraft is drawn */
  eastM: number
}

/** What VATSIM reports every 15 s: nothing, where vNAS last put the aircraft, or the aircraft taxiing away after TAXI_AWAY_AT_S. */
type VatsimTrack = 'none' | 'inPlace' | 'taxiesAway'

interface Scenario {
  stop: () => AircraftObservation[]
  silenceS: number
  vatsim: VatsimTrack
  /** vNAS samples at the parked spot after the silence, 1 Hz */
  resumed: number
}

interface Run {
  frames: Frame[]
  resumedSamples: AircraftObservation[]
}

/** VATSIM's reports for a track, every 15 s from scenario second 3 up to `endMs` after T0. */
function vatsimReports(track: VatsimTrack, stopSamples: AircraftObservation[], endMs: number): AircraftObservation[] {
  if (track === 'none') return []
  const parkedEastM = eastOf(stopSamples[stopSamples.length - 1])
  const reports: AircraftObservation[] = []
  for (let t = 3; t * 1000 <= endMs; t += VATSIM_PERIOD_S) {
    const vnasThen = stopSamples.filter((s) => s.observedAt <= T0 + t * 1000).pop()
    const inPlaceEastM = vnasThen ? eastOf(vnasThen) : parkedEastM
    if (track === 'taxiesAway' && t >= TAXI_AWAY_AT_S) {
      const step = Math.floor((t - TAXI_AWAY_AT_S) / VATSIM_PERIOD_S) + 1
      reports.push(sample('vatsim', t, parkedEastM + TAXI_AWAY_STEP_M * step, TAXI_AWAY_KTS))
    } else {
      reports.push(sample('vatsim', t, inPlaceEastM))
    }
  }
  return reports
}

/**
 * The stop's vNAS samples, `silenceS` seconds of vNAS silence, then `resumed` samples at the parked spot, with VATSIM
 * reporting along its track. Each frame interpolates the timeline, up to 30 s after the last resumed receipt (or after
 * the silence, with none).
 */
async function runParked({ stop, silenceS, vatsim: track, resumed }: Scenario): Promise<Run> {
  const stopSamples = stop()
  const last = stopSamples[stopSamples.length - 1]
  const lastT = (last.observedAt - T0) / 1000
  const resumedSamples = Array.from({ length: resumed }, (_, i) => sample('vnas', lastT + silenceS + i, eastOf(last)))
  const vnas = [...stopSamples, ...resumedSamples]
  // Long enough for a 15 s display delay to reach every resumed sample
  const endMs = (resumed > 0 ? resumedSamples[resumed - 1].receivedAt - T0 : (lastT + silenceS) * 1000) + 30_000
  const vatsim = vatsimReports(track, stopSamples, endMs)
  return { frames: await runFeeds(vnas, vatsim, endMs), resumedSamples }
}

/** Feeds vNAS (in receive order) and VATSIM's reports as they are received and interpolates each frame up to `endMs`. */
async function runFeeds(vnas: AircraftObservation[], vatsim: AircraftObservation[], endMs: number): Promise<Frame[]> {
  vi.resetModules()
  // vnasStore registers a removal listener at module init; loading it first resolves the store import cycle in the
  // same order the app does.
  await import('@/stores/vnasStore')
  const tl = await import('@/stores/aircraftTimelineStore')
  const store = tl.useAircraftTimelineStore

  const frames: Frame[] = []
  let nextVnas = 0
  let nextVatsim = 0
  for (let f = 0; f * FRAME_MS <= endMs; f++) {
    const now = T0 + f * FRAME_MS
    while (nextVnas < vnas.length && vnas[nextVnas].receivedAt <= now) {
      store.getState().addObservation(CS, vnas[nextVnas++], METADATA)
    }
    const batch = []
    while (nextVatsim < vatsim.length && vatsim[nextVatsim].receivedAt <= now) {
      batch.push({ callsign: CS, observation: vatsim[nextVatsim++], metadata: METADATA })
    }
    if (batch.length > 0) store.getState().addObservationBatch(batch)
    const result = store.getState().getInterpolatedStates(now).get(CS)
    if (!result) continue
    frames.push({
      now,
      displayTime: result.displayTime,
      displayDelay: result.displayDelay,
      isExtrapolating: result.isExtrapolating,
      eastM: eastOf(result),
    })
  }
  return frames
}

/**
 * The display-delay state after each sample is added in receive order, VATSIM by batch as the app does. A single vNAS
 * sample keeps the list mixed, so intervals between sources reach the statistics.
 */
async function delayStateAfter(samples: AircraftObservation[]): Promise<DynamicDelayState> {
  vi.resetModules()
  await import('@/stores/vnasStore')
  const tl = await import('@/stores/aircraftTimelineStore')
  const store = tl.useAircraftTimelineStore
  for (const s of [...samples].sort((a, b) => a.receivedAt - b.receivedAt)) {
    if (s.source === 'vatsim') store.getState().addObservationBatch([{ callsign: CS, observation: s, metadata: METADATA }])
    else store.getState().addObservation(CS, s, METADATA)
  }
  const state = store.getState().dynamicDelays.get(CS)
  if (!state) throw new Error(`${CS} has no display-delay state`)
  return state
}

/**
 * A 1 Hz vNAS track of per-second steps (m) from `startEastM`, its first sample at scenario second `startS + 1`; each
 * sample reports its own step's speed.
 */
function track(startS: number, startEastM: number, stepsM: number[]): AircraftObservation[] {
  let east = startEastM
  return stepsM.map((step, i) => {
    east += step
    return sample('vnas', startS + i + 1, east, Math.abs(step) * MPS_TO_KT)
  })
}

/**
 * VATSIM every 15 s from scenario second `startS` up to `endS`, where the vNAS track put the aircraft `staleS` seconds
 * before each report (a snapshot taken mid-stop sits short of the parked spot).
 */
function vatsimAlong(vnas: AircraftObservation[], startS: number, endS: number, staleS: number): AircraftObservation[] {
  const reports: AircraftObservation[] = []
  for (let t = startS; t <= endS; t += VATSIM_PERIOD_S) {
    const then = vnas.filter((s) => s.observedAt <= T0 + (t - staleS) * 1000).pop()
    reports.push(sample('vatsim', t, then ? eastOf(then) : 0))
  }
  return reports
}

/** The vNAS samples with vnasStore's groundspeed in place of their own: the mean of the last 5 measured steps. */
function withAveragedGroundspeeds(vnas: AircraftObservation[], vatsim: AircraftObservation[]): AircraftObservation[] {
  const byReceipt = [...vnas, ...vatsim].sort((a, b) => a.receivedAt - b.receivedAt)
  const steps: number[] = []
  const averaged: AircraftObservation[] = []
  let previous: AircraftObservation | null = null
  let newest: AircraftObservation | null = null
  for (const o of byReceipt) {
    if (o.source !== 'vnas') {
      newest = o
      continue
    }
    const gapMs = previous ? o.observedAt - previous.observedAt : Number.POSITIVE_INFINITY
    let groundspeed = newest?.groundspeed ?? 0
    if (previous && gapMs > 0 && gapMs < AVERAGE_RESEED_GAP_MS) {
      steps.push((Math.abs(eastOf(o) - eastOf(previous)) / (gapMs / 1000)) * MPS_TO_KT)
      if (steps.length > AVERAGED_STEPS) steps.shift()
      groundspeed = steps.reduce((a, b) => a + b, 0) / steps.length
    }
    const withSpeed = { ...o, groundspeed }
    averaged.push(withSpeed)
    previous = withSpeed
    newest = withSpeed
  }
  return averaged
}

interface Feeds {
  vnas: AircraftObservation[]
  vatsim: AircraftObservation[]
  /** The vNAS samples after the silence, which must show within the vNAS display delay */
  checked: AircraftObservation[]
}

/** Runs the feeds up to 30 s after the last vNAS receipt. */
async function runChecked(feeds: Feeds): Promise<Run> {
  const endMs = feeds.vnas[feeds.vnas.length - 1].receivedAt - T0 + 30_000
  return { frames: await runFeeds(feeds.vnas, feeds.vatsim, endMs), resumedSamples: feeds.checked }
}

/**
 * The missed stop with vnasStore's averaged groundspeeds, whose 5-step mean lags the stop, then `silenceS` of silence
 * and 3 samples at rest.
 */
function averagedMissedStop(silenceS: number, withVatsim: boolean): Feeds {
  const stop = missedStop()
  const last = stop[stop.length - 1]
  const resumed = track((last.observedAt - T0) / 1000 + silenceS - 1, eastOf(last), [0, 0, 0])
  const raw = [...stop, ...resumed]
  const lastS = (resumed[resumed.length - 1].observedAt - T0) / 1000
  const vatsim = withVatsim ? vatsimAlong(raw, 3, lastS + 30, 0) : []
  const vnas = withAveragedGroundspeeds(raw, vatsim)
  return { vnas, vatsim, checked: vnas.slice(-resumed.length) }
}

/** A 10 kt taxi whose last step is 4 m, `silenceS` of silence, then 2 m of residual roll and rest. */
function keyboardStop(silenceS: number): Feeds {
  const taxiMps = knotsToMps(TAXI_KTS)
  const taxi = Array.from({ length: TAXI_S + 1 }, (_, t) => sample('vnas', t, taxiMps * t, TAXI_KTS))
  const stop = track(TAXI_S, taxiMps * TAXI_S, [KEYBOARD_STOP_STEP_M])
  const resumed = track(TAXI_S + silenceS, eastOf(stop[0]), KEYBOARD_RESUMED_STEPS_M)
  return { vnas: [...taxi, ...stop, ...resumed], vatsim: [], checked: resumed }
}

/** A taxi-queue crawl: per burst 5 steps of 3 m, then a sudden stop and a 4-20 s pause. */
function suddenStopCrawl(withVatsim: boolean): Feeds {
  const vnas: AircraftObservation[] = [sample('vnas', 0)]
  let fromPause = 0
  for (const [k, pause] of CRAWL_PAUSES_S.entries()) {
    const last = vnas[vnas.length - 1]
    const startS = (last.observedAt - T0) / 1000 + (k === 0 ? 0 : pause - 1)
    if (k === 1) fromPause = vnas.length
    vnas.push(...track(startS, eastOf(last), Array(CRAWL_STEPS).fill(CRAWL_STEP_M)))
  }
  const lastS = (vnas[vnas.length - 1].observedAt - T0) / 1000
  return { vnas, vatsim: withVatsim ? vatsimAlong(vnas, 3, lastS, 0) : [], checked: vnas.slice(fromPause) }
}

/**
 * A 15 kt taxi, a firm stop the stop test misses, a hold of `holdS`, then 5 s of 15 kt taxi; VATSIM every 15 s from
 * `vatsimFromS`, `staleS` behind the vNAS track.
 */
function holdShort(holdS: number, vatsimFromS: number, staleS: number): Feeds {
  const taxiMps = knotsToMps(HOLD_TAXI_KTS)
  const taxi = track(-1, 0, Array(TAXI_S + 1).fill(taxiMps))
  const stop = track(TAXI_S, eastOf(taxi[taxi.length - 1]), HOLD_STOP_STEPS_M)
  const last = stop[stop.length - 1]
  const go = track((last.observedAt - T0) / 1000 + holdS - 1, eastOf(last), Array(HOLD_GO_STEPS).fill(taxiMps))
  const vnas = [...taxi, ...stop, ...go]
  const lastS = (go[go.length - 1].observedAt - T0) / 1000
  return { vnas, vatsim: vatsimAlong(vnas, vatsimFromS, lastS + 30, staleS), checked: go }
}

/**
 * A held stop, still samples at `gapsS` (s) apart, `silenceS` of silence, then 3 samples at rest; no VATSIM. The
 * resumed samples are checked.
 */
function parkedGaps(gapsS: number[], silenceS: number): Feeds {
  const parked = heldStop()
  let t = (parked[parked.length - 1].observedAt - T0) / 1000
  const still = gapsS.map((gap) => {
    t += gap
    return sample('vnas', t)
  })
  const resumed = Array.from({ length: RESUMED_AT_REST }, (_, i) => sample('vnas', t + silenceS + i))
  return { vnas: [...parked, ...still, ...resumed], vatsim: [], checked: resumed }
}

/**
 * First seen parked with only VATSIM reports every 15 s, then 1 Hz vNAS at the same spot from FIRST_SEEN_VNAS_FROM_S;
 * VATSIM reports throughout. The vNAS samples from the first that can show a stop are checked.
 */
function firstSeenParked(): Feeds {
  const vnas = Array.from({ length: FIRST_SEEN_VNAS_SAMPLES }, (_, i) => sample('vnas', FIRST_SEEN_VNAS_FROM_S + i))
  const lastS = FIRST_SEEN_VNAS_FROM_S + FIRST_SEEN_VNAS_SAMPLES - 1
  const vatsim = Array.from({ length: Math.floor(lastS / VATSIM_PERIOD_S) + 1 }, (_, i) =>
    sample('vatsim', i * VATSIM_PERIOD_S),
  )
  return { vnas, vatsim, checked: vnas.slice(FIRST_STOPPED_SAMPLE) }
}

/** Milliseconds from a sample's receipt to the first frame whose displayed instant reaches it. */
function receiptToDisplayMs(frames: Frame[], s: AircraftObservation): number {
  const shown = frames.find((f) => f.displayTime >= s.observedAt)
  if (!shown) throw new Error(`sample observed at +${s.observedAt - T0} ms was never displayed`)
  return shown.now - s.receivedAt
}

function expectResumedWithinVnasDelay(run: Run): void {
  expect(run.resumedSamples.length, 'resumed samples').toBeGreaterThan(0)
  for (const s of run.resumedSamples) {
    const lag = receiptToDisplayMs(run.frames, s)
    expect(lag, `sample at +${(s.observedAt - T0) / 1000} s shown ${lag.toFixed(0)} ms after receipt`).toBeLessThanOrEqual(
      RESUMED_MAX_LAG_MS,
    )
  }
}

/** Once the display delay first reaches the resumed-sample limit, it never rises over it again. */
function expectDelaySettledWithinLimit(run: Run): void {
  const settled = run.frames.findIndex((f) => f.displayDelay <= RESUMED_MAX_LAG_MS)
  expect(settled, 'first frame within the limit').toBeGreaterThanOrEqual(0)
  const worst = run.frames.slice(settled).reduce((w, f) => (f.displayDelay > w.displayDelay ? f : w))
  expect(worst.displayDelay, `display delay at +${((worst.now - T0) / 1000).toFixed(2)} s`).toBeLessThanOrEqual(
    RESUMED_MAX_LAG_MS,
  )
}

// The scenarios run at the top level, where collection has no timeout (tests/setup/hookBudget.ts).
const vatsimLongSilence = await runParked({ stop: heldStop, silenceS: 150, vatsim: 'inPlace', resumed: RESUMED_AT_REST })
const missedStopNoVatsim = await runParked({ stop: missedStop, silenceS: 150, vatsim: 'none', resumed: RESUMED_AT_REST })
const missedStopVatsim = await runParked({ stop: missedStop, silenceS: 150, vatsim: 'inPlace', resumed: RESUMED_AT_REST })
const missedStopShortSilence = await runParked({ stop: missedStop, silenceS: 20, vatsim: 'none', resumed: RESUMED_AT_REST })
const taxiesAwayOnVatsim = await runParked({ stop: heldStop, silenceS: 180, vatsim: 'taxiesAway', resumed: 0 })
const vatsimShortSilence = await runParked({ stop: heldStop, silenceS: 25, vatsim: 'inPlace', resumed: RESUMED_AT_REST })
const noVatsimLongSilence = await runParked({ stop: heldStop, silenceS: 150, vatsim: 'none', resumed: RESUMED_AT_REST })
const averagedMissedStopVatsim = await runChecked(averagedMissedStop(150, true))
const averagedMissedStopShortSilence = await runChecked(averagedMissedStop(20, false))
const keyboardStopShortSilence = await runChecked(keyboardStop(20))
const keyboardStopLongSilence = await runChecked(keyboardStop(150))
const crawlVatsim = await runChecked(suddenStopCrawl(true))
const crawlNoVatsim = await runChecked(suddenStopCrawl(false))
const holdShort25 = await runChecked(holdShort(25, 3, 0))
const holdShort60 = await runChecked(holdShort(60, 3, 0))
const holdShort120 = await runChecked(holdShort(120, 3, 0))
const holdShortStaleVatsim6 = await runChecked(holdShort(120, STALE_VATSIM_FROM_S, 6))
const holdShortStaleVatsim7 = await runChecked(holdShort(120, STALE_VATSIM_FROM_S, 7))
const parkedIrregular = await runChecked(parkedGaps(PARKED_GAPS_S, PARKED_GAPS_SILENCE_S))
const holdShort3Min = await runChecked(holdShort(HOLD_SHORT_3_MIN_S, 3, 0))
const firstSeenParkedOnVatsim = await runChecked(firstSeenParked())
const realParkedShape = await runChecked(parkedGaps(REAL_PARKED_GAPS_S, REAL_PARKED_SILENCE_S))
// A 10 kt taxi VATSIM reported first, taken over by 1 Hz vNAS at TAKEOVER_S; its delay, falling from VATSIM's at the
// 100 ms/s limit, is still about 10 s when it stops at STOP_S, then stands still to STOPPED_UNTIL_S (TC3D-398)
const TAKEOVER_S = 60
const STOP_S = 111
const STOPPED_UNTIL_S = 130
// A frame's step may exceed one frame of taxi speed by this much: the delay falling at 100 ms/s plays it at 1.1x
const TAKEOVER_STEP_MARGIN = 1.5
// A one-frame fall of the delay over this is a snap, not the rate limit
const SNAP_MIN_MS = 100
const takeoverMps = knotsToMps(TAXI_KTS)
const takeoverVnas = [
  ...Array.from({ length: STOP_S - TAKEOVER_S + 1 }, (_, i) => {
    const t = TAKEOVER_S + i
    return sample('vnas', t, takeoverMps * t, TAXI_KTS)
  }),
  ...Array.from({ length: STOPPED_UNTIL_S - STOP_S }, (_, i) => sample('vnas', STOP_S + 1 + i, takeoverMps * STOP_S)),
]
const takeoverVatsim = Array.from({ length: Math.floor(STOPPED_UNTIL_S / VATSIM_PERIOD_S) + 1 }, (_, i) => {
  const t = i * VATSIM_PERIOD_S
  return sample('vatsim', t, takeoverMps * Math.min(t, STOP_S), t < STOP_S ? TAXI_KTS : 0)
})
const takeoverStop = takeoverVnas[STOP_S - TAKEOVER_S]
const takenOverTaxi = await runFeeds(takeoverVnas, takeoverVatsim, takeoverStop.receivedAt - T0 + 30_000)
// A 10 kt taxi whose vNAS repeats the last position after a 3 s gap: a moving aircraft, not a stop
const repeatTaxiMps = knotsToMps(TAXI_KTS)
const repeatedOnTaxi = await delayStateAfter([
  ...Array.from({ length: TAXI_S + 1 }, (_, t) => sample('vnas', t, repeatTaxiMps * t, TAXI_KTS)),
  sample('vnas', TAXI_S + REPEATED_GAP_S, repeatTaxiMps * TAXI_S, TAXI_KTS),
])
// Moving samples, so only the change of source and the 30 s bound leave their intervals out
const vatsimToVnas = [sample('vatsim', 0, 0, 20), sample('vatsim', 15, 150, 20), sample('vnas', 50, 500, 20)]
const vatsimToVnasIntervals = (await delayStateAfter(vatsimToVnas)).intervalHistory
const vnasToVatsim = [sample('vatsim', 0, 0, 20), sample('vnas', 5, 50, 20), sample('vatsim', 40, 400, 20)]
const vnasToVatsimIntervals = (await delayStateAfter(vnasToVatsim)).intervalHistory
const vatsimMovingMps = knotsToMps(VATSIM_MOVING_KTS)
const vatsimOnlyMoving = await delayStateAfter(
  Array.from({ length: VATSIM_ONLY_REPORTS }, (_, i) => {
    const t = i * VATSIM_PERIOD_S
    return sample('vatsim', t, vatsimMovingMps * t, VATSIM_MOVING_KTS)
  }),
)
const dropoutMps = knotsToMps(TAXI_DROPOUT_KTS)
const dropoutAfterS = 20
const beforeDropoutS = Array.from({ length: dropoutAfterS + 1 }, (_, t) => t)
const afterDropoutS = [0, 1, 2, 3].map((i) => dropoutAfterS + TAXI_DROPOUT_MS / 1000 + i)
const taxiDropout = await delayStateAfter(
  [...beforeDropoutS, ...afterDropoutS].map((t) => sample('vnas', t, dropoutMps * t, TAXI_DROPOUT_KTS)),
)
const outageSeconds = [
  ...Array.from({ length: OUTAGE_BEFORE_S + 1 }, (_, t) => t),
  ...[0, 1, 2].map((i) => OUTAGE_BACK_S + i),
]
const movingOutage = await delayStateAfter(
  outageSeconds.map((t) => sample('vnas', t, OUTAGE_TAXI_MPS * t, OUTAGE_TAXI_MPS * MPS_TO_KT)),
)
const outageGapMs = (OUTAGE_BACK_S - OUTAGE_BEFORE_S) * 1000
const mixedMps = knotsToMps(TAXI_DROPOUT_KTS)
const mixedFeed: [AircraftDataSource, number][] = [
  ['vatsim', 0],
  ['vnas', 5],
  ['vatsim', 20],
]
const mixedMoving = await delayStateAfter(
  mixedFeed.map(([source, t]) => sample(source, t, mixedMps * t, TAXI_DROPOUT_KTS)),
)

it('a parked vNAS aircraft that VATSIM reports shows its first vNAS samples after 150 s of silence within the vNAS display delay (TC3D-373)', () => {
  expectResumedWithinVnasDelay(vatsimLongSilence)
})

it('a parked vNAS aircraft whose stop the stop test misses keeps its display delay within the vNAS one after 150 s of silence (TC3D-373)', () => {
  const resumedAt = missedStopNoVatsim.resumedSamples[0].receivedAt
  const after = missedStopNoVatsim.frames.filter((f) => f.now >= resumedAt)
  expect(after.length, 'frames after vNAS resumes').toBeGreaterThan(60)
  const worst = after.reduce((w, f) => (f.displayDelay > w.displayDelay ? f : w))
  expect(worst.displayDelay, `display delay at +${((worst.now - T0) / 1000).toFixed(2)} s`).toBeLessThanOrEqual(SOURCE_DISPLAY_DELAYS.vnas)
  expectResumedWithinVnasDelay(missedStopNoVatsim)
})

it('missed stop with VATSIM in place: first vNAS samples after 150 s within the vNAS delay (TC3D-373)', () => {
  expectResumedWithinVnasDelay(missedStopVatsim)
})

it('missed stop: first vNAS samples after a 20 s silence within the vNAS delay (TC3D-373)', () => {
  expectResumedWithinVnasDelay(missedStopShortSilence)
})

it('a stopped vNAS aircraft that VATSIM then shows taxiing away is drawn between VATSIM reports, not extrapolated (TC3D-373)', () => {
  const checked = taxiesAwayOnVatsim.frames.filter((f) => f.now >= T0 + TAXI_AWAY_CHECK_FROM_S * 1000)
  expect(checked.length, `frames from +${TAXI_AWAY_CHECK_FROM_S} s`).toBeGreaterThan(60)
  const extrapolating = checked.filter((f) => f.isExtrapolating).length
  expect(extrapolating, `frames extrapolating of ${checked.length}`).toBeLessThan(checked.length * TAXI_AWAY_MAX_EXTRAPOLATING_SHARE)
})

it('a parked vNAS aircraft that VATSIM reports shows its first vNAS samples after a 25 s silence within the vNAS display delay', () => {
  expectResumedWithinVnasDelay(vatsimShortSilence)
})

it('a parked vNAS aircraft with no VATSIM shows its first vNAS samples after 150 s of silence within the vNAS display delay', () => {
  expectResumedWithinVnasDelay(noVatsimLongSilence)
})

it('an interval over 30 s from a VATSIM report to a vNAS sample does not count toward the display delay', () => {
  expect(vatsimToVnasIntervals, 'intervals kept in the statistics').not.toContain(
    vatsimToVnas[2].receivedAt - vatsimToVnas[1].receivedAt,
  )
})

it('an interval over 30 s from a vNAS sample to a VATSIM report does not count toward the display delay', () => {
  expect(vnasToVatsimIntervals, 'intervals kept in the statistics').not.toContain(
    vnasToVatsim[2].receivedAt - vnasToVatsim[1].receivedAt,
  )
})

it('missed stop, averaged groundspeeds, VATSIM in place: first vNAS samples after 150 s within the vNAS delay (TC3D-373)', () => {
  expectResumedWithinVnasDelay(averagedMissedStopVatsim)
})

it('missed stop, averaged groundspeeds: first vNAS samples after a 20 s silence within the vNAS delay (TC3D-373)', () => {
  expectResumedWithinVnasDelay(averagedMissedStopShortSilence)
})

it('a keyboard stop (last step 4 m) shows its first vNAS samples after a 20 s silence within the vNAS display delay (TC3D-373)', () => {
  expectResumedWithinVnasDelay(keyboardStopShortSilence)
})

it('a keyboard stop (last step 4 m) shows its first vNAS samples after 150 s of silence within the vNAS display delay (TC3D-373)', () => {
  expectResumedWithinVnasDelay(keyboardStopLongSilence)
})

it('crawl at 3 m steps, sudden stops, VATSIM: every vNAS sample after a pause within the vNAS delay (TC3D-373)', () => {
  expectResumedWithinVnasDelay(crawlVatsim)
})

it('crawl at 3 m steps, sudden stops: every vNAS sample after a pause within the vNAS delay (TC3D-373)', () => {
  expectResumedWithinVnasDelay(crawlNoVatsim)
})

it('an aircraft holding short for 25 s after a firm stop, with VATSIM, shows its taxi on within the vNAS display delay (TC3D-373)', () => {
  expectResumedWithinVnasDelay(holdShort25)
})

it('an aircraft holding short for 60 s after a firm stop, with VATSIM, shows its taxi on within the vNAS display delay (TC3D-373)', () => {
  expectResumedWithinVnasDelay(holdShort60)
})

it('an aircraft holding short for 120 s after a firm stop, with VATSIM, shows its taxi on within the vNAS display delay (TC3D-373)', () => {
  expectResumedWithinVnasDelay(holdShort120)
})

it('a VATSIM report taken 6 s before the stop, 17 m short, does not raise the delay of the vNAS burst after a 120 s hold (TC3D-373)', () => {
  expectResumedWithinVnasDelay(holdShortStaleVatsim6)
})

it('a VATSIM report taken 7 s before the stop, 24 m short, does not raise the delay of the vNAS burst after a 120 s hold (TC3D-373)', () => {
  expectResumedWithinVnasDelay(holdShortStaleVatsim7)
})

it('a parked aircraft with still samples 1-3 s apart keeps its display delay within 1.4 s and shows its samples after 60 s of silence within it (TC3D-398)', () => {
  expectDelaySettledWithinLimit(parkedIrregular)
  expectResumedWithinVnasDelay(parkedIrregular)
})

it('an aircraft holding short for 3 min, with VATSIM every 15 s, shows its taxi on within the vNAS display delay (TC3D-398 B3)', () => {
  expectResumedWithinVnasDelay(holdShort3Min)
})

it('an aircraft first seen parked on VATSIM alone shows its vNAS samples within the vNAS display delay once they show a stop (TC3D-382)', () => {
  expectResumedWithinVnasDelay(firstSeenParkedOnVatsim)
})

it("run 4's commonest parked shape that settled near 3.2 s (SMX9750) keeps its delay within 1.4 s and shows its resumed samples within it (TC3D-398)", () => {
  expectDelaySettledWithinLimit(realParkedShape)
  expectResumedWithinVnasDelay(realParkedShape)
})

it('a taxiing aircraft whose vNAS repeats a position after a 3 s gap counts that gap at its length (TC3D-398)', () => {
  const gapMs = REPEATED_GAP_S * 1000
  expect(repeatedOnTaxi.intervalHistory, 'intervals kept in the statistics').toContain(gapMs)
  expect(repeatedOnTaxi.targetDelayMs, 'target display delay').toBe(gapMs + DYNAMIC_DELAY_JITTER_BUFFER_MS)
})

it('a taxi taken over from VATSIM (delay ~10 s) that stops never jumps forward; the snap waits until the drawn instant reaches the stop sample (TC3D-398)', () => {
  const fromStop = takenOverTaxi.filter((f) => f.now >= takeoverStop.receivedAt)
  expect(fromStop[0]?.displayDelay, 'display delay when the stop sample arrives').toBeGreaterThan(9000)
  const frameOfTaxiM = takeoverMps * (FRAME_MS / 1000)
  const steps = fromStop.slice(1).map((f, i) => ({ f, stepM: Math.abs(f.eastM - fromStop[i].eastM) }))
  const worst = steps.reduce((w, s) => (s.stepM > w.stepM ? s : w))
  expect(
    worst.stepM,
    `step at +${((worst.f.now - T0) / 1000).toFixed(2)} s (one frame of taxi ${frameOfTaxiM.toFixed(3)} m)`,
  ).toBeLessThanOrEqual(frameOfTaxiM * TAKEOVER_STEP_MARGIN)
  const snaps = fromStop.slice(1).filter((f, i) => fromStop[i].displayDelay - f.displayDelay > SNAP_MIN_MS)
  expect(snaps.length, 'snaps of the delay').toBeGreaterThan(0)
  const early = snaps.filter((f) => f.displayTime < takeoverStop.observedAt)
  expect(early.length, 'snaps before the drawn instant reaches the stop sample').toBe(0)
})

it('a VATSIM-only aircraft moving at 20 kt keeps its display delay at its 15 s cadence', () => {
  expect(vatsimOnlyMoving.targetDelayMs, 'target display delay').toBe(VATSIM_PERIOD_S * 1000 + DYNAMIC_DELAY_JITTER_BUFFER_MS)
})

it('a 60 s vNAS outage while taxiing at 7.7 m/s does not count toward the display delay once vNAS returns', () => {
  expect(movingOutage.intervalHistory, 'intervals kept in the statistics').not.toContain(outageGapMs)
  expect(movingOutage.targetDelayMs, 'target display delay').toBe(ONE_HZ_TARGET_MS)
})

it('moving reports that alternate VATSIM, vNAS, VATSIM leave no interval in the statistics', () => {
  expect(mixedMoving.intervalHistory, 'intervals kept in the statistics').toEqual([])
})

it('a 4 s vNAS dropout while taxiing at 15 kt counts toward the display delay', () => {
  expect(taxiDropout.intervalHistory, 'intervals kept in the statistics').toContain(TAXI_DROPOUT_MS)
  expect(taxiDropout.targetDelayMs, 'target display delay').toBe(TAXI_DROPOUT_MS + DYNAMIC_DELAY_JITTER_BUFFER_MS)
})
