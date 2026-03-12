/**
 * Geographic math utilities for distance, bearing, and angle calculations
 *
 * @see {@link ../docs/coordinate-systems.md#1-geographic-coordinates} for geographic coordinate system details
 * @see {@link ../docs/coordinate-systems.md#distance-calculations} for distance calculation implementation notes
 */

import {
  FLARE_START_ALTITUDE_METERS,
  FLARE_END_ALTITUDE_METERS,
  FLARE_TARGET_PITCH_DEGREES,
  FLARE_MIN_DESCENT_RATE,
  GROUNDSPEED_THRESHOLD_KNOTS,
} from '../constants/rendering'

/**
 * Linear interpolation between two values
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * Smooth easing function (smoothstep) for natural acceleration/deceleration
 * Creates smooth S-curve transition instead of linear
 */
export function smoothstep(t: number): number {
  const clamped = Math.max(0, Math.min(1, t))
  return clamped * clamped * (3 - 2 * clamped)
}

/**
 * Normalize angle to 0-360 range
 */
export function normalizeAngle(angle: number): number {
  return ((angle % 360) + 360) % 360
}

/**
 * Calculate shortest angular difference between two headings
 * Returns value in range [-180, 180]
 */
export function angleDifference(from: number, to: number): number {
  const a = normalizeAngle(from)
  const b = normalizeAngle(to)
  let diff = b - a
  if (diff > 180) diff -= 360
  if (diff < -180) diff += 360
  return diff
}

/**
 * Linear interpolation between two angles, handling 0↔360° wrapping
 * Takes the shortest path around the circle
 *
 * @param from - Start angle in degrees
 * @param to - Target angle in degrees
 * @param t - Interpolation factor (0 = from, 1 = to)
 * @returns Interpolated angle normalized to 0-360
 */
export function lerpAngle(from: number, to: number, t: number): number {
  const diff = angleDifference(from, to)
  return normalizeAngle(from + diff * t)
}

/**
 * Calculate flare pitch adjustment for landing aircraft
 *
 * When an aircraft is descending and close to the ground, pilots perform a
 * "flare" maneuver - pitching the nose up to reduce descent rate before touchdown.
 * This function emulates that behavior by gradually transitioning from the
 * flight path angle (negative pitch during descent) toward a nose-up attitude.
 *
 * @param basePitch - Pitch calculated from flight path angle (degrees)
 * @param altitudeAGL - Altitude above ground level in meters (null if unknown)
 * @param verticalRate - Vertical rate in m/min (negative = descending)
 * @param groundspeedKnots - Current groundspeed in knots
 * @param orientationIntensity - Intensity multiplier from settings (0.25 to 1.5)
 * @returns Adjusted pitch in degrees
 */
export function calculateFlarePitch(
  basePitch: number,
  altitudeAGL: number | null,
  verticalRate: number,
  groundspeedKnots: number,
  orientationIntensity: number,
): number {
  // Cannot calculate flare without AGL data
  if (altitudeAGL === null) return basePitch

  // Check flare conditions:
  // 1. Must be descending (negative vertical rate beyond threshold)
  // 2. Must be in the flare zone (below start altitude, above ground)
  // 3. Must be airborne (above groundspeed threshold)
  const isDescending = verticalRate < FLARE_MIN_DESCENT_RATE
  const inFlareZone = altitudeAGL > 0 && altitudeAGL < FLARE_START_ALTITUDE_METERS
  const isAirborne = groundspeedKnots >= GROUNDSPEED_THRESHOLD_KNOTS

  if (!isDescending || !inFlareZone || !isAirborne) {
    return basePitch
  }

  // Calculate flare progress (0 = start of flare, 1 = full flare at touchdown)
  // Progress increases as altitude decreases
  const range = FLARE_START_ALTITUDE_METERS - FLARE_END_ALTITUDE_METERS
  const distanceFromEnd = altitudeAGL - FLARE_END_ALTITUDE_METERS
  const flareProgress = Math.max(0, Math.min(1, 1 - distanceFromEnd / range))

  // Apply smoothstep easing for natural transition
  const easedProgress = smoothstep(flareProgress)

  // Adjust target pitch based on descent rate
  // Steeper approaches (more negative vertical rate) require more aggressive flares
  // Typical approach: -200 to -400 m/min (-650 to -1300 fpm)
  // Steep approach: -400 to -600 m/min (-1300 to -2000 fpm)
  const descentMagnitude = Math.abs(verticalRate)
  const descentFactor = Math.min(1.5, descentMagnitude / 300) // 1.0 at 300 m/min, max 1.5
  const targetPitch = FLARE_TARGET_PITCH_DEGREES * descentFactor * orientationIntensity

  // Clamp target pitch to realistic maximum (12 degrees)
  const clampedTargetPitch = Math.min(targetPitch, 12)

  // Blend from current pitch toward target flare pitch
  return lerp(basePitch, clampedTargetPitch, easedProgress)
}

/**
 * Calculate distance between two coordinates in nautical miles using haversine formula.
 *
 * If altitudes are provided (in meters MSL), calculates 3D slant range.
 * Otherwise calculates 2D great-circle surface distance.
 *
 * @param lat1 - First position latitude in degrees (geographic coordinates)
 * @param lon1 - First position longitude in degrees (geographic coordinates)
 * @param lat2 - Second position latitude in degrees (geographic coordinates)
 * @param lon2 - Second position longitude in degrees (geographic coordinates)
 * @param alt1Meters - Optional first position altitude in meters MSL
 * @param alt2Meters - Optional second position altitude in meters MSL
 * @returns Distance in nautical miles
 *
 * @see {@link ../docs/coordinate-systems.md#1-geographic-coordinates} for geographic coordinate system
 * @see {@link ../docs/coordinate-systems.md#distance-calculations} for implementation notes
 */
export function calculateDistanceNM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  alt1Meters?: number,
  alt2Meters?: number,
): number {
  const R = 3440.065 // Earth radius in nautical miles

  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2)

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  const horizontalDistanceNM = R * c

  // If altitudes provided, calculate 3D slant range
  if (alt1Meters !== undefined && alt2Meters !== undefined) {
    const altDiffMeters = alt2Meters - alt1Meters
    // Convert altitude difference to nautical miles (1 NM = 1852 meters)
    const altDiffNM = altDiffMeters / 1852
    return Math.sqrt(horizontalDistanceNM * horizontalDistanceNM + altDiffNM * altDiffNM)
  }

  return horizontalDistanceNM
}

/**
 * Calculate bearing between two coordinates in degrees
 */
export function calculateBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const lat1Rad = (lat1 * Math.PI) / 180
  const lat2Rad = (lat2 * Math.PI) / 180

  const y = Math.sin(dLon) * Math.cos(lat2Rad)
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon)

  const bearing = (Math.atan2(y, x) * 180) / Math.PI
  return ((bearing % 360) + 360) % 360
}
