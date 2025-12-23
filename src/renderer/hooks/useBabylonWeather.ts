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
  STATUTE_MILES_TO_METERS,
  CLOUD_NOISE_TEXTURE_SIZE,
  CLOUD_NOISE_OCTAVES,
  CLOUD_NOISE_SCALE,
  CLOUD_NOISE_PERSISTENCE,
  CLOUD_EDGE_SOFTNESS,
  CLOUD_RADIAL_FADE_START,
  CLOUD_RADIAL_FADE_END,
  CLOUD_ROTATION_SPEED,
  CLOUD_ROTATION_SPEED_VARIANCE,
  CLOUD_ROTATION_CHANGE_INTERVAL,
  CLOUD_ROTATION_TRANSITION_TIME
} from '@/constants'

interface UseBabylonWeatherOptions {
  scene: BABYLON.Scene | null
  isTopDownView?: boolean
}

// ============================================================================
// Noise Generation Functions for Patchy Clouds
// ============================================================================

/**
 * Simple hash function for pseudo-random number generation.
 * Used as the basis for procedural noise.
 */
function hash(x: number, y: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return n - Math.floor(n)
}

/**
 * Smooth noise interpolation at a point using bilinear interpolation.
 */
function smoothNoise(x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0

  // Smoothstep interpolation for smoother transitions
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)

  // Sample corners
  const n00 = hash(x0, y0)
  const n10 = hash(x0 + 1, y0)
  const n01 = hash(x0, y0 + 1)
  const n11 = hash(x0 + 1, y0 + 1)

  // Bilinear interpolation
  const nx0 = n00 * (1 - sx) + n10 * sx
  const nx1 = n01 * (1 - sx) + n11 * sx
  return nx0 * (1 - sy) + nx1 * sy
}

/**
 * Fractal Brownian Motion (fBm) noise - layered noise for natural cloud patterns.
 * Combines multiple octaves of noise at different frequencies.
 */
function fbmNoise(x: number, y: number, octaves: number, persistence: number): number {
  let total = 0
  let amplitude = 1
  let maxValue = 0
  let frequency = 1

  for (let i = 0; i < octaves; i++) {
    total += smoothNoise(x * frequency, y * frequency) * amplitude
    maxValue += amplitude
    amplitude *= persistence
    frequency *= 2
  }

  return total / maxValue // Normalize to 0-1
}

/**
 * Generate a patchy cloud opacity texture using fBm noise.
 * Coverage determines how much of the noise becomes visible cloud vs transparent gap.
 *
 * @param scene - Babylon.js scene
 * @param textureSize - Size of the texture in pixels
 * @param coverage - Cloud coverage (0-1, from METAR oktas)
 * @param seed - Random seed for unique patterns per layer
 * @returns DynamicTexture with patchy cloud pattern and radial edge fade
 */
