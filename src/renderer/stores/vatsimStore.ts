import { create } from 'zustand'
import type { PilotData, VatsimData, AircraftState } from '../types/vatsim'
import { interpolateAircraftState, calculateDistanceNM } from '../utils/interpolation'
import { useSettingsStore } from './settingsStore'
import { VATSIM_DATA_URL, VATSIM_POLL_INTERVAL, VATSIM_ACTUAL_UPDATE_INTERVAL } from '../constants'

interface ReferencePosition {
  latitude: number
  longitude: number
}

interface VatsimStore {
  // Data
  allPilots: PilotData[] // All pilots from API (for global search, stats)
  pilots: PilotData[] // Filtered pilots (near reference position)
  aircraftStates: Map<string, AircraftState>
  previousStates: Map<string, AircraftState>

  // Reference position for distance filtering (camera/tower location)
  referencePosition: ReferencePosition | null

  // Stats for memory diagnostics
  totalPilotsFromApi: number
  pilotsFilteredByDistance: number

  // Timing - using VATSIM's timestamps for accurate interpolation
  lastVatsimTimestamp: number // VATSIM's update_timestamp as epoch ms
  lastUpdateInterval: number // Actual ms between last two VATSIM updates

  // Status
  isConnected: boolean
  lastUpdate: Date | null
  error: string | null
  isLoading: boolean

  // Polling
  pollingInterval: NodeJS.Timeout | null

  // Actions
  fetchData: () => Promise<void>
  startPolling: () => void
  stopPolling: () => void
  updateAircraftState: (callsign: string, state: AircraftState) => void
  setReferencePosition: (lat: number, lon: number) => void
  refilterPilots: () => void
}

