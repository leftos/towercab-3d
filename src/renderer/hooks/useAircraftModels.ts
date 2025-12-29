import { useEffect, useRef, useCallback } from 'react'
import * as Cesium from 'cesium'
import type { ModelPoolRefs, SilhouetteRefs } from './useCesiumViewer'
import type { InterpolatedAircraftState } from '../types/vatsim'
import type { ViewMode } from '../types'
import { aircraftModelService } from '../services/AircraftModelService'
import { performanceMonitor } from '../utils/performanceMonitor'
import {
  getModelColorRgb,
  getModelColorBlendAmount,
  getFsltlModelColorBlendAmount,
  GROUNDSPEED_THRESHOLD_KNOTS,
  FSLTL_MODEL_HEIGHT_OFFSET
} from '../constants/rendering'
import {
  SUN_ELEVATION_DAY,
  SUN_ELEVATION_NIGHT
} from '../constants/lighting'
import { useSettingsStore } from '../stores/settingsStore'
import {
  updateGearAnimation,
  applyGearAnimation,
  clearGearState,
  initializeGearState,
  getCurrentGearProgress
} from '../utils/gearAnimationController'
import {
  getModelGroundData,
  parseGroundDataFromUrl
} from '../utils/gltfAnimationParser'
import { filterAircraftForRendering } from './useRenderCulling'

/**
 * Manages aircraft 3D model rendering using Cesium.Model pool
 *
 * ## Responsibilities
 * - Assign aircraft to model pool slots
 * - Dynamically load aircraft-specific models (B738, A320, etc.)
 * - Position and orient models based on interpolated aircraft state
 * - Apply non-uniform scaling per aircraft type
 * - Handle model visibility and cleanup
 * - Coordinate with Babylon overlay for shadow rendering
 *
 * ## Model Pool System
 * Uses a pool of pre-loaded Cesium.Model primitives to avoid per-aircraft load overhead:
 * - **Pool size**: 100 models (AIRCRAFT_POOL_SIZE)
 * - **Assignment**: Maps callsign → pool index
 * - **Dynamic loading**: Swaps models when aircraft type changes
 * - **Cleanup**: Hides and releases models when aircraft leave viewport
 *
 * ## Model Transformation
 * Each model has a transformation matrix combining:
 * 1. **Translation**: Geographic position (lat/lon/alt) with terrain offset
 * 2. **Rotation**: Heading/pitch/roll in Cesium's coordinate system
 * 3. **Scale**: Non-uniform per-axis scaling from model metadata
 *
 * ## Coordinate System Notes
 * - Cesium models typically face +X axis (east)
 * - Heading adjustment: -90° + 180° to convert from compass (north=0)
 * - Pitch/roll: Negated due to Cesium's coordinate conventions
 *
 * ## Dependencies
 * - Requires: useCesiumViewer for viewer and model pool refs
 * - Requires: useAircraftInterpolation for smooth position data
 * - Reads: aircraftModelService for model URLs and dimensions
 * - Reads: performanceMonitor for diagnostic logging
 *
 * @param viewer - Initialized Cesium.Viewer instance
 * @param modelPoolRefs - Model pool state from useCesiumViewer
 * @param interpolatedAircraft - Map of smoothly interpolated aircraft positions
 * @param viewMode - Current view mode ('3d' or 'topdown')
 * @param followingCallsign - Callsign of followed aircraft (for diagnostic logging)
 * @param groundElevationMeters - Ground elevation in meters MSL (for gear AGL calculation)
 * @param silhouetteRefs - Silhouette stage refs for outline rendering (null for inset viewports)
 * @param sunElevation - Sun elevation angle in degrees (for night visibility boost)
 *
 * @example
 * ```tsx
 * const { viewer, modelPoolRefs, silhouetteRefs } = useCesiumViewer(...)
 * const interpolatedAircraft = useAircraftInterpolation()
 * const sunElevation = useSunElevation(viewer, { timeMode, fixedTimeHour })
 *
 * useAircraftModels(
 *   viewer,
 *   modelPoolRefs,
 *   interpolatedAircraft,
 *   viewMode,
 *   followingCallsign,
 *   groundElevationMeters,
 *   silhouetteRefs,
 *   sunElevation
 * )
 * ```
 */
