import { beforeEach, describe, expect, it, vi } from 'vitest'

// Tauri-shaped window before the store modules load — see vnasStore.subscribe.test.ts.
vi.hoisted(() => {
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async () => null } } as unknown as Window & typeof globalThis
})

/**
 * airportStore is the module that closes the aircraftTimelineStore → viewportStore →
 * airportStore → vnasStore import cycle. Node's async module loader drains microtasks
 * mid-graph, so vnasStore's module-scope removal-listener registration would otherwise
 * hit aircraftTimelineStore's not-yet-initialised listener set. Cut the cycle here.
 */
vi.mock('../src/renderer/stores/airportStore', () => ({
  useAirportStore: { getState: () => ({ currentAirport: null }) },
}))

import {
  AIRCRAFT_TIMEOUT,
  DROP_HOLD_RELEASE_MS,
  DYNAMIC_DELAY_MAX_MS,
  DYNAMIC_DELAY_MIN_MS,
  SOURCE_DISPLAY_DELAYS,
  VNAS_PREFERENCE_THRESHOLD_MS,
} from '../src/renderer/constants/aircraft-timeline'
import type {
  AircraftDataSource,
  AircraftMetadata,
  AircraftObservation,
  DropHold,
  TimelineInterpolationResult,
} from '../src/renderer/types/aircraft-timeline'
import type { ReplayExportDataV2 } from '../src/renderer/types/replay'
import type { PilotData } from '../src/renderer/types/vatsim'
import { useAircraftTimelineStore } from '../src/renderer/stores/aircraftTimelineStore'
import { useReplayStore } from '../src/renderer/stores/replayStore'
import { useVatsimStore } from '../src/renderer/stores/vatsimStore'
import { useVnasStore } from '../src/renderer/stores/vnasStore'

const METADATA: AircraftMetadata = {
  cid: 1234567,
  aircraftType: 'B738',
  transponder: '1200',
  departure: null,
  arrival: null,
}

function observation(source: AircraftDataSource, observedAt: number, receivedAt: number): AircraftObservation {
  return {
    latitude: 37.7,
    longitude: -122.2,
    altitude: 900,
    heading: 300,
    groundspeed: 140,
    groundTrack: 300,
    headingIsTrue: true,
    onGround: false,
    pitch: null,
    roll: null,
    verticalRate: null,
    observedAt,
    receivedAt,
    source,
    displayDelay: 0,
  }
}

function pilot(callsign: string): PilotData {
  return {
    cid: 1234567,
    name: 'Test Pilot',
    callsign,
    server: 'USA-WEST',
    pilot_rating: 0,
    latitude: 37.71,
    longitude: -122.21,
    altitude: 1000,
    groundspeed: 140,
    transponder: '1200',
    heading: 300,
    qnh_i_hg: 29.92,
    qnh_mb: 1013,
    flight_plan: null,
    logon_time: '2026-10-02T00:00:00Z',
    last_updated: '2026-10-02T00:00:00Z',
  }
}

/** Live playback, no VATSIM pilot list, no timelines, and a vNAS session subscribed to OAK. */
function resetStores(): void {
  useReplayStore.setState({ playbackMode: 'live' })
  useVatsimStore.setState({ allPilots: [], lastVatsimTimestamp: 0, isPolling: false, lastUpdate: null })
  useAircraftTimelineStore.getState().clear()
  useVnasStore.setState({
    aircraftStates: new Map(),
    sessionFacilities: [],
    status: {
      state: 'subscribed',
      environment: 'live',
      subscribedFacilities: ['OAK'],
      error: null,
      available: true,
      lastSessionEnd: null,
    },
  })
}

