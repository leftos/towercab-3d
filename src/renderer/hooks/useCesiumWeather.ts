import type { Viewer } from 'cesium'
import { useEffect } from 'react'
import { sceneFogValues } from '@/utils/weatherStage'

/**
 * Manages Cesium's own scene fog from METAR weather data
 *
 * ## Responsibilities
 * - Turn the scene's fog on and off with the weather toggles
 * - Tune the fog from METAR visibility while the Cesium weather stage draws no
 *   fog, and hold it at Cesium's defaults while the stage fogs the scene
 * - Adjust terrain draw distance in low visibility conditions
 *
 * ## Fog System
 * Cesium fog affects:
 * - **Terrain fade distance**: Lower visibility = closer fade
 * - **Visual density**: Scales fog appearance based on METAR
 * - **Performance**: Increases screen space error in fog for faster rendering
 * - **Brightness**: Prevents fog from being too dark
 *
 * The weather stage (`useCesiumWeatherStages`) fogs the scene in its composite
 * pass from the same METAR visibility; while it does, the scene's fog stays at
 * Cesium's defaults so the terrain is not fogged twice.
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
 * - Takes: whether the Cesium weather stage draws the fog itself
 *
 * @param viewer - Initialized Cesium.Viewer instance
 * @param showWeatherEffects - Global weather effects toggle
 * @param showCesiumFog - Cesium-specific fog toggle
 * @param fogDensity - Fog density from METAR visibility (0 to ~0.015)
 * @param stageDrawsFog - Whether the Cesium weather stage is drawing the fog now
 *   (its fog gate on and an anchor frame); while it is not, this hook keeps
 *   tuning the scene's fog from METAR visibility
 *
 * @example
 * ```tsx
 * const viewer = useCesiumViewer(...)
 * const fogDensity = useWeatherStore(state => state.fogDensity)
 * const showWeatherEffects = useSettingsStore(state => state.showWeatherEffects)
 * const showCesiumFog = useSettingsStore(state => state.showCesiumFog)
 *
 * useCesiumWeather(viewer, showWeatherEffects, showCesiumFog, fogDensity, stageDrawsFog)
 * ```
 */
export function useCesiumWeather(
  viewer: Viewer | null,
  showWeatherEffects: boolean,
  showCesiumFog: boolean,
  fogDensity: number,
  stageDrawsFog: boolean,
) {
  // Update Cesium's own scene fog; it mostly reduces draw distance and fades terrain/imagery
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return

    const values = sceneFogValues({
      fogEnabled: showWeatherEffects && showCesiumFog,
      fogDensity,
      stageDrawsFog,
    })
    viewer.scene.fog.enabled = values.enabled
    viewer.scene.fog.density = values.density
    viewer.scene.fog.visualDensityScalar = values.visualDensityScalar
    viewer.scene.fog.screenSpaceErrorFactor = values.screenSpaceErrorFactor
    viewer.scene.fog.minimumBrightness = values.minimumBrightness
  }, [viewer, showWeatherEffects, showCesiumFog, fogDensity, stageDrawsFog])
}
