import { useEffect, useRef } from 'react'
import type { Viewer } from 'cesium'

/**
 * Maps terrain quality (1-5) to Cesium's maximumScreenSpaceError
 * Lower error = higher quality but more tiles to load
 */
function getScreenSpaceError(quality: number): number {
  const qualityMap: Record<number, number> = {
    1: 16,  // Low - fast loading, blurry at distance
    2: 8,   // Medium - balanced
    3: 4,   // High - good quality
    4: 2,   // Very High - excellent quality (Cesium default)
    5: 1    // Ultra - maximum quality, slower
  }
  return qualityMap[quality] ?? 4
}

/**
 * Manages terrain quality settings for a Cesium viewer
 *
 * ## Responsibilities
 * - Configure Cesium terrain tile detail level (1-5 quality scale)
 * - Synchronize in-memory tile cache size with settings
 * - Handle runtime terrain quality changes with proper cache eviction
 *
 * ## Quality Change Strategy
 * When user changes quality at runtime, we must evict old tiles before loading
 * new ones to prevent memory spikes. The eviction process:
 * 1. Hide globe to stop new tile requests
 * 2. Reduce cache to 1 tile to force eviction
 * 3. Force 10 render cycles (Cesium only evicts during renders)
 * 4. Change quality setting
 * 5. Restore cache size and show globe
 *
 * This prevents the scenario where both old (high-quality) and new (low-quality)
 * tiles compete for memory, potentially causing 2-3x memory usage spikes.
 *
 * @param viewer - Initialized Cesium.Viewer instance
 * @param terrainQuality - Quality level (1=Low to 5=Ultra)
 * @param inMemoryTileCacheSize - Number of tiles to cache in memory
 *
 * @example
 * ```tsx
 * const viewer = useCesiumViewer(...)
 * useTerrainQuality(viewer, settings.terrainQuality, settings.inMemoryTileCacheSize)
 * ```
 */
export function useTerrainQuality(
  viewer: Viewer | null,
  terrainQuality: number,
  inMemoryTileCacheSize: number
) {
  // Track the last terrain quality to detect actual user changes vs initial mount
  const lastTerrainQualityRef = useRef<number | null>(null)
  const qualityChangeInProgressRef = useRef(false)

  // Update terrain quality when setting changes - only flush cache on actual user changes
  useEffect(() => {
    if (!viewer || qualityChangeInProgressRef.current) return

    const newError = getScreenSpaceError(terrainQuality)

    // On first mount, just set the quality without flushing
    if (lastTerrainQualityRef.current === null) {
      viewer.scene.globe.maximumScreenSpaceError = newError
      lastTerrainQualityRef.current = terrainQuality
      return
    }

    // Only flush cache if the user actually changed the terrain quality setting
    if (lastTerrainQualityRef.current !== terrainQuality) {
      const originalCacheSize = viewer.scene.globe.tileCacheSize

      qualityChangeInProgressRef.current = true

      // CRITICAL: Evict tiles BEFORE changing quality to prevent memory spike
      // Step 1: Hide globe to stop new tile requests
      viewer.scene.globe.show = false

      // Step 2: Aggressively reduce cache to force eviction
      viewer.scene.globe.tileCacheSize = 1

      // Step 3: Force multiple render cycles to actually evict tiles
      // Cesium only evicts tiles during render cycles, so we must render
      let renderCount = 0
      const forceEviction = () => {
        if (viewer.isDestroyed()) return

        // Force a render to trigger tile eviction
        viewer.scene.render()
        renderCount++

        if (renderCount < 10) {
          // Continue forcing renders to ensure tiles are evicted
          requestAnimationFrame(forceEviction)
        } else {
          // Step 4: After eviction, change quality and restore
          // Now change the quality setting (no old tiles to compete with)
          viewer.scene.globe.maximumScreenSpaceError = newError
          lastTerrainQualityRef.current = terrainQuality

          // Restore cache size
          viewer.scene.globe.tileCacheSize = originalCacheSize

          // Show globe again - will load fresh tiles at new quality
          viewer.scene.globe.show = true

          qualityChangeInProgressRef.current = false
        }
      }

      // Start the eviction process
      requestAnimationFrame(forceEviction)
    }
  }, [viewer, terrainQuality])

  // Update in-memory tile cache size when setting changes
  useEffect(() => {
    if (!viewer) return
    viewer.scene.globe.tileCacheSize = inMemoryTileCacheSize
  }, [viewer, inMemoryTileCacheSize])
}
