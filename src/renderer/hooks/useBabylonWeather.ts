import { useEffect, useRef, useCallback } from 'react'
import * as BABYLON from '@babylonjs/core'
import { useWeatherStore } from '../stores/weatherStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useAirportStore } from '../stores/airportStore'
import type { UseBabylonWeatherResult, CloudMeshData, WeatherVisibilityParams, CloudLayer } from '@/types'
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
  CLOUD_ROTATION_SPEED,
  CLOUD_ROTATION_SPEED_VARIANCE,
  CLOUD_ROTATION_CHANGE_INTERVAL,
  CLOUD_ROTATION_TRANSITION_TIME,
  CLOUD_LAYER_MATCH_ALTITUDE_THRESHOLD,
  CLOUD_LAYER_MATCH_COVERAGE_THRESHOLD,
  CLOUD_LAYER_ALTITUDE_TRANSITION_SPEED,
  CLOUD_LAYER_COVERAGE_TRANSITION_SPEED,
  CLOUD_LAYER_FADE_SPEED,
  CLOUD_LAYER_COVERAGE_REGEN_THRESHOLD,
  CLOUD_DOME_COVERAGE_THRESHOLD,
  CLOUD_DOME_FRESNEL_BIAS,
  CLOUD_DOME_FRESNEL_POWER,
  CLOUD_ABOVE_TRANSITION_BUFFER,
  CLOUD_DOME_FRESNEL_BIAS_ABOVE,
  CLOUD_ABOVE_DIFFUSE_COLOR,
  CLOUD_ABOVE_EMISSIVE_COLOR,
  CLOUD_ABOVE_BASE_ALPHA,
  VISIBILITY_TRANSITION_TIME
} from '@/constants'

// Import extracted weather utilities
import {
  createPatchyCloudTexture,
  createOvercastDomeTexture,
  createAboveCloudTexture,
  createCloudDomeMesh
} from './weather'

interface UseBabylonWeatherOptions {
  scene: BABYLON.Scene | null
  isTopDownView?: boolean
}

/**
 * Persistent state for a cloud layer that enables smooth transitions.
 * When METAR updates, layers are matched by altitude proximity and
 * transitions are animated rather than instantly regenerated.
 */
interface CloudLayerState {
  /** Noise seed for texture generation - persists when layer matches to keep pattern */
  noiseSeed: number
  /** Current coverage being displayed (animates toward target) */
  currentCoverage: number
  /** Target coverage from METAR data */
  targetCoverage: number
  /** Current altitude in meters (animates toward target) */
  currentAltitude: number
  /** Target altitude from METAR data */
  targetAltitude: number
  /** Current alpha/opacity (for fade in/out transitions) */
  currentAlpha: number
  /** Target alpha (1 = visible, 0 = fading out) */
  targetAlpha: number
  /** Coverage value last used to generate texture (avoids unnecessary regeneration) */
  lastRenderedCoverage: number
  /** Whether this layer is actively in use */
  active: boolean
  /** Rotation state for this layer */
  rotation: {
    currentSpeed: number
    targetSpeed: number
  }
  /** Whether this layer should use dome geometry (for OVC coverage) */
  useDome: boolean
  /** Whether dome texture has been generated for current state */
  domeTextureGenerated: boolean
  /** Whether above-cloud texture has been generated for current state */
  aboveTextureGenerated: boolean
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
  const cloudLayerStatesRef = useRef<CloudLayerState[]>([])
  const cloudOpacityRef = useRef(1.0)
  const prevIsTopDownViewRef = useRef<boolean | undefined>(undefined)
  // Track if we've ever had active cloud layers (for instant display on initial load)
  const hadActiveCloudsRef = useRef(false)

  // Fog smoothing state - smooth transitions when interpolated weather changes
  const fogSmoothingRef = useRef({
    // Current smoothed values (what's actually rendered)
    currentVisibility: 10,
    currentAlpha: 0,
    currentFresnelBias: 0.1,
    currentScale: 10000,
    // Target values (from METAR data)
    targetVisibility: 10,
    targetAlpha: 0,
    targetFresnelBias: 0.1,
    targetScale: 10000,
    // Whether smoothing is initialized
    initialized: false
  })

  // Cloud layer smoothing - smooth the cloud layer data before matching
  const cloudSmoothingRef = useRef<{
    layers: Array<{
      currentAltitude: number
      currentCoverage: number
      targetAltitude: number
      targetCoverage: number
      type: string
    }>
    initialized: boolean
  }>({ layers: [], initialized: false })

  // Track current airport to detect airport switches (reset smoothing on switch)
  const currentAirportIcao = useAirportStore((state) => state.currentAirport?.icao ?? null)
  const prevAirportIcaoRef = useRef<string | null>(null)

  // Track camera position to detect position jumps (reset smoothing on teleport)
  const cameraPosition = useWeatherStore((state) => state.cameraPosition)
  const prevCameraPositionRef = useRef<{ lat: number; lon: number } | null>(null)

  // Weather store subscriptions
  const cloudLayers = useWeatherStore((state) => state.cloudLayers)
  const currentMetar = useWeatherStore((state) => state.currentMetar)
  const fogDensity = useWeatherStore((state) => state.fogDensity)
  const consumeInstantUpdate = useWeatherStore((state) => state.consumeInstantUpdate)
  const showWeatherEffects = useSettingsStore((state) => state.weather.showWeatherEffects)
  const showCesiumFog = useSettingsStore((state) => state.weather.showCesiumFog)
  const showBabylonFog = useSettingsStore((state) => state.weather.showBabylonFog)
  const showClouds = useSettingsStore((state) => state.weather.showClouds)
  const cloudOpacity = useSettingsStore((state) => state.weather.cloudOpacity)
  const fogIntensity = useSettingsStore((state) => state.weather.fogIntensity)
  const visibilityScale = useSettingsStore((state) => state.weather.visibilityScale)