describe('vNAS session end', () => {
  beforeEach(resetStores)

  it('drops vNAS-only aircraft and strips vNAS observations without a seed when VATSIM lists neither, holding nothing (TC3D-6)', () => {
    const now = Date.now()
    const { addObservation } = useAircraftTimelineStore.getState()

    // vNAS-only aircraft
    addObservation('VNAS1', observation('vnas', now - 4000, now - 3900), METADATA)
    addObservation('VNAS1', observation('vnas', now - 1000, now - 900), METADATA)

    // Aircraft VATSIM also reports, where the vNAS observation is newest
    addObservation('BOTH1', observation('vatsim', now - 16000, now - 15900), METADATA)
    addObservation('BOTH1', observation('vnas', now - 1000, now - 900), METADATA)

    useAircraftTimelineStore.getState().dropSourceObservations('vnas')

    const { timelines } = useAircraftTimelineStore.getState()
    expect(timelines.has('VNAS1')).toBe(false)

    const both1 = timelines.get('BOTH1')
    expect(both1).toBeDefined()
    // No pilot record: every vNAS sample goes and nothing holds the aircraft, though its stored report is older
    expect(both1?.observations.map((obs) => obs.source)).toEqual(['vatsim'])
    expect(both1?.lastSource).toBe('vatsim')
    expect(both1?.lastReceivedAt).toBe(now - 15900)
    expect(useAircraftTimelineStore.getState().dynamicDelays.get('BOTH1')?.dropHold).toBeUndefined()
  })

  it('strips every vNAS observation when the pilot record is newer than the last vNAS sample', () => {
    const now = Date.now()
    const vatsimTimestamp = now - 500
    const batchReceivedAt = now - 200
    useVatsimStore.setState({
      allPilots: [pilot('BOTH1')],
      lastVatsimTimestamp: vatsimTimestamp,
      isPolling: true,
      lastUpdate: new Date(batchReceivedAt),
    })

    const { addObservation } = useAircraftTimelineStore.getState()
    addObservation('BOTH1', observation('vatsim', now - 16000, now - 15900), METADATA)
    addObservation('BOTH1', observation('vnas', now - 2000, now - 1900), METADATA)
    addObservation('BOTH1', observation('vnas', now - 1000, now - 900), METADATA)

    useAircraftTimelineStore.getState().dropSourceObservations('vnas')

    const both1 = useAircraftTimelineStore.getState().timelines.get('BOTH1')
    expect(both1?.observations.map((obs) => obs.source)).toEqual(['vatsim', 'vatsim'])
    expect(both1?.observations.map((obs) => obs.observedAt)).toEqual([now - 16000, vatsimTimestamp])
    expect(both1?.lastSource).toBe('vatsim')
    expect(both1?.lastReceivedAt).toBe(batchReceivedAt)
  })

  it('keeps an aircraft VATSIM lists even when its timeline holds only vNAS observations', () => {
    const now = Date.now()
    const batchReceivedAt = now - 2000
    useVatsimStore.setState({
      allPilots: [pilot('LISTED1')],
      lastVatsimTimestamp: now - 5000,
      isPolling: true,
      lastUpdate: new Date(batchReceivedAt),
    })

    // The VATSIM points were skipped or pruned during the vNAS stream; only stale vNAS ones remain.
    const { addObservation } = useAircraftTimelineStore.getState()
    addObservation('LISTED1', observation('vnas', now - 61000, now - 60900), METADATA)
    addObservation('LISTED1', observation('vnas', now - 60000, now - 59900), METADATA)

    useAircraftTimelineStore.getState().dropSourceObservations('vnas')
    useAircraftTimelineStore.getState().pruneStaleAircraft()

    const listed = useAircraftTimelineStore.getState().timelines.get('LISTED1')
    expect(listed).toBeDefined()
    expect(listed?.observations.map((obs) => obs.source)).toEqual(['vatsim'])
    expect(listed?.observations[0].receivedAt).toBe(batchReceivedAt)
    expect(listed?.lastSource).toBe('vatsim')
    expect(listed?.lastReceivedAt).toBe(batchReceivedAt)
  })

  it('does not seed from the pilot list while VATSIM is not polling', () => {
    const now = Date.now()
    useVatsimStore.setState({
      allPilots: [pilot('LISTED1')],
      lastVatsimTimestamp: now - 5000,
      isPolling: false,
      lastUpdate: new Date(now - 2000),
    })
    useAircraftTimelineStore.getState().addObservation('LISTED1', observation('vnas', now - 1000, now - 900), METADATA)

    useAircraftTimelineStore.getState().dropSourceObservations('vnas')

    expect(useAircraftTimelineStore.getState().timelines.has('LISTED1')).toBe(false)
  })

  it('does not seed from a pilot list older than the aircraft timeout', () => {
    const now = Date.now()
    useVatsimStore.setState({
      allPilots: [pilot('LISTED1')],
      lastVatsimTimestamp: now - AIRCRAFT_TIMEOUT - 5000,
      isPolling: true,
      lastUpdate: new Date(now - AIRCRAFT_TIMEOUT - 1000),
    })
    useAircraftTimelineStore.getState().addObservation('LISTED1', observation('vnas', now - 1000, now - 900), METADATA)

    useAircraftTimelineStore.getState().dropSourceObservations('vnas')

    expect(useAircraftTimelineStore.getState().timelines.has('LISTED1')).toBe(false)
  })

  it('replaces a stored VATSIM point at the seed time, keeps older ones, and holds at the newer last vNAS sample', () => {
    const now = Date.now()
    const vatsimTimestamp = now - 5000
    const batchReceivedAt = now - 4000
    useVatsimStore.setState({
      allPilots: [pilot('BOTH1')],
      lastVatsimTimestamp: vatsimTimestamp,
      isPolling: true,
      lastUpdate: new Date(batchReceivedAt),
    })

    const { addObservation } = useAircraftTimelineStore.getState()
    addObservation('BOTH1', { ...observation('vatsim', now - 20000, now - 19000), latitude: 10 }, METADATA)
    addObservation('BOTH1', { ...observation('vatsim', vatsimTimestamp, batchReceivedAt), latitude: 20 }, METADATA)
    addObservation('BOTH1', observation('vnas', now - 1000, now - 900), METADATA)

    useAircraftTimelineStore.getState().dropSourceObservations('vnas')

    const observations = useAircraftTimelineStore.getState().timelines.get('BOTH1')?.observations ?? []
    // The seed is older than the last vNAS sample: the aircraft holds there, a sample its timeline no longer stores
    expect(observations.map((obs) => obs.observedAt)).toEqual([now - 20000, vatsimTimestamp])
    const hold = useAircraftTimelineStore.getState().dynamicDelays.get('BOTH1')?.dropHold
    expect(hold?.point.source).toBe('vnas')
    expect(hold?.point.observedAt).toBe(now - 1000)
    expect(observations[0].latitude).toBe(10)
    expect(observations[1].latitude).toBe(pilot('BOTH1').latitude)
    expect(observations[1].receivedAt).toBe(batchReceivedAt)
  })

  it("keeps a surviving timeline's delay state in dynamicDelays after dropping a source", () => {
    const now = Date.now()
    const { addObservation } = useAircraftTimelineStore.getState()
    const vatsimDelay = SOURCE_DISPLAY_DELAYS.vatsim
    addObservation('BOTH1', { ...observation('vatsim', now - 16000, now - 15900), displayDelay: vatsimDelay }, METADATA)
    addObservation('BOTH1', observation('vnas', now - 1000, now - 900), METADATA)
    const before = useAircraftTimelineStore.getState().dynamicDelays.get('BOTH1')
    expect(before).toBeDefined()

    useAircraftTimelineStore.getState().dropSourceObservations('vnas')

    // One surviving observation: no interval to measure, so the target falls back to its
    // display delay, while the eased fields carry over from the state it had. No pilot record, so no hold.
    const { timelines, dynamicDelays } = useAircraftTimelineStore.getState()
    expect(timelines.get('BOTH1')?.observations.map((obs) => obs.source)).toEqual(['vatsim'])
    expect(dynamicDelays.get('BOTH1')).toEqual({
      ...before,
      targetDelayMs: Math.max(DYNAMIC_DELAY_MIN_MS, Math.min(DYNAMIC_DELAY_MAX_MS, vatsimDelay)),
      intervalHistory: [],
    })
    expect(dynamicDelays.get('BOTH1')?.dropHold).toBeUndefined()
    expect(timelines.get('BOTH1')).not.toHaveProperty('dynamicDelay')
  })

  it("puts a dropped-out timeline's delay state in the graveyard", () => {
    const now = Date.now()
    const { addObservation } = useAircraftTimelineStore.getState()
    addObservation('VNAS1', observation('vnas', now - 2000, now - 1900), METADATA)
    addObservation('VNAS1', observation('vnas', now - 1000, now - 900), METADATA)
    const before = useAircraftTimelineStore.getState().dynamicDelays.get('VNAS1')
    expect(before).toBeDefined()

    useAircraftTimelineStore.getState().dropSourceObservations('vnas')

    const { recentlyRemoved, dynamicDelays } = useAircraftTimelineStore.getState()
    expect(recentlyRemoved.get('VNAS1')?.dynamicDelay).toBe(before)
    expect(dynamicDelays.has('VNAS1')).toBe(false)
  })

  it('leaves unlisted callsigns untouched when the drop is scoped', () => {
    const now = Date.now()
    const { addObservation } = useAircraftTimelineStore.getState()
    addObservation('A', observation('vnas', now - 1000, now - 900), METADATA)
    addObservation('B', observation('vnas', now - 1000, now - 900), METADATA)
    const timelineB = useAircraftTimelineStore.getState().timelines.get('B')

    useAircraftTimelineStore.getState().dropSourceObservations('vnas', ['A'])

    const { timelines } = useAircraftTimelineStore.getState()
    expect(timelines.has('A')).toBe(false)
    expect(timelines.get('B')).toBe(timelineB)
  })

  it('leaves timelines alone outside live playback', () => {
    const now = Date.now()
    useAircraftTimelineStore.getState().addObservation('VNAS1', observation('vnas', now - 1000, now - 900), METADATA)
    useReplayStore.setState({ playbackMode: 'replay' })

    useAircraftTimelineStore.getState().dropSourceObservations('vnas')

    expect(useAircraftTimelineStore.getState().timelines.get('VNAS1')?.observations).toHaveLength(1)
  })

  it('drops the callsign from the timeline when the hub reports it disconnected', () => {
    const now = Date.now()
    useAircraftTimelineStore.getState().addObservation('VNAS1', observation('vnas', now - 1000, now - 900), METADATA)

    useVnasStore.getState().removeAircraft('VNAS1')

    expect(useAircraftTimelineStore.getState().timelines.has('VNAS1')).toBe(false)
  })

  it('clears aircraft state and subscriptions when the session ends', () => {
    const now = Date.now()
    useAircraftTimelineStore.getState().addObservation('VNAS1', observation('vnas', now - 1000, now - 900), METADATA)
    useVnasStore.setState({ aircraftStates: new Map([['VNAS1', {} as never]]) })

    useVnasStore.getState().handleSessionEnded()

    expect(useAircraftTimelineStore.getState().timelines.has('VNAS1')).toBe(false)
    const state = useVnasStore.getState()
    expect(state.aircraftStates.size).toBe(0)
    expect(state.status.subscribedFacilities).toEqual([])
    expect(state.sessionFacilities).toEqual([])
  })
})

