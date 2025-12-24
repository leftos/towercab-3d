import { useEffect, useRef, useCallback } from 'react'
import * as Cesium from 'cesium'
import type { ModelPoolRefs } from './useCesiumViewer'
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
import { useSettingsStore } from '../stores/settingsStore'
import {
  updateGearAnimation,
  applyGearAnimation,
  clearGearState,
  initializeGearState
} from '../utils/gearAnimationController'

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
 * - **Pool size**: 100 models (CONE_POOL_SIZE)
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
 *
 * @example
 * ```tsx
 * const { viewer, modelPoolRefs } = useCesiumViewer(...)
 * const interpolatedAircraft = useAircraftInterpolation()
 *
 * useAircraftModels(
 *   viewer,
 *   modelPoolRefs,
 *   interpolatedAircraft,
 *   viewMode,
 *   followingCallsign,
 *   groundElevationMeters
 * )
 * ```
 */
export function useAircraftModels(
  viewer: Cesium.Viewer | null,
  modelPoolRefs: ModelPoolRefs,
  interpolatedAircraft: Map<string, InterpolatedAircraftState>,
  viewMode: ViewMode,
  followingCallsign: string | null,
  groundElevationMeters: number
) {
  const {
    modelPool,
    modelPoolAssignments,
    modelPoolUrls,
    modelPoolLoading,
    modelPoolReady
  } = modelPoolRefs

  // Get model brightness from settings - separate for built-in and FSLTL models
  const builtinModelBrightness = useSettingsStore((state) => state.graphics.builtinModelBrightness) ?? 1.7
  const fsltlModelBrightness = useSettingsStore((state) => state.graphics.fsltlModelBrightness) ?? 1.0

  // Track previous positions for diagnostic logging
  const prevModelPositionsRef = useRef<Map<string, Cesium.Cartesian3>>(new Map())

  // Track which pool slots have FSLTL models (for color blend logic)
  const modelPoolIsFsltlRef = useRef<Map<number, boolean>>(new Map())

  // Track animation counts per model URL (populated via gltfCallback during model loading)
  const modelAnimationCountsRef = useRef<Map<string, number>>(new Map())

  // Update aircraft models
  const updateAircraftModels = useCallback(() => {
    if (!viewer || !modelPoolReady.current) return

    performanceMonitor.startTimer('aircraftUpdate')

    // Track which callsigns we've seen this frame (for cleanup)
    const seenCallsigns = new Set<string>()

    // Calculate view mode scale (smaller in topdown for better overview)
    const viewModeScale = viewMode === 'topdown' ? 0.5 : 1.0

    // Update each aircraft model
    for (const aircraft of interpolatedAircraft.values()) {
      seenCallsigns.add(aircraft.callsign)

      // Get the correct model info for this aircraft type (and callsign for FSLTL livery matching)
      const modelInfo = aircraftModelService.getModelInfo(aircraft.aircraftType, aircraft.callsign)

      // Model height: interpolatedAltitude is already terrain-corrected by interpolation system
      // (includes terrain sampling, ground/air transitions, and all offsets)
      // FSLTL models need additional offset to prevent ground clipping
      const isFsltlModel = modelInfo.matchType === 'fsltl' || modelInfo.matchType === 'fsltl-base'
      const heightOffset = isFsltlModel ? FSLTL_MODEL_HEIGHT_OFFSET + 4.0 : 0
      const modelHeight = aircraft.interpolatedAltitude + heightOffset

      // Find existing pool slot for this callsign, or get an unused one
      let poolIndex = -1
      for (const [idx, assignedCallsign] of modelPoolAssignments.current.entries()) {
        if (assignedCallsign === aircraft.callsign) {
          poolIndex = idx
          break
        }
      }
      if (poolIndex === -1) {
        // Find an unused slot
        for (const [idx, assignedCallsign] of modelPoolAssignments.current.entries()) {
          if (assignedCallsign === null) {
            poolIndex = idx
            modelPoolAssignments.current.set(idx, aircraft.callsign)

            // Initialize gear state based on aircraft's current conditions
            // This ensures aircraft spawning in flight have gear up, while ground aircraft have gear down
            const isOnGround = aircraft.interpolatedGroundspeed < GROUNDSPEED_THRESHOLD_KNOTS
            const altitudeAglMeters = aircraft.interpolatedAltitude - groundElevationMeters
            const altitudeAglFeet = altitudeAglMeters * 3.28084
            const verticalRateFpm = aircraft.verticalRate * 3.28084
            initializeGearState(aircraft.callsign, altitudeAglFeet, verticalRateFpm, isOnGround)
            break
          }
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

            // Track if this is an FSLTL model (for color blend logic)
            const isFsltlModel = modelInfo.matchType.startsWith('fsltl')
            modelPoolIsFsltlRef.current.set(poolIndex, isFsltlModel)

            // Calculate model color and blend amount based on brightness setting
            // FSLTL models use their own brightness slider to preserve livery colors
            const effectiveBrightness = isFsltlModel ? fsltlModelBrightness : builtinModelBrightness
            const modelColorRgb = getModelColorRgb(effectiveBrightness)
            const modelColor = new Cesium.Color(...modelColorRgb, 1.0)
            const blendAmount = isFsltlModel
              ? getFsltlModelColorBlendAmount(effectiveBrightness)
              : getModelColorBlendAmount(effectiveBrightness)

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
              console.error(`Failed to load model ${modelInfo.modelUrl}:`, err)
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
          // Pitch: Negate because Cesium's coordinate system is opposite to our convention
          // Roll: Negate for same reason as pitch (due to model orientation)
          const rotationOffset = modelInfo.rotationOffset ?? 0
          const hpr = new Cesium.HeadingPitchRoll(
            Cesium.Math.toRadians(aircraft.interpolatedHeading - 90 + 180 + rotationOffset),
            Cesium.Math.toRadians(-aircraft.interpolatedPitch),
            Cesium.Math.toRadians(-aircraft.interpolatedRoll)
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
          // FSLTL models get no blend by default in 3D mode to show their liveries
          const isFsltlModel = modelPoolIsFsltlRef.current.get(poolIndex) ?? false
          if (viewMode === 'topdown') {
            // Always white in top-down view for visibility (both FSLTL and built-in)
            model.color = Cesium.Color.WHITE
            model.colorBlendAmount = 1.0
          } else {
            // In 3D mode: FSLTL models show liveries, built-in models get subtle tint
            const effectiveBrightness = isFsltlModel ? fsltlModelBrightness : builtinModelBrightness
            const modelColorRgb = getModelColorRgb(effectiveBrightness)
            const blendAmount = isFsltlModel
              ? getFsltlModelColorBlendAmount(effectiveBrightness)
              : getModelColorBlendAmount(effectiveBrightness)
            model.color = new Cesium.Color(...modelColorRgb, 1.0)
            model.colorBlendAmount = blendAmount
          }

          // Show the model
          model.show = true

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
    for (const [idx, assignedCallsign] of modelPoolAssignments.current.entries()) {
      if (assignedCallsign !== null && !seenCallsigns.has(assignedCallsign)) {
        // Clean up gear animation state for this aircraft
        clearGearState(assignedCallsign)

        // Release this slot and hide the model
        modelPoolAssignments.current.set(idx, null)
        modelPoolIsFsltlRef.current.delete(idx)
        const model = modelPool.current.get(idx)
        if (model) {
          model.show = false

          // Reset model URL tracking (next aircraft may need different model)
          modelPoolUrls.current.set(idx, './b738.glb')
        }
      }
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
    groundElevationMeters
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
