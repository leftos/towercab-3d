import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** A Tauri-shaped window before the store modules load; see vnasStore.subscribe.test.ts. */
const { invokeMock } = vi.hoisted(() => {
  const invoke = vi.fn()
  globalThis.window = { __TAURI_INTERNALS__: { invoke } } as unknown as Window & typeof globalThis
  return { invokeMock: invoke }
})

/** The airport store as the follow reads it: the airport list, the airport in view and the picker. */
const airportState = vi.hoisted(() => ({
  airports: new Map<string, unknown>(),
  currentAirport: null as { icao: string } | null,
  selectAirport: (_icao: string, _options?: unknown): void => {},
}))

/** Cuts the aircraftTimelineStore → viewportStore → airportStore → vnasStore cycle; see vnasStore.subscribe.test.ts. */
vi.mock('../src/renderer/stores/airportStore', () => ({
  useAirportStore: { getState: () => airportState },
}))
vi.mock('../src/renderer/stores/vatsimStore', () => ({
  useVatsimStore: { getState: () => ({ startPolling: () => {}, stopPolling: () => {} }) },
}))
vi.mock('../src/renderer/stores/globalSettingsStore', () => ({
  useGlobalSettingsStore: { getState: () => ({ realtraffic: { dataSource: 'vatsim' } }) },
}))

import { handleSessionStateEvent } from '../src/renderer/hooks/useVnasEvents'
import { useUIFeedbackStore } from '../src/renderer/stores/uiFeedbackStore'
import { useVnasStore } from '../src/renderer/stores/vnasStore'
import type { VnasStatus } from '../src/renderer/types/vnas'

/** The host's status once a YAAT room session is joined */
const ROOM_JOINED: VnasStatus = {
  state: 'subscribing',
  environment: 'yaatlocal',
  subscribedFacilities: [],
  error: null,
  available: true,
  lastSessionEnd: null,
  sessionKind: 'room',
}

const FOLLOW_OPTIONS = { skipRealTrafficBroadcast: true }

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** What `vnas_get_status` returns; a subscribe adds its facility */
let hostStatus: VnasStatus = ROOM_JOINED
/** What `vnas_get_session_airports` returns: the joined session's airports */
let hostAirports: string[] = []
/** When set, every `vnas_get_status` waits for it before replying */
let statusGate: Deferred | null = null
/** Runs inside `vnas_connect`, as the host's forwarder emits a join while the connect is under way */
let duringConnect: (() => void) | null = null
/** When set, `vnas_disconnect` waits for it before replying */
let disconnectGate: Deferred | null = null
/** Who waits for a command to be invoked */
const waiters = new Map<string, Array<() => void>>()

/** Resolves when `command` is next invoked */
function invoked(command: string): Promise<void> {
  return new Promise((resolve) => {
    waiters.set(command, [...(waiters.get(command) ?? []), resolve])
  })
}

async function fakeHost(command: string, args?: Record<string, unknown>): Promise<unknown> {
  for (const resolve of waiters.get(command) ?? []) {
    resolve()
  }
  waiters.delete(command)
  switch (command) {
    case 'vnas_get_status':
      if (statusGate) {
        await statusGate.promise
      }
      return hostStatus
    case 'vnas_get_session_airports':
      return hostAirports
    case 'vnas_subscribe_facility':
      hostStatus = {
        ...hostStatus,
        subscribedFacilities: [...hostStatus.subscribedFacilities, String(args?.facilityId)],
      }
      return null
    case 'vnas_connect':
      duringConnect?.()
      return null
    case 'vnas_disconnect':
      if (disconnectGate) {
        await disconnectGate.promise
      }
      return null
    default:
      return null
  }
}

/**
 * What the app's subscribe effects do for the airport in view on a render: `useVnasSubscription`
 * subscribes it when the session offers it, and the auto-subscribe effect in `useVnasEvents`
 * while `subscribing`; neither re-subscribes a facility already subscribed.
 */
function runSubscribeEffects(icao: string): Promise<void> {
  const vnas = useVnasStore.getState()
  const offered = vnas.canSubscribeTo(icao) || vnas.status.state === 'subscribing'
  if (!offered || vnas.isSubscribedTo(icao)) {
    return Promise.resolve()
  }
  return vnas.subscribeToFacility(icao)
}