  // Keep cloudOpacity ref in sync (avoids recreating animation effect when opacity changes)
  useEffect(() => {
    cloudOpacityRef.current = cloudOpacity
  }, [cloudOpacity])

  // Detect airport changes and reset smoothing (instant weather changes when switching airports)
  useEffect(() => {
    if (currentAirportIcao !== prevAirportIcaoRef.current) {
      prevAirportIcaoRef.current = currentAirportIcao

      // Reset fog smoothing - snap to target values
      const fogState = fogSmoothingRef.current
      fogState.currentVisibility = fogState.targetVisibility
      fogState.currentAlpha = fogState.targetAlpha
      fogState.currentFresnelBias = fogState.targetFresnelBias
      fogState.currentScale = fogState.targetScale

      // Reset cloud smoothing - snap to target values
      const cloudState = cloudSmoothingRef.current
      cloudState.initialized = false  // Force re-initialization for new airport
      for (const layer of cloudState.layers) {
        layer.currentAltitude = layer.targetAltitude
        layer.currentCoverage = layer.targetCoverage
      }

      // Also reset the visual cloud layer states to force immediate update
      for (const state of cloudLayerStatesRef.current) {
        state.currentAlpha = state.targetAlpha
        state.currentAltitude = state.targetAltitude
        state.currentCoverage = state.targetCoverage
      }

      // Reset initial load flag so clouds appear instantly at new airport
      hadActiveCloudsRef.current = false
    }
  }, [currentAirportIcao])

  // Detect camera position jumps and reset smoothing (instant weather when teleporting)
  // Threshold: ~5 nautical miles (0.083 degrees latitude ≈ 5nm)
  const POSITION_JUMP_THRESHOLD_DEG = 0.083
  useEffect(() => {
    if (!cameraPosition) return

    const prev = prevCameraPositionRef.current
    if (prev) {
      // Calculate approximate distance using simple lat/lon difference
      // This is fast and accurate enough for detecting large jumps
      const latDiff = Math.abs(cameraPosition.lat - prev.lat)
      const lonDiff = Math.abs(cameraPosition.lon - prev.lon) * Math.cos((cameraPosition.lat * Math.PI) / 180)
      const distance = Math.sqrt(latDiff * latDiff + lonDiff * lonDiff)

      if (distance > POSITION_JUMP_THRESHOLD_DEG) {
        // Position jumped significantly - reset all smoothing
        const fogState = fogSmoothingRef.current
        fogState.currentVisibility = fogState.targetVisibility
        fogState.currentAlpha = fogState.targetAlpha
        fogState.currentFresnelBias = fogState.targetFresnelBias
        fogState.currentScale = fogState.targetScale

        const cloudState = cloudSmoothingRef.current
        for (const layer of cloudState.layers) {
          layer.currentAltitude = layer.targetAltitude
          layer.currentCoverage = layer.targetCoverage
        }

        for (const state of cloudLayerStatesRef.current) {
          state.currentAlpha = state.targetAlpha
          state.currentAltitude = state.targetAltitude
          state.currentCoverage = state.targetCoverage
        }
      }
    }

    prevCameraPositionRef.current = { ...cameraPosition }
  }, [cameraPosition])

