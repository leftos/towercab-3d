/**
 * Weather smoothing hook with hysteresis
 *
 * Provides smoothed weather values that transition gradually rather than
 * instantly when METAR/interpolated weather data updates. This prevents
 * jarring visual changes when flying between weather stations or when
 * rapidly changing interpolated weather data.
 *
 * Smoothed parameters:
 * - Visibility (affects fog dome scale and opacity)
 * - Fog density
 * - Wind direction (circular interpolation for wrap-around)
 * - Wind speed and gust speed
 * - Precipitation state (with onset/cessation hysteresis)
 * - Thunderstorm state (with onset/cessation hysteresis)
 */

import { useEffect, useRef, useCallback } from 'react'
import { useWeatherStore } from '../stores/weatherStore'
import type { PrecipitationState, WindState } from '@/types'
import {
  VISIBILITY_TRANSITION_TIME,
  FOG_DENSITY_TRANSITION_TIME,
  WIND_DIRECTION_TRANSITION_TIME,
  WIND_SPEED_TRANSITION_TIME,
  PRECIPITATION_FADE_TIME,
  PRECIPITATION_ONSET_DELAY,
  PRECIPITATION_CESSATION_DELAY,
  THUNDERSTORM_ONSET_DELAY,
  THUNDERSTORM_CESSATION_DELAY
} from '@/constants'

export interface SmoothedWeatherState {
  /** Smoothed visibility in statute miles */
  visibility: number
  /** Smoothed fog density (0 to ~0.015) */
  fogDensity: number
  /** Smoothed wind state */
  wind: WindState
  /** Smoothed precipitation state with intensity factor (0-1) */
  precipitation: SmoothedPrecipitationState
  /** Whether any smoothing is currently active */
  isTransitioning: boolean
}

export interface SmoothedPrecipitationState extends PrecipitationState {
  /**
   * Intensity factor for precipitation particles (0-1)
   * Used to fade in/out particle emit rates smoothly
   */
  intensityFactor: number
  /**
   * Intensity factor for thunderstorm effects (0-1)
   * Controls lightning flash probability/intensity
   */
  thunderstormFactor: number
}

interface SmoothingState {
  // Current smoothed values
  visibility: number
  fogDensity: number
  windDirection: number
  windSpeed: number
  windGustSpeed: number | null

  // Target values from weather store
  targetVisibility: number
  targetFogDensity: number
  targetWindDirection: number
  targetWindSpeed: number
  targetWindGustSpeed: number | null

  // Precipitation hysteresis
  precipitationActive: boolean
  precipitationIntensityFactor: number
  precipitationOnsetTime: number | null     // When precip was first detected
  precipitationCessationTime: number | null // When precip was last active

  // Thunderstorm hysteresis
  thunderstormActive: boolean
  thunderstormFactor: number
  thunderstormOnsetTime: number | null
  thunderstormCessationTime: number | null

  // Track if values are initialized
  initialized: boolean
}

/**
 * Interpolates between two angles (in degrees) taking the shortest path
 * Handles wrap-around at 0/360 degrees
 */
function lerpAngle(current: number, target: number, t: number): number {
  // Normalize angles to 0-360
  current = ((current % 360) + 360) % 360
  target = ((target % 360) + 360) % 360

  // Find the shortest angular distance
  let diff = target - current
  if (diff > 180) diff -= 360
  if (diff < -180) diff += 360

  // Interpolate
  const result = current + diff * t
  // Normalize result
  return ((result % 360) + 360) % 360
}

/**
 * Linear interpolation with clamping to prevent overshoot
 */
function lerp(current: number, target: number, t: number): number {
  const clamped = Math.max(0, Math.min(1, t))
  return current + (target - current) * clamped
}

/**
 * Calculate interpolation factor based on delta time and transition time
 * Uses exponential smoothing formula: 1 - e^(-dt/tau)
 * This provides smooth asymptotic approach to target
 */
