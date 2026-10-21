import { create } from 'zustand'
import type { WeatherRenderer, WeatherStageCameraOverride, WeatherStageTestAircraft } from '@/types'

/**
 * Non-persisted switch between the Cesium cloud and fog stage and the Babylon
 * fog dome and cloud meshes, plus the dev-only drive aids of the stage.
 *
 * `renderer` decides which of the two draws clouds and fog, so they are never
 * drawn twice; it starts at `'cesium'` in every window (each inset iframe has
 * its own copy) and is not saved. `cameraOverride` and `testAircraft` are set
 * only from `window.__tc3d.weatherStage` in dev builds.
 */
interface WeatherStageState {
  renderer: WeatherRenderer
  cameraOverride: WeatherStageCameraOverride | null
  testAircraft: WeatherStageTestAircraft | null
}

export const useWeatherStageStore = create<WeatherStageState>(() => ({
  renderer: 'cesium',
  cameraOverride: null,
  testAircraft: null,
}))
