import { create } from 'zustand'
import type { WeatherStageCameraOverride, WeatherStageTestAircraft } from '@/types'

/**
 * Non-persisted, dev-only drive aids of the Cesium cloud and fog stage.
 *
 * `cameraOverride` and `testAircraft` are set only from
 * `window.__tc3d.weatherStage` in dev builds; each window (and each inset
 * iframe) has its own copy, and nothing is saved.
 */
interface WeatherStageState {
  cameraOverride: WeatherStageCameraOverride | null
  testAircraft: WeatherStageTestAircraft | null
}

export const useWeatherStageStore = create<WeatherStageState>(() => ({
  cameraOverride: null,
  testAircraft: null,
}))