export function useAircraftModels(
  viewer: Cesium.Viewer | null,
  modelPoolRefs: ModelPoolRefs,
  interpolatedAircraft: Map<string, InterpolatedAircraftState>,
  viewMode: ViewMode,
  followingCallsign: string | null,
  groundElevationMeters: number,
  silhouetteRefs: SilhouetteRefs | null,
  sunElevation: number | null
) {
  const {
    modelPool,
    modelPoolAssignments,
    modelPoolUrls,
    modelPoolLoading,
    modelPoolReady
  } = modelPoolRefs

  // Get model brightness and tint color from settings - separate for built-in and FSLTL models
  const builtinModelBrightness = useSettingsStore((state) => state.graphics.builtinModelBrightness) ?? 1.7
  const fsltlModelBrightness = useSettingsStore((state) => state.graphics.fsltlModelBrightness) ?? 1.0
  const builtinModelTintColor = useSettingsStore((state) => state.graphics.builtinModelTintColor) ?? 'lightBlue'
  const enableNightDarkening = useSettingsStore((state) => state.graphics.enableNightDarkening) ?? true
  const aircraftNightVisibility = useSettingsStore((state) => state.graphics.aircraftNightVisibility) ?? 1.5

  // Track previous positions for diagnostic logging
  const prevModelPositionsRef = useRef<Map<string, Cesium.Cartesian3>>(new Map())

  // Track which pool slots have FSLTL models (for color blend logic)
  const modelPoolIsFsltlRef = useRef<Map<number, boolean>>(new Map())

  // Reverse lookup: callsign → pool index (O(1) lookup instead of O(poolSize) scan)
  const callsignToPoolIndexRef = useRef<Map<string, number>>(new Map())

  // Track available (unused) pool slots for O(1) allocation
  const availablePoolSlotsRef = useRef<Set<number>>(new Set())

  // Track animation counts per model URL (populated via gltfCallback during model loading)
  const modelAnimationCountsRef = useRef<Map<string, number>>(new Map())

  // Track URLs that have failed to load (avoid repeated error logging)
  const failedModelUrlsRef = useRef<Set<string>>(new Set())

  // Update aircraft models
  const updateAircraftModels = useCallback(() => {
    if (!viewer || !modelPoolReady.current) return

    performanceMonitor.startTimer('aircraftUpdate')

    // Initialize available pool slots on first run (O(poolSize) once, not every frame)
    if (availablePoolSlotsRef.current.size === 0 && callsignToPoolIndexRef.current.size === 0) {
      for (const idx of modelPool.current.keys()) {
        if (modelPoolAssignments.current.get(idx) === null) {
          availablePoolSlotsRef.current.add(idx)
        }
      }
    }

    // Apply render culling: filter by distance from camera and max aircraft limit
    // This runs every frame to keep the closest aircraft visible as camera moves
    const { filteredAircraft } = filterAircraftForRendering({
      viewer,
      interpolatedAircraft,
      alwaysInclude: followingCallsign
    })

    // Track which callsigns we've seen this frame (for cleanup)
    const seenCallsigns = new Set<string>()

    // View mode scale - keep at full size in both modes for visibility
    const viewModeScale = 1.0

    // Calculate night visibility light boost
    // When night darkening is enabled and sun is below horizon, boost aircraft brightness
    // using model.lightColor to make them more visible against darkened imagery
    let nightLightBoost: number | null = null
    if (enableNightDarkening && viewMode === '3d' && sunElevation !== null && sunElevation < SUN_ELEVATION_DAY) {
      // Interpolate from 1.0 (at horizon) to full boost (at full night)
      const nightProgress = Math.min(1.0, (SUN_ELEVATION_DAY - sunElevation) / (SUN_ELEVATION_DAY - SUN_ELEVATION_NIGHT))
      // Apply boost: 1.0 at day, aircraftNightVisibility at night
      nightLightBoost = 1.0 + (aircraftNightVisibility - 1.0) * nightProgress
    }

    // Update each aircraft model (using filtered list)
    for (const aircraft of filteredAircraft.values()) {
      seenCallsigns.add(aircraft.callsign)

      // Get the correct model info for this aircraft type (and callsign for FSLTL livery matching)
      const modelInfo = aircraftModelService.getModelInfo(aircraft.aircraftType, aircraft.callsign)

      // Model height: interpolatedAltitude is already terrain-corrected by interpolation system
      // (includes terrain sampling, ground/air transitions, and all offsets)
      // Compute dynamic ground offset based on model geometry and gear state
      const isFsltlModel = modelInfo.matchType === 'fsltl' || modelInfo.matchType === 'fsltl-base' ||
                           modelInfo.matchType === 'fsltl-vmr' || modelInfo.matchType === 'custom-vmr'
      const groundData = getModelGroundData(modelInfo.modelUrl)
      let heightOffset: number
      if (groundData) {
        // Interpolate between gear-up and gear-down min-Y based on current gear state
        const gearProgress = getCurrentGearProgress(aircraft.callsign)
        const minY = groundData.gearUpMinY + (groundData.gearDownMinY - groundData.gearUpMinY) * gearProgress
        // Negate minY to get offset: if model extends below origin (minY=-2), raise by +2m
        // Multiply by model Y scale since ground data is in model space
        // Note: For glTF 1.0 (FR24) models, gltfAnimationParser uses Z as vertical axis
        heightOffset = -minY * modelInfo.scale.y
      } else {
        // Fallback to static offset if ground data not yet computed
        // Use conservative offset until we can parse the actual model bounds
        heightOffset = isFsltlModel ? FSLTL_MODEL_HEIGHT_OFFSET + 4.0 : 3.0
        // Trigger async parsing of ground data for next frame
        parseGroundDataFromUrl(modelInfo.modelUrl)
      }
      const modelHeight = aircraft.interpolatedAltitude + heightOffset

      // Find existing pool slot for this callsign, or get an unused one - O(1) lookup
      let poolIndex = callsignToPoolIndexRef.current.get(aircraft.callsign) ?? -1

      if (poolIndex === -1) {
        // Get an unused slot from the available set - O(1)
        const firstAvailable = availablePoolSlotsRef.current.values().next()
        if (!firstAvailable.done) {
          poolIndex = firstAvailable.value
          availablePoolSlotsRef.current.delete(poolIndex)
          callsignToPoolIndexRef.current.set(aircraft.callsign, poolIndex)
          modelPoolAssignments.current.set(poolIndex, aircraft.callsign)

          // Initialize gear state based on aircraft's current conditions
          // This ensures aircraft spawning in flight have gear up, while ground aircraft have gear down
          const isOnGround = aircraft.interpolatedGroundspeed < GROUNDSPEED_THRESHOLD_KNOTS
          const altitudeAglMeters = aircraft.interpolatedAltitude - groundElevationMeters
          const altitudeAglFeet = altitudeAglMeters * 3.28084
          const verticalRateFpm = aircraft.verticalRate * 3.28084
          initializeGearState(aircraft.callsign, altitudeAglFeet, verticalRateFpm, isOnGround)
        }
      }

      if (poolIndex !== -1) {
        const model = modelPool.current.get(poolIndex)
        if (model) {
          const currentModelUrl = modelPoolUrls.current.get(poolIndex)

          // If model URL changed, load the new model asynchronously
          if (currentModelUrl !== modelInfo.modelUrl && !modelPoolLoading.current.has(poolIndex)) {
            modelPoolLoading.current.add(poolIndex)
            modelPoolUrls.current.set(poolIndex, modelInfo.modelUrl)

            // Track if this is an FSLTL or custom VMR model (for color blend logic)
            // These models have custom liveries and should use FSLTL brightness/no tint
            const isFsltlOrVmrModel = modelInfo.isFsltl === true
            modelPoolIsFsltlRef.current.set(poolIndex, isFsltlOrVmrModel)

            // Calculate model color and blend amount based on brightness setting
            // FSLTL/VMR models use their own brightness slider to preserve livery colors
            // Built-in models use the configurable tint color for visibility
            const effectiveBrightness = isFsltlOrVmrModel ? fsltlModelBrightness : builtinModelBrightness
            const tintColor = isFsltlOrVmrModel ? 'white' : builtinModelTintColor
            const modelColorRgb = getModelColorRgb(effectiveBrightness, tintColor)
            const modelColor = new Cesium.Color(...modelColorRgb, 1.0)
            const blendAmount = isFsltlOrVmrModel
              ? getFsltlModelColorBlendAmount(effectiveBrightness)
              : getModelColorBlendAmount(effectiveBrightness, tintColor)

            // Load new model in background
            // Use gltfCallback to capture animation count for gear animation system
            const modelUrl = modelInfo.modelUrl
            Cesium.Model.fromGltfAsync({
              url: modelUrl,
              show: false,
              modelMatrix: model.modelMatrix,  // Copy current transform
              shadows: Cesium.ShadowMode.ENABLED,
              color: modelColor,
              colorBlendMode: Cesium.ColorBlendMode.MIX,
              colorBlendAmount: blendAmount,
              gltfCallback: (gltf) => {
                // Capture animation count from parsed glTF
                const animCount = gltf.animations?.length ?? 0
                modelAnimationCountsRef.current.set(modelUrl, animCount)
              }
            }).then(newModel => {
              if (viewer.isDestroyed()) return

              // Remove old model from scene
              const oldModel = modelPool.current.get(poolIndex)
              if (oldModel) {
                viewer.scene.primitives.remove(oldModel)
              }

              // Add new model to scene and update pool
              viewer.scene.primitives.add(newModel)
              modelPool.current.set(poolIndex, newModel)
              modelPoolLoading.current.delete(poolIndex)
            }).catch(err => {
              // Only log error once per URL to avoid console spam
              if (!failedModelUrlsRef.current.has(modelUrl)) {
                failedModelUrlsRef.current.add(modelUrl)
                console.warn(`[Models] Failed to load ${modelUrl}:`, err.message || err)
              }
              modelPoolLoading.current.delete(poolIndex)
              // Reset URL to trigger retry on next frame
              modelPoolUrls.current.set(poolIndex, './b738.glb')
            })
          }

          // Build modelMatrix with position, rotation, and non-uniform scale
          const position = Cesium.Cartesian3.fromDegrees(
            aircraft.interpolatedLongitude,
            aircraft.interpolatedLatitude,
            modelHeight
          )

          // Track position deltas for followed aircraft (diagnostic logging)
          if (aircraft.callsign === followingCallsign) {
            const prev = prevModelPositionsRef.current.get(aircraft.callsign)
            if (prev) {
              const delta = Cesium.Cartesian3.distance(prev, position)
              if (delta > 5.0) { // Log significant jumps > 5 meters
                const metrics = performanceMonitor.getMetrics()
                console.warn(
                  `[Cesium Model] Position jump for ${aircraft.callsign}: ${delta.toFixed(2)}m | ` +
                  `FPS: ${Math.round(metrics.fps)} | Frame interval: ${metrics.frameInterval.toFixed(2)}ms | ` +
                  `Operations: ${metrics.totalFrame.toFixed(2)}ms`
                )
              }
            }
            prevModelPositionsRef.current.set(aircraft.callsign, Cesium.Cartesian3.clone(position))
          }

          // Model heading: Cesium models typically face +X, so heading=0 means east
          // Subtract 90 to convert from compass heading (north=0) to model heading
          // Add 180° to flip models that face backwards
          // Add rotationOffset for models that face different directions (e.g., FSLTL = 180°)
          // Pitch/Roll: Use values directly - positive pitch = nose up, positive roll = right bank
          const rotationOffset = modelInfo.rotationOffset ?? 0
          const hpr = new Cesium.HeadingPitchRoll(
            Cesium.Math.toRadians(aircraft.interpolatedHeading - 90 + 180 + rotationOffset),
            Cesium.Math.toRadians(aircraft.interpolatedPitch),
            Cesium.Math.toRadians(aircraft.interpolatedRoll)
          )

          // Create base transformation matrix (translation + rotation)
          const modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(position, hpr)

          // Apply non-uniform scale (viewModeScale is uniform, modelInfo.scale is per-axis)
          const totalScaleX = viewModeScale * modelInfo.scale.x
          const totalScaleY = viewModeScale * modelInfo.scale.y
          const totalScaleZ = viewModeScale * modelInfo.scale.z
          const scaleMatrix = Cesium.Matrix4.fromScale(
            new Cesium.Cartesian3(totalScaleX, totalScaleY, totalScaleZ)
          )
          Cesium.Matrix4.multiply(modelMatrix, scaleMatrix, modelMatrix)

          // Apply the transformation
          model.modelMatrix = modelMatrix

          // Apply color blend - full white in topdown, preserve textures in 3D
          // FSLTL/VMR models get no blend by default in 3D mode to show their liveries
          const isFsltlOrVmr = modelInfo.isFsltl === true
          if (viewMode === 'topdown') {
            // Always white in top-down view for visibility (both FSLTL and built-in)
            model.color = Cesium.Color.WHITE
            model.colorBlendAmount = 1.0
          } else {
            // In 3D mode: FSLTL/VMR models show liveries, built-in models get configurable tint
            const effectiveBrightness = isFsltlOrVmr ? fsltlModelBrightness : builtinModelBrightness
            const tintColor = isFsltlOrVmr ? 'white' : builtinModelTintColor
            const modelColorRgb = getModelColorRgb(effectiveBrightness, tintColor)
            const blendAmount = isFsltlOrVmr
              ? getFsltlModelColorBlendAmount(effectiveBrightness)
              : getModelColorBlendAmount(effectiveBrightness, tintColor)
            model.color = new Cesium.Color(...modelColorRgb, 1.0)
            model.colorBlendAmount = blendAmount
          }

          // Show the model
          model.show = true

          // Apply night visibility boost via lightColor
          // This makes aircraft brighter than the darkened scene without washing out textures
          if (nightLightBoost !== null && nightLightBoost > 1.0) {
            model.lightColor = new Cesium.Cartesian3(nightLightBoost, nightLightBoost, nightLightBoost)
          } else {
            // Reset to normal scene lighting (1.0, 1.0, 1.0 = white light, normal intensity)
            model.lightColor = new Cesium.Cartesian3(1.0, 1.0, 1.0)
          }

          // Apply landing gear animation for FSLTL models
          // We check for FSLTL match type instead of hasAnimations flag because:
          // 1. Old converted models may not have hasAnimations set correctly
          // 2. The applyGearAnimation function handles models without animations gracefully
          const isFsltlForGear = modelInfo.matchType === 'fsltl' || modelInfo.matchType === 'fsltl-base'

          // Skip gear animation if model is still loading (the current model in pool is a placeholder)
          const isModelLoading = modelPoolLoading.current.has(poolIndex)

          if (isFsltlForGear && model.ready && !isModelLoading) {
            // Determine if aircraft is on ground based on groundspeed threshold
            const isOnGround = aircraft.interpolatedGroundspeed < GROUNDSPEED_THRESHOLD_KNOTS

            // Calculate AGL (above ground level) by subtracting ground elevation from aircraft altitude
            // Both values are in meters MSL, so the difference gives us AGL
            const altitudeAglMeters = aircraft.interpolatedAltitude - groundElevationMeters
            const altitudeAglFeet = altitudeAglMeters * 3.28084

            // Convert vertical rate from meters/min to feet/min
            const verticalRateFpm = aircraft.verticalRate * 3.28084

            // Update gear animation state and get current progress
            const gearProgress = updateGearAnimation(
              aircraft.callsign,
              altitudeAglFeet,
              verticalRateFpm,
              isOnGround,
              Date.now()
            )

            // Apply the animation progress to the model
            // Pass known animation count from gltfCallback for reliable animation access
            const knownAnimCount = modelAnimationCountsRef.current.get(modelInfo.modelUrl)
            applyGearAnimation(model, gearProgress, aircraft.callsign, modelInfo.modelUrl, knownAnimCount)
          }
        }
      }
    }

    // Hide unused pool models and clean up references to prevent memory leaks
    // Use reverse lookup to find stale assignments - O(seenCallsigns) instead of O(poolSize)
    for (const [callsign, idx] of callsignToPoolIndexRef.current.entries()) {
      if (!seenCallsigns.has(callsign)) {
        // Clean up gear animation state for this aircraft
        clearGearState(callsign)

        // Release this slot and hide the model
        modelPoolAssignments.current.set(idx, null)
        modelPoolIsFsltlRef.current.delete(idx)
        callsignToPoolIndexRef.current.delete(callsign)
        availablePoolSlotsRef.current.add(idx)

        const model = modelPool.current.get(idx)
        if (model) {
          model.show = false

          // Reset model URL tracking (next aircraft may need different model)
          modelPoolUrls.current.set(idx, './b738.glb')
        }
      }
    }

    // Update silhouette selected array with only built-in (non-FSLTL) visible models
    // This enables edge detection outlines only for the white FR24 models
    // Use reverse lookup for O(active_aircraft) instead of O(poolSize)
    const edgeDetection = silhouetteRefs?.edgeDetection.current
    if (edgeDetection) {
      const builtinModels: Cesium.Model[] = []
      for (const [, idx] of callsignToPoolIndexRef.current.entries()) {
        const model = modelPool.current.get(idx)
        const isFsltl = modelPoolIsFsltlRef.current.get(idx) ?? false
        if (model && model.show && !isFsltl) {
          builtinModels.push(model)
        }
      }
      edgeDetection.selected = builtinModels
    }

    performanceMonitor.endTimer('aircraftUpdate')
  }, [
    viewer,
    interpolatedAircraft,
    modelPool,
    modelPoolAssignments,
    modelPoolUrls,
    modelPoolLoading,
    modelPoolReady,
    viewMode,
    followingCallsign,
    builtinModelBrightness,
    fsltlModelBrightness,
    builtinModelTintColor,
    groundElevationMeters,
    silhouetteRefs,
    enableNightDarkening,
    aircraftNightVisibility,
    sunElevation
  ])

  // Set up render loop to update models every frame
  // Use preRender (not postRender) so aircraft positions are set BEFORE the frame renders,
  // matching the camera follow calculations which also happen in preRender
  useEffect(() => {
    if (!viewer) return

    const removeListener = viewer.scene.preRender.addEventListener(updateAircraftModels)

    return () => {
      removeListener()
    }
  }, [viewer, updateAircraftModels])

  // Listen for FSLTL model updates to clear URL cache
  // This forces models to re-fetch from AircraftModelService which will pick up new FSLTL models
  useEffect(() => {
    const handleFsltlUpdate = () => {
      // Clear all URL mappings to force model refresh on next frame
      for (const [idx] of modelPoolUrls.current.entries()) {
        modelPoolUrls.current.set(idx, '')
      }
    }

    window.addEventListener('fsltl-models-updated', handleFsltlUpdate)
    return () => {
      window.removeEventListener('fsltl-models-updated', handleFsltlUpdate)
    }
  }, [modelPoolUrls])
}
