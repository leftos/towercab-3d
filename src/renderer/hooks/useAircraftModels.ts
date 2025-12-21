import { useEffect, useRef, useCallback } from 'react'
import * as Cesium from 'cesium'
import type { ModelPoolRefs } from './useCesiumViewer'
import type { InterpolatedAircraftState } from '../types/vatsim'
import type { ViewMode } from '../types'
import { aircraftModelService } from '../services/AircraftModelService'
import { performanceMonitor } from '../utils/performanceMonitor'

// Model rendering constants
const MODEL_HEIGHT_OFFSET = 1       // Meters to raise models above ground to prevent clipping
const MODEL_DEFAULT_COLOR = new Cesium.Color(0.9, 0.9, 0.9, 1.0)  // Light gray tint for MIX mode
const MODEL_COLOR_BLEND_AMOUNT = 0.15  // Subtle blend to preserve original textures (0=original, 1=full tint)

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
 * @param terrainOffsetRef - Geoid offset for this airport location
 * @param terrainOffsetReady - Whether terrain offset has been calculated
 * @param viewMode - Current view mode ('3d' or 'topdown')
 * @param followingCallsign - Callsign of followed aircraft (for diagnostic logging)
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
 *   terrainOffsetRef,
 *   terrainOffsetReady,
 *   viewMode,
 *   followingCallsign
 * )
 * ```
 */
export function useAircraftModels(
  viewer: Cesium.Viewer | null,
  modelPoolRefs: ModelPoolRefs,
  interpolatedAircraft: Map<string, InterpolatedAircraftState>,
  terrainOffsetRef: React.MutableRefObject<number>,
  terrainOffsetReady: boolean,
  viewMode: ViewMode,
  followingCallsign: string | null
) {
  const {
    modelPool,
    modelPoolAssignments,
    modelPoolUrls,
    modelPoolLoading,
    modelPoolReady
  } = modelPoolRefs

  // Track previous positions for diagnostic logging
  const prevModelPositionsRef = useRef<Map<string, Cesium.Cartesian3>>(new Map())

  // Update aircraft models
  const updateAircraftModels = useCallback(() => {
    if (!viewer || !modelPoolReady.current || !terrainOffsetReady) return

    performanceMonitor.startTimer('aircraftUpdate')

    // Track which callsigns we've seen this frame (for cleanup)
    const seenCallsigns = new Set<string>()

    // Calculate view mode scale (smaller in topdown for better overview)
    const viewModeScale = viewMode === 'topdown' ? 0.5 : 1.0

    // Update each aircraft model
    for (const aircraft of interpolatedAircraft.values()) {
      seenCallsigns.add(aircraft.callsign)

      // Calculate height above ellipsoid
      const heightAboveEllipsoid = aircraft.interpolatedAltitude

      // Get the correct model info for this aircraft type
      const modelInfo = aircraftModelService.getModelInfo(aircraft.aircraftType)

      // Calculate model position with terrain offset correction and height offset to prevent ground clipping
      const modelHeight = heightAboveEllipsoid + terrainOffsetRef.current + MODEL_HEIGHT_OFFSET

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

            // Load new model in background
            Cesium.Model.fromGltfAsync({
              url: modelInfo.modelUrl,
              show: false,
              modelMatrix: model.modelMatrix,  // Copy current transform
              shadows: Cesium.ShadowMode.ENABLED,
              color: model.color,
              colorBlendMode: Cesium.ColorBlendMode.MIX,
              colorBlendAmount: MODEL_COLOR_BLEND_AMOUNT
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
          // Pitch: Negate because Cesium's coordinate system is opposite to our convention
          // Roll: Negate for same reason as pitch (due to model orientation)
          const hpr = new Cesium.HeadingPitchRoll(
            Cesium.Math.toRadians(aircraft.interpolatedHeading - 90 + 180),
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

          // Apply color blend - full white in topdown, subtle tint in 3D to preserve textures
          if (viewMode === 'topdown') {
            model.color = Cesium.Color.WHITE
            model.colorBlendAmount = 1.0  // Full white for 2D visibility
          } else {
            model.color = MODEL_DEFAULT_COLOR
            model.colorBlendAmount = MODEL_COLOR_BLEND_AMOUNT  // Subtle blend preserves textures
          }

          // Show the model
          model.show = true
        }
      }
    }

    // Hide unused pool models and clean up references to prevent memory leaks
    for (const [idx, assignedCallsign] of modelPoolAssignments.current.entries()) {
      if (assignedCallsign !== null && !seenCallsigns.has(assignedCallsign)) {
        // Release this slot and hide the model
        modelPoolAssignments.current.set(idx, null)
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
    terrainOffsetRef,
    terrainOffsetReady,
    viewMode,
    followingCallsign
  ])

  // Set up render loop to update models every frame
  useEffect(() => {
    if (!viewer) return

    const removeListener = viewer.scene.postRender.addEventListener(updateAircraftModels)

    return () => {
      removeListener()
    }
  }, [viewer, updateAircraftModels])
}