function subscribeCalls(): unknown[] {
  return invokeMock.mock.calls
    .filter(([command]) => command === 'vnas_subscribe_facility')
    .map(([, args]) => (args as { facilityId: string }).facilityId)
}

const selectAirport = vi.fn((icao: string, _options?: unknown) => {
  airportState.currentAirport = { icao }
})
const showFeedback = vi.fn()
const realShowFeedback = useUIFeedbackStore.getState().showFeedback
const setRoomAirportNotice = vi.fn(useVnasStore.getState().setRoomAirportNotice)

beforeEach(() => {
  hostStatus = ROOM_JOINED
  hostAirports = ['OAK']
  statusGate = null
  duringConnect = null
  disconnectGate = null
  waiters.clear()
  invokeMock.mockReset()
  invokeMock.mockImplementation(fakeHost)
  selectAirport.mockClear()
  showFeedback.mockClear()
  setRoomAirportNotice.mockClear()
  airportState.airports = new Map([
    ['KOAK', {}],
    ['KSFO', {}],
    ['KLAX', {}],
  ])
  airportState.currentAirport = { icao: 'KSFO' }
  airportState.selectAirport = selectAirport
  useUIFeedbackStore.setState({ showFeedback })
  useVnasStore.setState({
    status: { ...ROOM_JOINED, state: 'connecting', sessionKind: null },
    sessionFacilities: [],
    roomAirportNotice: null,
    followPending: false,
    setRoomAirportNotice,
  })
})

afterEach(() => {
  useUIFeedbackStore.setState({ showFeedback: realShowFeedback })
  vi.useRealTimers()
})

