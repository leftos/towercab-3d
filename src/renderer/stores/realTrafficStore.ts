/**
 * RealTraffic Store
 *
 * Zustand store for managing RealTraffic (RTAPI) state.
 * Provides real-world ADS-B aircraft data as an alternative to VATSIM.
 *
 * @see RealTrafficService - Service that handles API communication
 * @see useAircraftDataSource - Hook that unifies data sources
 */

import { create } from 'zustand'
import type { AircraftState } from '../types/vatsim'
import type { RTConnectionStatus } from '../types/realtraffic'
import type { AircraftObservation, AircraftMetadata } from '../types/aircraft-timeline'
import { realTrafficService } from '../services/RealTrafficService'
import { interpolateAircraftState } from '../utils/interpolation'
import { useGlobalSettingsStore } from './globalSettingsStore'
import { useAircraftTimelineStore } from './aircraftTimelineStore'
import {
  REALTRAFFIC_DEFAULT_POLL_INTERVAL
} from '../constants/realtraffic'
import { SOURCE_DISPLAY_DELAYS } from '../constants/aircraft-timeline'

interface ReferencePosition {
  latitude: number
  longitude: number
}

interface RealTrafficStore {
  // Connection state
  status: RTConnectionStatus
  isPro: boolean
  error: string | null

  // Rate limiting
  trafficRateLimit: number

  // Historical data (Pro license only)
  timeOffset: number

  // Reference position for bounding box queries
  referencePosition: ReferencePosition | null

  // Aircraft data (same structure as vatsimStore for compatibility)
  aircraftStates: Map<string, AircraftState>
  previousStates: Map<string, AircraftState>

  // Timing
  lastUpdate: number
  updateInterval: number

  // Polling
  isPolling: boolean  // Flag indicating polling is active
  pollingTimeout: NodeJS.Timeout | null  // Timer for next fetch
  isLoading: boolean

  // Stats
  totalAircraftFromApi: number

  // Actions
  authenticate: (licenseKey: string) => Promise<boolean>
  disconnect: () => void
  fetchData: () => Promise<void>
  scheduleNextFetch: () => void
  startPolling: () => void
  stopPolling: () => void
  setReferencePosition: (lat: number, lon: number) => void
  setTimeOffset: (minutes: number) => void
}

