import { create } from 'zustand'
import { metarService, type MetarData } from '../services/MetarService'

export interface CloudLayer {
  altitude: number    // Altitude in meters above ground
  coverage: number    // 0-1 coverage (FEW=0.25, SCT=0.5, BKN=0.75, OVC=1.0)
  type: string        // Original cover type (FEW, SCT, BKN, OVC)
}

interface WeatherState {
  // Current weather data
  currentMetar: MetarData | null
  lastFetchTime: number
  isLoading: boolean
  error: string | null

  // Derived weather effects
  fogDensity: number        // 0 to ~0.0003, computed from visibility
  cloudLayers: CloudLayer[] // Processed cloud data

  // Auto-refresh state
  refreshIntervalId: ReturnType<typeof setInterval> | null

  // Actions
  fetchWeather: (icao: string) => Promise<void>
  startAutoRefresh: (icao: string) => void
  stopAutoRefresh: () => void
  clearWeather: () => void
}

/**
 * Convert visibility in statute miles to Cesium fog density
 * Cesium default fog density is 0.0006
 * Higher density = denser fog = less visibility
 *
 * Visibility reference:
 * - 1/4 SM (400m) = very dense fog, LIFR conditions
 * - 1 SM (1600m) = dense fog, IFR conditions
 * - 3 SM (4800m) = moderate fog, MVFR conditions
 * - 10+ SM = clear, VFR conditions
 */
function visibilityToFogDensity(visibSM: number): number {
  // No fog for good visibility (10+ SM)
  if (visibSM >= 10) return 0

  // Very dense fog for extremely low visibility (< 1/4 SM)
  if (visibSM <= 0.25) return 0.015

  // Use inverse relationship: lower visibility = higher density
  // Map visibility range [0.25, 10] to density range [0.015, 0]
  // Using logarithmic scale for more natural fog perception
  const minVis = 0.25
  const maxVis = 10
  const maxDensity = 0.015

  // Logarithmic interpolation
  const logMin = Math.log10(minVis)
  const logMax = Math.log10(maxVis)
  const logVis = Math.log10(visibSM)

  // Normalize to 0-1 range (0 = worst visibility, 1 = best visibility)
  const normalized = (logVis - logMin) / (logMax - logMin)

  // Invert and scale to density (higher normalized = lower density)
  return maxDensity * (1 - normalized)
}

/**
 * Convert cloud cover code to opacity value
 */
function coverageToOpacity(cover: string): number {
  const coverageMap: Record<string, number> = {
    'FEW': 0.25,   // 1-2 oktas
    'SCT': 0.50,   // 3-4 oktas (scattered)
    'BKN': 0.75,   // 5-7 oktas (broken)
    'OVC': 1.00,   // 8 oktas (overcast)
    'SKC': 0,      // Sky clear
    'CLR': 0,      // Clear below 12,000ft
    'NSC': 0,      // No significant cloud
    'NCD': 0,      // No cloud detected
  }
  return coverageMap[cover.toUpperCase()] ?? 0
}

/**
 * Parse METAR cloud data into CloudLayer format
 */
function parseCloudLayers(metar: MetarData): CloudLayer[] {
  if (!metar.clouds || metar.clouds.length === 0) return []

  return metar.clouds
    .filter(c => coverageToOpacity(c.cover) > 0)
    .map(c => ({
      altitude: c.base * 0.3048, // Convert feet to meters
      coverage: coverageToOpacity(c.cover),
      type: c.cover.toUpperCase()
    }))
    .slice(0, 4) // Max 4 cloud layers
}

export const useWeatherStore = create<WeatherState>((set, get) => ({
  // Initial state
  currentMetar: null,
  lastFetchTime: 0,
  isLoading: false,
  error: null,
  fogDensity: 0,
  cloudLayers: [],
  refreshIntervalId: null,

  fetchWeather: async (icao: string) => {
    set({ isLoading: true, error: null })

    try {
      const metar = await metarService.fetchMetar(icao)

      if (metar) {
        set({
          currentMetar: metar,
          lastFetchTime: Date.now(),
          isLoading: false,
          error: null,
          fogDensity: visibilityToFogDensity(metar.visib),
          cloudLayers: parseCloudLayers(metar)
        })
      } else {
        set({
          isLoading: false,
          error: 'No METAR data available'
        })
      }
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch weather'
      })
    }
  },

  startAutoRefresh: (icao: string) => {
    const state = get()

    // Clear any existing interval
    if (state.refreshIntervalId) {
      clearInterval(state.refreshIntervalId)
    }

    // Start new 5-minute refresh interval
    const intervalId = setInterval(() => {
      get().fetchWeather(icao)
    }, 5 * 60 * 1000) // 5 minutes

    set({ refreshIntervalId: intervalId })
  },

  stopAutoRefresh: () => {
    const state = get()
    if (state.refreshIntervalId) {
      clearInterval(state.refreshIntervalId)
      set({ refreshIntervalId: null })
    }
  },

  clearWeather: () => {
    const state = get()
    if (state.refreshIntervalId) {
      clearInterval(state.refreshIntervalId)
    }
    set({
      currentMetar: null,
      lastFetchTime: 0,
      isLoading: false,
      error: null,
      fogDensity: 0,
      cloudLayers: [],
      refreshIntervalId: null
    })
  }
}))