// The vNAS drop hold (TC3D-396). GHOST41's shape: a departure climbing out on vNAS, whose VATSIM reports reach the host
// 11.5 s after VATSIM observed them, every 15 s; the vNAS hub then disconnects it. Frames run on a fake host clock.
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0)
const CS = 'GHOST41'
const CLIMB_KTS = 150
const KT_TO_MPS = 0.514444
const M_PER_DEG_LON = 111320 * Math.cos((37.7 * Math.PI) / 180)
const VNAS_LAG_MS = 80
const LATE_VATSIM_MS = 11_500
const VATSIM_PERIOD_MS = 15_000
const FIRST_VATSIM_RECEIVED_MS = 7000
const DROP_AT_MS = 60_300
const DROP_FRAME_MS = 100
// The last vNAS sample before the drop, at scenario second 60
const LAST_VNAS_S = 60
// A session end with the host clock 20 s ahead of VATSIM's, whose reports are 10 s old when fetched
const HOST_AHEAD_MS = 20_000
const REPORT_AGE_MS = 10_000
const SESSION_AIRCRAFT = 50
// vNAS stalls here, 8 s before the hub disconnect, so the aircraft is drawn past its last vNAS position at the drop
const STALLED_LAST_VNAS_S = 52
const STALLED_UNTIL_MS = 110_000
const PARKED_VNAS_PERIOD_MS = 2000
const PARKED_HEIGHT_M = 0.5
// Reports 2 s old stamped 22 s before their receipt: the host clock runs 20 s ahead of VATSIM's, so none is observed
// after the last vNAS sample before the hold expires, and each places the aircraft 20 s past its observed time
const SKEWED_REPORT_RECEIVED_S = [7, 22, 37, 52, 67, 82]
const SKEWED_REPORT_AGE_MS = 2000
const SKEWED_STAMP_LAG_MS = 22_000
const POSITION_TOLERANCE_M = 1e-3
const DISPLAY_TIME_TOLERANCE_MS = 1e-3

