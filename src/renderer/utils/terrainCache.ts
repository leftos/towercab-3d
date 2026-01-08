/**
 * Terrain Cache Utilities
 *
 * Functions for managing Cesium terrain tile cache.
 * Used when terrain flattening settings change to ensure fresh tiles are loaded.
 */

import * as Cesium from 'cesium'

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

      // Step 4: Wait for terrain to load, then trigger render to let camera clamping
      // logic (in useCesiumCamera) correct the camera height automatically.
      // The camera's preRender listener uses globe.getHeight() which needs loaded terrain.
      setTimeout(() => {
        if (viewer.isDestroyed()) {
          resolve()
          return
        }
        // Force a render cycle - the camera's preRender listener will
        // use the updated terrain height from globe.getHeight() to clamp the camera
        viewer.scene.render()
        resolve()
      }, 300) // Wait for terrain tiles to load
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
  const terrainCaches = cacheNames.filter(name =>
    name.toLowerCase().includes('cesium') ||
    name.toLowerCase().includes('terrain') ||
    name.toLowerCase().includes('tile')
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
    if (request.url.includes('terrain') ||
        request.url.includes('quantized-mesh') ||
        request.url.includes('cesiumjs.org') ||
        request.url.includes('cesium.com')) {
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

  await Promise.all([
    clearTerrainCache(viewer),
    clearDiskTerrainCache()
  ])

  console.log('[TerrainCache] All terrain caches cleared')
}
