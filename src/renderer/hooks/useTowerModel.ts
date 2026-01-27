/**
 * useTowerModel Hook
 *
 * Loads and manages a 3D tower model for the current airport.
 * Handles model loading, positioning, terrain height sampling, and cleanup.
 *
 * Unlike aircraft models which are pooled (100+ simultaneous, constantly moving),
 * towers are:
 * - One per airport (static)
 * - Only visible at current airport
 * - Changed infrequently
 *
 * Position Fallback Chain:
 * 1. manifest.modelPosition (explicit lat/lon/height/rotation in tower mod)
 * 2. tower-positions data (view3d lat/lon from bundled FAA data or user overrides)
 * 3. Skip rendering if no position data available
 *
 * Height Calculation:
 * - Base: terrain height at position (sampled from terrain provider)
 * - Add: placement.height from manifest (default 0) for fine-tuning
 * - The model base should be at ground level
 */

import { useEffect, useRef } from 'react'
import * as Cesium from 'cesium'
import { useAirportStore } from '../stores/airportStore'
import { modService } from '../services/ModService'
import { convertToAssetUrlSync } from '../utils/tauriApi'

interface UseTowerModelOptions {
  /** Whether the hook is enabled */
  enabled?: boolean
}

/**
 * Hook to load and display tower 3D models in the Cesium scene
 *
 * @param viewer - Cesium viewer instance (null during initialization)
 * @param options - Configuration options
 */
export function useTowerModel(
  viewer: Cesium.Viewer | null,
  options: UseTowerModelOptions = {}
): void {
  const { enabled = true } = options

  // Get current airport from store
  const currentAirport = useAirportStore((state) => state.currentAirport)

  // Track the current model and ICAO to manage cleanup
  const modelRef = useRef<Cesium.Model | null>(null)
  const currentIcaoRef = useRef<string | null>(null)
  const loadingIcaoRef = useRef<string | null>(null)

  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !enabled) {
      return
    }

    const icao = currentAirport?.icao?.toUpperCase() ?? null

    // If no airport or same airport, do nothing
    if (!icao || icao === currentIcaoRef.current) {
      return
    }

    // Mark as loading new airport
    loadingIcaoRef.current = icao

    // Cleanup previous model
    if (modelRef.current) {
      try {
        viewer.scene.primitives.remove(modelRef.current)
        modelRef.current.destroy()
      } catch {
        // Model may already be destroyed
      }
      modelRef.current = null
      currentIcaoRef.current = null
    }

    // Check if there's a tower mod for this airport
    const towerMod = modService.getTowerModel(icao)
    if (!towerMod) {
      // No tower mod for this airport
      return
    }

    // Get the tower placement (position)
    const placement = modService.getTowerPlacement(icao)
    if (!placement) {
      console.warn(`[useTowerModel] No position available for tower mod at ${icao}`)
      return
    }

    // Convert model URL for use with Cesium
    const modelUrl = convertToAssetUrlSync(towerMod.modelUrl)
    const manifest = towerMod.manifest

    // Get model scale (default 1.0)
    const scale = manifest.scale ?? 1.0

    console.log(`[useTowerModel] Loading tower model for ${icao}:`, {
      modelUrl,
      position: { lat: placement.lat, lon: placement.lon },
      height: placement.height,
      rotation: placement.rotation,
      source: placement.source,
      scale
    })

    // Sample terrain height at tower position
    const terrainPosition = Cesium.Cartographic.fromDegrees(
      placement.lon,
      placement.lat
    )

    Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [terrainPosition])
      .then((sampledPositions) => {
        // Verify we're still loading the same airport
        if (loadingIcaoRef.current !== icao || viewer.isDestroyed()) {
          return
        }

        const terrainHeight = sampledPositions[0].height ?? 0

        // Final height = terrain height + height offset from placement
        const finalHeight = terrainHeight + placement.height

        console.log(`[useTowerModel] Terrain sampled for ${icao}:`, {
          terrainHeight,
          placementHeight: placement.height,
          finalHeight
        })

        // Create position cartesian
        const position = Cesium.Cartesian3.fromDegrees(
          placement.lon,
          placement.lat,
          finalHeight
        )

        // Create heading/pitch/roll with rotation from placement
        const heading = Cesium.Math.toRadians(placement.rotation)
        const pitch = 0
        const roll = 0
        const hpr = new Cesium.HeadingPitchRoll(heading, pitch, roll)

        // Create model matrix (position + rotation)
        const modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(position, hpr)

        // Apply uniform scale
        if (scale !== 1.0) {
          const scaleMatrix = Cesium.Matrix4.fromUniformScale(scale)
          Cesium.Matrix4.multiply(modelMatrix, scaleMatrix, modelMatrix)
        }

        // Load the model
        Cesium.Model.fromGltfAsync({
          url: modelUrl,
          modelMatrix,
          show: true,
          shadows: Cesium.ShadowMode.ENABLED
        })
          .then((model) => {
            // Verify we're still loading the same airport and viewer is valid
            if (loadingIcaoRef.current !== icao || viewer.isDestroyed()) {
              // Cleanup loaded model since we no longer need it
              model.destroy()
              return
            }

            // Add to scene
            viewer.scene.primitives.add(model)

            // Track the model
            modelRef.current = model
            currentIcaoRef.current = icao

            console.log(`[useTowerModel] Tower model loaded for ${icao}`)
          })
          .catch((error) => {
            console.error(`[useTowerModel] Failed to load tower model for ${icao}:`, error)
          })
      })
      .catch((error) => {
        console.warn(`[useTowerModel] Failed to sample terrain for ${icao}:`, error)

        // Fallback: try to load without terrain height
        if (loadingIcaoRef.current !== icao || viewer.isDestroyed()) {
          return
        }

        const position = Cesium.Cartesian3.fromDegrees(
          placement.lon,
          placement.lat,
          placement.height
        )

        const heading = Cesium.Math.toRadians(placement.rotation)
        const hpr = new Cesium.HeadingPitchRoll(heading, 0, 0)
        const modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(position, hpr)

        if (scale !== 1.0) {
          const scaleMatrix = Cesium.Matrix4.fromUniformScale(scale)
          Cesium.Matrix4.multiply(modelMatrix, scaleMatrix, modelMatrix)
        }

        Cesium.Model.fromGltfAsync({
          url: modelUrl,
          modelMatrix,
          show: true,
          shadows: Cesium.ShadowMode.ENABLED
        })
          .then((model) => {
            if (loadingIcaoRef.current !== icao || viewer.isDestroyed()) {
              model.destroy()
              return
            }

            viewer.scene.primitives.add(model)
            modelRef.current = model
            currentIcaoRef.current = icao

            console.warn(`[useTowerModel] Tower model loaded for ${icao} without terrain sampling`)
          })
          .catch((loadError) => {
            console.error(`[useTowerModel] Failed to load tower model for ${icao}:`, loadError)
          })
      })

    // Cleanup on unmount or when viewer changes
    return () => {
      if (modelRef.current && viewer && !viewer.isDestroyed()) {
        try {
          viewer.scene.primitives.remove(modelRef.current)
          modelRef.current.destroy()
        } catch {
          // Model may already be destroyed
        }
        modelRef.current = null
        currentIcaoRef.current = null
      }
    }
  }, [viewer, currentAirport?.icao, enabled])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      modelRef.current = null
      currentIcaoRef.current = null
      loadingIcaoRef.current = null
    }
  }, [])
}

export default useTowerModel
