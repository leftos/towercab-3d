/**
 * Terrain Cache Utilities
 *
 * Functions for managing Cesium terrain tile cache.
 * Used when terrain flattening settings change to ensure fresh tiles are loaded.
 */

import * as Cesium from 'cesium'

/** Maximum time to wait for terrain to load (ms) */
const MAX_TERRAIN_WAIT_MS = 2000
/** Check interval when waiting for terrain (ms) */
const TERRAIN_CHECK_INTERVAL_MS = 100

/**
 * Clear the in-memory terrain tile cache
 *
 * Forces Cesium to discard all terrain tiles and reload them by temporarily
 * swapping the terrain provider. This ensures modified requestTileGeometry
 * is called for all visible tiles.
 *
 * @param viewer - Cesium.Viewer instance
 * @returns Promise that resolves when cache is cleared
 */
export async function clearTerrainCache(viewer: Cesium.Viewer): Promise<void> {
  if (!viewer || viewer.isDestroyed()) return

  const globe = viewer.scene.globe
  const currentProvider = viewer.terrainProvider

  // Temporarily switch to ellipsoid terrain to force all terrain tiles to be discarded
  // This is the most reliable way to invalidate terrain cache in Cesium
  const ellipsoidProvider = new Cesium.EllipsoidTerrainProvider()

  return new Promise((resolve) => {
    // Step 1: Switch to ellipsoid provider
    viewer.terrainProvider = ellipsoidProvider

    // Step 2: Force a render to process the change
    viewer.scene.render()

    // Step 3: Switch back to original provider after a frame
    // This triggers Cesium to request all terrain tiles fresh
    requestAnimationFrame(() => {
      if (viewer.isDestroyed()) {
        resolve()
        return
      }

      viewer.terrainProvider = currentProvider

      // Force another render to start loading new tiles
      viewer.scene.render()

      // Also clear imagery tile cache for good measure
      const originalCacheSize = globe.tileCacheSize
      globe.tileCacheSize = 1
      viewer.scene.render()
      globe.tileCacheSize = originalCacheSize

      console.log('[TerrainCache] Terrain provider swapped to force tile reload')

      // Step 4: Wait for terrain to load before resolving
      // Use a retry pattern instead of fixed timeout for reliability
      const startTime = Date.now()
      const initialTilesLoading = globe.tilesLoaded

      const checkTerrainLoaded = (): void => {
        if (viewer.isDestroyed()) {
          resolve()
          return
        }

        // Check if terrain has loaded (tilesLoaded becomes true or changed state)
        // Also check if we've exceeded the max wait time
        const elapsed = Date.now() - startTime
        const tilesNowLoaded = globe.tilesLoaded

        if (tilesNowLoaded || elapsed >= MAX_TERRAIN_WAIT_MS) {
          // Terrain is loaded or we've waited long enough
          viewer.scene.render()
          resolve()
          return
        }

        // If tiles started loading and are still loading, or just waiting for first load
        if (!initialTilesLoading || !tilesNowLoaded) {
          setTimeout(checkTerrainLoaded, TERRAIN_CHECK_INTERVAL_MS)
        } else {
          // Tiles appear loaded, resolve
          viewer.scene.render()
          resolve()
        }
      }

      // Start checking after a short initial delay
      setTimeout(checkTerrainLoaded, TERRAIN_CHECK_INTERVAL_MS)
    })
  })
}

/**
 * Clear the service worker terrain cache (disk cache)
 *
 * This clears cached terrain tiles from the browser's Cache Storage.
 * Call this along with clearTerrainCache for a complete cache reset.
 *
 * @returns Promise that resolves when cache is cleared, or rejects if not available
 */
export async function clearDiskTerrainCache(): Promise<void> {
  if (!('caches' in window)) {
    console.warn('[TerrainCache] Cache API not available')
    return
  }

  const cacheNames = await caches.keys()

  // Find terrain-related caches (typically named with 'cesium' or 'terrain')
  const terrainCaches = cacheNames.filter(
    (name) =>
      name.toLowerCase().includes('cesium') ||
      name.toLowerCase().includes('terrain') ||
      name.toLowerCase().includes('tile'),
  )

  for (const cacheName of terrainCaches) {
    await caches.delete(cacheName)
    console.log(`[TerrainCache] Cleared cache: ${cacheName}`)
  }

  // Also try to clear the main runtime cache if it has terrain tiles
  const runtimeCache = await caches.open('runtime-cache')
  const requests = await runtimeCache.keys()

  let deleted = 0
  for (const request of requests) {
    if (
      request.url.includes('terrain') ||
      request.url.includes('quantized-mesh') ||
      request.url.includes('cesiumjs.org') ||
      request.url.includes('cesium.com')
    ) {
      await runtimeCache.delete(request)
      deleted++
    }
  }

  if (deleted > 0) {
    console.log(`[TerrainCache] Cleared ${deleted} terrain entries from runtime-cache`)
  }
}

/**
 * Clear all terrain caches (memory + disk)
 *
 * @param viewer - Cesium.Viewer instance
 * @returns Promise that resolves when all caches are cleared
 */
export async function clearAllTerrainCaches(viewer: Cesium.Viewer): Promise<void> {
  console.log('[TerrainCache] Clearing all terrain caches...')

  await Promise.all([clearTerrainCache(viewer), clearDiskTerrainCache()])

  console.log('[TerrainCache] All terrain caches cleared')
}
