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

import { useEffect, useRef, useCallback, useState } from 'react'
import * as Cesium from 'cesium'
import type { Runway } from '../types/airport'
import { airportPolygonService } from '../services/AirportPolygonService'
import { airportSurfacesService } from '../services/AirportSurfacesService'
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
  // Track if pavements were included in the last polygon generation
  const hadPavementsRef = useRef(false)
  // Track last enabled state to detect enable/disable transitions
  const lastEnabledRef = useRef<boolean>(enabled)

  // Track if airport surfaces data is loaded
  const [surfacesLoaded, setSurfacesLoaded] = useState(airportSurfacesService.isLoaded())

  // Load airport surfaces data on mount
  useEffect(() => {
    if (!surfacesLoaded) {
      airportSurfacesService.load()
        .then(() => {
          setSurfacesLoaded(true)
          console.log('[TerrainFlattening] Airport surfaces data loaded')
        })
        .catch((error) => {
          console.warn('[TerrainFlattening] Failed to load airport surfaces data:', error)
          // Still mark as loaded (empty) so flattening can proceed with just runways
          setSurfacesLoaded(true)
        })
    }
  }, [surfacesLoaded])

  // Wrap the terrain provider on first use
  const wrapTerrainProvider = useCallback(() => {
    if (!viewer || viewer.isDestroyed() || isWrappedRef.current) return

    const currentProvider = viewer.terrainProvider
    if (!(currentProvider instanceof Cesium.CesiumTerrainProvider)) {
      console.warn('[TerrainFlattening] Terrain provider is not CesiumTerrainProvider, cannot wrap')
      return
    }

    // Wrap the provider
    const wrapped = createFlatteningTerrainProvider(currentProvider)
    flatteningProviderRef.current = wrapped
    isWrappedRef.current = true

    console.log('[TerrainFlattening] Wrapped terrain provider')
  }, [viewer])

  // Single unified effect for managing terrain flattening state
  // Handles: enable/disable, airport changes, pavement data loading
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return

    // Ensure provider is wrapped
    if (!isWrappedRef.current) {
      wrapTerrainProvider()
    }

    const provider = flatteningProviderRef.current
    if (!provider) return

    // Detect enable/disable transition
    const wasEnabled = lastEnabledRef.current
    const justDisabled = wasEnabled && !enabled
    const justEnabled = !wasEnabled && enabled
    lastEnabledRef.current = enabled

    // Handle disabled state
    if (!enabled) {
      if (lastAirportRef.current !== null) {
        if (justDisabled) {
          console.log('[TerrainFlattening] Disabled - clearing polygons')
        }
        provider.clearFlatteningPolygons()
        lastAirportRef.current = null
        hadPavementsRef.current = false
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
        hadPavementsRef.current = false
        void clearAllTerrainCaches(viewer).then(() => refreshCamera())
      }
      return
    }

    // Check if we need to regenerate polygons:
    // - Different airport: always regenerate
    // - Same airport but pavements just became available: regenerate to include them
    // - Just re-enabled: regenerate
    const pavementsNowAvailable = surfacesLoaded && airportSurfacesService.isLoaded()
    const airportChanged = currentAirportIcao !== lastAirportRef.current
    const pavementsJustLoaded = pavementsNowAvailable && !hadPavementsRef.current
    const needsRegeneration = airportChanged || pavementsJustLoaded || justEnabled

    if (!needsRegeneration) {
      return
    }

    if (justEnabled) {
      console.log(`[TerrainFlattening] Re-enabled for ${currentAirportIcao}`)
    }

    // Generate polygons (includes pavements if loaded)
    const config = airportPolygonService.generateRunwayPolygons(
      currentAirportIcao,
      runways,
      blendDistance
    )

    // Track whether pavements were included
    const pavementsIncluded = pavementsNowAvailable && airportSurfacesService.hasAirportData(currentAirportIcao)
    hadPavementsRef.current = pavementsIncluded

    if (config.polygons.length === 0) {
      console.log(`[TerrainFlattening] No polygons for ${currentAirportIcao}`)
      provider.clearFlatteningPolygons()
      lastAirportRef.current = currentAirportIcao
      return
    }

    // Set the flattening polygons first, then clear cache
    // This ensures new tiles will use the updated polygons
    provider.setFlatteningPolygons(config.polygons)
    lastAirportRef.current = currentAirportIcao

    const runwayCount = config.polygons.filter(p => p.source === 'runway').length
    const pavementCount = config.polygons.length - runwayCount
    console.log(`[TerrainFlattening] Set ${config.polygons.length} polygons for ${currentAirportIcao} (${runwayCount} runways, ${pavementCount} pavements)`)

    // Clear tile cache to force re-fetch with modifications, then refresh camera position
    void clearAllTerrainCaches(viewer).then(() => refreshCamera())
  }, [viewer, currentAirportIcao, runways, enabled, blendDistance, wrapTerrainProvider, refreshCamera, surfacesLoaded])

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
