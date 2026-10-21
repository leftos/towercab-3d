import { CLOUD_CEILING_COVERAGE_THRESHOLD, STATUTE_MILES_TO_METERS } from '@/constants'
import type { WeatherVisibilityConditions, WeatherVisibilityParams } from '@/types'

/**
 * Decides whether weather leaves an aircraft visible from the camera.
 *
 * Two rules hide an aircraft, each behind its own toggle:
 * - Surface visibility: the aircraft is farther than the METAR visibility
 *   (statute miles × `visibilityScale`). An aircraft exactly at that distance stays visible.
 * - Cloud ceiling: a layer with coverage at or above BKN lies strictly between the
 *   camera and aircraft altitudes. A layer exactly at either altitude does not hide it.
 *   Skipped in top-down view.
 *
 * Args:
 *   conditions: Weather state and toggles, shared by every aircraft in one pass.
 *   geometry: Camera and aircraft heights above ground, like the METAR cloud bases, and the
 *     horizontal distance between them, all in meters. `useAircraftFiltering` currently
 *     passes sea-level heights instead (known issue, tracked separately).
 *
 * Returns:
 *   True when the aircraft is visible, false when weather hides it.
 */
export function isVisibleThroughWeather(
  conditions: WeatherVisibilityConditions,
  geometry: WeatherVisibilityParams,
): boolean {
  if (!conditions.showWeatherEffects) return true
  if (isBeyondVisibility(conditions, geometry.horizontalDistanceMeters)) return false
  if (isBehindCeiling(conditions, geometry.cameraAltitudeMeters, geometry.aircraftAltitudeMeters)) return false
  return true
}

function isBeyondVisibility(conditions: WeatherVisibilityConditions, horizontalDistanceMeters: number): boolean {
  if (conditions.visibilityStatuteMiles === null || !conditions.cullBeyondVisibility) return false
  const visibilityMeters = conditions.visibilityStatuteMiles * STATUTE_MILES_TO_METERS * conditions.visibilityScale
  return horizontalDistanceMeters > visibilityMeters
}

function isBehindCeiling(
  conditions: WeatherVisibilityConditions,
  cameraAltitudeMeters: number,
  aircraftAltitudeMeters: number,
): boolean {
  if (!conditions.showClouds || conditions.isTopDownView) return false
  const lowerAlt = Math.min(cameraAltitudeMeters, aircraftAltitudeMeters)
  const higherAlt = Math.max(cameraAltitudeMeters, aircraftAltitudeMeters)
  return conditions.cloudLayers.some(
    (layer) =>
      layer.coverage >= CLOUD_CEILING_COVERAGE_THRESHOLD && layer.altitude > lowerAlt && layer.altitude < higherAlt,
  )
}
