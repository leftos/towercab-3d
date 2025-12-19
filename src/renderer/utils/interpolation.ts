// Interpolation utilities for smooth aircraft movement
// Uses physics-based prediction for natural flight simulation appearance

import type { AircraftState, InterpolatedAircraftState } from '../types/vatsim'

// Constants for physics-based interpolation
const NM_TO_DEGREES_LAT = 1 / 60 // 1 NM = 1/60 degree latitude
const KNOTS_TO_NM_PER_MS = 1 / 3600000 // Convert knots to NM/ms

// Turn rate constants
const MAX_TURN_RATE_DEG_PER_SEC = 6 // Maximum realistic turn rate

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
 * Smoother easing function (smootherstep) for even more natural motion
 */
export function smootherstep(t: number): number {
  const clamped = Math.max(0, Math.min(1, t))
  return clamped * clamped * clamped * (clamped * (clamped * 6 - 15) + 10)
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
 * Interpolate angle (heading) taking shortest path
 * Handles wrap-around at 360 degrees
 */
export function lerpAngle(a: number, b: number, t: number): number {
  const diff = angleDifference(a, b)
  const result = a + diff * t
  return normalizeAngle(result)
}

/**
 * Calculate rate of turn in degrees per second
 * Based on heading change over the interval
 */
export function calculateTurnRate(
  headingFrom: number,
  headingTo: number,
  intervalMs: number
): number {
  if (intervalMs <= 0) return 0
  const headingChange = angleDifference(headingFrom, headingTo)
  const turnRate = (headingChange / intervalMs) * 1000 // deg/sec
  // Clamp to realistic limits
  return Math.max(-MAX_TURN_RATE_DEG_PER_SEC, Math.min(MAX_TURN_RATE_DEG_PER_SEC, turnRate))
}

/**
 * Calculate new position using dead reckoning from heading and groundspeed
 * Uses great circle approximation for short distances
 */
export function deadReckonPosition(
  lat: number,
  lon: number,
  headingDeg: number,
  groundspeedKnots: number,
  durationMs: number
): { lat: number; lon: number } {
  // Distance traveled in nautical miles
  const distanceNM = groundspeedKnots * KNOTS_TO_NM_PER_MS * durationMs

  // Convert to radians
  const headingRad = headingDeg * Math.PI / 180
  const latRad = lat * Math.PI / 180

  // Calculate displacement in degrees
  // North component (latitude change)
  const dLat = distanceNM * Math.cos(headingRad) * NM_TO_DEGREES_LAT

  // East component (longitude change) - adjusted for latitude
  const cosLat = Math.cos(latRad)
  const dLon = cosLat > 0.001
    ? (distanceNM * Math.sin(headingRad) * NM_TO_DEGREES_LAT) / cosLat
    : 0

  return {
    lat: lat + dLat,
    lon: lon + dLon
  }
}

/**
 * Interpolate position along a curved arc for turning aircraft
 * Uses circular arc approximation based on turn rate
 */
export function arcInterpolatePosition(
  startLat: number,
  startLon: number,
  startHeading: number,
  endLat: number,
  endLon: number,
  endHeading: number,
  groundspeed: number,
  t: number,
  intervalMs: number
): { lat: number; lon: number; heading: number } {
  const headingChange = angleDifference(startHeading, endHeading)

  // If minimal turn (< 5 degrees), use simple linear interpolation
  if (Math.abs(headingChange) < 5) {
    return {
      lat: lerp(startLat, endLat, t),
      lon: lerp(startLon, endLon, t),
      heading: lerpAngle(startHeading, endHeading, t)
    }
  }

  // For significant turns, use arc interpolation
  // The heading changes linearly through the turn
  const currentHeading = lerpAngle(startHeading, endHeading, t)

  // For arc interpolation, we trace the path by integrating heading
  // Using midpoint heading between start and current for better arc approximation
  const avgHeading = lerpAngle(startHeading, currentHeading, 0.5)

  // Calculate position using the average heading over the arc segment
  // This produces a smooth curved path that follows the turn
  const pos = deadReckonPosition(startLat, startLon, avgHeading, groundspeed, intervalMs * t)

  return {
    lat: pos.lat,
    lon: pos.lon,
    heading: currentHeading
  }
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
 * Interpolate aircraft state between two snapshots using physics-based prediction
 *
 * For t <= 1.0 (interpolation):
 * - Uses arc interpolation for turning aircraft (curved flight paths)
 * - Uses smoothstep easing for altitude and speed changes
 * - Produces natural, flight-sim-like motion
 *
 * For t > 1.0 (extrapolation/dead reckoning):
 * - Uses velocity-driven dead reckoning based on last known heading and speed
 * - Continues turn rate for consistent heading extrapolation
 * - Maintains aircraft momentum realistically
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

  const interval = current.timestamp - previous.timestamp
  const t = getInterpolationFactor(previous.timestamp, current.timestamp, now)

  // Calculate turn rate for this segment
  const turnRate = calculateTurnRate(previous.heading, current.heading, interval)

  let interpolatedLat: number
  let interpolatedLon: number
  let interpolatedHeading: number
  let interpolatedAltitude: number
  let interpolatedGroundspeed: number

  if (t <= 1.0) {
    // INTERPOLATION PHASE (0 <= t <= 1.0)
    // Use arc interpolation for smooth curved paths during turns

    // Average groundspeed for the segment
    const avgGroundspeed = (previous.groundspeed + current.groundspeed) / 2

    // Get curved position and heading
    const arcResult = arcInterpolatePosition(
      previous.latitude,
      previous.longitude,
      previous.heading,
      current.latitude,
      current.longitude,
      current.heading,
      avgGroundspeed,
      t,
      interval
    )

    interpolatedLat = arcResult.lat
    interpolatedLon = arcResult.lon
    interpolatedHeading = arcResult.heading

    // Use smoothstep easing for altitude and speed (more natural acceleration)
    const easedT = smoothstep(t)
    interpolatedAltitude = lerp(previous.altitude, current.altitude, easedT)
    interpolatedGroundspeed = lerp(previous.groundspeed, current.groundspeed, easedT)

  } else {
    // EXTRAPOLATION PHASE (t > 1.0) - Dead reckoning
    // Use heading and groundspeed to predict position

    // Time elapsed since we reached the "current" position
    const extrapolationMs = now - current.timestamp

    // Continue the turn at the same rate (decaying slightly over time)
    // This prevents sudden heading stops and makes turns look natural
    const turnDecay = Math.exp(-extrapolationMs / 10000) // Decay over ~10 seconds
    const extrapolatedTurnDeg = turnRate * (extrapolationMs / 1000) * turnDecay
    interpolatedHeading = normalizeAngle(current.heading + extrapolatedTurnDeg)

    // Use average heading during extrapolation for smoother arcs
    const avgExtrapolationHeading = lerpAngle(current.heading, interpolatedHeading, 0.5)

    // Dead reckon position from last known position using heading and speed
    const deadReckonedPos = deadReckonPosition(
      current.latitude,
      current.longitude,
      avgExtrapolationHeading,
      current.groundspeed,
      extrapolationMs
    )

    interpolatedLat = deadReckonedPos.lat
    interpolatedLon = deadReckonedPos.lon

    // Hold altitude and groundspeed at final values during extrapolation
    // (We don't have good prediction for these)
    interpolatedAltitude = current.altitude
    interpolatedGroundspeed = current.groundspeed
  }

  return {
    ...current,
    interpolatedLatitude: interpolatedLat,
    interpolatedLongitude: interpolatedLon,
    interpolatedAltitude: interpolatedAltitude,
    interpolatedHeading: interpolatedHeading,
    interpolatedGroundspeed: interpolatedGroundspeed,
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
