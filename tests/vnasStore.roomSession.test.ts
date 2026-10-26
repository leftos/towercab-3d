import { beforeEach, describe, expect, it, vi } from 'vitest'

/** A Tauri-shaped window before the store modules load; see vnasStore.subscribe.test.ts. */
const { invokeMock } = vi.hoisted(() => {
  const invoke = vi.fn()
  globalThis.window = { __TAURI_INTERNALS__: { invoke } } as unknown as Window & typeof globalThis
  return { invokeMock: invoke }
})

/** The airport store as the connect reads it: the airport in view. */
const airportState = vi.hoisted(() => ({ currentAirport: null as { icao: string } | null }))

/** Cuts the aircraftTimelineStore → viewportStore → airportStore → vnasStore cycle; see vnasStore.subscribe.test.ts. */
vi.mock('../src/renderer/stores/airportStore', () => ({
  useAirportStore: { getState: () => airportState },
}))

import { useVnasStore } from '../src/renderer/stores/vnasStore'
import type { VnasStatus } from '../src/renderer/types/vnas'
import { getVnasErrorLine, getVnasSessionEndNote } from '../src/renderer/utils/vnasStatusText'

const ROOM_STATUS: VnasStatus = {
  state: 'connected',
  environment: 'yaat1',
  subscribedFacilities: ['OAK'],
  error: null,
  available: true,
  lastSessionEnd: null,
  sessionKind: 'room',
}

/** What `vnas_get_status` returns: the host's status. */
let hostStatus: VnasStatus = ROOM_STATUS
/** What `vnas_get_session_airports` returns. */
let hostAirports: string[] = []

/**
 * Hold the next `vnas_get_status` and answer it with `status` once released; later reads
 * answer `hostStatus` at once. `requested` resolves when the held read is made.
 */
function heldFirstStatusRead(status: VnasStatus): { requested: Promise<void>; release: () => void } {
  let requestedResolve: () => void = () => {}
  const requested = new Promise<void>((resolve) => {
    requestedResolve = resolve
  })
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let held = false
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'vnas_get_status' && !held) {
      held = true
      requestedResolve()
      await released
      return status
    }
    if (command === 'vnas_get_status') {
      return hostStatus
    }
    return command === 'vnas_get_session_airports' ? hostAirports : null
  })
  return { requested, release }
}

function subscribeCalls(): unknown[] {
  return invokeMock.mock.calls
    .filter(([command]) => command === 'vnas_subscribe_facility')
    .map(([, args]) => (args as { facilityId: string }).facilityId)
}

