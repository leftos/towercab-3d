import { useEffect, useRef } from 'react'
import * as Cesium from 'cesium'
import {
  SUN_ELEVATION_DAY,
  SUN_ELEVATION_CIVIL_TWILIGHT,
  SUN_ELEVATION_NAUTICAL_TWILIGHT,
  SUN_ELEVATION_NIGHT,
  NIGHT_BRIGHTNESS_MIN,
  NIGHT_BRIGHTNESS_TWILIGHT,
  NIGHT_BRIGHTNESS_CIVIL,
  NIGHT_GAMMA_BOOST
} from '@/constants'

export interface NightDarkeningSettings {
  /** Whether night darkening is enabled */
  enabled: boolean
  /** Intensity of the darkening effect (0.0-1.0, higher = darker nights) */
  intensity: number
}

/**
 * Smoothstep function for smooth interpolation between values
 * Returns smooth transition between 0 and 1 based on where x is between edge0 and edge1
 */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * Linear interpolation between two values
 */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}


/**
 * Calculate the target brightness based on sun elevation angle
 *
 * Uses smooth transitions through twilight phases:
 * - Day (sun > 0°): Full brightness (1.0)
 * - Civil twilight (0° to -6°): 1.0 -> 0.6
 * - Nautical twilight (-6° to -12°): 0.6 -> 0.3
 * - Astronomical twilight (-12° to -18°): 0.3 -> min
 * - Night (sun < -18°): Minimum brightness
 *
 * @param sunElevation - Sun elevation angle in degrees
 * @param intensity - User intensity setting (0.0-1.0)
 * @returns Target brightness value (0.0-1.0)
 */
function calculateTargetBrightness(sunElevation: number, intensity: number): number {
  // Minimum brightness at night depends on intensity setting
  // intensity 0.0 = minBrightness 0.5 (no darkening)
  // intensity 0.7 = minBrightness ~0.22
  // intensity 1.0 = minBrightness 0.15 (maximum darkening)
  const minBrightness = NIGHT_BRIGHTNESS_MIN + (1 - intensity) * (0.5 - NIGHT_BRIGHTNESS_MIN)

  // Day: full brightness
  if (sunElevation >= SUN_ELEVATION_DAY) {
    return 1.0
  }

  // Civil twilight: smooth transition from 1.0 to 0.6
  if (sunElevation > SUN_ELEVATION_CIVIL_TWILIGHT) {
    const t = smoothstep(SUN_ELEVATION_CIVIL_TWILIGHT, SUN_ELEVATION_DAY, sunElevation)
    return lerp(NIGHT_BRIGHTNESS_CIVIL, 1.0, t)
  }

  // Nautical twilight: smooth transition from 0.6 to 0.3
  if (sunElevation > SUN_ELEVATION_NAUTICAL_TWILIGHT) {
    const t = smoothstep(SUN_ELEVATION_NAUTICAL_TWILIGHT, SUN_ELEVATION_CIVIL_TWILIGHT, sunElevation)
    return lerp(NIGHT_BRIGHTNESS_TWILIGHT, NIGHT_BRIGHTNESS_CIVIL, t)
  }

  // Astronomical twilight: smooth transition from 0.3 to minimum
  if (sunElevation > SUN_ELEVATION_NIGHT) {
    const t = smoothstep(SUN_ELEVATION_NIGHT, SUN_ELEVATION_NAUTICAL_TWILIGHT, sunElevation)
    return lerp(minBrightness, NIGHT_BRIGHTNESS_TWILIGHT, t)
  }

  // Full night: minimum brightness
  return minBrightness
}

/**
 * Calculate target gamma based on sun elevation
 * Slightly boost gamma during twilight for warmer sunset/sunrise tones
 */