  // Create cloud plane mesh pool and fog dome
  useEffect(() => {
    if (!scene) return

    // Create cloud plane mesh pool (opacity textures are set dynamically based on coverage)
    for (let i = 0; i < CLOUD_POOL_SIZE; i++) {
      // Create flat plane for FEW/SCT/BKN coverage
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

      // Create dome mesh for OVC (overcast) coverage
      const dome = createCloudDomeMesh(`cloud_dome_${i}`, scene)
      dome.isVisible = false

      // Create dome material with fresnel effect for more realistic overcast appearance
      const domeMaterial = new BABYLON.StandardMaterial(`cloud_dome_mat_${i}`, scene)
      domeMaterial.diffuseColor = new BABYLON.Color3(0.75, 0.75, 0.78) // Slightly darker gray
      domeMaterial.emissiveColor = new BABYLON.Color3(0.35, 0.35, 0.38)
      domeMaterial.specularColor = new BABYLON.Color3(0, 0, 0)
      domeMaterial.alpha = 1.0
      domeMaterial.backFaceCulling = false
      domeMaterial.disableLighting = true // Use emissive for uniform lighting
      domeMaterial.useAlphaFromDiffuseTexture = true

      // Fresnel effect: more opaque at glancing angles (horizon), more transparent overhead
      domeMaterial.opacityFresnelParameters = new BABYLON.FresnelParameters()
      domeMaterial.opacityFresnelParameters.bias = CLOUD_DOME_FRESNEL_BIAS
      domeMaterial.opacityFresnelParameters.power = CLOUD_DOME_FRESNEL_POWER
      domeMaterial.opacityFresnelParameters.leftColor = new BABYLON.Color3(1, 1, 1)  // Opaque at edges
      domeMaterial.opacityFresnelParameters.rightColor = new BABYLON.Color3(0.7, 0.7, 0.7) // Slightly transparent center

      dome.material = domeMaterial

      // Create above-cloud plane (for viewing clouds from above)
      const abovePlane = BABYLON.MeshBuilder.CreatePlane(`cloud_above_${i}`, {
        size: CLOUD_PLANE_DIAMETER
      }, scene)
      abovePlane.rotation.x = CLOUD_PLANE_ROTATION_X
      abovePlane.isVisible = false

      // Above-cloud material: lighter colors simulating cloud tops
      const aboveMaterial = new BABYLON.StandardMaterial(`cloud_above_mat_${i}`, scene)
      aboveMaterial.diffuseColor = new BABYLON.Color3(...CLOUD_ABOVE_DIFFUSE_COLOR)
      aboveMaterial.emissiveColor = new BABYLON.Color3(...CLOUD_ABOVE_EMISSIVE_COLOR)
      aboveMaterial.specularColor = new BABYLON.Color3(0, 0, 0)
      aboveMaterial.alpha = CLOUD_ABOVE_BASE_ALPHA
      aboveMaterial.backFaceCulling = false
      aboveMaterial.disableLighting = true // Use emissive for uniform look
      aboveMaterial.useAlphaFromDiffuseTexture = true
      abovePlane.material = aboveMaterial

      cloudMeshPoolRef.current.push({ plane, dome, abovePlane, material, domeMaterial, aboveMaterial, usingDome: false })
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
      // Dispose cloud planes, domes, above-planes, and their individual diffuse textures
      for (const cloudData of cloudMeshPoolRef.current) {
        cloudData.material.diffuseTexture?.dispose()
        cloudData.material?.dispose()
        cloudData.plane.dispose()
        cloudData.domeMaterial.diffuseTexture?.dispose()
        cloudData.domeMaterial?.dispose()
        cloudData.dome.dispose()
        cloudData.aboveMaterial.diffuseTexture?.dispose()
        cloudData.aboveMaterial?.dispose()
        cloudData.abovePlane.dispose()
      }
      cloudMeshPoolRef.current = []

      // Dispose fog dome
      fogDomeMaterialRef.current?.dispose()
      fogDomeRef.current?.dispose()
      fogDomeRef.current = null
      fogDomeMaterialRef.current = null
    }
  }, [scene])

  // Initialize cloud layer states when mesh pool is created
  useEffect(() => {
    if (cloudMeshPoolRef.current.length === 0) return

    // Initialize layer states if not already done
    if (cloudLayerStatesRef.current.length === 0) {
      for (let i = 0; i < CLOUD_POOL_SIZE; i++) {
        const initialSpeed = CLOUD_ROTATION_SPEED * (1 + (Math.random() * 2 - 1) * CLOUD_ROTATION_SPEED_VARIANCE)
        cloudLayerStatesRef.current.push({
          noiseSeed: Math.random() * 10000,
          currentCoverage: 0,
          targetCoverage: 0,
          currentAltitude: 0,
          targetAltitude: 0,
          currentAlpha: 0,
          targetAlpha: 0,
          lastRenderedCoverage: -1,
          active: false,
          rotation: {
            currentSpeed: initialSpeed,
            targetSpeed: initialSpeed
          },
          useDome: false,
          domeTextureGenerated: false,
          aboveTextureGenerated: false
        })
      }
    }
  }, [scene])

  // Smooth cloud layer data before matching to prevent flickering from rapid METAR changes
  // Updates target values in cloudSmoothingRef, actual smoothing happens in animation loop
  useEffect(() => {
    const smoothing = cloudSmoothingRef.current

    // Check if instant update was requested (e.g., from Weather Debug panel)
    const isInstantUpdate = consumeInstantUpdate()

    // Resize smoothing array to match incoming cloud layers
    while (smoothing.layers.length < cloudLayers.length) {
      smoothing.layers.push({
        currentAltitude: 0,
        currentCoverage: 0,
        targetAltitude: 0,
        targetCoverage: 0,
        type: ''
      })
    }

    // Update targets from raw cloud layer data
    for (let i = 0; i < cloudLayers.length; i++) {
      const layer = cloudLayers[i]
      const smooth = smoothing.layers[i]
      smooth.targetAltitude = layer.altitude
      smooth.targetCoverage = layer.coverage
      smooth.type = layer.type

      // Initialize on first update OR instant update - snap to target (no transition)
      if (!smoothing.initialized || isInstantUpdate) {
        smooth.currentAltitude = layer.altitude
        smooth.currentCoverage = layer.coverage
      }
    }

    // Mark layers beyond the current count as having zero coverage target
    for (let i = cloudLayers.length; i < smoothing.layers.length; i++) {
      smoothing.layers[i].targetCoverage = 0
      // Also snap current to zero on instant update
      if (isInstantUpdate) {
        smoothing.layers[i].currentCoverage = 0
      }
    }

    // If instant update, also reset the visual cloud layer states and force texture regeneration
    if (isInstantUpdate) {
      for (const state of cloudLayerStatesRef.current) {
        state.currentAlpha = state.targetAlpha
        state.currentAltitude = state.targetAltitude
        state.currentCoverage = state.targetCoverage
        // Force texture regeneration
        state.aboveTextureGenerated = false
        state.domeTextureGenerated = false
        state.lastRenderedCoverage = -1
      }
    }

    // Only mark as initialized once we have actual cloud data
    // This ensures first METAR with clouds snaps to values instead of smoothing from 0
    if (cloudLayers.length > 0) {
      smoothing.initialized = true
    }
  }, [cloudLayers, consumeInstantUpdate])

