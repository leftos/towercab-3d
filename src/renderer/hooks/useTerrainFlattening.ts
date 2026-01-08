/**
 * Terrain Flattening Hook
 *
 * Flattens airport runway surfaces by modifying terrain mesh vertex heights.
 * Uses a custom terrain provider wrapper that intercepts tile requests and
 * adjusts heights for vertices inside runway polygons.
 *
 * ## How It Works
 * 1. Wraps the viewer's terrain provider with FlatteningTerrainProvider
 * 2. Generates runway polygons from RunwayService data
 * 3. When tiles are requested, vertices inside polygons get flattened
 * 4. Clears tile cache when polygons change to force re-fetch
 */

import { useEffect, useRef, useCallback } from 'react'
import * as Cesium from 'cesium'
import type { Runway } from '../types/airport'
import { airportPolygonService } from '../services/AirportPolygonService'
import { createFlatteningTerrainProvider } from '../terrain/FlatteningTerrainProvider'
import { clearAllTerrainCaches } from '../utils/terrainCache'
import { useViewportStore } from '../stores/viewportStore'

interface UseTerrainFlatteningOptions {
  /** Cesium viewer instance */
  viewer: Cesium.Viewer | null
  /** Current airport ICAO code */
  currentAirportIcao: string | null
  /** Runways for the current airport */
  runways: Runway[]
  /** Enable terrain flattening */
  enabled: boolean
  /** Edge blend distance in meters */
  blendDistance: number
}

/** Extended terrain provider type with flattening methods */
type FlatteningProvider = Cesium.CesiumTerrainProvider & {
  setFlatteningPolygons: (polygons: import('../types/terrain').FlatteningPolygon[]) => void
  clearFlatteningPolygons: () => void
}

/**
 * Flatten runway surfaces by modifying terrain mesh heights
 *
 * @param options - Hook configuration options
 */
export function useTerrainFlattening({
  viewer,
  currentAirportIcao,
  runways,
  enabled,
  blendDistance
}: UseTerrainFlatteningOptions): void {
  // Get refreshCamera action to trigger camera recalculation after terrain changes
  const refreshCamera = useViewportStore((state) => state.refreshCamera)

  // Track if we've wrapped the terrain provider
  const isWrappedRef = useRef(false)
  const flatteningProviderRef = useRef<FlatteningProvider | null>(null)
  const lastAirportRef = useRef<string | null>(null)
  const originalProviderRef = useRef<Cesium.TerrainProvider | null>(null)

  // Wrap the terrain provider on first use
  const wrapTerrainProvider = useCallback(() => {
    if (!viewer || viewer.isDestroyed() || isWrappedRef.current) return

    const currentProvider = viewer.terrainProvider
    if (!(currentProvider instanceof Cesium.CesiumTerrainProvider)) {
      console.warn('[TerrainFlattening] Terrain provider is not CesiumTerrainProvider, cannot wrap')
      return
    }

    // Store original for potential restoration
    originalProviderRef.current = currentProvider

    // Wrap the provider
    const wrapped = createFlatteningTerrainProvider(currentProvider)
    flatteningProviderRef.current = wrapped
    isWrappedRef.current = true

    console.log('[TerrainFlattening] Wrapped terrain provider')
  }, [viewer])

  // Update flattening polygons when airport/runways change
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return

    // Ensure provider is wrapped
    if (!isWrappedRef.current) {
      wrapTerrainProvider()
    }

    const provider = flatteningProviderRef.current
    if (!provider) return

    // Handle disabled state
    if (!enabled) {
      if (lastAirportRef.current !== null) {
        provider.clearFlatteningPolygons()
        lastAirportRef.current = null
        // Clear cache to reload original tiles, then refresh camera position
        void clearAllTerrainCaches(viewer).then(() => refreshCamera())
      }
      return
    }

    // Handle no airport
    if (!currentAirportIcao) {
      if (lastAirportRef.current !== null) {
        provider.clearFlatteningPolygons()
        lastAirportRef.current = null
        void clearAllTerrainCaches(viewer).then(() => refreshCamera())
      }
      return
    }

    // Skip if same airport (polygons already set)
    if (currentAirportIcao === lastAirportRef.current) {
      return
    }

    // Generate runway polygons
    const config = airportPolygonService.generateRunwayPolygons(
      currentAirportIcao,
      runways,
      blendDistance
    )

    if (config.polygons.length === 0) {
      console.log(`[TerrainFlattening] No runway polygons for ${currentAirportIcao}`)
      provider.clearFlatteningPolygons()
      lastAirportRef.current = currentAirportIcao
      return
    }

    // Set the flattening polygons first, then clear cache
    // This ensures new tiles will use the updated polygons
    provider.setFlatteningPolygons(config.polygons)
    lastAirportRef.current = currentAirportIcao

    console.log(`[TerrainFlattening] Set ${config.polygons.length} runway polygons for ${currentAirportIcao}`)

    // Clear tile cache to force re-fetch with modifications, then refresh camera position
    void clearAllTerrainCaches(viewer).then(() => refreshCamera())
  }, [viewer, currentAirportIcao, runways, enabled, blendDistance, wrapTerrainProvider, refreshCamera])

  // Handle enabled toggle - this is separate from airport change to ensure proper state
  // The main effect handles re-enabling since lastAirportRef.current will be null
  useEffect(() => {
    const provider = flatteningProviderRef.current
    if (!provider || !viewer || viewer.isDestroyed()) return

    if (!enabled && lastAirportRef.current !== null) {
      console.log('[TerrainFlattening] Disabling - clearing polygons and cache')
      provider.clearFlatteningPolygons()
      lastAirportRef.current = null
      // Wait for cache clear to complete, then refresh camera position
      void clearAllTerrainCaches(viewer).then(() => {
        console.log('[TerrainFlattening] Cache cleared after disable')
        refreshCamera()
      })
    } else if (enabled && lastAirportRef.current === null && currentAirportIcao) {
      // Re-enabling with an airport set - regenerate polygons
      console.log(`[TerrainFlattening] Re-enabling for ${currentAirportIcao}`)
      const config = airportPolygonService.generateRunwayPolygons(
        currentAirportIcao,
        runways,
        blendDistance
      )
      if (config.polygons.length > 0) {
        provider.setFlatteningPolygons(config.polygons)
        lastAirportRef.current = currentAirportIcao
        console.log(`[TerrainFlattening] Set ${config.polygons.length} polygons, clearing cache`)
        void clearAllTerrainCaches(viewer).then(() => {
          console.log('[TerrainFlattening] Cache cleared after enable')
          refreshCamera()
        })
      }
    }
  }, [viewer, enabled, currentAirportIcao, runways, blendDistance, refreshCamera])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (flatteningProviderRef.current) {
        flatteningProviderRef.current.clearFlatteningPolygons()
      }
      isWrappedRef.current = false
      flatteningProviderRef.current = null
      lastAirportRef.current = null
    }
  }, [])
}

export default useTerrainFlattening