describe('vnasStore.followSessionState', () => {
  beforeEach(() => {
    hostStatus = ROOM_STATUS
    hostAirports = []
    airportState.currentAirport = null
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (command: string) => {
      switch (command) {
        case 'vnas_get_status':
          return hostStatus
        case 'vnas_get_session_airports':
          return hostAirports
        default:
          return null
      }
    })
    useVnasStore.setState({ status: ROOM_STATUS, roomAirportNotice: null })
  })

  it('keeps the kick reason through the disconnected transition', async () => {
    hostStatus = {
      ...ROOM_STATUS,
      state: 'disconnected',
      subscribedFacilities: [],
      sessionKind: null,
      lastSessionEnd: { reason: 'Removed from the room', forcible: true },
    }

    await useVnasStore.getState().followSessionState('disconnected')
    // The host's vnas-error for the kick arrives after the state change
    useVnasStore.getState().setError('Removed from the room')

    const { status } = useVnasStore.getState()
    expect(status.state).toBe('disconnected')
    expect(status.lastSessionEnd).toEqual({ reason: 'Removed from the room', forcible: true })
    expect(status.sessionKind).toBeNull()
    expect(getVnasErrorLine(status)).toBe('Removed from the room by the instructor')
    expect(getVnasSessionEndNote(status)).toBeNull()
  })

  it('shows a room end reason as the dim note only while waiting for a session', async () => {
    hostStatus = {
      ...ROOM_STATUS,
      state: 'waitingForSession',
      subscribedFacilities: [],
      sessionKind: null,
      lastSessionEnd: { reason: 'Room closed', forcible: false },
    }

    await useVnasStore.getState().followSessionState('waitingForSession')

    const { status } = useVnasStore.getState()
    expect(status.lastSessionEnd).toEqual({ reason: 'Room closed', forcible: false })
    expect(getVnasSessionEndNote(status)).toBe('Room closed')
    expect(getVnasErrorLine(status)).toBeNull()

    for (const state of ['disconnected', 'subscribing', 'connected'] as const) {
      expect(getVnasSessionEndNote({ ...status, state }), state).toBeNull()
    }
  })

  it('learns the session kind and airports when a session is joined', async () => {
    // The host knows the kind only once the session's airports have been read
    let airportsRead = false
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'vnas_get_session_airports') {
        airportsRead = true
        return ['OAK']
      }
      if (command === 'vnas_get_status') {
        return { ...ROOM_STATUS, state: 'subscribing', subscribedFacilities: [], sessionKind: airportsRead ? 'room' : null }
      }
      return null
    })
    useVnasStore.setState({ status: { ...ROOM_STATUS, sessionKind: null }, roomAirportNotice: 'old notice' })

    await useVnasStore.getState().followSessionState('subscribing')

    const state = useVnasStore.getState()
    expect(state.status.sessionKind).toBe('room')
    expect(state.sessionFacilities).toEqual(['OAK'])
    expect(state.roomAirportNotice).toBeNull()
  })

  it("drops the last session's kind and end reason at the next session's first state, before the host read", async () => {
    useVnasStore.setState({
      status: { ...ROOM_STATUS, lastSessionEnd: { reason: 'Room closed', forcible: false } },
      sessionFacilities: ['OAK'],
    })
    let releaseRead: () => void = () => {}
    const readHeld = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'vnas_get_status') {
        await readHeld
        return { ...ROOM_STATUS, state: 'subscribing', subscribedFacilities: [], sessionKind: 'crc' }
      }
      return []
    })

    const following = useVnasStore.getState().followSessionState('subscribing')

    const { status, sessionFacilities } = useVnasStore.getState()
    expect(status.sessionKind).toBeNull()
    expect(status.lastSessionEnd).toBeNull()
    expect(status.subscribedFacilities).toEqual([])
    expect(sessionFacilities).toEqual([])

    releaseRead()
    await following
    expect(useVnasStore.getState().status.sessionKind).toBe('crc')
  })

  it("drops a waiting read that lands after the next session's join", async () => {
    // The first status read (for waitingForSession) is held until the room session is joined
    const firstRead = heldFirstStatusRead({
      ...ROOM_STATUS,
      state: 'waitingForSession',
      subscribedFacilities: [],
      sessionKind: null,
      lastSessionEnd: { reason: 'Room closed', forcible: false },
    })
    hostStatus = { ...ROOM_STATUS, state: 'subscribing', subscribedFacilities: [] }

    const waiting = useVnasStore.getState().followSessionState('waitingForSession')
    await firstRead.requested
    await useVnasStore.getState().followSessionState('subscribing')
    firstRead.release()
    await waiting

    const { status } = useVnasStore.getState()
    expect(status.lastSessionEnd).toBeNull()
    expect(status.sessionKind).toBe('room')
  })

  it('takes only the subscriptions and error from a status snapshot that started before a join', async () => {
    useVnasStore.setState({ status: { ...ROOM_STATUS, sessionKind: 'crc' } })
    // getStatus's read, held until the room session is joined, still describes the CRC session
    const firstRead = heldFirstStatusRead({
      ...ROOM_STATUS,
      subscribedFacilities: ['SFO'],
      error: 'Subscription failed: SFO',
      sessionKind: 'crc',
      lastSessionEnd: { reason: 'CRC closed', forcible: false },
    })
    hostStatus = { ...ROOM_STATUS, state: 'subscribing', subscribedFacilities: [] }

    const snapshot = useVnasStore.getState().getStatus()
    await firstRead.requested
    await useVnasStore.getState().followSessionState('subscribing')
    firstRead.release()
    await snapshot

    const { status } = useVnasStore.getState()
    expect(status.subscribedFacilities).toEqual(['SFO'])
    expect(status.error).toBe('Subscription failed: SFO')
    expect(status.sessionKind).toBe('room')
    expect(status.lastSessionEnd).toBeNull()
    expect(status.state).toBe('subscribing')
  })

  it('connect to a host already in a session takes its state', async () => {
    // A reloaded webview: the host's restore and connect find the session live and emit nothing
    useVnasStore.setState({
      status: { ...ROOM_STATUS, state: 'disconnected', subscribedFacilities: [], sessionKind: null },
      followPending: false,
    })
    airportState.currentAirport = { icao: 'KSFO' }
    hostStatus = { ...ROOM_STATUS, environment: 'live', subscribedFacilities: [], sessionKind: 'crc' }
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'vnas_get_status') {
        return hostStatus
      }
      return command === 'vnas_try_restore_session' ? true : null
    })

    await useVnasStore.getState().tryConnectWithStoredTokens('live')

    expect(useVnasStore.getState().status.state).toBe('connected')
    expect(subscribeCalls()).toEqual(['SFO'])
  })
})
