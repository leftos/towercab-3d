// Interpolation utilities for smooth aircraft movement

import type { AircraftState, InterpolatedAircraftState } from '../types/vatsim'

const UPDATE_INTERVAL = 15000 // 15 seconds in ms

/**
 * Linear interpolation between two values
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * Interpolate angle (heading) taking shortest path
 * Handles wrap-around at 360 degrees
 */
export function lerpAngle(a: number, b: number, t: number): number {
  // Normalize angles to 0-360
  a = ((a % 360) + 360) % 360
  b = ((b % 360) + 360) % 360

  // Find shortest path
  let diff = b - a
  if (diff > 180) diff -= 360
  if (diff < -180) diff += 360

  // Interpolate and normalize result
  const result = a + diff * t
  return ((result % 360) + 360) % 360
}

/**
 * Calculate interpolation factor based on elapsed time
 * Uses the actual interval between updates, not a constant
 * Returns unbounded factor - caller handles extrapolation (t > 1.0)
 */
export function getInterpolationFactor(
  previousTimestamp: number,
  currentTimestamp: number,
  now: number
): number {
  const elapsed = now - currentTimestamp
  const interval = currentTimestamp - previousTimestamp

  // If no previous state or invalid interval, don't interpolate
  if (interval <= 0) return 1

  // Return unbounded factor - allows seamless extrapolation beyond t=1.0
  return elapsed / interval
}

/**
 * Interpolate aircraft state between two snapshots
 * Uses constant-speed linear interpolation for smooth motion
 * Seamlessly extrapolates beyond t=1.0 until new data arrives
 * If no previous state, returns current state with isInterpolated=false
 */
export function interpolateAircraftState(
  previous: AircraftState | undefined,
  current: AircraftState,
  now: number
): InterpolatedAircraftState {
  // If no previous state, return current position without interpolation
  if (!previous) {
    return {
      ...current,
      interpolatedLatitude: current.latitude,
      interpolatedLongitude: current.longitude,
      interpolatedAltitude: current.altitude,
      interpolatedHeading: current.heading,
      interpolatedGroundspeed: current.groundspeed,
      isInterpolated: false
    }
  }

  // Calculate interpolation factor (unbounded - allows extrapolation)
  const t = getInterpolationFactor(previous.timestamp, current.timestamp, now)

  // Clamp t for altitude and heading (don't extrapolate these)
  const clampedT = Math.min(t, 1.0)

  // Linear interpolation for constant-speed motion
  // Position uses unbounded t for seamless extrapolation
  // Altitude, heading, and groundspeed use clamped t (hold at final value)
  return {
    ...current,
    interpolatedLatitude: lerp(previous.latitude, current.latitude, t),
    interpolatedLongitude: lerp(previous.longitude, current.longitude, t),
    interpolatedAltitude: lerp(previous.altitude, current.altitude, clampedT),
    interpolatedHeading: lerpAngle(previous.heading, current.heading, clampedT),
    interpolatedGroundspeed: lerp(previous.groundspeed, current.groundspeed, clampedT),
    isInterpolated: true
  }
}

/**
 * Calculate distance between two coordinates in nautical miles
 */
export function calculateDistanceNM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 3440.065 // Earth radius in nautical miles

  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) *
    Math.sin(dLon / 2)

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  return R * c
}

/**
 * Calculate bearing between two coordinates in degrees
 */
export function calculateBearing(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const dLon = (lon2 - lon1) * Math.PI / 180
  const lat1Rad = lat1 * Math.PI / 180
  const lat2Rad = lat2 * Math.PI / 180

  const y = Math.sin(dLon) * Math.cos(lat2Rad)
  const x =
    Math.cos(lat1Rad) * Math.sin(lat2Rad) -
    Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon)

  const bearing = Math.atan2(y, x) * 180 / Math.PI
  return ((bearing % 360) + 360) % 360
}