/** A sample at scenario ms `atMs` of the aircraft flying east from the origin at CLIMB_KTS, received `lagMs` later. */
function flown(source: AircraftDataSource, atMs: number, lagMs: number): AircraftObservation {
  const eastM = CLIMB_KTS * KT_TO_MPS * (atMs / 1000)
  return {
    ...observation(source, T0 + atMs, T0 + atMs + lagMs),
    longitude: -122.2 + eastM / M_PER_DEG_LON,
    heading: 90,
    groundTrack: 90,
    groundspeed: CLIMB_KTS,
    displayDelay: SOURCE_DISPLAY_DELAYS[source],
  }
}

/** 1 Hz vNAS samples for scenario seconds `fromS` to `toS`. */
function vnasSeconds(fromS: number, toS: number): AircraftObservation[] {
  return Array.from({ length: toS - fromS + 1 }, (_, i) => flown('vnas', (fromS + i) * 1000, VNAS_LAG_MS))
}

/** VATSIM's reports, received every 15 s from FIRST_VATSIM_RECEIVED_MS up to `untilMs`, each observed 11.5 s before. */
function lateVatsim(untilMs: number): AircraftObservation[] {
  const reports: AircraftObservation[] = []
  for (let rcv = FIRST_VATSIM_RECEIVED_MS; rcv <= untilMs; rcv += VATSIM_PERIOD_MS) {
    reports.push(flown('vatsim', rcv - LATE_VATSIM_MS, LATE_VATSIM_MS))
  }
  return reports
}

/** A sample at scenario ms `atMs` of an aircraft parked at the origin, received `lagMs` later; vNAS's carry a height. */
function parked(source: AircraftDataSource, atMs: number, lagMs: number): AircraftObservation {
  return {
    ...observation(source, T0 + atMs, T0 + atMs + lagMs),
    heading: 90,
    groundTrack: 90,
    groundspeed: 0,
    onGround: true,
    displayDelay: SOURCE_DISPLAY_DELAYS[source],
    ...(source === 'vnas' ? { heightAboveGround: PARKED_HEIGHT_M } : {}),
  }
}

/** A VATSIM report received at scenario second `receivedS` by a host 20 s ahead of VATSIM's clock. */
function skewedReport(receivedS: number): AircraftObservation {
  const receivedMs = receivedS * 1000
  return {
    ...flown('vatsim', receivedMs - SKEWED_REPORT_AGE_MS, 0),
    observedAt: T0 + receivedMs - SKEWED_STAMP_LAG_MS,
    receivedAt: T0 + receivedMs,
  }
}

/** VATSIM's pilot list entry for a report. */
function pilotOf(callsign: string, report: AircraftObservation): PilotData {
  return {
    ...pilot(callsign),
    latitude: report.latitude,
    longitude: report.longitude,
    altitude: report.altitude / 0.3048,
    groundspeed: report.groundspeed,
    heading: report.heading,
  }
}

const eastOf = (state: { longitude: number }) => (state.longitude + 122.2) * M_PER_DEG_LON

interface DropFrame {
  now: number
  result: TimelineInterpolationResult | undefined
  /** The hold after the frame */
  hold: DropHold | undefined
  /** The display-delay statistics after the frame */
  intervals: number[]
  stored: AircraftObservation[]
}

interface DropScenario {
  vnas: AircraftObservation[]
  vatsim: AircraftObservation[]
  /** Scenario ms of the hub disconnect, with VATSIM's pilot list holding the newest report received; none by default */
  dropAtMs?: number
  untilMs: number
}

/**
 * Feeds vNAS (one sample at a time) and VATSIM (by batch) as they are received, drops the aircraft's vNAS at
 * `dropAtMs`, prunes stale aircraft every second and interpolates a frame every DROP_FRAME_MS up to `untilMs`.
 */
