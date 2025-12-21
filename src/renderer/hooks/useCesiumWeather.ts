import { useEffect } from 'react'
import type { Viewer } from 'cesium'

/**
 * Manages METAR-based weather effects for Cesium rendering
 *
 * ## Responsibilities
 * - Apply fog based on METAR visibility data
 * - Adjust terrain draw distance in low visibility conditions
 * - Coordinate with Babylon fog dome for immersive weather
 *
 * ## Fog System
 * Cesium fog affects:
 * - **Terrain fade distance**: Lower visibility = closer fade
 * - **Visual density**: Scales fog appearance based on METAR
 * - **Performance**: Increases screen space error in fog for faster rendering
 * - **Brightness**: Prevents fog from being too dark
 *
 * ## Fog Density Scale
 * - METAR 1/4 SM (400m): fogDensity ~0.015 (very dense fog, LIFR)
 * - METAR 1 SM (1600m): fogDensity ~0.006 (dense fog, IFR)
 * - METAR 3 SM (4800m): fogDensity ~0.002 (moderate fog, MVFR)
 * - METAR 10+ SM: fogDensity ~0 (clear, VFR)
 *
 * ## Visual Density Scalar
 * Controls fog appearance intensity:
 * - 0.15 (default): Light fog, subtle effect
 * - 1.0 (max): Dense fog, dramatic effect
 * - Automatically scaled based on METAR fog density
 *
 * ## Dependencies
 * - Requires: weatherStore for fog density from METAR
 * - Requires: settingsStore for weather effect toggles
 * - Coordinates with: useBabylonOverlay for fog dome rendering
 *
 * @param viewer - Initialized Cesium.Viewer instance
 * @param showWeatherEffects - Global weather effects toggle
 * @param showCesiumFog - Cesium-specific fog toggle
 * @param fogDensity - Fog density from METAR visibility (0 to ~0.015)
 *
 * @example
 * ```tsx
 * const viewer = useCesiumViewer(...)
 * const fogDensity = useWeatherStore(state => state.fogDensity)
 * const showWeatherEffects = useSettingsStore(state => state.showWeatherEffects)
 * const showCesiumFog = useSettingsStore(state => state.showCesiumFog)
 *
 * useCesiumWeather(viewer, showWeatherEffects, showCesiumFog, fogDensity)
 * ```
 */
export function useCesiumWeather(
  viewer: Viewer | null,
  showWeatherEffects: boolean,
  showCesiumFog: boolean,
  fogDensity: number
) {
  // Update Cesium fog based on weather effects and METAR visibility
  // Cesium fog primarily reduces draw distance and fades terrain/imagery
  useEffect(() => {
    if (!viewer) return

    const shouldShowFog = showWeatherEffects && showCesiumFog
    viewer.scene.fog.enabled = shouldShowFog

    if (shouldShowFog && fogDensity > 0) {
      // Apply fog density from METAR visibility
      // fogDensity ranges from ~0.015 (1/4 SM) to ~0 (10+ SM)
      viewer.scene.fog.density = fogDensity

      // visualDensityScalar controls the visual appearance of fog (default 0.15)
      // Scale it based on fog density for more dramatic effect in low visibility
      // Range from 0.15 (light fog) to 1.0 (very dense fog)
      const visualScalar = Math.min(1.0, 0.15 + (fogDensity / 0.015) * 0.85)
      viewer.scene.fog.visualDensityScalar = visualScalar

      // Increase screen space error factor in fog for better performance
      viewer.scene.fog.screenSpaceErrorFactor = 2.0

      // Prevent fog from being too dark
      viewer.scene.fog.minimumBrightness = 0.1
    } else {
      // Reset to default fog settings when no weather effects
      viewer.scene.fog.density = 0.0006 // Cesium default
      viewer.scene.fog.visualDensityScalar = 0.15 // Cesium default
      viewer.scene.fog.screenSpaceErrorFactor = 2.0
      viewer.scene.fog.minimumBrightness = 0.03 // Cesium default
    }
  }, [viewer, showWeatherEffects, showCesiumFog, fogDensity])
}
