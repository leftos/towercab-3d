import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Airport } from '../types/airport'
import type { CustomTowerPosition } from '../types/mod'
import { getEstimatedTowerHeight } from '../types/airport'
import { useCameraStore } from './cameraStore'
import { useViewportStore } from './viewportStore'
import { useVatsimStore } from './vatsimStore'
import { modService } from '../services/ModService'

interface AirportStore {
  // Data
  airports: Map<string, Airport>
  isLoaded: boolean

  // Current selection
  currentAirport: Airport | null
  towerHeight: number  // meters above ground
  customTowerPosition: CustomTowerPosition | null  // Custom tower position from tower mod or tower-positions.json
  customHeading: number | null  // Custom default heading in degrees, or null to use app default

  // Recent airports (persisted)
  recentAirports: string[]  // ICAO codes

  // UI state
  isAirportSelectorOpen: boolean

  // Actions
  loadAirports: (data: Record<string, Airport>) => void
  selectAirport: (icao: string) => void
  searchAirports: (query: string) => Airport[]
  addToRecent: (icao: string) => void
  setAirportSelectorOpen: (open: boolean) => void
}

const MAX_RECENT_AIRPORTS = 10

export const useAirportStore = create<AirportStore>()(
  persist(
    (set, get) => ({
      // Initial state
      airports: new Map(),
      isLoaded: false,
      currentAirport: null,
      towerHeight: 35,
      customTowerPosition: null,
      customHeading: null,
      recentAirports: [],
      isAirportSelectorOpen: false,

      // Load airport database
      loadAirports: (data: Record<string, Airport>) => {
        const airports = new Map<string, Airport>()
        for (const [icao, airport] of Object.entries(data)) {
          airports.set(icao.toUpperCase(), airport)
        }
        set({ airports, isLoaded: true })
      },

      // Select an airport
      selectAirport: (icao: string) => {
        const { airports, addToRecent } = get()
        const airport = airports.get(icao.toUpperCase())

        if (airport) {
          const towerHeight = getEstimatedTowerHeight(airport)

          // Check for custom tower position from tower mod or tower-positions.json
          // Priority: tower mod cabPosition > tower-positions.json
          let customTowerPosition: CustomTowerPosition | null = null
          let customHeading: number | null = null

          // Check tower mod first (higher priority)
          const towerMod = modService.getTowerModel(icao)
          if (towerMod?.manifest.cabPosition) {
            customTowerPosition = {
              lat: towerMod.manifest.cabPosition.lat,
              lon: towerMod.manifest.cabPosition.lon,
              aglHeight: towerMod.manifest.cabPosition.aglHeight,
              heading: towerMod.manifest.cabHeading ?? 0
            }
            customHeading = towerMod.manifest.cabHeading ?? 0
          }

          // Fall back to tower-positions.json if no tower mod position
          if (!customTowerPosition) {
            const customPos = modService.getCustomTowerPosition(icao)
            if (customPos) {
              customTowerPosition = customPos
              customHeading = customPos.heading ?? 0
            }
          }

          set({
            currentAirport: airport,
            towerHeight,
            customTowerPosition,
            customHeading,
            isAirportSelectorOpen: false
          })
          addToRecent(icao)

          // Update camera store with new airport (loads saved camera settings)
          useCameraStore.getState().setCurrentAirport(icao)

          // Update viewport store (saves/loads viewport configurations per airport)
          useViewportStore.getState().setCurrentAirport(icao)

          // Immediately update VATSIM reference position to trigger re-filter
          // This ensures aircraft near the new airport are visible right away
          useVatsimStore.getState().setReferencePosition(airport.lat, airport.lon)
        }
      },

      // Search airports by query
      searchAirports: (query: string): Airport[] => {
        const { airports } = get()
        if (!query.trim()) return []

        const normalizedQuery = query.toLowerCase().trim()
        const results: Airport[] = []

        for (const airport of airports.values()) {
          // Search in ICAO, IATA, name, and city
          if (
            airport.icao.toLowerCase().includes(normalizedQuery) ||
            airport.iata?.toLowerCase().includes(normalizedQuery) ||
            airport.name.toLowerCase().includes(normalizedQuery) ||
            airport.city.toLowerCase().includes(normalizedQuery)
          ) {
            results.push(airport)
          }

          // Limit results for performance
          if (results.length >= 50) break
        }

        // Sort results: exact ICAO/IATA matches first, then by name
        return results.sort((a, b) => {
          const aExact = a.icao.toLowerCase() === normalizedQuery ||
                         a.iata?.toLowerCase() === normalizedQuery
          const bExact = b.icao.toLowerCase() === normalizedQuery ||
                         b.iata?.toLowerCase() === normalizedQuery
          if (aExact && !bExact) return -1
          if (!aExact && bExact) return 1
          return a.name.localeCompare(b.name)
        })
      },

      // Add airport to recent list
      addToRecent: (icao: string) => {
        const { recentAirports } = get()
        const normalizedIcao = icao.toUpperCase()

        // Remove if already exists
        const filtered = recentAirports.filter((i) => i !== normalizedIcao)

        // Add to front and limit size
        const updated = [normalizedIcao, ...filtered].slice(0, MAX_RECENT_AIRPORTS)

        set({ recentAirports: updated })
      },

      // Toggle airport selector
      setAirportSelectorOpen: (open: boolean) => {
        set({ isAirportSelectorOpen: open })
      }
    }),
    {
      name: 'airport-store',
      partialize: (state) => ({
        recentAirports: state.recentAirports
      })
    }
  )
)
