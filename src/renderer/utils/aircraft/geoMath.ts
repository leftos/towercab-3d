/**
 * Geographic Math Utilities for Aircraft Calculations
 *
 * Pure functions for distance, bearing, and heading calculations.
 * Used by smart sort, flight phase detection, and other aircraft utilities.
 */

/**
 * Calculate distance between two points in nautical miles using Haversine formula
 */
export function haversineDistanceNm(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R = 3440.065 // Earth's radius in nautical miles
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

/**
 * Calculate distance in feet between two points
 */
export function haversineDistanceFt(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  return haversineDistanceNm(lat1, lon1, lat2, lon2) * 6076.12
}

/**
 * Calculate bearing from point 1 to point 2 in degrees
 */
export function calculateBearing(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const dLon = (lon2 - lon1) * Math.PI / 180
  const lat1Rad = lat1 * Math.PI / 180
  const lat2Rad = lat2 * Math.PI / 180

  const y = Math.sin(dLon) * Math.cos(lat2Rad)
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
            Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon)

  const bearing = Math.atan2(y, x) * 180 / Math.PI
  return (bearing + 360) % 360
}

/**
 * Normalize heading difference to -180 to +180
 */
export function headingDifference(h1: number, h2: number): number {
  let diff = h2 - h1
  while (diff > 180) diff -= 360
  while (diff < -180) diff += 360
  return diff
}