  // Match cloud layers to existing visual states and update targets
  // Uses smoothed cloud layer values to prevent matching failures from rapid METAR changes
  // This enables smooth transitions instead of instant regeneration
  useEffect(() => {
    // Wait for both mesh pool and layer states to be initialized
    if (cloudMeshPoolRef.current.length === 0 || cloudLayerStatesRef.current.length === 0) return

    const states = cloudLayerStatesRef.current
    const smoothing = cloudSmoothingRef.current
    const shouldShowClouds = showWeatherEffects && showClouds && !isTopDownView

    // Get smoothed cloud layers (only those with non-zero coverage)
    const smoothedLayers: CloudLayer[] = smoothing.layers
      .filter(l => l.targetCoverage > 0)
      .map(l => ({
        altitude: l.currentAltitude,  // Use smoothed current value for matching
        coverage: l.currentCoverage,
        type: l.type
      }))

    if (!shouldShowClouds || smoothedLayers.length === 0) {
      // Fade out all layers
      for (const state of states) {
        if (state.active) {
          state.targetAlpha = 0
        }
      }
      return
    }

    // Track which states have been matched to new layers
    const matchedStates = new Set<number>()
    const matchedNewLayers = new Set<number>()

    // First pass: match smoothed layers to existing active states by altitude proximity
    // Use target values for matching (more stable than current values mid-transition)
    for (let newIdx = 0; newIdx < smoothedLayers.length; newIdx++) {
      const newLayer = smoothedLayers[newIdx]
      let bestMatchIdx = -1
      let bestMatchScore = Infinity

      for (let stateIdx = 0; stateIdx < states.length; stateIdx++) {
        const state = states[stateIdx]
        if (!state.active || matchedStates.has(stateIdx)) continue

        // Match using TARGET values (more stable during transitions)
        const altitudeDiff = Math.abs(state.targetAltitude - newLayer.altitude)
        const coverageDiff = Math.abs(state.targetCoverage - newLayer.coverage)

        // Use more lenient thresholds for smoother transitions
        // Double the thresholds to allow more matching during rapid changes
        const altThreshold = CLOUD_LAYER_MATCH_ALTITUDE_THRESHOLD * 2
        const covThreshold = CLOUD_LAYER_MATCH_COVERAGE_THRESHOLD * 1.5

        if (altitudeDiff <= altThreshold && coverageDiff <= covThreshold) {
          // Score by altitude difference (prefer closer matches)
          if (altitudeDiff < bestMatchScore) {
            bestMatchScore = altitudeDiff
            bestMatchIdx = stateIdx
          }
        }
      }

      if (bestMatchIdx >= 0) {
        // Match found - update targets from smoothed values, keep noise seed
        const state = states[bestMatchIdx]
        state.targetCoverage = newLayer.coverage
        state.targetAltitude = newLayer.altitude
        state.targetAlpha = 1
        matchedStates.add(bestMatchIdx)
        matchedNewLayers.add(newIdx)
      }
    }

    // Second pass: fade out unmatched active states
    for (let stateIdx = 0; stateIdx < states.length; stateIdx++) {
      const state = states[stateIdx]
      if (state.active && !matchedStates.has(stateIdx)) {
        state.targetAlpha = 0
      }
    }

    // Third pass: assign unmatched smoothed layers to inactive states (fade in)
    // On initial load (never had active clouds), snap to visible immediately
    const isInitialLoad = !hadActiveCloudsRef.current

    for (let newIdx = 0; newIdx < smoothedLayers.length; newIdx++) {
      if (matchedNewLayers.has(newIdx)) continue

      const newLayer = smoothedLayers[newIdx]

      // Find an inactive state to use
      for (let stateIdx = 0; stateIdx < states.length; stateIdx++) {
        const state = states[stateIdx]
        if (!state.active && state.targetAlpha === 0 && state.currentAlpha < 0.01) {
          // Use this inactive slot - generate new seed for new pattern
          state.noiseSeed = Math.random() * 10000
          state.currentCoverage = newLayer.coverage
          state.targetCoverage = newLayer.coverage
          state.currentAltitude = newLayer.altitude
          state.targetAltitude = newLayer.altitude
          // On initial load, show clouds instantly; otherwise fade in
          state.currentAlpha = isInitialLoad ? 1 : 0
          state.targetAlpha = 1
          state.lastRenderedCoverage = -1 // Force texture regeneration
          state.active = true
          hadActiveCloudsRef.current = true  // Mark that we've had active clouds
          matchedNewLayers.add(newIdx)
          break
        }
      }
    }
  }, [cloudLayers, showWeatherEffects, showClouds, isTopDownView])

  // Instantly hide/show weather effects when switching between 3D and 2D view modes
  // (no gradual fade - user expects immediate response to view mode toggle)
  useEffect(() => {
    const wasTopDown = prevIsTopDownViewRef.current
    prevIsTopDownViewRef.current = isTopDownView

    // Skip on initial mount (no previous value to compare)
    if (wasTopDown === undefined) return

    // Only act on actual view mode changes
    if (wasTopDown === isTopDownView) return

    const pool = cloudMeshPoolRef.current
    const states = cloudLayerStatesRef.current

    if (isTopDownView) {
      // Switching to top-down: instantly hide all cloud meshes
      for (let i = 0; i < pool.length && i < states.length; i++) {
        pool[i].plane.isVisible = false
        pool[i].dome.isVisible = false
        // Set currentAlpha to target to prevent fade animation when switching back
        states[i].currentAlpha = states[i].targetAlpha
      }
    } else {
      // Switching to 3D view: instantly show cloud meshes that should be visible
      // The animation loop will handle proper material setup on next frame
      for (let i = 0; i < pool.length && i < states.length; i++) {
        if (states[i].active && states[i].targetAlpha > 0) {
          // Instantly set alpha to target
          states[i].currentAlpha = states[i].targetAlpha
          // Show appropriate mesh based on coverage
          if (states[i].useDome) {
            pool[i].dome.isVisible = true
          } else {
            pool[i].plane.isVisible = true
          }
        }
      }
    }
  }, [isTopDownView])

