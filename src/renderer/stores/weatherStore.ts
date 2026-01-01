import { create } from 'zustand'
import { metarService, type MetarData } from '../services/MetarService'
import type { CloudLayer, PrecipitationState, WindState, DistancedMetar, InterpolatedWeather } from '../types'
import { interpolateWeather } from '../utils/weatherInterpolation'
import {
  WEATHER_REFRESH_INTERVAL,
  NEAREST_METAR_THROTTLE,
  POSITION_CHANGE_THRESHOLD,
  PRECIP_VIS_THRESHOLD_HIGH,
  PRECIP_VIS_THRESHOLD_LOW,
  PRECIP_VIS_FACTOR_MIN,
  PRECIP_VIS_FACTOR_MAX,
  INTERPOLATION_POSITION_THRESHOLD_DEG
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

  // Weather interpolation state
  nearbyMetars: DistancedMetar[]              // Nearby METAR stations with distance
  interpolatedWeather: InterpolatedWeather | null  // Interpolated weather from nearby stations
  lastInterpolationPosition: { lat: number; lon: number } | null  // Position used for last interpolation
  lastInterpolationTime: number               // Timestamp of last interpolation fetch
  useInterpolation: boolean                   // true when using interpolated weather

  // Auto-refresh state
  refreshIntervalId: ReturnType<typeof setInterval> | null

  // Debug override mode - when true, METAR updates don't overwrite precipitation/wind/clouds
  isDebugOverriding: boolean

  // Instant update flag - when true, smoothing should be bypassed for immediate visual update
  instantUpdatePending: boolean

  // Actions
  fetchWeather: (icao: string) => Promise<void>
  fetchNearestWeather: (lat: number, lon: number) => Promise<void>
  fetchInterpolatedWeather: (lat: number, lon: number) => Promise<void>
  updateCameraPosition: (lat: number, lon: number) => void
  startAutoRefresh: (icao: string) => void
  startNearestAutoRefresh: () => void
  startInterpolatedAutoRefresh: () => void
  stopAutoRefresh: () => void
  clearWeather: () => void
  setUseInterpolation: (useInterpolation: boolean) => void

  // Debug overrides (for development)
  setDebugOverriding: (isOverriding: boolean) => void
  setPrecipitation: (precipitation: PrecipitationState) => void
  setWind: (wind: WindState) => void
  setCloudLayers: (cloudLayers: CloudLayer[]) => void
  /** Trigger instant update (bypasses smoothing), returns true if flag was set */
  triggerInstantUpdate: () => void
  /** Consume instant update flag, returns true if flag was pending */
  consumeInstantUpdate: () => boolean
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
 * Convert cloud cover code to coverage value.
 * Returns the midpoint of the okta range for stable texture caching.
 * Visual variety comes from the noise seed in texture generation.
 */
function coverageToOpacity(cover: string): number {
  // Use midpoint of each okta range for stable/deterministic values
  // This ensures texture caching works (coverage doesn't change between METAR refetches)
  const coverageMap: Record<string, number> = {
    'FEW': 0.1875,  // 1-2 oktas, midpoint of 1.5/8
    'SCT': 0.4375,  // 3-4 oktas, midpoint of 3.5/8
    'BKN': 0.6875,  // 5-6 oktas, midpoint of 5.5/8
    'OVC': 1.0,     // 8 oktas (full coverage)
    'SKC': 0,       // Sky clear
    'CLR': 0,       // Clear below 12,000ft
    'NSC': 0,       // No significant cloud
    'NCD': 0,       // No cloud detected
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

/**
 * Compare two cloud layer arrays for equality
 * Uses tolerance for floating point values
 */
function cloudLayersEqual(a: CloudLayer[], b: CloudLayer[]): boolean {
  if (a.length !== b.length) return false
  return a.every((layer, i) =>
    Math.abs(layer.altitude - b[i].altitude) < 10 &&
    Math.abs(layer.coverage - b[i].coverage) < 0.05 &&
    layer.type === b[i].type
  )
}

/**
 * Compare two wind states for equality
 */
function windEqual(a: WindState, b: WindState): boolean {
  return a.direction === b.direction &&
    a.speed === b.speed &&
    a.gustSpeed === b.gustSpeed &&
    a.isVariable === b.isVariable
}

/**
 * Compare two precipitation states for equality
 */
function precipitationEqual(a: PrecipitationState, b: PrecipitationState): boolean {
  if (a.active !== b.active) return false
  if (a.hasThunderstorm !== b.hasThunderstorm) return false
  if (a.types.length !== b.types.length) return false
  return a.types.every((t, i) => t.code === b.types[i].code)
}

/**
 * Check if two interpolated weather results are effectively the same
 * Used to skip state updates when values haven't meaningfully changed
 */
function interpolatedWeatherEqual(a: InterpolatedWeather, b: InterpolatedWeather): boolean {
  return Math.abs(a.visibility - b.visibility) < 0.1 &&
    Math.abs(a.fogDensity - b.fogDensity) < 0.0001 &&
    cloudLayersEqual(a.cloudLayers, b.cloudLayers) &&
    windEqual(a.wind, b.wind) &&
    precipitationEqual(a.precipitation, b.precipitation)
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
  nearbyMetars: [],
  interpolatedWeather: null,
  lastInterpolationPosition: null,
  lastInterpolationTime: 0,
  useInterpolation: false,
  refreshIntervalId: null,
  isDebugOverriding: false,
  instantUpdatePending: false,

  fetchWeather: async (icao: string) => {
    set({ isLoading: true, error: null, useNearestMetar: false })

    try {
      const metar = await metarService.fetchMetar(icao)

      if (metar) {
        const state = get()
        // When debug override is active, only update METAR data and fog density
        // Don't overwrite precipitation, wind, or cloud layers
        if (state.isDebugOverriding) {
          set({
            currentMetar: metar,
            lastFetchTime: Date.now(),
            isLoading: false,
            error: null,
            fogDensity: visibilityToFogDensity(metar.visib)
          })
        } else {
          const newPrecip = parsePrecipitationState(metar)
          set({
            currentMetar: metar,
            lastFetchTime: Date.now(),
            isLoading: false,
            error: null,
            fogDensity: visibilityToFogDensity(metar.visib),
            cloudLayers: parseCloudLayers(metar),
            precipitation: newPrecip,
            wind: metar.wind
          })
        }
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
        const state = get()
        // When debug override is active, only update METAR data and fog density
        // Don't overwrite precipitation, wind, or cloud layers
        if (state.isDebugOverriding) {
          set({
            currentMetar: metar,
            lastFetchTime: Date.now(),
            isLoading: false,
            error: null,
            fogDensity: visibilityToFogDensity(metar.visib),
            cameraPosition: { lat, lon }
          })
        } else {
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
        }
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

  fetchInterpolatedWeather: async (lat: number, lon: number) => {
    const state = get()
    const now = Date.now()

    // Check if position changed enough to warrant a new fetch
    // Time-based refresh is handled separately by auto-refresh (5 minute interval)
    // This prevents unnecessary API calls and state updates when camera is stationary
    if (state.lastInterpolationPosition) {
      const latDiff = Math.abs(lat - state.lastInterpolationPosition.lat)
      const lonDiff = Math.abs(lon - state.lastInterpolationPosition.lon)

      // Skip if position hasn't changed much - no need for time check here
      // Auto-refresh handles periodic updates, this is for position-based updates only
      if (latDiff < INTERPOLATION_POSITION_THRESHOLD_DEG &&
          lonDiff < INTERPOLATION_POSITION_THRESHOLD_DEG) {
        return
      }
    }

    set({ isLoading: true, error: null, useInterpolation: true })

    try {
      const nearbyMetars = await metarService.fetchNearestMetars(lat, lon)

      if (nearbyMetars.length > 0) {
        const interpolated = interpolateWeather(nearbyMetars)

        if (interpolated && !state.isDebugOverriding) {
          // Check if values actually changed - skip update if identical
          // This prevents unnecessary React re-renders and cloud layer matching
          if (state.interpolatedWeather && interpolatedWeatherEqual(interpolated, state.interpolatedWeather)) {
            // Values unchanged, just update position/timestamp without triggering weather re-render
            set({
              lastInterpolationPosition: { lat, lon },
              lastInterpolationTime: now,
              cameraPosition: { lat, lon },
              lastFetchTime: now,
              isLoading: false
            })
            return
          }

          set({
            nearbyMetars,
            interpolatedWeather: interpolated,
            lastInterpolationPosition: { lat, lon },
            lastInterpolationTime: now,
            cameraPosition: { lat, lon },
            lastFetchTime: now,
            isLoading: false,
            error: null,
            // Apply interpolated values to active weather state
            fogDensity: interpolated.fogDensity,
            cloudLayers: interpolated.cloudLayers,
            precipitation: interpolated.precipitation,
            wind: interpolated.wind
          })
        } else if (interpolated) {
          // Debug override mode - don't overwrite weather effects
          set({
            nearbyMetars,
            interpolatedWeather: interpolated,
            lastInterpolationPosition: { lat, lon },
            lastInterpolationTime: now,
            cameraPosition: { lat, lon },
            lastFetchTime: now,
            isLoading: false,
            error: null,
            fogDensity: interpolated.fogDensity
          })
        }
      } else {
        set({
          nearbyMetars: [],
          interpolatedWeather: null,
          isLoading: false,
          error: 'No nearby METAR stations for interpolation'
        })
      }
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch interpolated weather'
      })
    }
  },

  updateCameraPosition: (lat: number, lon: number) => {
    const state = get()
    const oldPos = state.cameraPosition

    // Always update camera position
    set({ cameraPosition: { lat, lon } })

    // Handle interpolation mode
    if (state.useInterpolation) {
      // Interpolation handles its own throttling in fetchInterpolatedWeather
      state.fetchInterpolatedWeather(lat, lon)
      return
    }

    // Handle nearest METAR mode (legacy)
    if (!state.useNearestMetar) {
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

  startInterpolatedAutoRefresh: () => {
    const state = get()

    // Clear any existing interval
    if (state.refreshIntervalId) {
      clearInterval(state.refreshIntervalId)
    }

    // Start new refresh interval for interpolated weather
    const intervalId = setInterval(() => {
      const currentState = get()
      if (currentState.cameraPosition && currentState.useInterpolation) {
        // Force refetch by clearing last interpolation time
        set({ lastInterpolationTime: 0 })
        currentState.fetchInterpolatedWeather(
          currentState.cameraPosition.lat,
          currentState.cameraPosition.lon
        )
      }
    }, WEATHER_REFRESH_INTERVAL)

    set({ refreshIntervalId: intervalId, useInterpolation: true, useNearestMetar: false })
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
      nearbyMetars: [],
      interpolatedWeather: null,
      lastInterpolationPosition: null,
      lastInterpolationTime: 0,
      useInterpolation: false,
      refreshIntervalId: null
    })
  },

  setUseInterpolation: (useInterpolation: boolean) => {
    set({ useInterpolation, useNearestMetar: false })
  },

  // Debug overrides - allow dev panel to set weather state directly
  setDebugOverriding: (isOverriding: boolean) => {
    set({ isDebugOverriding: isOverriding })
    // When clearing override, restore weather data from current METAR
    if (!isOverriding) {
      const state = get()
      if (state.currentMetar) {
        set({
          cloudLayers: parseCloudLayers(state.currentMetar),
          precipitation: parsePrecipitationState(state.currentMetar),
          wind: state.currentMetar.wind
        })
      }
    }
  },

  setPrecipitation: (precipitation: PrecipitationState) => {
    set({ precipitation })
  },

  setWind: (wind: WindState) => {
    set({ wind })
  },

  setCloudLayers: (cloudLayers: CloudLayer[]) => {
    set({ cloudLayers })
  },

  triggerInstantUpdate: () => {
    set({ instantUpdatePending: true })
  },

  consumeInstantUpdate: () => {
    const state = get()
    if (state.instantUpdatePending) {
      set({ instantUpdatePending: false })
      return true
    }
    return false
  }
}))