function calcLerpFactor(deltaSeconds: number, transitionTime: number): number {
  if (transitionTime <= 0) return 1
  return 1 - Math.exp(-deltaSeconds / (transitionTime / 3))
}

export interface UseSmoothedWeatherOptions {
  /** Whether smoothing is enabled (default: true) */
  enabled?: boolean
  /** Callback called each frame with smoothed values */
  onUpdate?: (state: SmoothedWeatherState) => void
}

/**
 * Hook that provides smoothed weather values with hysteresis
 */
export function useSmoothedWeather(options: UseSmoothedWeatherOptions = {}) {
  const { enabled = true, onUpdate } = options

  // Store subscriptions
  const currentMetar = useWeatherStore((state) => state.currentMetar)
  const fogDensity = useWeatherStore((state) => state.fogDensity)
  const wind = useWeatherStore((state) => state.wind)
  const precipitation = useWeatherStore((state) => state.precipitation)

  // Smoothing state ref (persists across renders)
  const stateRef = useRef<SmoothingState>({
    visibility: 10,
    fogDensity: 0,
    windDirection: 0,
    windSpeed: 0,
    windGustSpeed: null,
    targetVisibility: 10,
    targetFogDensity: 0,
    targetWindDirection: 0,
    targetWindSpeed: 0,
    targetWindGustSpeed: null,
    precipitationActive: false,
    precipitationIntensityFactor: 0,
    precipitationOnsetTime: null,
    precipitationCessationTime: null,
    thunderstormActive: false,
    thunderstormFactor: 0,
    thunderstormOnsetTime: null,
    thunderstormCessationTime: null,
    initialized: false
  })

  // Last update time for delta calculation
  const lastUpdateRef = useRef<number>(0)

  // Animation frame ID for cleanup
  const frameIdRef = useRef<number | null>(null)

  // Smoothed state for external consumption
  const smoothedStateRef = useRef<SmoothedWeatherState>({
    visibility: 10,
    fogDensity: 0,
    wind: { direction: 0, speed: 0, gustSpeed: null, isVariable: false },
    precipitation: {
      active: false,
      types: [],
      visibilityFactor: 1,
      hasThunderstorm: false,
      intensityFactor: 0,
      thunderstormFactor: 0
    },
    isTransitioning: false
  })

  // Update targets when weather store changes
  useEffect(() => {
    const state = stateRef.current

    // Update visibility target
    if (currentMetar) {
      state.targetVisibility = currentMetar.visib
    }

    // Update fog density target
    state.targetFogDensity = fogDensity

    // Update wind targets
    state.targetWindDirection = wind.direction
    state.targetWindSpeed = wind.speed
    state.targetWindGustSpeed = wind.gustSpeed

    // Initialize on first update
    if (!state.initialized && currentMetar) {
      state.visibility = currentMetar.visib
      state.fogDensity = fogDensity
      state.windDirection = wind.direction
      state.windSpeed = wind.speed
      state.windGustSpeed = wind.gustSpeed
      state.initialized = true
    }
  }, [currentMetar, fogDensity, wind])

  // Handle precipitation hysteresis
  useEffect(() => {
    const state = stateRef.current
    const now = performance.now()

    if (precipitation.active) {
      // Precipitation is reported
      if (!state.precipitationActive && state.precipitationOnsetTime === null) {
        // Start onset timer
        state.precipitationOnsetTime = now
      }
      // Clear cessation timer
      state.precipitationCessationTime = null
    } else {
      // Precipitation not reported
      if (state.precipitationActive && state.precipitationCessationTime === null) {
        // Start cessation timer
        state.precipitationCessationTime = now
      }
      // Clear onset timer
      state.precipitationOnsetTime = null
    }

    // Handle thunderstorm separately
    if (precipitation.hasThunderstorm) {
      if (!state.thunderstormActive && state.thunderstormOnsetTime === null) {
        state.thunderstormOnsetTime = now
      }
      state.thunderstormCessationTime = null
    } else {
      if (state.thunderstormActive && state.thunderstormCessationTime === null) {
        state.thunderstormCessationTime = now
      }
      state.thunderstormOnsetTime = null
    }
  }, [precipitation.active, precipitation.hasThunderstorm])

  // Animation loop for smooth interpolation
  const updateSmoothing = useCallback(() => {
    const now = performance.now()
    const state = stateRef.current
    const smoothed = smoothedStateRef.current

    if (!state.initialized) {
      frameIdRef.current = requestAnimationFrame(updateSmoothing)
      return
    }

    // Calculate delta time (clamped to prevent huge jumps when tab was backgrounded)
    const deltaMs = lastUpdateRef.current ? now - lastUpdateRef.current : 16
    const deltaSeconds = Math.min(deltaMs / 1000, 0.1)
    lastUpdateRef.current = now

    let isTransitioning = false

    if (enabled) {
      // Smooth visibility
      const visLerpFactor = calcLerpFactor(deltaSeconds, VISIBILITY_TRANSITION_TIME)
      if (Math.abs(state.visibility - state.targetVisibility) > 0.01) {
        state.visibility = lerp(state.visibility, state.targetVisibility, visLerpFactor)
        isTransitioning = true
      } else {
        state.visibility = state.targetVisibility
      }

      // Smooth fog density
      const fogLerpFactor = calcLerpFactor(deltaSeconds, FOG_DENSITY_TRANSITION_TIME)
      if (Math.abs(state.fogDensity - state.targetFogDensity) > 0.0001) {
        state.fogDensity = lerp(state.fogDensity, state.targetFogDensity, fogLerpFactor)
        isTransitioning = true
      } else {
        state.fogDensity = state.targetFogDensity
      }

      // Smooth wind direction (circular interpolation)
      const windDirLerpFactor = calcLerpFactor(deltaSeconds, WIND_DIRECTION_TRANSITION_TIME)
      const dirDiff = Math.abs(((state.windDirection - state.targetWindDirection + 180) % 360) - 180)
      if (dirDiff > 1) {
        state.windDirection = lerpAngle(state.windDirection, state.targetWindDirection, windDirLerpFactor)
        isTransitioning = true
      } else {
        state.windDirection = state.targetWindDirection
      }

      // Smooth wind speed
      const windSpeedLerpFactor = calcLerpFactor(deltaSeconds, WIND_SPEED_TRANSITION_TIME)
      if (Math.abs(state.windSpeed - state.targetWindSpeed) > 0.5) {
        state.windSpeed = lerp(state.windSpeed, state.targetWindSpeed, windSpeedLerpFactor)
        isTransitioning = true
      } else {
        state.windSpeed = state.targetWindSpeed
      }

      // Smooth gust speed
      if (state.targetWindGustSpeed !== null) {
        const currentGust = state.windGustSpeed ?? state.windSpeed
        if (Math.abs(currentGust - state.targetWindGustSpeed) > 0.5) {
          state.windGustSpeed = lerp(currentGust, state.targetWindGustSpeed, windSpeedLerpFactor)
          isTransitioning = true
        } else {
          state.windGustSpeed = state.targetWindGustSpeed
        }
      } else {
        state.windGustSpeed = null
      }

      // Handle precipitation hysteresis and fade
      if (state.precipitationOnsetTime !== null) {
        const elapsed = (now - state.precipitationOnsetTime) / 1000
        if (elapsed >= PRECIPITATION_ONSET_DELAY) {
          state.precipitationActive = true
          state.precipitationOnsetTime = null
        }
      }
      if (state.precipitationCessationTime !== null) {
        const elapsed = (now - state.precipitationCessationTime) / 1000
        if (elapsed >= PRECIPITATION_CESSATION_DELAY) {
          state.precipitationActive = false
          state.precipitationCessationTime = null
        }
      }

      // Fade precipitation intensity factor
      const precipFadeFactor = calcLerpFactor(deltaSeconds, PRECIPITATION_FADE_TIME)
      const targetIntensity = state.precipitationActive ? 1 : 0
      if (Math.abs(state.precipitationIntensityFactor - targetIntensity) > 0.01) {
        state.precipitationIntensityFactor = lerp(
          state.precipitationIntensityFactor,
          targetIntensity,
          precipFadeFactor
        )
        isTransitioning = true
      } else {
        state.precipitationIntensityFactor = targetIntensity
      }

      // Handle thunderstorm hysteresis and fade
      if (state.thunderstormOnsetTime !== null) {
        const elapsed = (now - state.thunderstormOnsetTime) / 1000
        if (elapsed >= THUNDERSTORM_ONSET_DELAY) {
          state.thunderstormActive = true
          state.thunderstormOnsetTime = null
        }
      }
      if (state.thunderstormCessationTime !== null) {
        const elapsed = (now - state.thunderstormCessationTime) / 1000
        if (elapsed >= THUNDERSTORM_CESSATION_DELAY) {
          state.thunderstormActive = false
          state.thunderstormCessationTime = null
        }
      }

      // Fade thunderstorm factor
      const targetThunderstorm = state.thunderstormActive ? 1 : 0
      if (Math.abs(state.thunderstormFactor - targetThunderstorm) > 0.01) {
        state.thunderstormFactor = lerp(
          state.thunderstormFactor,
          targetThunderstorm,
          precipFadeFactor
        )
        isTransitioning = true
      } else {
        state.thunderstormFactor = targetThunderstorm
      }
    } else {
      // Smoothing disabled - use target values directly
      state.visibility = state.targetVisibility
      state.fogDensity = state.targetFogDensity
      state.windDirection = state.targetWindDirection
      state.windSpeed = state.targetWindSpeed
      state.windGustSpeed = state.targetWindGustSpeed
      state.precipitationActive = precipitation.active
      state.precipitationIntensityFactor = precipitation.active ? 1 : 0
      state.thunderstormActive = precipitation.hasThunderstorm
      state.thunderstormFactor = precipitation.hasThunderstorm ? 1 : 0
    }

    // Update smoothed state for external consumption
    smoothed.visibility = state.visibility
    smoothed.fogDensity = state.fogDensity
    smoothed.wind = {
      direction: Math.round(state.windDirection),
      speed: Math.round(state.windSpeed),
      gustSpeed: state.windGustSpeed !== null ? Math.round(state.windGustSpeed) : null,
      isVariable: wind.isVariable
    }
    smoothed.precipitation = {
      active: state.precipitationIntensityFactor > 0.01,
      types: precipitation.types,
      visibilityFactor: precipitation.visibilityFactor,
      hasThunderstorm: state.thunderstormFactor > 0.01,
      intensityFactor: state.precipitationIntensityFactor,
      thunderstormFactor: state.thunderstormFactor
    }
    smoothed.isTransitioning = isTransitioning

    // Call update callback
    onUpdate?.(smoothed)

    // Continue animation loop
    frameIdRef.current = requestAnimationFrame(updateSmoothing)
  }, [enabled, precipitation, wind.isVariable, onUpdate])

  // Start/stop animation loop
  useEffect(() => {
    frameIdRef.current = requestAnimationFrame(updateSmoothing)

    return () => {
      if (frameIdRef.current !== null) {
        cancelAnimationFrame(frameIdRef.current)
        frameIdRef.current = null
      }
    }
  }, [updateSmoothing])

  // Return current smoothed state getter
  const getSmoothedWeather = useCallback((): SmoothedWeatherState => {
    return { ...smoothedStateRef.current }
  }, [])

  return {
    /** Get the current smoothed weather state */
    getSmoothedWeather,
    /** Reference to smoothed state (for direct access in render loops) */
    smoothedStateRef
  }
}

export default useSmoothedWeather