  // Calculate fog target values from METAR data
  // Smoothing is applied in the animation loop below
  useEffect(() => {
    const fogState = fogSmoothingRef.current

    const shouldShowFog = showWeatherEffects && showBabylonFog && currentMetar && fogDensity > 0 && !isTopDownView

    if (shouldShowFog && currentMetar) {
      const visibilityMeters = currentMetar.visib * STATUTE_MILES_TO_METERS
      const domeScale = visibilityMeters * visibilityScale

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

      // Set target values for smoothing
      fogState.targetVisibility = currentMetar.visib
      fogState.targetScale = domeScale
      fogState.targetAlpha = Math.min(1.0, baseAlpha * fogIntensity)
      fogState.targetFresnelBias = fresnelBias

      // Initialize on first valid METAR - snap to target (no transition)
      if (!fogState.initialized) {
        fogState.currentVisibility = fogState.targetVisibility
        fogState.currentScale = fogState.targetScale
        fogState.currentAlpha = fogState.targetAlpha
        fogState.currentFresnelBias = fogState.targetFresnelBias
        fogState.initialized = true
      }
    } else {
      // Fog should be hidden - fade alpha to 0
      fogState.targetAlpha = 0
      fogState.targetScale = fogState.currentScale // Keep scale while fading
      // Initialize if first update
      if (!fogState.initialized) {
        fogState.currentAlpha = 0
        fogState.initialized = true
      }
    }
  }, [showWeatherEffects, showBabylonFog, currentMetar, fogDensity, fogIntensity, visibilityScale, isTopDownView])

