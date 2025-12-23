import { create } from 'zustand'
import { metarService, type MetarData } from '../services/MetarService'
import type { CloudLayer, PrecipitationState, WindState } from '../types'
import {
  WEATHER_REFRESH_INTERVAL,
  NEAREST_METAR_THROTTLE,
  POSITION_CHANGE_THRESHOLD,
  PRECIP_VIS_THRESHOLD_HIGH,
  PRECIP_VIS_THRESHOLD_LOW,
  PRECIP_VIS_FACTOR_MIN,
  PRECIP_VIS_FACTOR_MAX
} from '../constants'

interface WeatherState {
  // Current weather data
  currentMetar: MetarData | null
  lastFetchTime: number
  isLoading: boolean
  error: string | null

  // Derived weather effects
  fogDensity: number        // 0 to ~0.0003, computed from visibility
  cloudLayers: CloudLayer[] // Processed cloud data

  // Precipitation and wind state (for particle effects)
  precipitation: PrecipitationState
  wind: WindState

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

  // Debug overrides (for development)
  setPrecipitation: (precipitation: PrecipitationState) => void
  setWind: (wind: WindState) => void
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

/**
 * Calculate visibility factor for precipitation particles
 * Lower visibility = more particles (higher factor)
 */
function calculateVisibilityFactor(visibSM: number): number {
  if (visibSM >= PRECIP_VIS_THRESHOLD_HIGH) return PRECIP_VIS_FACTOR_MIN
  if (visibSM <= PRECIP_VIS_THRESHOLD_LOW) return PRECIP_VIS_FACTOR_MAX

  // Linear interpolation between thresholds
  const range = PRECIP_VIS_THRESHOLD_HIGH - PRECIP_VIS_THRESHOLD_LOW
  const t = (visibSM - PRECIP_VIS_THRESHOLD_LOW) / range
  return PRECIP_VIS_FACTOR_MAX - t * (PRECIP_VIS_FACTOR_MAX - PRECIP_VIS_FACTOR_MIN)
}

/**
 * Build precipitation state from METAR data
 */
function parsePrecipitationState(metar: MetarData): PrecipitationState {
  return {
    active: metar.precipitation.length > 0,
    types: metar.precipitation,
    visibilityFactor: calculateVisibilityFactor(metar.visib),
    hasThunderstorm: metar.hasThunderstorm
  }
}

/** Default precipitation state (no precipitation) */
const DEFAULT_PRECIPITATION: PrecipitationState = {
  active: false,
  types: [],
  visibilityFactor: 1.0,
  hasThunderstorm: false
}

/** Default wind state (calm) */
const DEFAULT_WIND: WindState = {
  direction: 0,
  speed: 0,
  gustSpeed: null,
  isVariable: false
}

export const useWeatherStore = create<WeatherState>((set, get) => ({
  // Initial state
  currentMetar: null,
  lastFetchTime: 0,
  isLoading: false,
  error: null,
  fogDensity: 0,
  cloudLayers: [],
  precipitation: DEFAULT_PRECIPITATION,
  wind: DEFAULT_WIND,
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
          cloudLayers: parseCloudLayers(metar),
          precipitation: parsePrecipitationState(metar),
          wind: metar.wind
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
          precipitation: parsePrecipitationState(metar),
          wind: metar.wind,
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

    // Throttle fetches - only fetch if last fetch was > NEAREST_METAR_THROTTLE ms ago
    const timeSinceLastFetch = Date.now() - state.lastFetchTime
    if (timeSinceLastFetch > NEAREST_METAR_THROTTLE) {
      state.fetchNearestWeather(lat, lon)
    }
  },

  startAutoRefresh: (icao: string) => {
    const state = get()

    // Clear any existing interval
    if (state.refreshIntervalId) {
      clearInterval(state.refreshIntervalId)
    }

    // Start new refresh interval
    const intervalId = setInterval(() => {
      get().fetchWeather(icao)
    }, WEATHER_REFRESH_INTERVAL)

    set({ refreshIntervalId: intervalId, useNearestMetar: false })
  },

  startNearestAutoRefresh: () => {
    const state = get()

    // Clear any existing interval
    if (state.refreshIntervalId) {
      clearInterval(state.refreshIntervalId)
    }

    // Start new refresh interval for nearest METAR
    const intervalId = setInterval(() => {
      const currentState = get()
      if (currentState.cameraPosition && currentState.useNearestMetar) {
        currentState.fetchNearestWeather(
          currentState.cameraPosition.lat,
          currentState.cameraPosition.lon
        )
      }
    }, WEATHER_REFRESH_INTERVAL)

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
      precipitation: DEFAULT_PRECIPITATION,
      wind: DEFAULT_WIND,
      cameraPosition: null,
      useNearestMetar: false,
      refreshIntervalId: null
    })
  },

  // Debug overrides - allow dev panel to set weather state directly
  setPrecipitation: (precipitation: PrecipitationState) => {
    set({ precipitation })
  },

  setWind: (wind: WindState) => {
    set({ wind })
  }
}))
