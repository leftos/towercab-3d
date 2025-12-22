import { useEffect, useRef, useCallback } from 'react'
import * as BABYLON from '@babylonjs/core'
import { useWeatherStore } from '../stores/weatherStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { UseBabylonWeatherResult, CloudMeshData, WeatherVisibilityParams } from '@/types'
import {
  CLOUD_POOL_SIZE,
  CLOUD_PLANE_DIAMETER,
  CLOUD_PLANE_ROTATION_X,
  CLOUD_DIFFUSE_COLOR,
  CLOUD_EMISSIVE_COLOR,
  CLOUD_BASE_ALPHA,
  FOG_DOME_BASE_DIAMETER,
  FOG_DOME_SEGMENTS,
  FOG_DIFFUSE_COLOR,
  FOG_EMISSIVE_COLOR,
  FOG_SPECULAR_COLOR,
  FOG_BASE_ALPHA,
  FOG_FRESNEL_BIAS,
  FOG_FRESNEL_POWER,
  VISIBILITY_THRESHOLD_EXTREMELY_LOW,
  VISIBILITY_THRESHOLD_LOW,
  VISIBILITY_THRESHOLD_MODERATE,
  VISIBILITY_THRESHOLD_DECENT,
  FOG_ALPHA_EXTREMELY_LOW,
  FOG_ALPHA_LOW_MIN,
  FOG_ALPHA_MODERATE_MIN,
  FOG_ALPHA_DECENT_MIN,
  FOG_ALPHA_GOOD,
  FOG_FRESNEL_BIAS_EXTREMELY_LOW,
  FOG_FRESNEL_BIAS_LOW_MIN,
  FOG_FRESNEL_BIAS_MODERATE,
  CLOUD_CEILING_COVERAGE_THRESHOLD,
  STATUTE_MILES_TO_METERS
} from '@/constants'

interface UseBabylonWeatherOptions {
  scene: BABYLON.Scene | null
  isTopDownView?: boolean
}

