import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface AircraftFilterStore {
  // Filter states
  searchQuery: string
  filterAirportTraffic: boolean
  filterWeatherVisibility: boolean

  // Actions
  setSearchQuery: (query: string) => void
  setFilterAirportTraffic: (enabled: boolean) => void
  setFilterWeatherVisibility: (enabled: boolean) => void
  resetFilters: () => void
}

const DEFAULT_FILTERS = {
  searchQuery: '',
  filterAirportTraffic: false,
  filterWeatherVisibility: false
}

export const useAircraftFilterStore = create<AircraftFilterStore>()(
  persist(
    (set) => ({
      ...DEFAULT_FILTERS,

      setSearchQuery: (query: string) => set({ searchQuery: query }),

      setFilterAirportTraffic: (enabled: boolean) => set({ filterAirportTraffic: enabled }),

      setFilterWeatherVisibility: (enabled: boolean) => set({ filterWeatherVisibility: enabled }),

      resetFilters: () => set(DEFAULT_FILTERS)
    }),
    {
      name: 'aircraft-filter-store'
    }
  )
)