function createPatchyCloudTexture(
  scene: BABYLON.Scene,
  textureSize: number,
  coverage: number,
  seed: number = 0
): BABYLON.DynamicTexture {
  const texture = new BABYLON.DynamicTexture(
    `cloud_patchy_${seed}_${coverage.toFixed(3)}`,
    textureSize,
    scene,
    true // generateMipMaps - prevents jagged edges when stretched over large plane
  )
  const ctx = texture.getContext() as CanvasRenderingContext2D

  const imageData = ctx.createImageData(textureSize, textureSize)
  const data = imageData.data

  const centerX = textureSize / 2
  const centerY = textureSize / 2
  const maxRadius = textureSize / 2

  // Coverage determines the noise threshold
  // For BKN/OVC (high coverage), we want mostly solid with small breaks
  // For FEW/SCT (low coverage), we want mostly clear with cloud patches
  const noiseScale = 10.0

  for (let y = 0; y < textureSize; y++) {
    for (let x = 0; x < textureSize; x++) {
      const idx = (y * textureSize + x) * 4

      // Generate fBm noise value with seed offset for variety between layers
      const nx = (x / textureSize) * noiseScale + seed * 100
      const ny = (y / textureSize) * noiseScale + seed * 100
      const noiseValue = fbmNoise(nx, ny, CLOUD_NOISE_OCTAVES, CLOUD_NOISE_PERSISTENCE)

      // Calculate cloud opacity based on coverage level
      let cloudAlpha: number
      if (coverage >= 0.95) {
        // OVC: completely solid, no breaks at all
        cloudAlpha = 1.0
      } else if (coverage >= 0.6) {
        // BKN: mostly solid with visible breaks where noise is low
        // Use higher gap threshold to ensure visible sky breaks
        // For BKN (0.6875): gap threshold ≈ 0.45, so ~40% of texture is gaps
        const gapThreshold = (1.0 - coverage) + 0.15
        if (noiseValue < gapThreshold) {
          // Clear gap - fully transparent for visible sky
          cloudAlpha = 0.0
        } else if (noiseValue < gapThreshold + 0.1) {
          // Soft edge transition
          cloudAlpha = (noiseValue - gapThreshold) / 0.1
        } else {
          cloudAlpha = 1.0
        }
      } else {
        // FEW/SCT: patches of cloud where noise is high
        // Higher coverage = lower threshold = more cloud patches
        const threshold = 0.5 + 0.2 * (1.0 - 2.0 * coverage)
        if (noiseValue > threshold) {
          const edge = (noiseValue - threshold) / CLOUD_EDGE_SOFTNESS
          cloudAlpha = Math.min(1.0, edge)
        } else {
          cloudAlpha = 0.0
        }
      }

      // Apply radial fade (clouds fade to transparent at edges)
      // But for high coverage, delay the fade start so center area is fully covered
      const dx = x - centerX
      const dy = y - centerY
      const distance = Math.sqrt(dx * dx + dy * dy) / maxRadius

      // Coverage determines fade start:
      // - OVC (0.95+): softer edge starting at 0.5 for gradual horizon fade
      // - BKN (0.6+): later fade at 0.7 for mostly solid center
      // - FEW/SCT: default fade start
      let fadeStart: number
      if (coverage >= 0.95) {
        fadeStart = 0.5  // OVC: soft gradual edge
      } else if (coverage >= 0.6) {
        fadeStart = 0.7  // BKN: later start, mostly solid
      } else {
        fadeStart = CLOUD_RADIAL_FADE_START  // FEW/SCT: default
      }
      let radialFade = 1.0
      if (distance > fadeStart) {
        radialFade = 1.0 - (distance - fadeStart) / (CLOUD_RADIAL_FADE_END - fadeStart)
        radialFade = Math.max(0, Math.min(1, radialFade))
      }

      // Combine patchy cloud with radial fade
      const finalAlpha = cloudAlpha * radialFade

      // Write RGBA - white color with alpha for transparency
      data[idx] = 255     // R
      data[idx + 1] = 255 // G
      data[idx + 2] = 255 // B
      data[idx + 3] = Math.round(finalAlpha * 255) // A
    }
  }

  ctx.putImageData(imageData, 0, 0)
  texture.hasAlpha = true
  texture.update()

  return texture
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

    // Create cloud plane mesh pool (opacity textures are set dynamically based on coverage)
    for (let i = 0; i < CLOUD_POOL_SIZE; i++) {
      const plane = BABYLON.MeshBuilder.CreatePlane(`cloud_layer_${i}`, {
        size: CLOUD_PLANE_DIAMETER
      }, scene)

      // Rotate to horizontal (XZ plane)
      plane.rotation.x = CLOUD_PLANE_ROTATION_X
      plane.isVisible = false

      // Create semi-transparent cloud material (diffuseTexture with alpha set in update effect)
      const material = new BABYLON.StandardMaterial(`cloud_mat_${i}`, scene)
      material.diffuseColor = new BABYLON.Color3(...CLOUD_DIFFUSE_COLOR)
      material.emissiveColor = new BABYLON.Color3(...CLOUD_EMISSIVE_COLOR)
      material.alpha = CLOUD_BASE_ALPHA
      material.backFaceCulling = false
      material.disableLighting = false
      material.useAlphaFromDiffuseTexture = true  // Use alpha channel from diffuseTexture
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
      // Dispose cloud planes and their individual diffuse textures
      for (const cloudData of cloudMeshPoolRef.current) {
        cloudData.material.diffuseTexture?.dispose()
        cloudData.material?.dispose()
        cloudData.plane.dispose()
      }
      cloudMeshPoolRef.current = []

      // Dispose fog dome
      fogDomeMaterialRef.current?.dispose()
      fogDomeRef.current?.dispose()
      fogDomeRef.current = null
      fogDomeMaterialRef.current = null
    }
  }, [scene])

  // Update cloud planes based on weather data with patchy textures
  useEffect(() => {
    if (cloudMeshPoolRef.current.length === 0 || !scene) return

    const shouldShowClouds = showWeatherEffects && showClouds && !isTopDownView
    const pool = cloudMeshPoolRef.current

    for (let i = 0; i < CLOUD_POOL_SIZE; i++) {
      const meshData = pool[i]
      if (!meshData) continue

      if (!shouldShowClouds || i >= cloudLayers.length) {
        meshData.plane.isVisible = false
        // Dispose texture when layer is hidden to free GPU memory
        if (meshData.material.diffuseTexture) {
          meshData.material.diffuseTexture.dispose()
          meshData.material.diffuseTexture = null
          meshData.lastCoverage = undefined
        }
        continue
      }

      const layer = cloudLayers[i]
      meshData.plane.position.y = layer.altitude
      meshData.plane.isVisible = true

      // Always regenerate texture when cloud layers update
      // This allows testing different random patterns via the debug panel
      // Dispose old texture if exists
      if (meshData.material.diffuseTexture) {
        meshData.material.diffuseTexture.dispose()
      }

      // Create new patchy texture with random seed for variety
      const randomSeed = i + Math.random() * 10000
      const patchyTexture = createPatchyCloudTexture(
        scene,
        CLOUD_NOISE_TEXTURE_SIZE,
        layer.coverage,
        randomSeed
      )
      meshData.material.diffuseTexture = patchyTexture

      // Scale material alpha based on coverage - denser clouds are more opaque
      // OVC should be completely solid, BKN nearly solid, FEW/SCT more transparent
      let baseAlpha: number
      if (layer.coverage >= 0.95) {
        // OVC: fully opaque - use OPAQUE mode to truly block transparency
        baseAlpha = 1.0
        meshData.material.transparencyMode = BABYLON.Material.MATERIAL_OPAQUE
        meshData.material.needDepthPrePass = true
        // Disable Babylon lighting - use only emissive for consistent dark gray appearance
        // This prevents the always-on hemispheric light from making OVC blindingly bright
        meshData.material.disableLighting = true
        meshData.material.emissiveColor = new BABYLON.Color3(0.25, 0.25, 0.28)
        meshData.material.diffuseColor = new BABYLON.Color3(0, 0, 0)
      } else if (layer.coverage >= 0.6) {
        // BKN: nearly opaque with alpha blending for gaps
        baseAlpha = 0.95
        meshData.material.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND
        meshData.material.needDepthPrePass = false
        meshData.material.emissiveColor = new BABYLON.Color3(...CLOUD_EMISSIVE_COLOR)
      } else {
        // FEW/SCT: transparent with alpha blending
        baseAlpha = 0.6 + layer.coverage * 0.4
        meshData.material.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND
        meshData.material.needDepthPrePass = false
        meshData.material.emissiveColor = new BABYLON.Color3(...CLOUD_EMISSIVE_COLOR)
      }
      meshData.material.alpha = baseAlpha * cloudOpacity
    }
  }, [scene, cloudLayers, showWeatherEffects, showClouds, cloudOpacity, isTopDownView])

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

  // Slowly rotate cloud planes to simulate cloud drift with variable speed per layer
  // Layers at similar altitudes have correlated speeds (similar wind at similar heights)
  useEffect(() => {
    if (!scene) return

    let lastTime = performance.now()
    let lastSpeedChangeTime = performance.now()

    // Per-layer rotation state
    interface LayerRotationState {
      currentSpeed: number
      targetSpeed: number
    }
    const layerStates: LayerRotationState[] = []

    // Initialize states for each layer in the pool
    for (let i = 0; i < CLOUD_POOL_SIZE; i++) {
      const initialSpeed = CLOUD_ROTATION_SPEED * (1 + (Math.random() * 2 - 1) * CLOUD_ROTATION_SPEED_VARIANCE)
      layerStates.push({
        currentSpeed: initialSpeed,
        targetSpeed: initialSpeed
      })
    }

    // Generate new target speeds for all layers, correlating by altitude proximity
    const pickNewTargetSpeeds = () => {
      const pool = cloudMeshPoolRef.current
      if (pool.length === 0) return

      // Get altitudes of visible layers
      const layerAltitudes: { index: number; altitude: number }[] = []
      for (let i = 0; i < pool.length; i++) {
        if (pool[i].plane.isVisible) {
          layerAltitudes.push({ index: i, altitude: pool[i].plane.position.y })
        }
      }

      if (layerAltitudes.length === 0) return

      // Sort by altitude
      layerAltitudes.sort((a, b) => a.altitude - b.altitude)

      // Pick a base speed for the lowest layer
      const baseVariance = (Math.random() * 2 - 1) * CLOUD_ROTATION_SPEED_VARIANCE
      const lowestLayerSpeed = CLOUD_ROTATION_SPEED * (1 + baseVariance)
      layerStates[layerAltitudes[0].index].targetSpeed = lowestLayerSpeed

      // For each subsequent layer, vary speed based on altitude difference
      // Layers close together (< 500m) have very similar speeds
      // Layers far apart (> 2000m) can have very different speeds
      for (let i = 1; i < layerAltitudes.length; i++) {
        const prevLayer = layerAltitudes[i - 1]
        const currLayer = layerAltitudes[i]
        const altitudeDiff = Math.abs(currLayer.altitude - prevLayer.altitude)

        // Normalize altitude difference: 0 at 0m, 1 at 2000m+
        const normalizedDiff = Math.min(1, altitudeDiff / 2000)

        // Correlation factor: 1 = same speed, 0 = independent speed
        // Close layers (normalizedDiff ~0) have high correlation
        const correlation = 1 - normalizedDiff

        // Generate independent random variance for this layer
        const independentVariance = (Math.random() * 2 - 1) * CLOUD_ROTATION_SPEED_VARIANCE
        const independentSpeed = CLOUD_ROTATION_SPEED * (1 + independentVariance)

        // Blend between previous layer's speed and independent speed
        const prevSpeed = layerStates[prevLayer.index].targetSpeed
        layerStates[currLayer.index].targetSpeed =
          prevSpeed * correlation + independentSpeed * (1 - correlation)
      }

      // Also set target speeds for non-visible layers (in case they become visible)
      for (let i = 0; i < pool.length; i++) {
        if (!pool[i].plane.isVisible) {
          const variance = (Math.random() * 2 - 1) * CLOUD_ROTATION_SPEED_VARIANCE
          layerStates[i].targetSpeed = CLOUD_ROTATION_SPEED * (1 + variance)
        }
      }
    }

    // Pick initial target speeds
    pickNewTargetSpeeds()

    const observer = scene.onBeforeRenderObservable.add(() => {
      const now = performance.now()
      const deltaSeconds = (now - lastTime) / 1000
      lastTime = now

      // Periodically pick new target speeds
      const timeSinceSpeedChange = (now - lastSpeedChangeTime) / 1000
      if (timeSinceSpeedChange > CLOUD_ROTATION_CHANGE_INTERVAL) {
        pickNewTargetSpeeds()
        lastSpeedChangeTime = now
      }

      // Smoothly interpolate each layer's speed and apply rotation
      const lerpFactor = Math.min(1, deltaSeconds / CLOUD_ROTATION_TRANSITION_TIME)
      const pool = cloudMeshPoolRef.current

      for (let i = 0; i < pool.length; i++) {
        const meshData = pool[i]
        const state = layerStates[i]

        if (meshData.plane.isVisible) {
          // Smoothly interpolate toward target speed
          state.currentSpeed = state.currentSpeed + (state.targetSpeed - state.currentSpeed) * lerpFactor

          // Rotate around Y axis (vertical in Babylon)
          meshData.plane.rotation.y += state.currentSpeed * deltaSeconds
        }
      }
    })

    return () => {
      scene.onBeforeRenderObservable.remove(observer)
    }
  }, [scene])

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