/**
 * Manages METAR-based weather effects in Babylon.js (fog dome and cloud layers).
 *
 * ## Responsibilities
 * - Create fog dome mesh with fresnel material for visibility simulation
 * - Create cloud layer mesh pool (up to 4 layers) from METAR data
 * - Update fog dome scale and opacity based on visibility conditions
 * - Update cloud layer positions and visibility based on METAR ceiling data
 * - Provide weather-based visibility culling function for aircraft labels
 * - Dispose all weather meshes and materials on unmount
 *
 * ## Dependencies
 * - Requires: Initialized Babylon.js scene (from useBabylonScene)
 * - Reads: weatherStore (METAR data, cloud layers, fog density)
 * - Reads: settingsStore (weather effect toggles, intensities)
 * - Writes: Creates and manages fog dome mesh and cloud layer meshes
 *
 * ## Call Order
 * This hook should be called after useBabylonScene but before useBabylonLabels:
 * ```typescript
 * // 1. Initialize scene first
 * const { scene, sceneReady } = useBabylonScene({ canvas })
 *
 * // 2. Create weather effects (needs scene)
 * const { fogDome, cloudLayers, isVisibleByWeather } = useBabylonWeather({
 *   scene,
 *   isTopDownView: false
 * })
 *
 * // 3. Setup labels (needs visibility culling function)
 * const labels = useBabylonLabels({ scene, isVisibleByWeather })
 * ```
 *
 * ## Fog Dome Implementation
 *
 * The fog dome is a hemisphere mesh that surrounds the camera at the METAR
 * visibility distance, creating a "fog wall" effect.
 *
 * ### Geometry
 * - **Shape**: Sphere with BACKSIDE orientation (renders inside faces only)
 * - **Base diameter**: 2 meters (scaled dynamically based on visibility)
 * - **Segments**: 32 (smooth sphere, balanced polygon count)
 *
 * ### Material
 * - **Diffuse color**: Light gray-blue [0.8, 0.8, 0.82]
 * - **Emissive color**: Self-illuminated [0.6, 0.6, 0.65]
 * - **Specular**: Black (no highlights)
 * - **Alpha**: Base 0.3, adjusted based on visibility severity
 *
 * ### Fresnel Effect
 * The fog uses opacity fresnel to create realistic fog appearance:
 * - **Center**: Almost fully transparent (looking through fog)
 * - **Edges**: More opaque (looking at fog wall)
 * - **Bias**: Adjusted based on visibility (0.1-0.3)
 * - **Power**: 3 (sharp edge falloff)
 *
 * This makes fog barely visible in good visibility (6+ SM) but prominent
 * in low visibility (<1 SM).
 *
 * ### Dynamic Scaling
 * The fog dome is scaled to match METAR visibility distance:
 * ```typescript
 * // METAR visibility: 1 SM = 1609.34 meters
 * const domeScale = visibilityMeters * visibilityScale
 * fogDome.scaling.setAll(domeScale)
 * ```
 *
 * The `visibilityScale` setting allows users to see farther (2.0 = double distance).
 *
 * ### Visibility-Based Opacity
 * Fog opacity is adjusted based on METAR visibility thresholds:
 *
 * | Visibility | Alpha | Fresnel Bias | Effect |
 * |------------|-------|--------------|--------|
 * | ≤ 0.25 SM  | 0.5   | 0.3          | Heavy fog (extremely low vis) |
 * | 0.25-1 SM  | 0.5→0.25 | 0.3→0.15  | Moderate to heavy fog (low vis) |
 * | 1-3 SM     | 0.25→0.1 | 0.15→0.1  | Light fog (moderate vis) |
 * | 3-6 SM     | 0.1→0.03 | 0.1       | Very light haze (decent vis) |
 * | > 6 SM     | 0.03  | 0.1          | Barely visible hint (good vis) |
 *
 * Interpolation is linear within each range for smooth transitions.
 *
 * ### Intensity Multiplier
 * The `fogIntensity` setting multiplies the base alpha:
 * ```typescript
 * finalAlpha = Math.min(1.0, baseAlpha * fogIntensity)
 * ```
 *
 * This allows users to customize fog density (0.5 = half, 1.0 = default, 2.0 = double).
 *
 * ## Cloud Layer Implementation
 *
 * Cloud layers are represented as large horizontal plane meshes positioned at
 * METAR-reported ceiling altitudes.
 *
 * ### Mesh Pool
 * - **Pool size**: 4 layers (matches max METAR cloud layers)
 * - **Diameter**: 50km (covers horizon from typical tower heights)
 * - **Rotation**: 90° around X-axis (XY plane → XZ horizontal plane)
 *
 * ### Material
 * - **Diffuse color**: Slightly blue-tinted white [0.95, 0.95, 0.98]
 * - **Emissive color**: Subtle self-illumination [0.4, 0.4, 0.45]
 * - **Base alpha**: 0.5
 * - **Back face culling**: false (visible from above and below)
 * - **Lighting**: enabled for realistic shading
 *
 * ### Dynamic Opacity
 * Cloud opacity is calculated from METAR coverage and user setting:
 * ```typescript
 * cloudAlpha = cloudLayer.coverage * cloudOpacity
 * ```
 *
 * Coverage values:
 * - FEW: 0.125 (very transparent)
 * - SCT: 0.375 (partially transparent)
 * - BKN: 0.75 (mostly opaque)
 * - OVC: 1.0 (fully opaque)
 *
 * ### Top-Down Mode Behavior
 * Clouds are **hidden** in top-down view because looking straight down through
 * clouds would obscure the entire map. This is controlled by the `isTopDownView` prop.
 *
 * ## Weather Visibility Culling
 *
 * The `isVisibleByWeather` function determines if aircraft labels should be
 * visible based on METAR weather conditions.
 *
 * ### Surface Visibility Culling
 * Aircraft beyond METAR visibility range are hidden:
 * ```typescript
 * visibilityMeters = metar.visibility * 1609.34 * visibilityScale
 * if (horizontalDistance > visibilityMeters) return false
 * ```
 *
 * ### Cloud Ceiling Culling
 * Aircraft obscured by BKN/OVC cloud layers are hidden:
 * ```typescript
 * if (layer.coverage >= 0.75 &&
 *     layer.altitude between [cameraAlt, aircraftAlt]) {
 *   return false  // Cloud blocks line-of-sight
 * }
 * ```
 *
 * **Note:** Cloud culling is skipped in top-down view since clouds don't
 * visually obscure in that mode.
 *
 * ### Culling Conditions
 * The function returns `false` (hide aircraft) if:
 * 1. Aircraft is beyond surface visibility range (fog)
 * 2. A BKN/OVC cloud layer is between camera and aircraft
 *
 * Otherwise returns `true` (show aircraft).
 *
 * ## Memory Management
 *
 * All weather resources are properly disposed on unmount:
 * 1. Cloud plane materials disposed
 * 2. Cloud plane meshes disposed
 * 3. Fog dome material disposed
 * 4. Fog dome mesh disposed
 * 5. All refs cleared
 *
 * **Important:** This hook manages its own resources but relies on the scene
 * being available. If the scene is disposed before this hook unmounts, resources
 * may already be cleaned up by scene disposal.
 *
 * ## Performance Considerations
 *
 * - **Fog dome**: Single mesh, ~2000 polygons (32 segments), minimal impact
 * - **Cloud layers**: 4 large planes (50km each), ~8 polygons total, negligible
 * - **Material updates**: Only when METAR data changes (5-minute interval)
 * - **Visibility culling**: O(n) where n = number of cloud layers (max 4)
 *
 * @param options - Weather configuration options
 * @param options.scene - Initialized Babylon.js scene (required)
 * @param options.isTopDownView - Whether camera is in top-down mode (default: false)
 * @returns Weather effect meshes and visibility culling function
 *
 * @example
 * // Basic weather effects setup
 * const { fogDome, cloudLayers, isVisibleByWeather } = useBabylonWeather({
 *   scene: babylonScene,
 *   isTopDownView: false
 * })
 *
 * // Check if aircraft label should be visible
 * const visible = isVisibleByWeather({
 *   cameraAltitudeMeters: 10,         // Tower at 10m AGL
 *   aircraftAltitudeMeters: 1500,     // Aircraft at 1500m AGL
 *   horizontalDistanceMeters: 8000    // 8km away
 * })
 *
 * @example
 * // Using with top-down view
 * const [isTopDown, setIsTopDown] = useState(false)
 *
 * const weather = useBabylonWeather({
 *   scene,
 *   isTopDownView: isTopDown  // Clouds will be hidden when true
 * })
 *
 * @example
 * // Integrating with label management
 * const { isVisibleByWeather } = useBabylonWeather({ scene })
 *
 * // In label update logic
 * filteredAircraft.forEach(aircraft => {
 *   const visible = isVisibleByWeather({
 *     cameraAltitudeMeters: towerHeight,
 *     aircraftAltitudeMeters: aircraft.altitudeAGL,
 *     horizontalDistanceMeters: aircraft.distance * 1852  // NM to meters
 *   })
 *
 *   if (visible) {
 *     updateLabel(aircraft.callsign, aircraft.position, aircraft.text)
 *   } else {
 *     removeLabel(aircraft.callsign)
 *   }
 * })
 *
 * @see useBabylonScene - For scene initialization
 * @see useBabylonLabels - For label management with visibility culling
 * @see weatherStore - For METAR data and cloud layers
 * @see settingsStore - For weather effect toggles and intensities
 */
