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

  // Camera position for nearest METAR mode
  cameraPosition: { lat: number; lon: number } | null
  useNearestMetar: boolean  // true when using position-based weather instead of airport METAR

  // Auto-refresh state
  refreshIntervalId: ReturnType<typeof setInterval> | null

  // Actions
  fetchWeather: (icao: string) => Promise<void>
  fetchNearestWeather: (lat: number, lon: number) => Promise<void>
  updateCameraPosition: (lat: number, lon: number) => void
  startAutoRefresh: (icao: string) => void
  startNearestAutoRefresh: () => void
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

// Grid size for position-based cache (in degrees, ~6nm)
const POSITION_GRID_SIZE = 0.1

// Minimum distance change to trigger a new nearest METAR fetch (in degrees, ~3nm)
const POSITION_CHANGE_THRESHOLD = 0.05

export const useWeatherStore = create<WeatherState>((set, get) => ({
  // Initial state
  currentMetar: null,
  lastFetchTime: 0,
  isLoading: false,
  error: null,
  fogDensity: 0,
  cloudLayers: [],
  cameraPosition: null,
  useNearestMetar: false,
  refreshIntervalId: null,

  fetchWeather: async (icao: string) => {
    set({ isLoading: true, error: null, useNearestMetar: false })

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

  fetchNearestWeather: async (lat: number, lon: number) => {
    set({ isLoading: true, error: null, useNearestMetar: true })

    try {
      const metar = await metarService.fetchNearestMetar(lat, lon, 100)

      if (metar) {
        set({
          currentMetar: metar,
          lastFetchTime: Date.now(),
          isLoading: false,
          error: null,
          fogDensity: visibilityToFogDensity(metar.visib),
          cloudLayers: parseCloudLayers(metar),
          cameraPosition: { lat, lon }
        })
      } else {
        set({
          isLoading: false,
          error: 'No nearby METAR stations'
        })
      }
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch nearest weather'
      })
    }
  },

  updateCameraPosition: (lat: number, lon: number) => {
    const state = get()
    const oldPos = state.cameraPosition

    // Only update and potentially refetch if position changed significantly
    // or if we don't have weather data yet
    if (!state.useNearestMetar) {
      // Not in nearest METAR mode, just store position for potential future use
      set({ cameraPosition: { lat, lon } })
      return
    }

    // Check if position changed enough to warrant a new fetch
    if (oldPos) {
      const latDiff = Math.abs(lat - oldPos.lat)
      const lonDiff = Math.abs(lon - oldPos.lon)

      if (latDiff < POSITION_CHANGE_THRESHOLD && lonDiff < POSITION_CHANGE_THRESHOLD) {
        // Position hasn't changed much, no need to refetch
        return
      }
    }

    // Position changed significantly, update and fetch
    set({ cameraPosition: { lat, lon } })

    // Throttle fetches - only fetch if last fetch was > 30 seconds ago
    const timeSinceLastFetch = Date.now() - state.lastFetchTime
    if (timeSinceLastFetch > 30000) {
      state.fetchNearestWeather(lat, lon)
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

    set({ refreshIntervalId: intervalId, useNearestMetar: false })
  },

  startNearestAutoRefresh: () => {
    const state = get()

    // Clear any existing interval
    if (state.refreshIntervalId) {
      clearInterval(state.refreshIntervalId)
    }

    // Start new 5-minute refresh interval for nearest METAR
    const intervalId = setInterval(() => {
      const currentState = get()
      if (currentState.cameraPosition && currentState.useNearestMetar) {
        currentState.fetchNearestWeather(
          currentState.cameraPosition.lat,
          currentState.cameraPosition.lon
        )
      }
    }, 5 * 60 * 1000) // 5 minutes

    set({ refreshIntervalId: intervalId, useNearestMetar: true })
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
      cameraPosition: null,
      useNearestMetar: false,
      refreshIntervalId: null
    })
  }
}))