function calculateTargetGamma(sunElevation: number): number {
  // Only boost gamma during civil twilight (around sunset/sunrise)
  if (sunElevation > SUN_ELEVATION_CIVIL_TWILIGHT && sunElevation < SUN_ELEVATION_DAY) {
    // Maximum gamma boost at the horizon (sun at 0°)
    const t = smoothstep(SUN_ELEVATION_CIVIL_TWILIGHT, SUN_ELEVATION_DAY, sunElevation)
    // Gamma peaks at the midpoint of civil twilight
    const peakT = 0.5
    const distFromPeak = Math.abs(t - peakT) / peakT
    const gammaMultiplier = 1 - distFromPeak // 1.0 at peak, 0.0 at edges
    return 1.0 + (NIGHT_GAMMA_BOOST - 1.0) * gammaMultiplier
  }
  return 1.0
}

/**
 * Manages night-time darkening of satellite imagery based on sun position
 *
 * ## How It Works
 * This hook adjusts the brightness and gamma of Cesium's base imagery layer
 * based on the sun's elevation angle at the camera position. The effect
 * smoothly transitions through twilight phases for a realistic day/night cycle.
 *
 * ## Twilight Phases
 * - **Civil twilight** (0° to -6°): Enough light for outdoor activities
 * - **Nautical twilight** (-6° to -12°): Horizon visible, stars appearing
 * - **Astronomical twilight** (-12° to -18°): Sky fully dark
 *
 * ## Performance
 * - Uses smooth interpolation to prevent jarring brightness changes
 * - Only updates when sun elevation changes
 * - Minimal impact on frame rate
 *
 * @param viewer - Initialized Cesium.Viewer instance
 * @param sunElevation - Current sun elevation in degrees (from useSunElevation)
 * @param settings - Night darkening configuration
 *
 * @example
 * ```tsx
 * const sunElevation = useSunElevation(viewer)
 * useCesiumNightDarkening(viewer, sunElevation, {
 *   enabled: true,
 *   intensity: 0.7
 * })
 * ```
 */
export function useCesiumNightDarkening(
  viewer: Cesium.Viewer | null,
  sunElevation: number | null,
  settings: NightDarkeningSettings
): void {
  const { enabled, intensity } = settings
  const lastBrightnessRef = useRef<number>(1.0)
  const lastGammaRef = useRef<number>(1.0)

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return
    if (!enabled || sunElevation === null) {
      // Reset to default brightness when disabled
      const imageryLayers = viewer.imageryLayers
      if (imageryLayers.length > 0) {
        const baseLayer = imageryLayers.get(0)
        baseLayer.brightness = 1.0
        baseLayer.gamma = 1.0
      }
      lastBrightnessRef.current = 1.0
      lastGammaRef.current = 1.0
      return
    }

    // Calculate target values based on sun elevation
    // The smoothstep functions in calculateTargetBrightness already provide
    // smooth transitions through twilight phases
    const targetBrightness = calculateTargetBrightness(sunElevation, intensity)
    const targetGamma = calculateTargetGamma(sunElevation)

    // Only update if values changed significantly (avoid unnecessary updates)
    if (Math.abs(targetBrightness - lastBrightnessRef.current) > 0.001 ||
        Math.abs(targetGamma - lastGammaRef.current) > 0.001) {
      // Apply to imagery layer
      const imageryLayers = viewer.imageryLayers
      if (imageryLayers.length > 0) {
        const baseLayer = imageryLayers.get(0)
        baseLayer.brightness = targetBrightness
        baseLayer.gamma = targetGamma
      }

      lastBrightnessRef.current = targetBrightness
      lastGammaRef.current = targetGamma
    }
  }, [viewer, sunElevation, enabled, intensity])

  // Cleanup: reset brightness when unmounting
  useEffect(() => {
    return () => {
      if (viewer && !viewer.isDestroyed()) {
        const imageryLayers = viewer.imageryLayers
        if (imageryLayers.length > 0) {
          const baseLayer = imageryLayers.get(0)
          baseLayer.brightness = 1.0
          baseLayer.gamma = 1.0
        }
      }
    }
  }, [viewer])
}
