import { create } from 'zustand'
import { VATSIM_ACTUAL_UPDATE_INTERVAL, VATSIM_DATA_URL, VATSIM_POLL_INTERVAL } from '../constants'
import { SOURCE_DISPLAY_DELAYS } from '../constants/aircraft-timeline'
import { geoidService } from '../services/GeoidService'
import type { AircraftMetadata, AircraftObservation } from '../types/aircraft-timeline'
import type { AircraftState, PilotData, VatsimData } from '../types/vatsim'
import { calculateDistanceNM } from '../utils/geoMath'
import { useAircraftTimelineStore } from './aircraftTimelineStore'
// Note: Intentional coupling - vatsimStore triggers replay snapshots on each VATSIM update.
// This is simpler than an event system and acceptable since replay depends on vatsim data.
import { useReplayStore } from './replayStore'
import { useSettingsStore } from './settingsStore'

// Backoff schedule for VATSIM fetch failures. We don't want to hammer the API
// at 1Hz when it's down or rate-limiting us. Resets to index 0 on the first
// successful fetch.
const VATSIM_BACKOFF_MS = [VATSIM_POLL_INTERVAL, 5000, 15000, 30000, 60000]

// Module-scope guard so a slow fetch can't be re-entered by the next tick.
// Without this, two in-flight fetches both pass the timestamp-equality skip
// and produce duplicate observations.
let fetchInFlight = false
let consecutiveFailures = 0

interface ReferencePosition {
  latitude: number
  longitude: number
}

interface VatsimStore {
  // Data
  allPilots: PilotData[] // All pilots from API (for global search, stats)
  pilots: PilotData[] // Filtered pilots (near reference position)

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

  // Polling — chained setTimeout (not setInterval) so failures can back off and
  // a slow fetch can't be re-entered while still in flight.
  pollingInterval: number | null
  isPolling: boolean

  // Actions
  fetchData: () => Promise<void>
  startPolling: () => void
  stopPolling: () => void
  resetTimestamp: () => void
  setReferencePosition: (lat: number, lon: number) => void
  refilterPilots: () => void
}