function runDrop({ vnas, vatsim, dropAtMs, untilMs }: DropScenario): DropFrame[] {
  const store = useAircraftTimelineStore
  const frames: DropFrame[] = []
  let nextVnas = 0
  let nextVatsim = 0
  let newestVatsim: AircraftObservation | null = null
  let dropped = dropAtMs === undefined
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    for (let ms = 0; ms <= untilMs; ms += DROP_FRAME_MS) {
      const now = T0 + ms
      vi.setSystemTime(now)
      if (!dropped && ms >= (dropAtMs ?? Number.POSITIVE_INFINITY)) {
        dropped = true
        if (newestVatsim) {
          useVatsimStore.setState({
            allPilots: [pilotOf(CS, newestVatsim)],
            lastVatsimTimestamp: newestVatsim.observedAt,
            isPolling: true,
            lastUpdate: new Date(newestVatsim.receivedAt),
          })
        }
        store.getState().dropSourceObservations('vnas', [CS])
      }
      while (nextVnas < vnas.length && vnas[nextVnas].receivedAt <= now) {
        store.getState().addObservation(CS, vnas[nextVnas++], METADATA)
      }
      const batch = []
      while (nextVatsim < vatsim.length && vatsim[nextVatsim].receivedAt <= now) {
        newestVatsim = vatsim[nextVatsim++]
        batch.push({ callsign: CS, observation: newestVatsim, metadata: METADATA })
      }
      if (batch.length > 0) store.getState().addObservationBatch(batch)
      if (ms % 1000 === 0) store.getState().pruneStaleAircraft()
      const result = store.getState().getInterpolatedStates(now).get(CS)
      const delay = store.getState().dynamicDelays.get(CS)
      frames.push({
        now,
        result,
        hold: delay?.dropHold,
        intervals: delay?.intervalHistory ?? [],
        stored: store.getState().timelines.get(CS)?.observations ?? [],
      })
    }
  } finally {
    vi.useRealTimers()
  }
  return frames
}

/**
 * Every frame from the aircraft's first report on draws it, and its display time never moves back from one frame to
 * the next.
 */
function expectDisplayTimeNeverBack(frames: DropFrame[]): void {
  const seen = frames.slice(frames.findIndex((f) => f.result !== undefined))
  expect(seen.filter((f) => f.result === undefined).length, 'frames without the aircraft once seen').toBe(0)
  const times = seen.flatMap((f) => (f.result ? [f.result.displayTime] : []))
  const back = times.findIndex((t, i) => i > 0 && t < times[i - 1] - 1e-6)
  const step = back === -1 ? null : `${(times[back - 1] - T0).toFixed(0)} -> ${(times[back] - T0).toFixed(0)} ms`
  expect(step, 'display time stepping back').toBeNull()
}

/** No frame draws the aircraft behind the frame before it, along its eastbound track. */
function expectPositionNeverBack(frames: DropFrame[]): void {
  const east = frames.flatMap((f) => (f.result ? [eastOf(f.result)] : []))
  const back = east.findIndex((e, i) => i > 0 && e < east[i - 1] - POSITION_TOLERANCE_M)
  const step = back === -1 ? null : `${east[back - 1].toFixed(1)} -> ${east[back].toFixed(1)} m`
  expect(step, 'position stepping back').toBeNull()
}

/** The frames from the drop until display time first reaches `observedAt`. */
function fromDropUntil(frames: DropFrame[], observedAt: number): DropFrame[] {
  const afterDrop = frames.filter((f) => f.now >= T0 + DROP_AT_MS)
  const reached = afterDrop.findIndex((f) => (f.result?.displayTime ?? 0) >= observedAt)
  return reached === -1 ? afterDrop : afterDrop.slice(0, reached)
}

/** The replay file exportReplay writes, read back from the blob it hands to the download link. */
async function exportedReplay(): Promise<ReplayExportDataV2> {
  const blobs: Blob[] = []
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    blobs.push(blob as Blob)
    return 'blob:replay'
  })
  const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  // Vite defines the app version at build time
  vi.stubGlobal('APP_VERSION', 'test')
  vi.stubGlobal('document', {
    createElement: () => ({ click: () => {} }),
    body: { appendChild: () => {}, removeChild: () => {} },
  })
  try {
    useReplayStore.getState().exportReplay()
  } finally {
    vi.unstubAllGlobals()
    createUrl.mockRestore()
    revokeUrl.mockRestore()
  }
  expect(blobs, 'replay files written').toHaveLength(1)
  return JSON.parse(await blobs[0].text()) as ReplayExportDataV2
}

