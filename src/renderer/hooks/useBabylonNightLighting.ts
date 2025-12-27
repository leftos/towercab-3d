import { useEffect, useRef } from 'react'
import * as BABYLON from '@babylonjs/core'
import {
  SUN_ELEVATION_DAY,
  SUN_ELEVATION_NIGHT,
  BABYLON_NIGHT_HEMISPHERIC_MULT,
  BABYLON_NIGHT_DIRECTIONAL_MULT,
  HEMISPHERIC_LIGHT_INTENSITY,
  DIRECTIONAL_LIGHT_INTENSITY
} from '@/constants'

/**
 * Smoothstep function for smooth interpolation
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
 * Calculate light intensity multiplier based on sun elevation
 *
 * @param sunElevation - Sun elevation angle in degrees
 * @param nightMultiplier - Target multiplier at full night
 * @returns Intensity multiplier (nightMultiplier to 1.0)
 */
function calculateLightMultiplier(sunElevation: number, nightMultiplier: number): number {
  // Day: full intensity
  if (sunElevation >= SUN_ELEVATION_DAY) {
    return 1.0
  }

  // Night: minimum intensity
  if (sunElevation <= SUN_ELEVATION_NIGHT) {
    return nightMultiplier
  }

  // Twilight: smooth transition
  const t = smoothstep(SUN_ELEVATION_NIGHT, SUN_ELEVATION_DAY, sunElevation)
  return lerp(nightMultiplier, 1.0, t)
}

export interface BabylonNightLightingSettings {
  /** Whether night lighting adjustment is enabled */
  enabled: boolean
}

/**
 * Adjusts Babylon.js scene lighting based on sun elevation for night-time effects
 *
 * ## How It Works
 * This hook finds the hemispheric and directional lights in the Babylon.js scene
 * and adjusts their intensities based on the sun's elevation angle. This ensures
 * that weather effects (fog, clouds) and any 3D overlays are appropriately dimmed
 * at night.
 *
 * ## Light Adjustments
 * - **Hemispheric light**: Reduced to 30% at night (ambient lighting)
 * - **Directional light**: Reduced to 15% at night (sun-like lighting)
 *
 * ## Important Note
 * This does NOT affect the GUI layer (aircraft labels) since they use
 * emissive colors that are independent of scene lighting.
 *
 * @param scene - Babylon.js Scene instance
 * @param sunElevation - Current sun elevation in degrees (from useSunElevation)
 * @param settings - Night lighting configuration
 *
 * @example
 * ```tsx
 * const sunElevation = useSunElevation(cesiumViewer)
 * useBabylonNightLighting(babylonScene, sunElevation, { enabled: true })
 * ```
 */
export function useBabylonNightLighting(
  scene: BABYLON.Scene | null,
  sunElevation: number | null,
  settings: BabylonNightLightingSettings
): void {
  const { enabled } = settings

  // Store current values for smooth interpolation
  const currentHemisphericIntensityRef = useRef<number>(HEMISPHERIC_LIGHT_INTENSITY)
  const currentDirectionalIntensityRef = useRef<number>(DIRECTIONAL_LIGHT_INTENSITY)

  useEffect(() => {
    if (!scene || scene.isDisposed) return

    // Find lights by name
    const hemisphericLight = scene.getLightByName('light') as BABYLON.HemisphericLight | null
    const directionalLight = scene.getLightByName('dirLight') as BABYLON.DirectionalLight | null

    if (!enabled || sunElevation === null) {
      // Reset to default intensities when disabled
      if (hemisphericLight) {
        hemisphericLight.intensity = HEMISPHERIC_LIGHT_INTENSITY
      }
      if (directionalLight) {
        directionalLight.intensity = DIRECTIONAL_LIGHT_INTENSITY
      }
      currentHemisphericIntensityRef.current = HEMISPHERIC_LIGHT_INTENSITY
      currentDirectionalIntensityRef.current = DIRECTIONAL_LIGHT_INTENSITY
      return
    }

    // Calculate target intensities based on sun elevation
    const hemisphericMultiplier = calculateLightMultiplier(sunElevation, BABYLON_NIGHT_HEMISPHERIC_MULT)
    const directionalMultiplier = calculateLightMultiplier(sunElevation, BABYLON_NIGHT_DIRECTIONAL_MULT)

    const targetHemispheric = HEMISPHERIC_LIGHT_INTENSITY * hemisphericMultiplier
    const targetDirectional = DIRECTIONAL_LIGHT_INTENSITY * directionalMultiplier

    // Apply intensities directly (smoothstep in calculateLightMultiplier provides smooth transitions)
    if (hemisphericLight) {
      hemisphericLight.intensity = targetHemispheric
    }
    if (directionalLight) {
      directionalLight.intensity = targetDirectional
    }

    currentHemisphericIntensityRef.current = targetHemispheric
    currentDirectionalIntensityRef.current = targetDirectional
  }, [scene, sunElevation, enabled])

  // Cleanup: reset intensities when unmounting
  useEffect(() => {
    return () => {
      if (scene && !scene.isDisposed) {
        const hemisphericLight = scene.getLightByName('light') as BABYLON.HemisphericLight | null
        const directionalLight = scene.getLightByName('dirLight') as BABYLON.DirectionalLight | null

        if (hemisphericLight) {
          hemisphericLight.intensity = HEMISPHERIC_LIGHT_INTENSITY
        }
        if (directionalLight) {
          directionalLight.intensity = DIRECTIONAL_LIGHT_INTENSITY
        }
      }
    }
  }, [scene])
}