export const useVatsimStore = create<VatsimStore>((set, get) => ({
  // Initial state
  allPilots: [],
  pilots: [],
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
  isPolling: false,

  // Fetch data from VATSIM API
  fetchData: async () => {
    // Guard against overlapping fetches. setInterval used to fire every 1s
    // regardless of whether the previous fetch had returned, which let two
    // fetches race past the timestamp-equality skip and duplicate observations.
    if (fetchInFlight) return
    fetchInFlight = true
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

      // Calculate actual interval between VATSIM updates (used for replay)
      const actualInterval =
        lastVatsimTimestamp > 0 ? vatsimTimestamp - lastVatsimTimestamp : VATSIM_ACTUAL_UPDATE_INTERVAL

      // Use local time for timestamps
      const now = Date.now()

      // Get distance filter radius from settings
      const aircraftDataRadiusNM = useSettingsStore.getState().memory.aircraftDataRadiusNM

      // Filter pilots by distance from reference position
      // Note: ALL pilots are still added to the timeline store for broadcasting
      // to remote clients and insets, which do their own filtering.
      const totalPilotsFromApi = data.pilots.length
      let filteredPilots: PilotData[] = []

      if (referencePosition) {
        filteredPilots = data.pilots.filter((pilot) => {
          const distance = calculateDistanceNM(
            referencePosition.latitude,
            referencePosition.longitude,
            pilot.latitude,
            pilot.longitude,
          )
          return distance <= aircraftDataRadiusNM
        })
      }

      const pilotsFilteredByDistance = filteredPilots.length

      set({
        allPilots: data.pilots,
        pilots: filteredPilots,
        totalPilotsFromApi,
        pilotsFilteredByDistance,
        lastVatsimTimestamp: vatsimTimestamp,
        lastUpdateInterval: actualInterval,
        isConnected: true,
        lastUpdate: new Date(),
        isLoading: false,
        error: null,
      })

      // =========================================================================
      // Feed observations into the unified timeline store
      // =========================================================================
      const timelineStore = useAircraftTimelineStore.getState()
      const observationBatch: Array<{
        callsign: string
        observation: AircraftObservation
        metadata: AircraftMetadata
      }> = []

      // Add ALL pilots to timeline store (not just filtered)
      // This ensures remote clients and insets receive all observations
      // and can do their own filtering based on their reference position
      for (const pilot of data.pilots) {
        const observation: AircraftObservation = {
          latitude: pilot.latitude,
          longitude: pilot.longitude,
          altitude: geoidService.mslToEllipsoidal(pilot.latitude, pilot.longitude, pilot.altitude * 0.3048), // Convert feet MSL → meters ellipsoidal
          heading: pilot.heading,
          groundspeed: pilot.groundspeed,
          groundTrack: null, // VATSIM doesn't provide ground track
          headingIsTrue: true, // VATSIM heading is always reliable (from simulator)
          // Extended ADS-B data (not available from VATSIM)
          onGround: null,
          pitch: null,
          roll: null,
          verticalRate: null,
          observedAt: vatsimTimestamp, // When VATSIM says this was true
          receivedAt: now,
          source: 'vatsim',
          displayDelay: SOURCE_DISPLAY_DELAYS.vatsim,
        }

        const metadata: AircraftMetadata = {
          cid: pilot.cid,
          aircraftType: pilot.flight_plan?.aircraft_short || null,
          transponder: pilot.transponder,
          departure: pilot.flight_plan?.departure || null,
          arrival: pilot.flight_plan?.arrival || null,
        }

        observationBatch.push({ callsign: pilot.callsign, observation, metadata })
      }

      // Add all observations in batch (broadcasts to insets and remote clients)
      if (observationBatch.length > 0) {
        timelineStore.addObservationBatch(observationBatch)
      }

      // Build UNFILTERED states for replay snapshot
      // This ensures replay contains ALL aircraft, not just those within current filter radius
      const allAircraftStates = new Map<string, AircraftState>()

      for (const pilot of data.pilots) {
        const state: AircraftState = {
          callsign: pilot.callsign,
          cid: pilot.cid,
          latitude: pilot.latitude,
          longitude: pilot.longitude,
          altitude: geoidService.mslToEllipsoidal(pilot.latitude, pilot.longitude, pilot.altitude * 0.3048), // Convert VATSIM feet MSL → meters ellipsoidal
          groundspeed: pilot.groundspeed,
          heading: pilot.heading,
          transponder: pilot.transponder,
          aircraftType: pilot.flight_plan?.aircraft_short || null,
          departure: pilot.flight_plan?.departure || null,
          arrival: pilot.flight_plan?.arrival || null,
          timestamp: now,
        }
        allAircraftStates.set(pilot.callsign, state)
      }

      // Trigger replay snapshot recording with ALL aircraft
      useReplayStore.getState().addSnapshot(allAircraftStates, vatsimTimestamp, actualInterval)

      // Successful fetch — reset failure counter so next interval is the normal poll cadence.
      consecutiveFailures = 0
    } catch (error) {
      consecutiveFailures += 1
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      set({
        isConnected: false,
        isLoading: false,
        error: `Failed to fetch VATSIM data: ${errorMessage}`,
      })
      console.error('VATSIM API error:', error)
    } finally {
      fetchInFlight = false

      // Schedule next fetch if still polling. Using setTimeout (not setInterval)
      // measures the delay from completion, ensuring failures back off instead
      // of hammering the API at 1Hz.
      if (get().isPolling) {
        const delayMs =
          consecutiveFailures > 0
            ? VATSIM_BACKOFF_MS[Math.min(consecutiveFailures - 1, VATSIM_BACKOFF_MS.length - 1)]
            : VATSIM_POLL_INTERVAL
        const timer = setTimeout(() => {
          if (get().isPolling) get().fetchData()
        }, delayMs)
        set({ pollingInterval: timer })
      } else {
        set({ pollingInterval: null })
      }
    }
  },

  // Start polling for data
  startPolling: () => {
    const { isPolling, fetchData } = get()

    // Don't start if already polling
    if (isPolling) {
      return
    }

    // Reset failure counter when (re)starting so we don't carry stale backoff state
    // across stop/start cycles (e.g., toggling between data sources via Settings).
    consecutiveFailures = 0
    set({ isPolling: true })

    // Fetch immediately — finally{} chains the next setTimeout from here.
    fetchData()
  },

  // Stop polling
  stopPolling: () => {
    const { pollingInterval } = get()
    if (pollingInterval !== null) {
      clearTimeout(pollingInterval)
    }
    set({ isPolling: false, pollingInterval: null })
  },

  // Reset the timestamp to force next fetch to process data
  // Used when switching data sources to ensure we don't skip the first fetch
  resetTimestamp: () => {
    set({ lastVatsimTimestamp: 0 })
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
    const { allPilots, referencePosition, lastVatsimTimestamp } = get()
    const aircraftDataRadiusNM = useSettingsStore.getState().memory.aircraftDataRadiusNM

    if (!referencePosition || allPilots.length === 0) {
      return
    }

    const now = Date.now()

    // Filter pilots by distance from reference position
    const filteredPilots = allPilots.filter((pilot) => {
      const distance = calculateDistanceNM(
        referencePosition.latitude,
        referencePosition.longitude,
        pilot.latitude,
        pilot.longitude,
      )
      return distance <= aircraftDataRadiusNM
    })

    // Add observations to timeline store for aircraft not already in timeline
    // This ensures the timeline gets populated immediately when switching airports
    const timelineStore = useAircraftTimelineStore.getState()
    const observationBatch: Array<{
      callsign: string
      observation: AircraftObservation
      metadata: AircraftMetadata
    }> = []

    for (const pilot of filteredPilots) {
      const existingTimeline = timelineStore.getTimeline(pilot.callsign)
      if (!existingTimeline) {
        const observation: AircraftObservation = {
          latitude: pilot.latitude,
          longitude: pilot.longitude,
          altitude: geoidService.mslToEllipsoidal(pilot.latitude, pilot.longitude, pilot.altitude * 0.3048),
          heading: pilot.heading,
          groundspeed: pilot.groundspeed,
          groundTrack: null,
          headingIsTrue: true,
          onGround: null,
          pitch: null,
          roll: null,
          verticalRate: null,
          observedAt: lastVatsimTimestamp || now,
          receivedAt: now,
          source: 'vatsim',
          displayDelay: SOURCE_DISPLAY_DELAYS.vatsim,
        }

        const metadata: AircraftMetadata = {
          cid: pilot.cid,
          aircraftType: pilot.flight_plan?.aircraft_short || null,
          transponder: pilot.transponder,
          departure: pilot.flight_plan?.departure || null,
          arrival: pilot.flight_plan?.arrival || null,
        }

        observationBatch.push({ callsign: pilot.callsign, observation, metadata })
      }
    }

    // Add observations to timeline store
    if (observationBatch.length > 0) {
      timelineStore.addObservationBatch(observationBatch)
    }

    set({
      pilots: filteredPilots,
      pilotsFilteredByDistance: filteredPilots.length,
    })
  },
}))
