import { beforeEach, describe, expect, it, vi } from 'vitest'

/** A Tauri-shaped window before the store modules load; see vnasStore.subscribe.test.ts. */
const { invokeMock } = vi.hoisted(() => {
  const invoke = vi.fn()
  globalThis.window = { __TAURI_INTERNALS__: { invoke } } as unknown as Window & typeof globalThis
  return { invokeMock: invoke }
})

vi.mock('../src/renderer/services/ModService', () => ({
  modService: { getTowerModel: () => undefined, get3dPosition: () => undefined, get2dPosition: () => undefined },
  getCameraPositionFromManifest: () => null,
}))
vi.mock('../src/renderer/hooks/useRemoteObservations', () => ({ requestRemoteAirportChange: () => {} }))
vi.mock('../src/renderer/stores/globalSettingsStore', () => ({
  useGlobalSettingsStore: {
    getState: () => ({
      realtraffic: { dataSource: 'realtraffic' },
      airports: { recentAirports: [] },
      updateAirports: () => {},
    }),
  },
}))
vi.mock('../src/renderer/stores/realTrafficStore', () => ({
  useRealTrafficStore: {
    getState: () => ({ status: 'disconnected', isPolling: false, setReferencePosition: () => {}, startPolling: () => {} }),
  },
}))
vi.mock('../src/renderer/stores/vatsimStore', () => ({
  useVatsimStore: { getState: () => ({ setReferencePosition: () => {} }) },
}))
vi.mock('../src/renderer/stores/viewportStore', () => ({
  useViewportStore: { getState: () => ({ setCurrentAirport: () => {} }) },
}))
vi.mock('../src/renderer/stores/vnasStore', () => ({
  useVnasStore: { getState: () => ({ canSubscribe: () => false }) },
}))

import { useAirportStore } from '../src/renderer/stores/airportStore'
import type { Airport } from '../src/renderer/types/airport'

function airport(icao: string, lat: number, lon: number): Airport {
  return { icao, iata: '', name: icao, city: '', state: '', country: 'US', elevation: 10, lat, lon, tz: '' }
}

/** Resolves when the host is next asked to broadcast an airport to RealTraffic remote browsers */
let broadcastSent: () => void = () => {}

describe('airportStore.selectAirport with RealTraffic as the data source', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'broadcast_airport_sync') {
        broadcastSent()
      }
      return null
    })
    useAirportStore.getState().loadAirports({
      KOAK: airport('KOAK', 37.72, -122.22),
      KSFO: airport('KSFO', 37.62, -122.38),
    })
  })

  it('skips the remote airport broadcast when asked, and sends it otherwise', async () => {
    const sent = new Promise<void>((resolve) => {
      broadcastSent = resolve
    })

    useAirportStore.getState().selectAirport('KOAK', { skipRealTrafficBroadcast: true })
    useAirportStore.getState().selectAirport('KSFO')
    await sent

    const broadcasts = invokeMock.mock.calls.filter(([command]) => command === 'broadcast_airport_sync')
    expect(broadcasts.map(([, args]) => args)).toEqual([{ icao: 'KSFO', realtrafficActive: true }])
    expect(useAirportStore.getState().currentAirport?.icao).toBe('KSFO')
  })
})
