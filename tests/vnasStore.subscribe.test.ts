import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The store reaches Tauri through `@tauri-apps/api/core`'s `invoke`, a thin wrapper
 * around `window.__TAURI_INTERNALS__.invoke`. Node has no window, so install a
 * Tauri-shaped one before the store modules load; the real module then delegates to
 * this fake. `vi.mock('@tauri-apps/api/core')` is not used: the store imports it
 * dynamically, and the first of several concurrent dynamic imports bypassed the mock
 * and reached the real module. The `__TAURI_INTERNALS__` marker also makes
 * isRemoteMode() false, so the subscription actions run their real path.
 */
const { invokeMock } = vi.hoisted(() => {
  const invoke = vi.fn()
  globalThis.window = { __TAURI_INTERNALS__: { invoke } } as unknown as Window & typeof globalThis
  return { invokeMock: invoke }
})

/**
 * airportStore is the only module in this graph that imports vnasStore back, which
 * closes the cycle aircraftTimelineStore → viewportStore → airportStore → vnasStore.
 * Node's async module loader drains microtasks between module evaluations, so
 * vnasStore's module-scope addAircraftRemovalListener() call would otherwise run
 * before aircraftTimelineStore has initialised its listener set (a TDZ error the
 * browser's synchronous module evaluation never hits). Mocking airportStore cuts the
 * cycle; the store's own dynamic import of it is not exercised here.
 */
vi.mock('../src/renderer/stores/airportStore', () => ({
  useAirportStore: { getState: () => ({ currentAirport: null }) },
}))

import { useVnasStore } from '../src/renderer/stores/vnasStore'

/** Facilities the fake hub has acknowledged, as `vnas_get_status` reports them. */
let hubFacilities: string[] = []
/** When true, the next `vnas_subscribe_facility` rejects instead of subscribing. */
let failNextSubscribe = false
/** Hub replies held back by the test: each `vnas_subscribe_facility` takes the next one, if any. */
let heldReplies: Deferred[] = []

interface Deferred {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function subscribeCalls(): unknown[][] {
  return invokeMock.mock.calls.filter(([command]) => command === 'vnas_subscribe_facility')
}

describe('vnasStore.subscribeToFacility', () => {
  beforeEach(() => {
    hubFacilities = []
    failNextSubscribe = false
    heldReplies = []
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case 'vnas_subscribe_facility': {
          // Resolve asynchronously so concurrent callers really do overlap.
          const held = heldReplies.shift()
          await (held ? held.promise : delay(10))
          if (failNextSubscribe) {
            failNextSubscribe = false
            throw new Error('hub refused the subscribe')
          }
          hubFacilities = [...hubFacilities, String(args?.facilityId)]
          return null
        }
        case 'vnas_get_status':
          return {
            state: 'subscribed',
            environment: 'live',
            subscribedFacilities: [...hubFacilities],
            error: null,
            available: true,
            lastSessionEnd: null,
          }
        default:
          return null
      }
    })

    useVnasStore.setState({
      status: {
        state: 'disconnected',
        environment: 'live',
        subscribedFacilities: [],
        error: null,
        available: true,
        lastSessionEnd: null,
      },
    })
  })

  it('sends one hub subscribe for three concurrent requests', async () => {
    const { subscribeToFacility } = useVnasStore.getState()

    await Promise.all([subscribeToFacility('KOAK'), subscribeToFacility('KOAK'), subscribeToFacility('KOAK')])

    expect(subscribeCalls()).toHaveLength(1)
  })

  it('sends no hub subscribe once the facility is subscribed', async () => {
    await useVnasStore.getState().subscribeToFacility('KOAK')
    await useVnasStore.getState().subscribeToFacility('KOAK')

    expect(subscribeCalls()).toHaveLength(1)
  })

  it('shares a failed subscribe with its concurrent callers, then invokes again on retry', async () => {
    failNextSubscribe = true
    const { subscribeToFacility } = useVnasStore.getState()

    const [first, second] = await Promise.allSettled([subscribeToFacility('KOAK'), subscribeToFacility('KOAK')])
    expect(first.status).toBe('rejected')
    expect(second.status).toBe('rejected')

    await useVnasStore.getState().subscribeToFacility('KOAK')

    expect(subscribeCalls()).toHaveLength(2)
    expect(useVnasStore.getState().isSubscribedTo('KOAK')).toBe(true)
  })

  it('leaves no error behind when a subscribe from an ended session fails', async () => {
    const staleReply = deferred()
    heldReplies = [staleReply]

    const stale = useVnasStore.getState().subscribeToFacility('KOAK')
    await vi.waitFor(() => expect(subscribeCalls()).toHaveLength(1))

    useVnasStore.getState().handleSessionEnded()
    staleReply.reject(new Error('session ended'))
    await expect(stale).rejects.toThrow('session ended')

    expect(useVnasStore.getState().status.error).toBeNull()
  })

  it('subscribes afresh after the session ends while a subscribe is pending', async () => {
    const staleReply = deferred()
    const freshReply = deferred()
    heldReplies = [staleReply, freshReply]

    const stale = useVnasStore.getState().subscribeToFacility('KOAK')
    await vi.waitFor(() => expect(subscribeCalls()).toHaveLength(1))

    useVnasStore.getState().handleSessionEnded()

    const fresh = useVnasStore.getState().subscribeToFacility('KOAK')
    await delay(20)
    expect(subscribeCalls()).toHaveLength(2)

    // The old session's subscribe settles late; the new session's entry must survive it.
    staleReply.reject(new Error('session ended'))
    await expect(stale).rejects.toThrow('session ended')

    const joined = useVnasStore.getState().subscribeToFacility('KOAK')
    await delay(20)
    expect(subscribeCalls()).toHaveLength(2)

    freshReply.resolve()
    await Promise.all([fresh, joined])
    expect(subscribeCalls()).toHaveLength(2)
    expect(useVnasStore.getState().isSubscribedTo('KOAK')).toBe(true)
  })
})
