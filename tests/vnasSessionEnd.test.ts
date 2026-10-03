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
    useVatsimStore.setState({ allPilots: [], lastVatsimTimestamp: 0 })
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
      },
    })
  })

  it('drops vNAS-only aircraft and strips vNAS observations from shared ones', () => {
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
    useVatsimStore.setState({ allPilots: [pilot('LISTED1')], lastVatsimTimestamp: now - 5000 })

    // The VATSIM points were skipped or pruned during the vNAS stream; only stale vNAS ones remain.
    const { addObservation } = useAircraftTimelineStore.getState()
    addObservation('LISTED1', observation('vnas', now - 61000, now - 60900), METADATA)
    addObservation('LISTED1', observation('vnas', now - 60000, now - 59900), METADATA)

    useAircraftTimelineStore.getState().dropSourceObservations('vnas')
    useAircraftTimelineStore.getState().pruneStaleAircraft()

    const listed = useAircraftTimelineStore.getState().timelines.get('LISTED1')
    expect(listed).toBeDefined()
    expect(listed?.observations.map((obs) => obs.source)).toEqual(['vatsim'])
    expect(listed?.lastSource).toBe('vatsim')
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
