import { useEffect } from 'react'
import * as Cesium from 'cesium'

export interface CesiumLightingSettings {
  /** Whether this is an inset viewport (disables shadows for performance) */
  isInset: boolean
  /** Enable realistic sun-based lighting on terrain */
  enableLighting: boolean
  /** Enable ground atmosphere effects */
  enableGroundAtmosphere: boolean
  /** Enable shadows cast by sun */
  enableShadows: boolean
  /** Shadow map resolution (512, 1024, 2048, 4096) */
  shadowMapSize: number
  /** Maximum distance for shadow rendering (meters) */
  shadowMaxDistance: number
  /** Shadow darkness (0-1, where 1 is completely black) */
  shadowDarkness: number
  /** Enable soft shadow edges (PCF filtering) */
  shadowSoftness: boolean
  /** Enable distance-based shadow fading */
  shadowFadingEnabled: boolean
  /** Normal offset to prevent shadow acne */
  shadowNormalOffset: boolean
  /** Only render shadows from aircraft models (terrain won't self-shadow) */
  aircraftShadowsOnly: boolean
  /** Shadow depth bias for terrain (reduces banding artifacts) */
  shadowDepthBias: number
  /** Shadow polygon offset factor (slope-based depth offset) */
  shadowPolygonOffsetFactor: number
  /** Shadow polygon offset units (constant depth offset) */
  shadowPolygonOffsetUnits: number
}

/**
 * Manages lighting and shadow configuration for a Cesium viewer
 *
 * ## Responsibilities
 * - Configure sun-based lighting and ground atmosphere
 * - Manage cascaded shadow maps with quality settings
 * - Handle inset viewport optimizations (shadows disabled)
 *
 * ## Shadow System
 * Cesium uses cascaded shadow maps for high-quality terrain shadows:
 * - **Cascades**: Fixed at 1 or 4 (not configurable via API)
 * - **Map size**: 512-4096px (higher = better quality, more VRAM)
 * - **Max distance**: How far from camera shadows render
 * - **Soft shadows**: PCF (Percentage Closer Filtering) for smooth edges
 * - **Normal offset**: Prevents shadow acne on steep slopes
 *
 * ## Performance Notes
 * - Inset viewports have shadows disabled for performance
 * - Shadow map size directly impacts VRAM usage
 * - Maximum distance affects both quality and performance
 *
 * @param viewer - Initialized Cesium.Viewer instance
 * @param settings - Lighting and shadow configuration
 *
 * @example
 * ```tsx
 * const viewer = useCesiumViewer(...)
 * useCesiumLighting(viewer, {
 *   isInset: false,
 *   enableLighting: true,
 *   enableShadows: true,
 *   shadowMapSize: 2048,
 *   shadowMaxDistance: 10000,
 *   shadowDarkness: 0.5,
 *   shadowSoftness: true,
 *   shadowFadingEnabled: true,
 *   shadowNormalOffset: true,
 *   enableGroundAtmosphere: true
 * })
 * ```
 */
export function useCesiumLighting(
  viewer: Cesium.Viewer | null,
  settings: CesiumLightingSettings
) {
  const {
    isInset,
    enableLighting,
    enableGroundAtmosphere,
    enableShadows,
    shadowMapSize,
    shadowMaxDistance,
    shadowDarkness,
    shadowSoftness,
    shadowFadingEnabled,
    shadowNormalOffset,
    aircraftShadowsOnly,
    shadowDepthBias,
    shadowPolygonOffsetFactor,
    shadowPolygonOffsetUnits
  } = settings

  // Update lighting and shadows when settings change
  useEffect(() => {
    if (!viewer) return

    // Update ground atmosphere
    viewer.scene.globe.showGroundAtmosphere = enableGroundAtmosphere

    // Update lighting
    viewer.scene.globe.enableLighting = enableLighting

    // Update shadows - disabled for insets, configurable for main viewport
    if (isInset) {
      viewer.shadows = false
      viewer.terrainShadows = Cesium.ShadowMode.DISABLED
    } else {
      viewer.shadows = enableShadows
      if (enableShadows) {
        // Configure cascaded shadow maps with user settings
        viewer.shadowMap.softShadows = shadowSoftness
        viewer.shadowMap.size = shadowMapSize
        // Note: numberOfCascades is not configurable in Cesium API (only 1 or 4 cascades supported internally)
        viewer.shadowMap.maximumDistance = shadowMaxDistance
        viewer.shadowMap.darkness = shadowDarkness
        viewer.shadowMap.fadingEnabled = shadowFadingEnabled
        viewer.shadowMap.normalOffset = shadowNormalOffset
        // RECEIVE_ONLY: terrain receives shadows from aircraft but doesn't cast shadows on itself
        viewer.terrainShadows = aircraftShadowsOnly
          ? Cesium.ShadowMode.RECEIVE_ONLY
          : Cesium.ShadowMode.ENABLED

        // Configure internal shadow bias settings (undocumented but stable API)
        // These help reduce shadow banding artifacts
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const shadowMap = viewer.shadowMap as any

        // Update terrain bias (affects terrain self-shadowing)
        if (shadowMap._terrainBias) {
          shadowMap._terrainBias.depthBias = shadowDepthBias
          shadowMap._terrainBias.polygonOffsetFactor = shadowPolygonOffsetFactor
          shadowMap._terrainBias.polygonOffsetUnits = shadowPolygonOffsetUnits
        }

        // Update primitive bias (affects aircraft model shadows)
        if (shadowMap._primitiveBias) {
          // Use smaller bias for primitives (models are smaller than terrain)
          shadowMap._primitiveBias.depthBias = shadowDepthBias / 5
          shadowMap._primitiveBias.polygonOffsetFactor = shadowPolygonOffsetFactor
          shadowMap._primitiveBias.polygonOffsetUnits = shadowPolygonOffsetUnits
        }

        // Force shadow map to rebuild render states with new bias values
        if (typeof shadowMap.debugCreateRenderStates === 'function') {
          shadowMap.debugCreateRenderStates()
        }
        shadowMap.dirty = true
      } else {
        viewer.terrainShadows = Cesium.ShadowMode.DISABLED
      }
    }
  }, [
    viewer,
    isInset,
    enableLighting,
    enableGroundAtmosphere,
    enableShadows,
    shadowMapSize,
    shadowMaxDistance,
    shadowDarkness,
    shadowSoftness,
    shadowFadingEnabled,
    shadowNormalOffset,
    aircraftShadowsOnly,
    shadowDepthBias,
    shadowPolygonOffsetFactor,
    shadowPolygonOffsetUnits
  ])
}