describe('following a joined session', () => {
  it('switches to the room airport and subscribes it', async () => {
    await handleSessionStateEvent('subscribing')

    expect(selectAirport).toHaveBeenCalledTimes(1)
    expect(selectAirport).toHaveBeenCalledWith('KOAK', FOLLOW_OPTIONS)
    expect(subscribeCalls()).toEqual(['OAK'])
    expect(useVnasStore.getState().roomAirportNotice).toBeNull()
    expect(showFeedback).not.toHaveBeenCalled()
  })

  it('stays at the room airport when it is already in view', async () => {
    airportState.currentAirport = { icao: 'KOAK' }

    await handleSessionStateEvent('subscribing')

    expect(selectAirport).not.toHaveBeenCalled()
    expect(subscribeCalls()).toEqual(['OAK'])
  })

  it('keeps the airport with a notice and a 5 s info toast when the room airport has no tower view', async () => {
    hostAirports = ['XYZ']
    const notice = 'No tower view for XYZ; showing your current airport'

    await handleSessionStateEvent('subscribing')

    expect(selectAirport).not.toHaveBeenCalled()
    expect(useVnasStore.getState().roomAirportNotice).toBe(notice)
    expect(showFeedback).toHaveBeenCalledTimes(1)
    expect(showFeedback).toHaveBeenCalledWith(notice, 'info', 5000)
    expect(subscribeCalls()).toEqual(['SFO'])
  })

  it('re-subscribes the airport in view after joining a CRC session, without moving', async () => {
    hostStatus = { ...ROOM_JOINED, sessionKind: 'crc' }

    await handleSessionStateEvent('subscribing')

    expect(selectAirport).not.toHaveBeenCalled()
    expect(showFeedback).not.toHaveBeenCalled()
    expect(subscribeCalls()).toEqual(['SFO'])
  })

  it('still switches when the session connects before the status read lands', async () => {
    statusGate = deferred()
    const statusRead = invoked('vnas_get_status')
    const joined = handleSessionStateEvent('subscribing')
    await statusRead

    await handleSessionStateEvent('connected')
    statusGate.resolve()
    await joined

    expect(selectAirport).toHaveBeenCalledWith('KOAK', FOLLOW_OPTIONS)
    expect(subscribeCalls()).toEqual(['OAK'])
  })

  it('subscribes only the room airport when the join lands during the YAAT Local connect', async () => {
    let joined: Promise<void> = Promise.resolve()
    duringConnect = () => {
      joined = handleSessionStateEvent('subscribing')
    }

    // The connect's own status read already carries the room kind
    await useVnasStore.getState().tryConnectWithStoredTokens('yaatlocal')
    await joined

    expect(subscribeCalls()).toEqual(['OAK'])
    expect(airportState.currentAirport?.icao).toBe('KOAK')
  })

  it('follows a join announced twice once: one switch', async () => {
    const first = handleSessionStateEvent('subscribing')
    const second = handleSessionStateEvent('subscribing')
    await Promise.all([first, second])

    expect(selectAirport).toHaveBeenCalledTimes(1)
  })

  it('follows a join announced twice once: one notice and one toast', async () => {
    hostAirports = ['XYZ']

    const first = handleSessionStateEvent('subscribing')
    const second = handleSessionStateEvent('subscribing')
    await Promise.all([first, second])

    expect(setRoomAirportNotice).toHaveBeenCalledTimes(1)
    expect(showFeedback).toHaveBeenCalledTimes(1)
    expect(showFeedback).toHaveBeenCalledWith('No tower view for XYZ; showing your current airport', 'info', 5000)
  })

  it('does not re-subscribe the old room airport when one room session replaces another', async () => {
    useVnasStore.setState({
      status: { ...ROOM_JOINED, state: 'connected', subscribedFacilities: ['OAK'] },
      sessionFacilities: ['OAK'],
    })
    airportState.currentAirport = { icao: 'KOAK' }
    hostAirports = ['SFO']

    // The host emits vnas-state-changed, then vnas-subscriptions-changed []; each is its own
    // task, and React runs the subscribe effects after each, before the next one
    const joined = handleSessionStateEvent('subscribing')
    const afterState = runSubscribeEffects('KOAK')
    useVnasStore.getState().setSubscribedFacilities([])
    const afterList = runSubscribeEffects('KOAK')
    await Promise.all([joined, afterState, afterList])

    expect(subscribeCalls()).toEqual(['SFO'])
    expect(airportState.currentAirport?.icao).toBe('KSFO')
  })

  it('does not switch when disconnected while the follow reads the session', async () => {
    statusGate = deferred()
    disconnectGate = deferred()
    const statusRead = invoked('vnas_get_status')
    const joined = handleSessionStateEvent('subscribing')
    await statusRead

    // The host is still disconnecting while the follow's read lands and the follow runs
    const disconnecting = useVnasStore.getState().disconnect()
    statusGate.resolve()
    await joined
    disconnectGate.resolve()
    await disconnecting

    expect(selectAirport).not.toHaveBeenCalled()
    expect(subscribeCalls()).toEqual([])
  })

  it('subscribes only the room airport when the connect reads the joined status before the join event', async () => {
    // vnas_get_status after vnas_connect already reports the room session; the
    // subscribing event is delivered only after the post-connect subscribe
    await useVnasStore.getState().tryConnectWithStoredTokens('yaatlocal')
    await handleSessionStateEvent('subscribing')

    expect(subscribeCalls()).toEqual(['OAK'])
    expect(airportState.currentAirport?.icao).toBe('KOAK')
  })

  it('overrides a hand pick made before the follow with the room airport', async () => {
    statusGate = deferred()
    const statusRead = invoked('vnas_get_status')
    const joined = handleSessionStateEvent('subscribing')
    await statusRead

    airportState.selectAirport('KLAX')
    // The hand pick's own subscribe, as airportStore.selectAirport makes it
    const handPick = useVnasStore.getState().subscribeToFacility('KLAX')
    statusGate.resolve()
    await Promise.all([joined, handPick])

    expect(selectAirport).toHaveBeenLastCalledWith('KOAK', FOLLOW_OPTIONS)
    expect(airportState.currentAirport?.icao).toBe('KOAK')
    expect(subscribeCalls()).toEqual(['OAK'])
  })
})

describe('the info toast', () => {
  it('stays up for the duration the call gives', () => {
    vi.useFakeTimers()
    useUIFeedbackStore.setState({ showFeedback: realShowFeedback })

    useUIFeedbackStore.getState().showFeedback('No tower view for XYZ; showing your current airport', 'info', 5000)
    vi.advanceTimersByTime(4999)
    expect(useUIFeedbackStore.getState().feedback).toEqual({
      message: 'No tower view for XYZ; showing your current airport',
      type: 'info',
    })

    vi.advanceTimersByTime(1)
    expect(useUIFeedbackStore.getState().feedback).toBeNull()
  })
})