export function useBabylonWeather(
  options: UseBabylonWeatherOptions
): UseBabylonWeatherResult {
  const { scene, isTopDownView = false } = options

  const fogDomeRef = useRef<BABYLON.Mesh | null>(null)
  const fogDomeMaterialRef = useRef<BABYLON.StandardMaterial | null>(null)
  const cloudMeshPoolRef = useRef<CloudMeshData[]>([])
  const cloudFadeTextureRef = useRef<BABYLON.DynamicTexture | null>(null)

  // Weather store subscriptions
  const cloudLayers = useWeatherStore((state) => state.cloudLayers)
  const currentMetar = useWeatherStore((state) => state.currentMetar)
  const fogDensity = useWeatherStore((state) => state.fogDensity)
  const showWeatherEffects = useSettingsStore((state) => state.weather.showWeatherEffects)
  const showCesiumFog = useSettingsStore((state) => state.weather.showCesiumFog)
  const showBabylonFog = useSettingsStore((state) => state.weather.showBabylonFog)
  const showClouds = useSettingsStore((state) => state.weather.showClouds)
  const cloudOpacity = useSettingsStore((state) => state.weather.cloudOpacity)
  const fogIntensity = useSettingsStore((state) => state.weather.fogIntensity)
  const visibilityScale = useSettingsStore((state) => state.weather.visibilityScale)

  // Create cloud plane mesh pool and fog dome
  useEffect(() => {
    if (!scene) return

    // Create a radial gradient texture for cloud edge fade-out
    // This makes clouds fade to transparent at the edges instead of having hard square borders
    const textureSize = 512
    const cloudFadeTexture = new BABYLON.DynamicTexture('cloud_fade_texture', textureSize, scene, false)
    const ctx = cloudFadeTexture.getContext()

    // Create radial gradient: opaque center, transparent edges
    const centerX = textureSize / 2
    const centerY = textureSize / 2
    const innerRadius = 0  // Start fully opaque at center
    const outerRadius = textureSize / 2  // Fade to transparent at edge

    const gradient = ctx.createRadialGradient(centerX, centerY, innerRadius, centerX, centerY, outerRadius)
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)')      // Center: fully opaque
    gradient.addColorStop(0.5, 'rgba(255, 255, 255, 1)')    // 50%: still opaque
    gradient.addColorStop(0.75, 'rgba(255, 255, 255, 0.5)') // 75%: start fading
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')      // Edge: fully transparent

    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, textureSize, textureSize)
    cloudFadeTexture.update()
    cloudFadeTextureRef.current = cloudFadeTexture

    // Create cloud plane mesh pool
    for (let i = 0; i < CLOUD_POOL_SIZE; i++) {
      const plane = BABYLON.MeshBuilder.CreatePlane(`cloud_layer_${i}`, {
        size: CLOUD_PLANE_DIAMETER
      }, scene)

      // Rotate to horizontal (XZ plane)
      plane.rotation.x = CLOUD_PLANE_ROTATION_X
      plane.isVisible = false

      // Create semi-transparent cloud material with edge fade
      const material = new BABYLON.StandardMaterial(`cloud_mat_${i}`, scene)
      material.diffuseColor = new BABYLON.Color3(...CLOUD_DIFFUSE_COLOR)
      material.emissiveColor = new BABYLON.Color3(...CLOUD_EMISSIVE_COLOR)
      material.alpha = CLOUD_BASE_ALPHA
      material.backFaceCulling = false
      material.disableLighting = false
      material.opacityTexture = cloudFadeTexture  // Apply radial fade
      material.useAlphaFromDiffuseTexture = false
      plane.material = material

      cloudMeshPoolRef.current.push({ plane, material })
    }

    // Create fog dome
    const fogDome = BABYLON.MeshBuilder.CreateSphere('fog_dome', {
      diameter: FOG_DOME_BASE_DIAMETER,
      segments: FOG_DOME_SEGMENTS,
      sideOrientation: BABYLON.Mesh.BACKSIDE
    }, scene)
    fogDome.isVisible = false

    const fogDomeMaterial = new BABYLON.StandardMaterial('fog_dome_mat', scene)
    fogDomeMaterial.diffuseColor = new BABYLON.Color3(...FOG_DIFFUSE_COLOR)
    fogDomeMaterial.emissiveColor = new BABYLON.Color3(...FOG_EMISSIVE_COLOR)
    fogDomeMaterial.specularColor = new BABYLON.Color3(...FOG_SPECULAR_COLOR)
    fogDomeMaterial.alpha = FOG_BASE_ALPHA
    fogDomeMaterial.backFaceCulling = true
    fogDomeMaterial.disableLighting = true

    // Fresnel effect for fog
    fogDomeMaterial.opacityFresnelParameters = new BABYLON.FresnelParameters()
    fogDomeMaterial.opacityFresnelParameters.bias = FOG_FRESNEL_BIAS
    fogDomeMaterial.opacityFresnelParameters.power = FOG_FRESNEL_POWER
    fogDomeMaterial.opacityFresnelParameters.leftColor = new BABYLON.Color3(1, 1, 1)
    fogDomeMaterial.opacityFresnelParameters.rightColor = new BABYLON.Color3(0, 0, 0)

    fogDome.material = fogDomeMaterial
    fogDomeRef.current = fogDome
    fogDomeMaterialRef.current = fogDomeMaterial

    return () => {
      // Dispose cloud planes
      for (const cloudData of cloudMeshPoolRef.current) {
        cloudData.material?.dispose()
        cloudData.plane.dispose()
      }
      cloudMeshPoolRef.current = []

      // Dispose cloud fade texture
      cloudFadeTextureRef.current?.dispose()
      cloudFadeTextureRef.current = null

      // Dispose fog dome
      fogDomeMaterialRef.current?.dispose()
      fogDomeRef.current?.dispose()
      fogDomeRef.current = null
      fogDomeMaterialRef.current = null
    }
  }, [scene])

  // Update cloud planes based on weather data
  useEffect(() => {
    if (cloudMeshPoolRef.current.length === 0) return

    const shouldShowClouds = showWeatherEffects && showClouds && !isTopDownView
    const pool = cloudMeshPoolRef.current

    for (let i = 0; i < CLOUD_POOL_SIZE; i++) {
      const meshData = pool[i]
      if (!meshData) continue

      if (!shouldShowClouds || i >= cloudLayers.length) {
        meshData.plane.isVisible = false
        continue
      }

      const layer = cloudLayers[i]
      meshData.plane.position.y = layer.altitude
      meshData.plane.isVisible = true
      meshData.material.alpha = layer.coverage * cloudOpacity
    }
  }, [cloudLayers, showWeatherEffects, showClouds, cloudOpacity, isTopDownView])

  // Apply fog dome effect
  useEffect(() => {
    const fogDome = fogDomeRef.current
    const fogMaterial = fogDomeMaterialRef.current
    if (!fogDome || !fogMaterial) return

    const shouldShowFog = showWeatherEffects && showBabylonFog && currentMetar && fogDensity > 0

    if (shouldShowFog && currentMetar) {
      const visibilityMeters = currentMetar.visib * STATUTE_MILES_TO_METERS
      const domeScale = visibilityMeters * visibilityScale
      fogDome.scaling.setAll(domeScale)

      // Adjust fog opacity based on visibility severity
      const visib = currentMetar.visib
      let baseAlpha: number
      let fresnelBias: number

      if (visib <= VISIBILITY_THRESHOLD_EXTREMELY_LOW) {
        baseAlpha = FOG_ALPHA_EXTREMELY_LOW
        fresnelBias = FOG_FRESNEL_BIAS_EXTREMELY_LOW
      } else if (visib <= VISIBILITY_THRESHOLD_LOW) {
        const t = (visib - VISIBILITY_THRESHOLD_EXTREMELY_LOW) / (VISIBILITY_THRESHOLD_LOW - VISIBILITY_THRESHOLD_EXTREMELY_LOW)
        baseAlpha = FOG_ALPHA_EXTREMELY_LOW - (t * (FOG_ALPHA_EXTREMELY_LOW - FOG_ALPHA_LOW_MIN))
        fresnelBias = FOG_FRESNEL_BIAS_EXTREMELY_LOW - (t * (FOG_FRESNEL_BIAS_EXTREMELY_LOW - FOG_FRESNEL_BIAS_LOW_MIN))
      } else if (visib <= VISIBILITY_THRESHOLD_MODERATE) {
        const t = (visib - VISIBILITY_THRESHOLD_LOW) / (VISIBILITY_THRESHOLD_MODERATE - VISIBILITY_THRESHOLD_LOW)
        baseAlpha = FOG_ALPHA_LOW_MIN - (t * (FOG_ALPHA_LOW_MIN - FOG_ALPHA_MODERATE_MIN))
        fresnelBias = FOG_FRESNEL_BIAS_LOW_MIN - (t * (FOG_FRESNEL_BIAS_LOW_MIN - FOG_FRESNEL_BIAS_MODERATE))
      } else if (visib <= VISIBILITY_THRESHOLD_DECENT) {
        const t = (visib - VISIBILITY_THRESHOLD_MODERATE) / (VISIBILITY_THRESHOLD_DECENT - VISIBILITY_THRESHOLD_MODERATE)
        baseAlpha = FOG_ALPHA_MODERATE_MIN - (t * (FOG_ALPHA_MODERATE_MIN - FOG_ALPHA_DECENT_MIN))
        fresnelBias = FOG_FRESNEL_BIAS_MODERATE
      } else {
        baseAlpha = FOG_ALPHA_GOOD
        fresnelBias = FOG_FRESNEL_BIAS_MODERATE
      }

      fogMaterial.alpha = Math.min(1.0, baseAlpha * fogIntensity)
      fogMaterial.opacityFresnelParameters!.bias = fresnelBias
      fogDome.isVisible = true
    } else {
      fogDome.isVisible = false
    }
  }, [showWeatherEffects, showBabylonFog, currentMetar, fogDensity, fogIntensity, visibilityScale])

  // Weather-based visibility culling function
  const isVisibleByWeather = useCallback((params: WeatherVisibilityParams): boolean => {
    const { cameraAltitudeMeters, aircraftAltitudeMeters, horizontalDistanceMeters } = params

    if (!showWeatherEffects) return true

    // Surface visibility culling
    if (currentMetar && showCesiumFog) {
      const visibilityMeters = currentMetar.visib * STATUTE_MILES_TO_METERS * visibilityScale
      if (horizontalDistanceMeters > visibilityMeters) {
        return false
      }
    }

    // Cloud ceiling culling (skip in top-down view)
    if (showClouds && cloudLayers.length > 0 && !isTopDownView) {
      const lowerAlt = Math.min(cameraAltitudeMeters, aircraftAltitudeMeters)
      const higherAlt = Math.max(cameraAltitudeMeters, aircraftAltitudeMeters)

      for (const layer of cloudLayers) {
        if (layer.coverage >= CLOUD_CEILING_COVERAGE_THRESHOLD) {
          if (layer.altitude > lowerAlt && layer.altitude < higherAlt) {
            return false
          }
        }
      }
    }

    return true
  }, [showWeatherEffects, showCesiumFog, showClouds, currentMetar, cloudLayers, visibilityScale, isTopDownView])

  // Return getter function for cloud meshes to avoid stale closure issue
  // The mesh creation effect runs after initial render, so returning the ref
  // contents directly would capture an empty array
  const getCloudMeshes = useCallback(() => cloudMeshPoolRef.current, [])

  return {
    fogDome: fogDomeRef.current,
    getCloudMeshes,
    isVisibleByWeather
  }
}

export default useBabylonWeather