export const useVatsimStore = create<VatsimStore>((set, get) => ({
  // Initial state
  allPilots: [],
  pilots: [],
  aircraftStates: new Map(),
  previousStates: new Map(),
  referencePosition: null,
  totalPilotsFromApi: 0,
  pilotsFilteredByDistance: 0,
  lastVatsimTimestamp: 0,
  lastUpdateInterval: VATSIM_ACTUAL_UPDATE_INTERVAL, // Default to expected VATSIM update interval
  isConnected: false,
  lastUpdate: null,
  error: null,
  isLoading: false,
  pollingInterval: null,

  // Fetch data from VATSIM API
  fetchData: async () => {
    set({ isLoading: true, error: null })

    try {
      const response = await fetch(VATSIM_DATA_URL)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const data: VatsimData = await response.json()

      // Parse VATSIM's update timestamp for stale detection
      const vatsimTimestamp = new Date(data.general.update_timestamp).getTime()
      const { lastVatsimTimestamp, referencePosition } = get()

      // Detect stale data - if VATSIM timestamp hasn't changed, skip this update
      if (vatsimTimestamp === lastVatsimTimestamp) {
        set({ isLoading: false })
        return
      }

      // Calculate actual interval between VATSIM updates (for accurate interpolation timing)
      // This tells us how long interpolation should take to reach the target
      const actualInterval = lastVatsimTimestamp > 0
        ? vatsimTimestamp - lastVatsimTimestamp
        : VATSIM_ACTUAL_UPDATE_INTERVAL

      // Use local time for interpolation (avoids clock skew issues with VATSIM server)
      const now = Date.now()

      // Get current state maps for calculating interpolated positions
      const oldCurrentStates = get().aircraftStates
      const oldPreviousStates = get().previousStates

      // Get distance filter radius from settings
      const aircraftDataRadiusNM = useSettingsStore.getState().aircraftDataRadiusNM

      // Filter pilots by distance if we have a reference position
      // This prevents storing data for aircraft that are far away
      let filteredPilots = data.pilots
      const totalPilotsFromApi = data.pilots.length

      if (referencePosition) {
        filteredPilots = data.pilots.filter(pilot => {
          const distance = calculateDistanceNM(
            referencePosition.latitude,
            referencePosition.longitude,
            pilot.latitude,
            pilot.longitude
          )
          return distance <= aircraftDataRadiusNM
        })
      }

      const pilotsFilteredByDistance = filteredPilots.length

      // First, create the new aircraft states from filtered VATSIM data
      const newAircraftStates = new Map<string, AircraftState>()
      for (const pilot of filteredPilots) {
        const state: AircraftState = {
          callsign: pilot.callsign,
          cid: pilot.cid,
          latitude: pilot.latitude,
          longitude: pilot.longitude,
          altitude: pilot.altitude,
          groundspeed: pilot.groundspeed,
          heading: pilot.heading,
          transponder: pilot.transponder,
          aircraftType: pilot.flight_plan?.aircraft_short || null,
          departure: pilot.flight_plan?.departure || null,
          arrival: pilot.flight_plan?.arrival || null,
          timestamp: now
        }
        newAircraftStates.set(pilot.callsign, state)
      }

      // Now build previous states for ALL aircraft in the NEW data
      // This ensures we always interpolate from current visual position to new VATSIM position
      const newPreviousStates = new Map<string, AircraftState>()

      for (const [callsign, newState] of newAircraftStates) {
        const oldCurrentState = oldCurrentStates.get(callsign)
        const oldPrevState = oldPreviousStates.get(callsign)

        if (oldCurrentState) {
          // Aircraft existed before - calculate its current visual position
          const interpolated = interpolateAircraftState(oldPrevState, oldCurrentState, now)

          // Use the current interpolated/extrapolated position as the starting point
          // ALL interpolated values must be captured for proper Hermite spline continuity
          newPreviousStates.set(callsign, {
            ...newState, // Use new state for metadata (transponder, flight plan, etc.)
            latitude: interpolated.interpolatedLatitude,
            longitude: interpolated.interpolatedLongitude,
            altitude: interpolated.interpolatedAltitude,
            heading: interpolated.interpolatedHeading,
            groundspeed: interpolated.interpolatedGroundspeed,
            timestamp: now - actualInterval
          })
        } else {
          // New aircraft - start from its VATSIM position (no interpolation needed)
          newPreviousStates.set(callsign, {
            ...newState,
            timestamp: now - actualInterval
          })
        }
      }

      set({
        allPilots: data.pilots,
        pilots: filteredPilots,
        aircraftStates: newAircraftStates,
        previousStates: newPreviousStates,
        totalPilotsFromApi,
        pilotsFilteredByDistance,
        lastVatsimTimestamp: vatsimTimestamp,
        lastUpdateInterval: actualInterval,
        isConnected: true,
        lastUpdate: new Date(),
        isLoading: false,
        error: null
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      set({
        isConnected: false,
        isLoading: false,
        error: `Failed to fetch VATSIM data: ${errorMessage}`
      })
      console.error('VATSIM API error:', error)
    }
  },

  // Start polling for data
  startPolling: () => {
    const { pollingInterval, fetchData } = get()

    // Don't start if already polling
    if (pollingInterval) return

    // Fetch immediately
    fetchData()

    // Set up interval
    const interval = setInterval(fetchData, VATSIM_POLL_INTERVAL)
    set({ pollingInterval: interval })
  },

  // Stop polling
  stopPolling: () => {
    const { pollingInterval } = get()
    if (pollingInterval) {
      clearInterval(pollingInterval)
      set({ pollingInterval: null })
    }
  },

  // Update individual aircraft state (for interpolation)
  updateAircraftState: (callsign: string, state: AircraftState) => {
    const { aircraftStates } = get()
    const newStates = new Map(aircraftStates)
    newStates.set(callsign, state)
    set({ aircraftStates: newStates })
  },

  // Set reference position for distance-based filtering
  // Called when airport changes or camera moves significantly
  setReferencePosition: (latitude: number, longitude: number) => {
    set({ referencePosition: { latitude, longitude } })
    // Immediately refilter pilots with new reference position
    get().refilterPilots()
  },

  // Refilter pilots based on current reference position
  // Called when reference position changes or settings change
  refilterPilots: () => {
    const { allPilots, referencePosition, aircraftStates, previousStates } = get()
    const aircraftDataRadiusNM = useSettingsStore.getState().aircraftDataRadiusNM

    if (!referencePosition || allPilots.length === 0) {
      return
    }

    // Filter pilots by distance from reference position
    const filteredPilots = allPilots.filter(pilot => {
      const distance = calculateDistanceNM(
        referencePosition.latitude,
        referencePosition.longitude,
        pilot.latitude,
        pilot.longitude
      )
      return distance <= aircraftDataRadiusNM
    })

    // Build new state maps containing only filtered aircraft
    const newAircraftStates = new Map<string, AircraftState>()
    const newPreviousStates = new Map<string, AircraftState>()

    for (const pilot of filteredPilots) {
      const callsign = pilot.callsign
      // Preserve existing interpolation state if available
      if (aircraftStates.has(callsign)) {
        newAircraftStates.set(callsign, aircraftStates.get(callsign)!)
      }
      if (previousStates.has(callsign)) {
        newPreviousStates.set(callsign, previousStates.get(callsign)!)
      }
    }

    set({
      pilots: filteredPilots,
      pilotsFilteredByDistance: filteredPilots.length,
      aircraftStates: newAircraftStates,
      previousStates: newPreviousStates
    })
  }
}))