describe('vNAS drop hold (TC3D-396)', () => {
  beforeEach(resetStores)

  it('a vNAS departure dropped at a hub disconnect, with VATSIM reports 11.5 s late every 15 s for 6 min, never moves display time back through the hold, its release and the 5-min prune', () => {
    const untilMs = DROP_AT_MS + 6 * 60_000
    const frames = runDrop({
      vnas: vnasSeconds(0, LAST_VNAS_S),
      vatsim: lateVatsim(untilMs),
      dropAtMs: DROP_AT_MS,
      untilMs,
    })
    expect(frames.some((f) => f.hold !== undefined), 'frames holding').toBe(true)
    expect(frames[frames.length - 1].hold, 'the hold at the end').toBeUndefined()
    const oldestAtEnd = frames[frames.length - 1].stored[0]
    expect(oldestAtEnd.observedAt - T0, 'oldest stored report at the end (pruned)').toBeGreaterThan(DROP_AT_MS)
    expectDisplayTimeNeverBack(frames)
  })

  it('control: a buffer-replay seek still moves display time back', () => {
    const frames = runDrop({ vnas: vnasSeconds(0, 20), vatsim: [], untilMs: 20_000 })
    const live = frames[frames.length - 1].result?.displayTime ?? Number.NaN
    useReplayStore.setState({ playbackMode: 'replay' })
    const store = useAircraftTimelineStore.getState()
    const seek = store.getInterpolatedStates(T0 + 10_000).get(CS)?.displayTime ?? Number.NaN
    const further = store.getInterpolatedStates(T0 + 5000).get(CS)?.displayTime ?? Number.NaN
    expect(live - seek, 'display time moved back by the seek to 10 s').toBeGreaterThan(9000)
    expect(seek - further, 'display time moved back by the seek to 5 s').toBeCloseTo(5000, 3)
  })

  it('the 30 s preference flip of a moving vNAS aircraft never moves display time back', () => {
    // VATSIM saw it first; vNAS goes quiet at 60 s while it flies on, and VATSIM's reports from before vNAS anchor the
    // mixed list once vNAS has been silent 30 s. The lag behind now then grows at half speed to VATSIM's
    const untilMs = 160_000
    const frames = runDrop({ vnas: vnasSeconds(12, LAST_VNAS_S), vatsim: lateVatsim(untilMs), untilMs })
    const settled = frames.filter((f) => f.now >= T0 + 150_000)
    expect(settled.length, 'frames once the new lag is reached').toBeGreaterThan(0)
    const anchorOffsetMs = (r: TimelineInterpolationResult, now: number) => r.displayTime - now + r.displayDelay
    const vnasAnchored = settled.filter((f) => f.result && anchorOffsetMs(f.result, f.now) > -LATE_VATSIM_MS + 1)
    expect(vnasAnchored.length, 'frames not anchored to the VATSIM report').toBe(0)
    expectDisplayTimeNeverBack(frames)
  })

  it('an aircraft drawn past its last vNAS position at a hub disconnect stays where it was last drawn: display time and position never move back', () => {
    const frames = runDrop({
      vnas: vnasSeconds(0, STALLED_LAST_VNAS_S),
      vatsim: lateVatsim(STALLED_UNTIL_MS),
      dropAtMs: DROP_AT_MS,
      untilMs: STALLED_UNTIL_MS,
    })
    const lastDrawn = frames.filter((f) => f.now < T0 + DROP_AT_MS).pop()?.result as TimelineInterpolationResult
    expect(lastDrawn.displayTime - T0, 'display time at the drop, past the last vNAS sample').toBeGreaterThan(
      STALLED_LAST_VNAS_S * 1000 + 5000,
    )
    expectDisplayTimeNeverBack(frames)
    expectPositionNeverBack(frames)

    const firstNewer = lateVatsim(STALLED_UNTIL_MS).find((r) => r.observedAt > lastDrawn.displayTime)
    const held = frames.filter((f) => f.now >= T0 + DROP_AT_MS && f.now < (firstNewer?.receivedAt ?? 0))
    expect(held.length, 'frames until a newer report arrives').toBeGreaterThan(100)
    expect(held.filter((f) => f.hold === undefined).length, 'frames not holding').toBe(0)
    const movedTime = held.filter(
      (f) => Math.abs((f.result?.displayTime ?? 0) - lastDrawn.displayTime) > DISPLAY_TIME_TOLERANCE_MS,
    )
    expect(movedTime.length, 'held frames off the last drawn display time').toBe(0)
    const movedEast = held.filter((f) => !f.result || Math.abs(eastOf(f.result) - eastOf(lastDrawn)) > POSITION_TOLERANCE_M)
    expect(movedEast.length, 'held frames off the last drawn position').toBe(0)
  })

  it('a parked aircraft whose last vNAS sample is 8 s old at a hub disconnect never moves display time back', () => {
    const frames = runDrop({
      vnas: Array.from({ length: STALLED_LAST_VNAS_S / 2 + 1 }, (_, i) =>
        parked('vnas', i * PARKED_VNAS_PERIOD_MS, VNAS_LAG_MS),
      ),
      vatsim: lateVatsim(STALLED_UNTIL_MS).map((r) => parked('vatsim', r.observedAt - T0, LATE_VATSIM_MS)),
      dropAtMs: DROP_AT_MS,
      untilMs: STALLED_UNTIL_MS,
    })
    expect(frames.some((f) => f.hold !== undefined), 'frames holding').toBe(true)
    expectDisplayTimeNeverBack(frames)
    const moved = frames.filter((f) => f.result && Math.abs(eastOf(f.result)) > POSITION_TOLERANCE_M)
    expect(moved.length, 'frames off the stand').toBe(0)
  })

  it('a hold that expires with the host clock 20 s ahead of VATSIM eases to the reports: no frame moves over one frame of speed plus the release rate', () => {
    const reports = SKEWED_REPORT_RECEIVED_S.map(skewedReport)
    const expiresAt = T0 + DROP_AT_MS + VNAS_PREFERENCE_THRESHOLD_MS
    const frames = runDrop({
      vnas: vnasSeconds(0, LAST_VNAS_S),
      vatsim: reports,
      dropAtMs: DROP_AT_MS,
      untilMs: DROP_AT_MS + VNAS_PREFERENCE_THRESHOLD_MS + DROP_HOLD_RELEASE_MS + 2000,
    })
    const speedMps = CLIMB_KTS * KT_TO_MPS
    const newest = reports[reports.length - 1]
    /** Where the newest report, extrapolated to `displayTime`, puts the aircraft. */
    const onReports = (displayTime: number) => eastOf(newest) + (speedMps * (displayTime - newest.observedAt)) / 1000

    const expiry = frames.findIndex((f) => f.now >= expiresAt)
    const held = frames[expiry - 1].result as TimelineInterpolationResult
    const first = frames[expiry].result as TimelineInterpolationResult
    const gapM = Math.abs(onReports(first.displayTime) - eastOf(held))
    expect(gapM, 'the gap the expiry opens (20 s of flight)').toBeGreaterThan(1500)

    const released = frames.filter((f) => f.now >= expiresAt - 1000 && f.now <= expiresAt + DROP_HOLD_RELEASE_MS)
    expect(released.length, 'frames across the release').toBeGreaterThan(100)
    const excess = released.slice(1).map((f, i) => {
      const [a, b] = [released[i].result, f.result] as TimelineInterpolationResult[]
      const allowedM = (speedMps * (b.displayTime - a.displayTime)) / 1000 + (gapM * (f.now - released[i].now)) / DROP_HOLD_RELEASE_MS
      return Math.abs(eastOf(b) - eastOf(a)) - allowedM
    })
    expect(Math.max(...excess), 'worst frame step over the allowance (m)').toBeLessThanOrEqual(POSITION_TOLERANCE_M)

    const end = frames[frames.length - 1].result as TimelineInterpolationResult
    expect(Math.abs(eastOf(end) - onReports(end.displayTime)), 'off the reports once released (m)').toBeLessThan(1)
  })

  it('dropped, flown on VATSIM for 2 min, then reconnected: no bracket has the pre-drop sample on one side, and the drawn list goes vNAS-only only at the second post-reconnect sample', () => {
    const reconnectS = 180
    const vnas = [...vnasSeconds(0, LAST_VNAS_S), ...vnasSeconds(reconnectS, reconnectS + 20)]
    const frames = runDrop({ vnas, vatsim: lateVatsim(210_000), dropAtMs: DROP_AT_MS, untilMs: 210_000 })
    const afterDrop = frames.filter((f) => f.now >= T0 + DROP_AT_MS)
    const preDrop = afterDrop.flatMap((f) => f.stored).filter((o) => o.source === 'vnas' && o.observedAt <= T0 + 60_000)
    expect(preDrop.length, 'pre-drop vNAS samples stored after the drop').toBe(0)
    const holdOver = afterDrop.filter((f) => f.now >= T0 + DROP_AT_MS + 30_000)
    expect(holdOver.filter((f) => f.hold !== undefined).length, 'frames holding 30 s after the drop').toBe(0)

    const [first, second] = vnasSeconds(reconnectS, reconnectS + 1)
    const vnasStored = (f: DropFrame) => f.stored.filter((o) => o.source === 'vnas').length
    const oneSample = frames.filter((f) => f.now >= first.receivedAt && f.now < second.receivedAt)
    expect(oneSample.length, 'frames with one post-reconnect sample').toBeGreaterThan(0)
    expect(oneSample.filter((f) => (f.result?.observationCount ?? 0) <= vnasStored(f)).length, 'vNAS-only').toBe(0)
    const twoSamples = frames.filter((f) => f.now >= second.receivedAt)
    expect(twoSamples.filter((f) => f.result?.observationCount !== vnasStored(f)).length, 'mixed').toBe(0)
  })

  it('a reconnect inside the hold glides monotonically from the last vNAS position to the first new sample', () => {
    const vnas = [...vnasSeconds(0, LAST_VNAS_S), ...vnasSeconds(LAST_VNAS_S + 2, 80)]
    const frames = runDrop({ vnas, vatsim: lateVatsim(80_000), dropAtMs: DROP_AT_MS, untilMs: 80_000 })
    const firstNew = vnas.find((o) => o.observedAt > T0 + LAST_VNAS_S * 1000) as AircraftObservation
    const glide = fromDropUntil(frames, firstNew.observedAt)
    expect(glide.length, 'frames from the drop to the first new sample').toBeGreaterThan(10)
    const east = glide.map((f) => (f.result ? eastOf(f.result) : Number.NaN))
    const back = east.findIndex((e, i) => i > 0 && !(e >= east[i - 1] - 1e-6))
    expect(back, 'first frame moving back (or not drawn)').toBe(-1)
    expectDisplayTimeNeverBack(frames)
  })

  it('after a drop, the hold point is never in `observations`, `intervalHistory` or vNAS-only counting', () => {
    // Reconnected 14.4 s after the hold point, an interval no feed here has
    const reconnect = flown('vnas', 74_400, VNAS_LAG_MS)
    const vnas = [...vnasSeconds(0, LAST_VNAS_S), reconnect]
    const frames = runDrop({ vnas, vatsim: lateVatsim(100_000), dropAtMs: DROP_AT_MS, untilMs: 100_000 })
    const point = vnasSeconds(LAST_VNAS_S, LAST_VNAS_S)[0]
    const afterDrop = frames.filter((f) => f.now >= T0 + DROP_AT_MS)
    expect(afterDrop[0].hold?.point.observedAt, 'the hold point').toBe(point.observedAt)
    const stored = afterDrop.filter((f) => f.stored.some((o) => o.observedAt === point.observedAt))
    expect(stored.length, 'frames storing the hold point').toBe(0)
    const pointToReconnect = reconnect.receivedAt - point.receivedAt
    expect(afterDrop.filter((f) => f.intervals.includes(pointToReconnect)).length, 'counted as cadence').toBe(0)
    const released = afterDrop.filter((f) => f.now >= reconnect.receivedAt && f.hold === undefined)
    expect(released.length, 'frames after the release with the reconnect sample stored').toBeGreaterThan(0)
    const notMixed = released.filter((f) => f.result?.observationCount !== f.stored.length)
    expect(notMixed.length, 'frames whose drawn list is not the whole stored list').toBe(0)
  })

  it('a replay exported during a hold carries no hold point or hold state; imported, it draws the aircraft\'s VATSIM reports, pilot record included, at every scrub time before K', async () => {
    const frames = runDrop({
      vnas: vnasSeconds(12, LAST_VNAS_S),
      vatsim: lateVatsim(DROP_AT_MS),
      dropAtMs: DROP_AT_MS,
      untilMs: DROP_AT_MS + 2000,
    })
    expect(frames[frames.length - 1].hold, 'holding at the export').toBeDefined()
    const data = await exportedReplay()
    const json = JSON.stringify(data)
    expect(json.includes('dropHold'), 'hold state in the replay').toBe(false)
    expect(json.includes('lastAnchorOffsetMs'), 'carried anchor offset in the replay').toBe(false)
    const exported = data.timelines.find((t) => t.callsign === CS)
    expect(exported?.observations.map((o) => o.source)).toEqual(['vatsim', 'vatsim'])
    const pilotRecord = exported?.observations[1] as AircraftObservation

    useAircraftTimelineStore.getState().loadImportedTimelines(data.timelines)
    useReplayStore.setState({ playbackMode: 'imported' })
    const store = useAircraftTimelineStore.getState()
    for (const report of exported?.observations ?? []) {
      const drawn = store.getInterpolatedState(CS, report.observedAt)
      expect(drawn ? Math.abs(eastOf(drawn) - eastOf(report)) : Number.NaN, 'metres from the report').toBeLessThan(1)
    }
    const first = exported?.observations[0].observedAt ?? Number.NaN
    const missing: number[] = []
    for (let t = first; t < T0 + LAST_VNAS_S * 1000; t += 1000) {
      if (!store.getInterpolatedState(CS, t)) missing.push(t - T0)
    }
    expect(missing, 'scrub times before K with nothing drawn').toEqual([])
    expect(pilotRecord.observedAt, 'the pilot record is older than K').toBeLessThan(T0 + LAST_VNAS_S * 1000)
  })

  it('during a drop hold, the phase window holds the hold point, not only the pilot record (R9)', () => {
    const frames = runDrop({
      vnas: vnasSeconds(0, LAST_VNAS_S),
      vatsim: lateVatsim(DROP_AT_MS),
      dropAtMs: DROP_AT_MS,
      untilMs: DROP_AT_MS + 5000,
    })
    const last = frames[frames.length - 1]
    expect(last.hold, 'holding').toBeDefined()
    const point = vnasSeconds(LAST_VNAS_S, LAST_VNAS_S)[0]
    const displayTime = last.result?.displayTime ?? Number.NaN
    expect(displayTime, 'display time held at the point').toBe(point.observedAt)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(last.now)
      // What smart sort hands the phase detector: the shown list, as the frame draws it
      const shown = useAircraftTimelineStore.getState().getShownObservations(CS) ?? []
      const window = shown.filter((o) => o.observedAt <= displayTime)
      expect(
        window.map((o) => o.observedAt - T0),
        'observations up to display time (the stored list has only VATSIM reports, the pilot record newest)',
      ).toEqual([point.observedAt - T0])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a session end holding 50 aircraft, with the host clock 20 s ahead of VATSIM\'s: every batch observed after the pilot record is stored and no listed aircraft is pruned', () => {
    const callsigns = Array.from({ length: SESSION_AIRCRAFT }, (_, i) => `HOLD${i}`)
    const vatsimAt = (rcvMs: number) => observation('vatsim', T0 + rcvMs - HOST_AHEAD_MS - REPORT_AGE_MS, T0 + rcvMs)
    const store = useAircraftTimelineStore
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(T0)
      const pilotRecord = vatsimAt(-3000)
      store.getState().addObservationBatch(callsigns.map((callsign) => ({ callsign, observation: pilotRecord, metadata: METADATA })))
      for (const callsign of callsigns) {
        store.getState().addObservation(callsign, observation('vnas', T0 - 2000, T0 - 1920), METADATA)
        store.getState().addObservation(callsign, observation('vnas', T0 - 1000, T0 - 920), METADATA)
      }
      useVatsimStore.setState({
        allPilots: callsigns.map((callsign) => pilot(callsign)),
        lastVatsimTimestamp: pilotRecord.observedAt,
        isPolling: true,
        lastUpdate: new Date(pilotRecord.receivedAt),
      })
      useVnasStore.getState().handleSessionEnded()
      const held = callsigns.filter((callsign) => store.getState().dynamicDelays.get(callsign)?.dropHold !== undefined)
      expect(held.length, 'aircraft held at the session end').toBe(SESSION_AIRCRAFT)

      const unstored: string[] = []
      for (let ms = 0; ms <= 90_000; ms += 1000) {
        vi.setSystemTime(T0 + ms)
        // VATSIM batches 12 s after the session end, then every 15 s
        if (ms >= 12_000 && (ms - 12_000) % VATSIM_PERIOD_MS === 0) {
          const report = vatsimAt(ms)
          store.getState().addObservationBatch(callsigns.map((callsign) => ({ callsign, observation: report, metadata: METADATA })))
          for (const callsign of callsigns) {
            const observations = store.getState().timelines.get(callsign)?.observations ?? []
            if (observations[observations.length - 1]?.observedAt !== report.observedAt) unstored.push(`${callsign}@${ms}`)
          }
        }
        store.getState().pruneStaleAircraft()
      }
      expect(unstored, 'batches not stored').toEqual([])
      const pruned = callsigns.filter((callsign) => !store.getState().timelines.has(callsign))
      expect(pruned, 'listed aircraft pruned').toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
