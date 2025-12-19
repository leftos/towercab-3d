import { create } from 'zustand'
import type { PilotData, VatsimData, AircraftState } from '../types/vatsim'
import { interpolateAircraftState } from '../utils/interpolation'

const VATSIM_API_URL = 'https://data.vatsim.net/v3/vatsim-data.json'
const POLL_INTERVAL = 3000 // Poll every 3 seconds (VATSIM updates ~15s, but poll faster to catch updates sooner)
const DEFAULT_UPDATE_INTERVAL = 15000 // Expected time between actual VATSIM data updates

interface VatsimStore {
  // Data
  pilots: PilotData[]
  aircraftStates: Map<string, AircraftState>
  previousStates: Map<string, AircraftState>

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
}

export const useVatsimStore = create<VatsimStore>((set, get) => ({
  // Initial state
  pilots: [],
  aircraftStates: new Map(),
  previousStates: new Map(),
  lastVatsimTimestamp: 0,
  lastUpdateInterval: DEFAULT_UPDATE_INTERVAL, // Default to expected VATSIM update interval
  isConnected: false,
  lastUpdate: null,
  error: null,
  isLoading: false,
  pollingInterval: null,

  // Fetch data from VATSIM API
  fetchData: async () => {
    set({ isLoading: true, error: null })

    try {
      const response = await fetch(VATSIM_API_URL)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const data: VatsimData = await response.json()

      // Parse VATSIM's update timestamp for stale detection
      const vatsimTimestamp = new Date(data.general.update_timestamp).getTime()
      const { lastVatsimTimestamp } = get()

      // Detect stale data - if VATSIM timestamp hasn't changed, skip this update
      if (vatsimTimestamp === lastVatsimTimestamp) {
        set({ isLoading: false })
        console.log('VATSIM data unchanged, skipping update')
        return
      }

      // Calculate actual interval between VATSIM updates (for accurate interpolation timing)
      // This tells us how long interpolation should take to reach the target
      const actualInterval = lastVatsimTimestamp > 0
        ? vatsimTimestamp - lastVatsimTimestamp
        : DEFAULT_UPDATE_INTERVAL

      // Use local time for interpolation (avoids clock skew issues with VATSIM server)
      const now = Date.now()

      // Calculate current interpolated positions to use as the starting point
      // This prevents jumps when new data arrives - aircraft continue from where they are
      const currentStates = get().aircraftStates
      const previousStates = get().previousStates
      const newPreviousStates = new Map<string, AircraftState>()

      for (const [callsign, currentState] of currentStates) {
        const prevState = previousStates.get(callsign)
        const interpolated = interpolateAircraftState(prevState, currentState, now)

        if (interpolated) {
          // Use the current interpolated position as the new "previous" state
          // This ensures smooth transitions without jumps
          // Set timestamp to (now - actualInterval) so interpolation spans the
          // same duration as the actual time between VATSIM updates
          newPreviousStates.set(callsign, {
            ...currentState,
            latitude: interpolated.interpolatedLatitude,
            longitude: interpolated.interpolatedLongitude,
            altitude: interpolated.interpolatedAltitude,
            heading: interpolated.interpolatedHeading,
            timestamp: now - actualInterval
          })
        } else {
          // No interpolation available, use raw state
          newPreviousStates.set(callsign, currentState)
        }
      }

      // Create new aircraft states using LOCAL time for interpolation consistency
      const newAircraftStates = new Map<string, AircraftState>()
      for (const pilot of data.pilots) {
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

      set({
        pilots: data.pilots,
        aircraftStates: newAircraftStates,
        previousStates: newPreviousStates,
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
    const interval = setInterval(fetchData, POLL_INTERVAL)
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
  }
}))