export const useRealTrafficStore = create<RealTrafficStore>((set, get) => ({
  // Initial state
  status: 'disconnected',
  isPro: false,
  error: null,
  trafficRateLimit: REALTRAFFIC_DEFAULT_POLL_INTERVAL,
  timeOffset: 0,
  referencePosition: null,
  aircraftStates: new Map(),
  previousStates: new Map(),
  lastUpdate: 0,
  updateInterval: REALTRAFFIC_DEFAULT_POLL_INTERVAL,
  isPolling: false,
  pollingTimeout: null,
  isLoading: false,
  totalAircraftFromApi: 0,

  /**
   * Authenticate with RealTraffic API
   *
   * @param licenseKey - RealTraffic license key
   * @returns true if authentication succeeded
   */
  authenticate: async (licenseKey: string): Promise<boolean> => {
    set({ status: 'connecting', error: null })

    const result = await realTrafficService.authenticate(licenseKey)

    if (result.success) {
      set({
        status: 'connected',
        isPro: result.isPro ?? false,
        trafficRateLimit: result.trafficRateLimit ?? REALTRAFFIC_DEFAULT_POLL_INTERVAL,
        updateInterval: result.trafficRateLimit ?? REALTRAFFIC_DEFAULT_POLL_INTERVAL,
        error: null
      })
      return true
    } else {
      set({
        status: 'error',
        error: result.error ?? 'Authentication failed'
      })
      return false
    }
  },

  /**
   * Disconnect from RealTraffic API
   * Deauthenticates the session on the server to allow immediate reconnection
   */
  disconnect: () => {
    const { pollingTimeout } = get()

    // Stop polling if active
    if (pollingTimeout) {
      clearTimeout(pollingTimeout)
    }

    // Deauthenticate from the server (fire-and-forget)
    realTrafficService.deauthenticate().catch(err => {
      console.warn('[RealTraffic] Deauth during disconnect failed:', err)
    })

    // Reset state (don't wait for deauth to complete)
    set({
      status: 'disconnected',
      isPro: false,
      error: null,
      isPolling: false,
      pollingTimeout: null,
      aircraftStates: new Map(),
      previousStates: new Map(),
      totalAircraftFromApi: 0
    })
  },

  /**
   * Fetch traffic data from RealTraffic API
   */
  fetchData: async () => {
    const { referencePosition, status, timeOffset, isLoading } = get()

    // Skip if not connected
    if (status !== 'connected') {
      return
    }

    // If no reference position yet, schedule next fetch and return
    // This keeps polling active while waiting for airport selection
    if (!referencePosition) {
      get().scheduleNextFetch()
      return
    }

    // Prevent concurrent fetches - this avoids race conditions
    if (isLoading) {
      return
    }

    set({ isLoading: true })

    // Get settings
    const rtSettings = useGlobalSettingsStore.getState().realtraffic
    const radiusNm = rtSettings.radiusNm
    const maxParkedAircraft = rtSettings.maxParkedAircraft ?? 0

    const result = await realTrafficService.fetchTraffic(
      referencePosition.latitude,
      referencePosition.longitude,
      radiusNm,
      timeOffset
    )

    if (!result.success) {
      // Handle authentication errors specially - stop polling
      if (result.error?.includes('Session expired') || result.error?.includes('Not authenticated')) {
        set({
          status: 'error',
          error: result.error,
          isLoading: false
        })
        get().stopPolling()
        return
      }

      // For other errors (rate limit, network), keep trying
      set({
        error: result.error ?? 'Failed to fetch traffic data',
        isLoading: false
      })
      // Still schedule next fetch - don't stop polling on transient errors
      get().scheduleNextFetch()
      return
    }

    const now = Date.now()

    // Filter out:
    // - Invalid callsigns (null, empty, or literal "null" string)
    // - Ground operations vehicles (callsigns containing "OPS")
    let aircraft = (result.aircraft ?? []).filter(state =>
      state.callsign &&
      state.callsign !== 'null' &&
      state.callsign.trim() !== '' &&
      !state.callsign.toUpperCase().startsWith('OPS')
    )

    // Fetch parked aircraft if enabled (maxParkedAircraft > 0)
    if (maxParkedAircraft > 0) {
      const parkedResult = await realTrafficService.fetchParkedTraffic(
        referencePosition.latitude,
        referencePosition.longitude,
        radiusNm
      )

      if (parkedResult.success && parkedResult.aircraft) {
        // Filter parked aircraft same as regular traffic, then limit to max
        const parkedAircraft = parkedResult.aircraft
          .filter(state =>
            state.callsign &&
            state.callsign !== 'null' &&
            state.callsign.trim() !== '' &&
            !state.callsign.toUpperCase().startsWith('OPS')
          )
          .slice(0, maxParkedAircraft)

        // Merge parked with active aircraft
        // Use a Set to avoid duplicates (active aircraft already on ground might overlap)
        const activeCallsigns = new Set(aircraft.map(a => a.callsign))
        const uniqueParked = parkedAircraft.filter(p => !activeCallsigns.has(p.callsign))
        aircraft = [...aircraft, ...uniqueParked]
      }
    }

    // =========================================================================
    // Feed observations into the unified timeline store
    // =========================================================================
    const timelineStore = useAircraftTimelineStore.getState()
    const observationBatch: Array<{
      callsign: string
      observation: AircraftObservation
      metadata: AircraftMetadata
    }> = []

    for (const state of aircraft) {
      // Only create observation if we have a valid apiTimestamp
      // (this is when the position was actually observed by ADS-B)
      if (state.apiTimestamp && state.apiTimestamp > 0) {
        const observation: AircraftObservation = {
          latitude: state.latitude,
          longitude: state.longitude,
          altitude: state.altitude,
          heading: state.heading,
          groundspeed: state.groundspeed,
          groundTrack: state.groundTrack ?? null,
          // Only trust heading when true_heading was available from ADS-B
          // If trueHeading is null, heading was derived from track or is a fallback
          headingIsTrue: state.trueHeading != null,
          // Extended ADS-B data
          onGround: state.onGround != null ? state.onGround === 1 : null,
          roll: state.roll ?? null,
          verticalRate: state.baroRate ?? null, // Actual ADS-B vertical rate in fpm
          observedAt: state.apiTimestamp * 1000,  // Convert seconds to ms
          receivedAt: now,
          source: 'realtraffic',
          displayDelay: SOURCE_DISPLAY_DELAYS.realtraffic
        }

        const metadata: AircraftMetadata = {
          cid: state.cid,
          aircraftType: state.aircraftType,
          transponder: state.transponder,
          departure: state.departure,
          arrival: state.arrival,
          isParked: state.isParked
        }

        observationBatch.push({ callsign: state.callsign, observation, metadata })
      }
    }

    // Add all observations in batch for efficiency
    if (observationBatch.length > 0) {
      timelineStore.addObservationBatch(observationBatch)
    }

    // =========================================================================
    // Legacy interpolation logic (kept for backward compatibility during transition)
    // TODO: Remove once rendering is fully switched to timeline store
    // =========================================================================

    // Get current state maps for calculating interpolated positions
    const oldCurrentStates = get().aircraftStates
    const oldPreviousStates = get().previousStates

    // Use ACTUAL time since last update for interpolation timing (like VATSIM does)
    // This is more accurate than using the rate limit, which is just a minimum
    const lastUpdate = get().lastUpdate
    const actualInterval = lastUpdate > 0 ? now - lastUpdate : (result.trafficRateLimit ?? get().trafficRateLimit)

    // Build new aircraft states (TARGET positions)
    // RealTraffic provides true_heading (nose direction) separately from track
    // (direction of movement), so we don't need to calculate heading from position changes
    const newAircraftStates = new Map<string, AircraftState>()
    const newPreviousStates = new Map<string, AircraftState>()

    for (const state of aircraft) {
      const callsign = state.callsign
      const oldCurrentState = oldCurrentStates.get(callsign)
      const oldPrevState = oldPreviousStates.get(callsign)

      // STALE DATA DETECTION:
      // apiTimestamp is when the ADS-B position was observed (Unix seconds).
      // If it hasn't changed since our last fetch, the data is stale.
      // This works for both moving AND stopped aircraft.
      const newApiTimestamp = state.apiTimestamp ?? 0
      const oldApiTimestamp = oldCurrentState?.apiTimestamp ?? 0
      const isStale = oldCurrentState && oldPrevState && newApiTimestamp === oldApiTimestamp

      if (isStale) {
        // Data is stale - keep existing states to continue extrapolating
        // Just update metadata (transponder, etc.) but preserve position/timing
        newAircraftStates.set(callsign, {
          ...oldCurrentState,
          transponder: state.transponder,
          aircraftType: state.aircraftType,
          departure: state.departure,
          arrival: state.arrival
        })
        newPreviousStates.set(callsign, oldPrevState)
      } else {
        // Fresh data - create new interpolation target
        //
        // Use the same timing model as VATSIM: target timestamp is now + actualInterval
        // (when we expect the NEXT update to arrive). The apiTimestamp is only used
        // for stale detection, not for timing calculations.
        //
        // All RealTraffic data is in the past when we receive it, but we interpolate
        // from our current visual position to the new reported position over the
        // expected poll interval.
        const updatedState = {
          ...state,
          timestamp: now + actualInterval  // When we expect to arrive at this position
        }
        newAircraftStates.set(callsign, updatedState)

        // Build previous state (START position - current visual position)
        if (oldCurrentState && oldPrevState) {
          // Aircraft existed before - calculate its current visual position
          const interpolated = interpolateAircraftState(oldPrevState, oldCurrentState, now)

          // Use the current interpolated position as the starting point
          // Timestamp is NOW because that's where the aircraft visually is
          newPreviousStates.set(callsign, {
            ...updatedState, // Use new state for metadata
            latitude: interpolated.interpolatedLatitude,
            longitude: interpolated.interpolatedLongitude,
            altitude: interpolated.interpolatedAltitude,
            heading: interpolated.interpolatedHeading,
            groundspeed: interpolated.interpolatedGroundspeed,
            timestamp: now
          })
        } else {
          // New aircraft - start from its reported position
          // Timestamp is NOW (when we received it), just like VATSIM
          newPreviousStates.set(callsign, {
            ...updatedState,
            timestamp: now
          })
        }
      }
    }

    // Guard against NaN/undefined - keep existing rate limit if new one is invalid
    const newRateLimit = (typeof result.trafficRateLimit === 'number' && !isNaN(result.trafficRateLimit))
      ? result.trafficRateLimit
      : get().trafficRateLimit

    set({
      aircraftStates: newAircraftStates,
      previousStates: newPreviousStates,
      lastUpdate: now,
      updateInterval: actualInterval,
      trafficRateLimit: newRateLimit,
      totalAircraftFromApi: aircraft.length,
      isLoading: false,
      error: null
    })

    // Schedule next fetch if polling is active
    // Use setTimeout chained after completion to ensure proper timing
    get().scheduleNextFetch()
  },

  /**
   * Schedule the next fetch after the rate limit delay
   *
   * Called after each fetch completes. Uses setTimeout to ensure
   * the delay is measured from completion, not from scheduling.
   */
  scheduleNextFetch: () => {
    const { isPolling, pollingTimeout, status, trafficRateLimit } = get()

    // Only schedule if we're actively polling and connected
    if (!isPolling || status !== 'connected') {
      return
    }

    // Clear any existing timeout
    if (pollingTimeout) {
      clearTimeout(pollingTimeout)
    }

    // Wait the full rate limit after receiving the response.
    // Since we measure from after the response arrives, and the server measures
    // from when it receives our request, our next request should arrive at least
    // (rateLimit + networkLatency) after the previous one from the server's perspective.
    const timeout = setTimeout(() => {
      get().fetchData()
    }, trafficRateLimit)

    set({ pollingTimeout: timeout })
  },

  /**
   * Start polling for traffic data
   */
  startPolling: () => {
    const { isPolling, status } = get()

    // Don't start if already polling or not connected
    if (isPolling || status !== 'connected') {
      return
    }

    // Set polling flag and fetch immediately
    set({ isPolling: true })
    get().fetchData()
  },

  /**
   * Stop polling for traffic data
   */
  stopPolling: () => {
    const { pollingTimeout } = get()
    if (pollingTimeout) {
      clearTimeout(pollingTimeout)
    }
    set({ isPolling: false, pollingTimeout: null })
  },

  /**
   * Set reference position for traffic queries
   *
   * Called when airport changes or camera moves significantly.
   */
  setReferencePosition: (latitude: number, longitude: number) => {
    set({ referencePosition: { latitude, longitude } })

    // Only fetch immediately if connected AND not already polling
    // (polling will pick up the new position on the next cycle)
    const { status, isPolling } = get()
    if (status === 'connected' && !isPolling) {
      get().fetchData()
    }
  },

  /**
   * Set time offset for historical data (Pro license only)
   *
   * @param minutes - Minutes into the past (0 = real-time)
   */
  setTimeOffset: (minutes: number) => {
    const { isPro } = get()

    // Only allow time offset for Pro licenses
    if (!isPro && minutes > 0) {
      return
    }

    set({ timeOffset: Math.max(0, Math.min(60, minutes)) })

    // Fetch with new time offset if connected
    if (get().status === 'connected') {
      get().fetchData()
    }
  }
}))

/**
 * Selector for checking if RealTraffic is active and connected
 */
export const selectIsRealTrafficActive = (state: RealTrafficStore): boolean => {
  return state.status === 'connected' && state.aircraftStates.size > 0
}