  // Animate cloud layers: coverage, altitude, alpha, and rotation
  // Also handles texture regeneration when coverage changes enough
  useEffect(() => {
    if (!scene) return

    let lastTime = performance.now()
    let lastSpeedChangeTime = performance.now()

    // Helper to apply material properties based on coverage
    // Uses cloudOpacityRef.current to avoid effect recreation when opacity slider changes
    const applyMaterialForCoverage = (material: BABYLON.StandardMaterial, coverage: number, alpha: number) => {
      const opacity = cloudOpacityRef.current
      if (coverage >= 0.95) {
        // OVC: fully opaque
        material.transparencyMode = BABYLON.Material.MATERIAL_OPAQUE
        material.needDepthPrePass = true
        material.disableLighting = true
        material.emissiveColor = new BABYLON.Color3(0.25, 0.25, 0.28)
        material.diffuseColor = new BABYLON.Color3(0, 0, 0)
        material.alpha = alpha * opacity
      } else if (coverage >= 0.6) {
        // BKN: nearly opaque with alpha blending
        material.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND
        material.needDepthPrePass = false
        material.disableLighting = false
        material.emissiveColor = new BABYLON.Color3(...CLOUD_EMISSIVE_COLOR)
        material.diffuseColor = new BABYLON.Color3(...CLOUD_DIFFUSE_COLOR)
        const baseAlpha = 0.95
        material.alpha = baseAlpha * alpha * opacity
      } else {
        // FEW/SCT: transparent
        material.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND
        material.needDepthPrePass = false
        material.disableLighting = false
        material.emissiveColor = new BABYLON.Color3(...CLOUD_EMISSIVE_COLOR)
        material.diffuseColor = new BABYLON.Color3(...CLOUD_DIFFUSE_COLOR)
        const baseAlpha = 0.6 + coverage * 0.4
        material.alpha = baseAlpha * alpha * opacity
      }
    }

    // Generate new target rotation speeds for all layers, correlating by altitude
    const pickNewTargetSpeeds = () => {
      const states = cloudLayerStatesRef.current
      if (states.length === 0) return

      // Get active layers with their altitudes
      const activeStates: { index: number; altitude: number }[] = []
      for (let i = 0; i < states.length; i++) {
        if (states[i].active || states[i].currentAlpha > 0.01) {
          activeStates.push({ index: i, altitude: states[i].currentAltitude })
        }
      }

      if (activeStates.length === 0) return

      // Sort by altitude
      activeStates.sort((a, b) => a.altitude - b.altitude)

      // Pick a base speed for the lowest layer
      const baseVariance = (Math.random() * 2 - 1) * CLOUD_ROTATION_SPEED_VARIANCE
      const lowestLayerSpeed = CLOUD_ROTATION_SPEED * (1 + baseVariance)
      states[activeStates[0].index].rotation.targetSpeed = lowestLayerSpeed

      // For each subsequent layer, vary speed based on altitude difference
      for (let i = 1; i < activeStates.length; i++) {
        const prevState = activeStates[i - 1]
        const currState = activeStates[i]
        const altitudeDiff = Math.abs(currState.altitude - prevState.altitude)

        // Normalize altitude difference: 0 at 0m, 1 at 2000m+
        const normalizedDiff = Math.min(1, altitudeDiff / 2000)
        const correlation = 1 - normalizedDiff

        const independentVariance = (Math.random() * 2 - 1) * CLOUD_ROTATION_SPEED_VARIANCE
        const independentSpeed = CLOUD_ROTATION_SPEED * (1 + independentVariance)

        const prevSpeed = states[prevState.index].rotation.targetSpeed
        states[currState.index].rotation.targetSpeed =
          prevSpeed * correlation + independentSpeed * (1 - correlation)
      }
    }

    const observer = scene.onBeforeRenderObservable.add(() => {
      const now = performance.now()
      // Clamp delta time to prevent huge jumps when tab was backgrounded
      const deltaSeconds = Math.min((now - lastTime) / 1000, 0.1)
      lastTime = now

      // === FOG SMOOTHING ===
      // Smooth fog dome parameters toward targets for gradual weather transitions
      const fogDome = fogDomeRef.current
      const fogMaterial = fogDomeMaterialRef.current
      const fogState = fogSmoothingRef.current

      if (fogDome && fogMaterial && fogState.initialized) {
        // Exponential smoothing factor: 1 - e^(-dt / (tau/3))
        const fogLerpFactor = 1 - Math.exp(-deltaSeconds / (VISIBILITY_TRANSITION_TIME / 3))

        // Smooth scale
        if (Math.abs(fogState.currentScale - fogState.targetScale) > 1) {
          fogState.currentScale += (fogState.targetScale - fogState.currentScale) * fogLerpFactor
        } else {
          fogState.currentScale = fogState.targetScale
        }

        // Smooth alpha
        if (Math.abs(fogState.currentAlpha - fogState.targetAlpha) > 0.001) {
          fogState.currentAlpha += (fogState.targetAlpha - fogState.currentAlpha) * fogLerpFactor
        } else {
          fogState.currentAlpha = fogState.targetAlpha
        }

        // Smooth fresnel bias
        if (Math.abs(fogState.currentFresnelBias - fogState.targetFresnelBias) > 0.001) {
          fogState.currentFresnelBias += (fogState.targetFresnelBias - fogState.currentFresnelBias) * fogLerpFactor
        } else {
          fogState.currentFresnelBias = fogState.targetFresnelBias
        }

        // Apply smoothed values to fog dome
        fogDome.scaling.setAll(fogState.currentScale)
        fogMaterial.alpha = fogState.currentAlpha
        fogMaterial.opacityFresnelParameters!.bias = fogState.currentFresnelBias

        // Show/hide based on alpha threshold
        fogDome.isVisible = fogState.currentAlpha > 0.001
      }

      // === CLOUD LAYER DATA SMOOTHING ===
      // Smooth cloud layer altitude/coverage values before they're used in matching
      const cloudSmoothing = cloudSmoothingRef.current
      if (cloudSmoothing.initialized) {
        // Use same lerp factor as fog for consistent weather transition speed
        const cloudLerpFactor = 1 - Math.exp(-deltaSeconds / (VISIBILITY_TRANSITION_TIME / 3))

        for (const layer of cloudSmoothing.layers) {
          // Smooth altitude
          if (Math.abs(layer.currentAltitude - layer.targetAltitude) > 1) {
            layer.currentAltitude += (layer.targetAltitude - layer.currentAltitude) * cloudLerpFactor
          } else {
            layer.currentAltitude = layer.targetAltitude
          }

          // Smooth coverage
          if (Math.abs(layer.currentCoverage - layer.targetCoverage) > 0.001) {
            layer.currentCoverage += (layer.targetCoverage - layer.currentCoverage) * cloudLerpFactor
          } else {
            layer.currentCoverage = layer.targetCoverage
          }
        }
      }

      // Periodically pick new rotation speeds
      const timeSinceSpeedChange = (now - lastSpeedChangeTime) / 1000
      if (timeSinceSpeedChange > CLOUD_ROTATION_CHANGE_INTERVAL) {
        pickNewTargetSpeeds()
        lastSpeedChangeTime = now
      }

      const pool = cloudMeshPoolRef.current
      const states = cloudLayerStatesRef.current

      for (let i = 0; i < pool.length && i < states.length; i++) {
        const meshData = pool[i]
        const state = states[i]

        // Animate alpha (fade in/out)
        if (Math.abs(state.currentAlpha - state.targetAlpha) > 0.001) {
          const alphaDelta = CLOUD_LAYER_FADE_SPEED * deltaSeconds
          if (state.currentAlpha < state.targetAlpha) {
            state.currentAlpha = Math.min(state.targetAlpha, state.currentAlpha + alphaDelta)
          } else {
            state.currentAlpha = Math.max(state.targetAlpha, state.currentAlpha - alphaDelta)
          }
        }

        // Mark as inactive when fully faded out
        if (state.currentAlpha < 0.01 && state.targetAlpha === 0) {
          state.active = false
          meshData.plane.isVisible = false
          meshData.dome.isVisible = false
          // Dispose textures to free GPU memory
          if (meshData.material.diffuseTexture) {
            meshData.material.diffuseTexture.dispose()
            meshData.material.diffuseTexture = null
          }
          if (meshData.domeMaterial.diffuseTexture) {
            meshData.domeMaterial.diffuseTexture.dispose()
            meshData.domeMaterial.diffuseTexture = null
          }
          state.domeTextureGenerated = false
          continue
        }

        // Skip if not visible at all
        if (state.currentAlpha < 0.01 && !state.active) {
          meshData.plane.isVisible = false
          meshData.dome.isVisible = false
          continue
        }

        // Animate altitude
        if (Math.abs(state.currentAltitude - state.targetAltitude) > 0.1) {
          const altDelta = CLOUD_LAYER_ALTITUDE_TRANSITION_SPEED * deltaSeconds
          if (state.currentAltitude < state.targetAltitude) {
            state.currentAltitude = Math.min(state.targetAltitude, state.currentAltitude + altDelta)
          } else {
            state.currentAltitude = Math.max(state.targetAltitude, state.currentAltitude - altDelta)
          }
        }

        // Animate coverage
        if (Math.abs(state.currentCoverage - state.targetCoverage) > 0.001) {
          const covDelta = CLOUD_LAYER_COVERAGE_TRANSITION_SPEED * deltaSeconds
          if (state.currentCoverage < state.targetCoverage) {
            state.currentCoverage = Math.min(state.targetCoverage, state.currentCoverage + covDelta)
          } else {
            state.currentCoverage = Math.max(state.targetCoverage, state.currentCoverage - covDelta)
          }
        }

        // Determine if we should use dome or plane based on coverage (for below view)
        const shouldUseDome = state.currentCoverage >= CLOUD_DOME_COVERAGE_THRESHOLD

        // Handle geometry switching for below-cloud view
        if (shouldUseDome !== state.useDome) {
          state.useDome = shouldUseDome
          if (shouldUseDome) {
            state.domeTextureGenerated = false
          } else {
            state.lastRenderedCoverage = -1
          }
        }

        // === VIEW-DEPENDENT GEOMETRY SWITCHING ===
        // Determine camera altitude and view mode (above/below/transition)
        const cameraAltitude = scene.activeCamera?.position.y ?? 0
        const cloudAltitude = state.currentAltitude
        const buffer = CLOUD_ABOVE_TRANSITION_BUFFER

        type ViewMode = 'below' | 'above' | 'transition'
        let viewMode: ViewMode
        if (cameraAltitude > cloudAltitude + buffer) {
          viewMode = 'above'
        } else if (cameraAltitude < cloudAltitude - buffer) {
          viewMode = 'below'
        } else {
          viewMode = 'transition'
        }

        const opacity = cloudOpacityRef.current

        // Set all mesh positions (Y coordinate)
        meshData.plane.position.y = cloudAltitude
        meshData.dome.position.y = cloudAltitude
        meshData.abovePlane.position.y = cloudAltitude

        if (viewMode === 'above') {
          // Camera is above cloud layer - show above-plane (cloud tops)
          meshData.plane.isVisible = false
          meshData.dome.isVisible = false
          meshData.abovePlane.isVisible = true

          // Generate above texture if needed
          if (!state.aboveTextureGenerated) {
            if (meshData.aboveMaterial.diffuseTexture) {
              meshData.aboveMaterial.diffuseTexture.dispose()
            }
            const aboveTexture = createAboveCloudTexture(
              scene,
              CLOUD_NOISE_TEXTURE_SIZE,
              state.currentCoverage,
              state.noiseSeed
            )
            meshData.aboveMaterial.diffuseTexture = aboveTexture
            state.aboveTextureGenerated = true
          }

          // Apply above material properties
          // Keep above-cloud plane semi-transparent so aircraft in Cesium show through
          // (Babylon overlay is on top of Cesium canvas, so we can't use depth testing)
          const isOVC = state.currentCoverage >= 0.95
          if (isOVC) {
            meshData.aboveMaterial.useAlphaFromDiffuseTexture = false
            meshData.aboveMaterial.alpha = 0.75  // Semi-transparent so aircraft show through
          } else {
            meshData.aboveMaterial.useAlphaFromDiffuseTexture = true
            meshData.aboveMaterial.alpha = state.currentAlpha * opacity * 0.8  // Slightly more transparent
          }

          // Animate rotation
          const rotLerpFactor = Math.min(1, deltaSeconds / CLOUD_ROTATION_TRANSITION_TIME)
          state.rotation.currentSpeed += (state.rotation.targetSpeed - state.rotation.currentSpeed) * rotLerpFactor
          meshData.abovePlane.rotation.y += state.rotation.currentSpeed * deltaSeconds

        } else if (viewMode === 'below') {
          // Camera is below cloud layer - show dome or plane based on coverage
          meshData.abovePlane.isVisible = false

          if (shouldUseDome) {
            // Use dome for OVC (overcast)
            meshData.plane.isVisible = false
            meshData.dome.isVisible = true

            // Generate dome texture if needed
            if (!state.domeTextureGenerated) {
              if (meshData.domeMaterial.diffuseTexture) {
                meshData.domeMaterial.diffuseTexture.dispose()
              }
              const domeTexture = createOvercastDomeTexture(
                scene,
                CLOUD_NOISE_TEXTURE_SIZE,
                state.noiseSeed
              )
              meshData.domeMaterial.diffuseTexture = domeTexture
              state.domeTextureGenerated = true
            }

            // Reset fresnel to default for below view
            meshData.domeMaterial.opacityFresnelParameters!.bias = CLOUD_DOME_FRESNEL_BIAS
            meshData.domeMaterial.alpha = state.currentAlpha * opacity

            // Animate dome rotation
            const rotLerpFactor = Math.min(1, deltaSeconds / CLOUD_ROTATION_TRANSITION_TIME)
            state.rotation.currentSpeed += (state.rotation.targetSpeed - state.rotation.currentSpeed) * rotLerpFactor
            meshData.dome.rotation.y += state.rotation.currentSpeed * deltaSeconds * 0.5

          } else {
            // Use plane for FEW/SCT/BKN
            meshData.dome.isVisible = false
            meshData.plane.isVisible = true

            // Regenerate texture if coverage changed enough
            const coverageChange = Math.abs(state.currentCoverage - state.lastRenderedCoverage)
            if (coverageChange >= CLOUD_LAYER_COVERAGE_REGEN_THRESHOLD || state.lastRenderedCoverage < 0) {
              if (meshData.material.diffuseTexture) {
                meshData.material.diffuseTexture.dispose()
              }
              const patchyTexture = createPatchyCloudTexture(
                scene,
                CLOUD_NOISE_TEXTURE_SIZE,
                state.currentCoverage,
                state.noiseSeed
              )
              meshData.material.diffuseTexture = patchyTexture
              state.lastRenderedCoverage = state.currentCoverage
            }

            applyMaterialForCoverage(meshData.material, state.currentCoverage, state.currentAlpha)

            // Animate rotation
            const rotLerpFactor = Math.min(1, deltaSeconds / CLOUD_ROTATION_TRANSITION_TIME)
            state.rotation.currentSpeed += (state.rotation.targetSpeed - state.rotation.currentSpeed) * rotLerpFactor
            meshData.plane.rotation.y += state.rotation.currentSpeed * deltaSeconds
          }

        } else {
          // Transition zone - interpolate between above and below views
          // Show both geometries with blended opacity
          const transitionT = (cameraAltitude - (cloudAltitude - buffer)) / (2 * buffer)
          const aboveAlpha = transitionT
          const belowAlpha = 1 - transitionT

          // Generate above texture if needed
          if (!state.aboveTextureGenerated) {
            if (meshData.aboveMaterial.diffuseTexture) {
              meshData.aboveMaterial.diffuseTexture.dispose()
            }
            const aboveTexture = createAboveCloudTexture(
              scene,
              CLOUD_NOISE_TEXTURE_SIZE,
              state.currentCoverage,
              state.noiseSeed
            )
            meshData.aboveMaterial.diffuseTexture = aboveTexture
            state.aboveTextureGenerated = true
          }

          // Show above plane with transition alpha
          // Keep semi-transparent so aircraft show through
          meshData.abovePlane.isVisible = true
          const isOVCTransition = state.currentCoverage >= 0.95
          if (isOVCTransition) {
            meshData.aboveMaterial.useAlphaFromDiffuseTexture = false
            meshData.aboveMaterial.alpha = 0.75 * aboveAlpha  // Semi-transparent with transition
          } else {
            meshData.aboveMaterial.useAlphaFromDiffuseTexture = true
            meshData.aboveMaterial.alpha = state.currentAlpha * opacity * aboveAlpha * 0.8
          }

          if (shouldUseDome) {
            meshData.plane.isVisible = false
            meshData.dome.isVisible = true

            if (!state.domeTextureGenerated) {
              if (meshData.domeMaterial.diffuseTexture) {
                meshData.domeMaterial.diffuseTexture.dispose()
              }
              const domeTexture = createOvercastDomeTexture(
                scene,
                CLOUD_NOISE_TEXTURE_SIZE,
                state.noiseSeed
              )
              meshData.domeMaterial.diffuseTexture = domeTexture
              state.domeTextureGenerated = true
            }

            // Dynamic fresnel: interpolate bias for smoother transition
            const adjustedBias = CLOUD_DOME_FRESNEL_BIAS * belowAlpha + CLOUD_DOME_FRESNEL_BIAS_ABOVE * aboveAlpha
            meshData.domeMaterial.opacityFresnelParameters!.bias = adjustedBias
            meshData.domeMaterial.alpha = state.currentAlpha * opacity * belowAlpha

            const rotLerpFactor = Math.min(1, deltaSeconds / CLOUD_ROTATION_TRANSITION_TIME)
            state.rotation.currentSpeed += (state.rotation.targetSpeed - state.rotation.currentSpeed) * rotLerpFactor
            meshData.dome.rotation.y += state.rotation.currentSpeed * deltaSeconds * 0.5

          } else {
            meshData.dome.isVisible = false
            meshData.plane.isVisible = true

            const coverageChange = Math.abs(state.currentCoverage - state.lastRenderedCoverage)
            if (coverageChange >= CLOUD_LAYER_COVERAGE_REGEN_THRESHOLD || state.lastRenderedCoverage < 0) {
              if (meshData.material.diffuseTexture) {
                meshData.material.diffuseTexture.dispose()
              }
              const patchyTexture = createPatchyCloudTexture(
                scene,
                CLOUD_NOISE_TEXTURE_SIZE,
                state.currentCoverage,
                state.noiseSeed
              )
              meshData.material.diffuseTexture = patchyTexture
              state.lastRenderedCoverage = state.currentCoverage
            }

            applyMaterialForCoverage(meshData.material, state.currentCoverage, state.currentAlpha * belowAlpha)

            const rotLerpFactor = Math.min(1, deltaSeconds / CLOUD_ROTATION_TRANSITION_TIME)
            state.rotation.currentSpeed += (state.rotation.targetSpeed - state.rotation.currentSpeed) * rotLerpFactor
            meshData.plane.rotation.y += state.rotation.currentSpeed * deltaSeconds
          }

          // Rotate above plane too
          meshData.abovePlane.rotation.y += state.rotation.currentSpeed * deltaSeconds
        }
      }
    })

    return () => {
      scene.onBeforeRenderObservable.remove(observer)
    }
  }, [scene]) // cloudOpacity accessed via ref to avoid effect recreation

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
