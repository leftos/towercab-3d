/**
 * Runway data store
 *
 * Manages loading state and provides access to runway data from OurAirports.
 * Runway data is used by the smart sort algorithm to detect aircraft phase of flight.
 */

import { create } from 'zustand'
import type { Runway } from '../types/airport'
import { runwayService } from '../services/RunwayService'

interface RunwayStore {
  /** Whether runway data is currently being loaded */
  isLoading: boolean

  /** Whether runway data has been successfully loaded */
  isLoaded: boolean

  /** Error message if loading failed */
  error: string | null

  /** Number of airports with runway data */
  airportCount: number

  /** Load runway database (call once on app startup) */
  loadRunways: () => Promise<void>

  /** Get runways for a specific airport */
  getRunwaysForAirport: (icao: string) => Runway[]

  /** Get runways with valid threshold coordinates */
  getRunwaysWithCoordinates: (icao: string) => Runway[]
}

export const useRunwayStore = create<RunwayStore>()((set, get) => ({
  isLoading: false,
  isLoaded: false,
  error: null,
  airportCount: 0,

  loadRunways: async () => {
    const { isLoaded, isLoading } = get()
    if (isLoaded || isLoading) return

    set({ isLoading: true, error: null })

    try {
      await runwayService.loadRunways()
      set({
        isLoading: false,
        isLoaded: true,
        airportCount: runwayService.getAirportCount()
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load runway data'
      console.error('[runwayStore] Load failed:', message)
      set({
        isLoading: false,
        error: message
      })
    }
  },

  getRunwaysForAirport: (icao: string) => {
    return runwayService.getRunwaysForAirport(icao)
  },

  getRunwaysWithCoordinates: (icao: string) => {
    return runwayService.getRunwaysWithCoordinates(icao)
  }
}))
