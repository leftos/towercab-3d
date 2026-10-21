/**
 * The sun-elevation brightness curve shared by the imagery night darkening and the tower cab.
 *
 * One curve keeps the cab as dark as the ground around it: `useCesiumNightDarkening` writes it into
 * the base imagery layer's brightness and `useTowerModel` into the cab model's light colour and
 * image-based lighting factor.
 */

import {
  NIGHT_BRIGHTNESS_CIVIL,
  NIGHT_BRIGHTNESS_MIN,
  NIGHT_BRIGHTNESS_TWILIGHT,
  SUN_ELEVATION_CIVIL_TWILIGHT,
  SUN_ELEVATION_DAY,
  SUN_ELEVATION_NAUTICAL_TWILIGHT,
  SUN_ELEVATION_NIGHT,
} from '@/constants'

/**
 * Smooth interpolation between 0 and 1 as x moves from edge0 to edge1.
 *
 * @param edge0 - Value of x that maps to 0
 * @param edge1 - Value of x that maps to 1
 * @param x - Input value
 * @returns 0 at or below edge0, 1 at or above edge1, smooth in between
 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * Brightness for a sun elevation, through the twilight phases.
 *
 * - Day (sun above 0°): 1.0
 * - Civil twilight (0° to -6°): 1.0 to 0.6
 * - Nautical twilight (-6° to -12°): 0.6 to 0.3
 * - Astronomical twilight (-12° to -18°): 0.3 to the night floor
 * - Night (sun below -18°): the night floor, set by the intensity
 *
 * @param sunElevation - Sun elevation angle in degrees
 * @param intensity - Darkening intensity, 0.0 (no darkening) to 1.0 (darkest nights)
 * @returns Brightness from the night floor to 1.0
 */
export function nightBrightness(sunElevation: number, intensity: number): number {
  // intensity 0.0 gives a floor of 1.0 (no darkening), 1.0 gives NIGHT_BRIGHTNESS_MIN.
  const minBrightness = NIGHT_BRIGHTNESS_MIN + (1 - intensity) * (1.0 - NIGHT_BRIGHTNESS_MIN)

  if (sunElevation >= SUN_ELEVATION_DAY) {
    return 1.0
  }
  if (sunElevation > SUN_ELEVATION_CIVIL_TWILIGHT) {
    const t = smoothstep(SUN_ELEVATION_CIVIL_TWILIGHT, SUN_ELEVATION_DAY, sunElevation)
    return lerp(NIGHT_BRIGHTNESS_CIVIL, 1.0, t)
  }
  if (sunElevation > SUN_ELEVATION_NAUTICAL_TWILIGHT) {
    const t = smoothstep(SUN_ELEVATION_NAUTICAL_TWILIGHT, SUN_ELEVATION_CIVIL_TWILIGHT, sunElevation)
    return lerp(NIGHT_BRIGHTNESS_TWILIGHT, NIGHT_BRIGHTNESS_CIVIL, t)
  }
  if (sunElevation > SUN_ELEVATION_NIGHT) {
    const t = smoothstep(SUN_ELEVATION_NIGHT, SUN_ELEVATION_NAUTICAL_TWILIGHT, sunElevation)
    return lerp(minBrightness, NIGHT_BRIGHTNESS_TWILIGHT, t)
  }
  return minBrightness
}

/**
 * How bright the tower cab is lit, as a multiple of the scene's light.
 *
 * Follows the imagery darkening exactly: with night darkening off (or lighting off, which the
 * caller folds into `enabled`) or the sun elevation not yet known, the cab is lit like the scene.
 *
 * @param sunElevation - Sun elevation in degrees, or null before it is known
 * @param intensity - Night darkening intensity setting (0.0-1.0)
 * @param enabled - Whether night darkening applies (setting on and lighting on)
 * @returns Light factor from the night floor to 1.0
 */
export function cabNightFactor(sunElevation: number | null, intensity: number, enabled: boolean): number {
  if (!enabled || sunElevation === null) {
    return 1.0
  }
  return nightBrightness(sunElevation, intensity)
}
