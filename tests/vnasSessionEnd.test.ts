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
  DYNAMIC_DELAY_MAX_MS,
  DYNAMIC_DELAY_MIN_MS,
  SOURCE_DISPLAY_DELAYS,
} from '../src/renderer/constants/aircraft-timeline'
import type { AircraftDataSource, AircraftMetadata, AircraftObservation } from '../src/renderer/types/aircraft-timeline'
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

describe('vNAS session end', () => {
  beforeEach(() => {
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
  })

  it('drops vNAS-only aircraft and strips vNAS observations without a seed when VATSIM lists neither', () => {
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
    expect(both1?.observations.map((obs) => obs.source)).toEqual(['vatsim'])
    expect(both1?.lastSource).toBe('vatsim')
    expect(both1?.lastReceivedAt).toBe(now - 15900)
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

  it('replaces a stored VATSIM point at the seed time and keeps older ones', () => {
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
    expect(observations.map((obs) => obs.observedAt)).toEqual([now - 20000, vatsimTimestamp])
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
    // display delay, while the eased fields carry over from the state it had.
    const { timelines, dynamicDelays } = useAircraftTimelineStore.getState()
    expect(dynamicDelays.get('BOTH1')).toEqual({
      ...before,
      targetDelayMs: Math.max(DYNAMIC_DELAY_MIN_MS, Math.min(DYNAMIC_DELAY_MAX_MS, vatsimDelay)),
      intervalHistory: [],
    })
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
