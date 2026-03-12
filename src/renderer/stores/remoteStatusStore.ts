/**
 * Remote Status Store
 *
 * Tracks connection status and observation health for remote browser clients.
 * Also tracks airport synchronization state for RealTraffic mode.
 * Updated by useRemoteObservations hook.
 */

import { create } from 'zustand'

/** Data source types for observations */
export type ObservationSource = 'vatsim' | 'vnas' | 'realtraffic'

/**
 * Expected update intervals per data source (milliseconds).
 * Used to determine appropriate stale thresholds.
 */
export const SOURCE_UPDATE_INTERVALS: Record<ObservationSource, number> = {
  vatsim: 15000, // 15 seconds
  vnas: 1000, // 1 second (1 Hz)
  realtraffic: 3000, // ~2-3 seconds
}

/**
 * Stale thresholds per data source (milliseconds).
 * If no data received within this time, show "No data" warning.
 * Set to ~1.5x the expected update interval to allow for network jitter.
 */
export const SOURCE_STALE_THRESHOLDS: Record<ObservationSource, number> = {
  vatsim: 25000, // 25 seconds (15s interval + 10s buffer)
  vnas: 5000, // 5 seconds (1s interval + 4s buffer)
  realtraffic: 8000, // 8 seconds (~3s interval + 5s buffer)
}

interface RemoteStatusState {
  /** WebSocket connection state */
  wsConnected: boolean
  /** Timestamp of last observation received */
  lastObservationTime: number
  /** Count of observations received (for calculating rate) */
  observationCount: number
  /** Timestamp when counting started (for rate calculation) */
  countStartTime: number
  /** Most recent data source received */
  lastSource: ObservationSource | null

  // Airport sync state (for RealTraffic mode)
  /** Whether RealTraffic mode is active on the host */
  realtrafficActive: boolean
  /** The synced airport ICAO (when RealTraffic is active) */
  syncedAirport: string | null

  // Actions
  setWsConnected: (connected: boolean) => void
  recordObservation: (count: number, source?: ObservationSource) => void
  setAirportSync: (icao: string | null, realtrafficActive: boolean) => void
  reset: () => void
}

export const useRemoteStatusStore = create<RemoteStatusState>((set, get) => ({
  wsConnected: false,
  lastObservationTime: 0,
  observationCount: 0,
  countStartTime: Date.now(),
  lastSource: null,
  realtrafficActive: false,
  syncedAirport: null,

  setWsConnected: (connected: boolean) => {
    set({ wsConnected: connected })
    if (!connected) {
      // Reset observation tracking on disconnect
      set({ lastObservationTime: 0, lastSource: null })
    }
  },

  recordObservation: (count: number, source?: ObservationSource) => {
    const now = Date.now()
    const state = get()

    // Reset counter every 10 seconds to get recent rate
    if (now - state.countStartTime > 10000) {
      set({
        observationCount: count,
        countStartTime: now,
        lastObservationTime: now,
        lastSource: source ?? state.lastSource,
      })
    } else {
      set({
        observationCount: state.observationCount + count,
        lastObservationTime: now,
        lastSource: source ?? state.lastSource,
      })
    }
  },

  setAirportSync: (icao: string | null, realtrafficActive: boolean) => {
    set({
      syncedAirport: icao,
      realtrafficActive,
    })
  },

  reset: () => {
    set({
      wsConnected: false,
      lastObservationTime: 0,
      observationCount: 0,
      countStartTime: Date.now(),
      lastSource: null,
      realtrafficActive: false,
      syncedAirport: null,
    })
  },
}))
