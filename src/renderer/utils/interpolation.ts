/**
 * Interpolation utilities for smooth aircraft movement
 *
 * Uses physics-based prediction for natural flight simulation appearance.
 * Handles geographic coordinates (lat/lon/alt) with great-circle distance calculations.
 *
 * @see {@link ../docs/coordinate-systems.md#1-geographic-coordinates} for geographic coordinate system details
 * @see {@link ../docs/coordinate-systems.md#distance-calculations} for distance calculation implementation notes
 */

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
 * Calculate velocity vector in degrees per millisecond from heading and groundspeed
 * Returns {dLat, dLon} representing the velocity components
 */
export function headingToVelocity(
  headingDeg: number,
  groundspeedKnots: number,
  lat: number
): { dLat: number; dLon: number } {
  // Speed in degrees per millisecond
  const speedDegPerMs = groundspeedKnots * KNOTS_TO_NM_PER_MS * NM_TO_DEGREES_LAT

  const headingRad = headingDeg * Math.PI / 180
  const cosLat = Math.cos(lat * Math.PI / 180)

  return {
    dLat: speedDegPerMs * Math.cos(headingRad),
    dLon: cosLat > 0.001 ? (speedDegPerMs * Math.sin(headingRad)) / cosLat : 0
  }
}

/**
 * Cubic Hermite spline interpolation
 * Guarantees passing through both endpoints with specified tangents
 * Creates smooth C1-continuous curves with no discontinuities
 *
 * @param p0 - Start value
 * @param m0 - Start tangent (derivative * interval)
 * @param p1 - End value
 * @param m1 - End tangent (derivative * interval)
 * @param t - Interpolation factor [0, 1]
 */
export function hermite(p0: number, m0: number, p1: number, m1: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t

  // Hermite basis functions
  const h00 = 2 * t3 - 3 * t2 + 1  // Position weight at start
  const h10 = t3 - 2 * t2 + t       // Tangent weight at start
  const h01 = -2 * t3 + 3 * t2      // Position weight at end
  const h11 = t3 - t2               // Tangent weight at end

  return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1
}

/**
 * Interpolate position using Hermite splines for smooth curved paths
 * Guarantees arrival at the target position at t=1.0 with no jumps
 * Uses velocity vectors derived from heading and groundspeed as tangents
 */
export function hermiteInterpolatePosition(
  startLat: number,
  startLon: number,
  startHeading: number,
  startGroundspeed: number,
  endLat: number,
  endLon: number,
  endHeading: number,
  endGroundspeed: number,
  t: number,
  intervalMs: number
): { lat: number; lon: number; heading: number } {
  // Calculate velocity vectors at start and end points
  // Scale by interval to get tangent magnitude for Hermite interpolation
  const startVel = headingToVelocity(startHeading, startGroundspeed, startLat)
  const endVel = headingToVelocity(endHeading, endGroundspeed, endLat)

  // Tangent vectors scaled by interval (m0 and m1 in Hermite formula)
  const m0Lat = startVel.dLat * intervalMs
  const m0Lon = startVel.dLon * intervalMs
  const m1Lat = endVel.dLat * intervalMs
  const m1Lon = endVel.dLon * intervalMs

  // Hermite interpolation for position - guarantees smooth curve through both points
  const lat = hermite(startLat, m0Lat, endLat, m1Lat, t)
  const lon = hermite(startLon, m0Lon, endLon, m1Lon, t)

  // Smoothly interpolate heading
  const heading = lerpAngle(startHeading, endHeading, t)

  return { lat, lon, heading }
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
 * Calculate pitch and roll from physics for a given state
 * @param verticalRateFtPerMs Vertical rate in feet per millisecond
 * @param groundspeedKnots Groundspeed in knots
 * @param turnRateDegPerSec Turn rate in degrees per second
 * @param orientationIntensity Intensity multiplier (0.25 to 1.5)
 * @returns Pitch and roll in degrees
 */
function calculateOrientation(
  verticalRateFtPerMs: number,
  groundspeedKnots: number,
  turnRateDegPerSec: number,
  orientationIntensity: number
): { pitch: number; roll: number } {
  let pitch = 0
  let roll = 0

  // Pitch from flight path angle: γ = atan(vertical_velocity / horizontal_velocity)
  const verticalRateFps = verticalRateFtPerMs * 1000  // ft/ms to ft/sec
  const groundspeedFps = groundspeedKnots * 1.68781  // knots to ft/sec
  if (groundspeedFps > 10) {
    const rawPitch = Math.atan2(verticalRateFps, groundspeedFps) * (180 / Math.PI)
    pitch = Math.max(-15, Math.min(20, rawPitch * orientationIntensity))
  }

  // Roll from coordinated turn: bank = atan(V × ω / g)
  // Only apply roll when airborne (groundspeed > 40 knots)
  // Ground aircraft should only yaw without banking
  const velocityMs = groundspeedKnots * 0.514444  // knots to m/s
  const turnRateRad = turnRateDegPerSec * (Math.PI / 180)  // deg/s to rad/s
  const isLikelyAirborne = groundspeedKnots > 40  // Knots threshold for airborne detection
  if (velocityMs > 5 && isLikelyAirborne) {
    const rawRoll = Math.atan2(velocityMs * turnRateRad, 9.81) * (180 / Math.PI)
    roll = Math.max(-35, Math.min(35, rawRoll * orientationIntensity))
  }

  return { pitch, roll }
}

/**
 * Interpolate aircraft state between two snapshots using physics-based prediction
 *
 * For t <= 1.0 (interpolation):
 * - Uses Hermite spline interpolation for smooth curved paths
 * - Guarantees arrival at target position at t=1.0 (no jumps/warps)
 * - Velocity vectors from heading/groundspeed define curve tangents
 * - Uses smoothstep easing for altitude and speed changes
 *
 * For t > 1.0 (extrapolation/dead reckoning):
 * - Uses velocity-driven dead reckoning based on last known heading and speed
 * - Continues turn rate for consistent heading extrapolation
 * - Maintains aircraft momentum realistically
 *
 * Orientation emulation (when enabled):
 * - Pitch derived from vertical rate: γ = atan(vertical_velocity / horizontal_velocity)
 * - Roll derived from turn rate using coordinated flight: bank = atan(V × ω / g)
 * - Both pitch and roll are smoothly interpolated between updates for realistic motion
 *
 * @param previousVerticalRate Vertical rate from the previous segment (ft/ms) for smooth orientation transitions
 * @param previousTurnRate Turn rate from the previous segment (deg/sec) for smooth orientation transitions
 */
export function interpolateAircraftState(
  previous: AircraftState | undefined,
  current: AircraftState,
  now: number,
  orientationEnabled: boolean = true,
  orientationIntensity: number = 1.0,
  previousVerticalRate: number = 0,
  previousTurnRate: number = 0
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
      interpolatedPitch: 0,
      interpolatedRoll: 0,
      verticalRate: 0,
      turnRate: 0,
      isInterpolated: false
    }
  }

  const interval = current.timestamp - previous.timestamp
  const t = getInterpolationFactor(previous.timestamp, current.timestamp, now)

  // Calculate turn rate and vertical rate for this segment
  const turnRate = calculateTurnRate(previous.heading, current.heading, interval)
  const verticalRate = interval > 0 ? (current.altitude - previous.altitude) / interval : 0

  let interpolatedLat: number
  let interpolatedLon: number
  let interpolatedHeading: number
  let interpolatedAltitude: number
  let interpolatedGroundspeed: number

  // Check if previous and current positions are essentially the same
  // This happens when an aircraft first appears or data hasn't changed
  const positionDelta = Math.abs(previous.latitude - current.latitude) +
                        Math.abs(previous.longitude - current.longitude)
  const positionsAreSame = positionDelta < 0.00001 // ~1 meter

  if (positionsAreSame) {
    // When prev ≈ curr for lat/lon, skip Hermite (which produces weird results with tangents)
    // But ALWAYS interpolate altitude smoothly - aircraft can climb while stationary (takeoff roll)

    if (t <= 1.0) {
      // Use linear interpolation for altitude to maintain consistent climb/descent rate
      interpolatedAltitude = lerp(previous.altitude, current.altitude, t)
      interpolatedGroundspeed = lerp(previous.groundspeed, current.groundspeed, smoothstep(t))
      interpolatedHeading = lerpAngle(previous.heading, current.heading, t)
      interpolatedLat = current.latitude
      interpolatedLon = current.longitude
    } else {
      // Extrapolate from current position using dead reckoning
      const extrapolationMs = (t - 1.0) * interval

      // Continue altitude at the same vertical rate during extrapolation
      // Clamp to 0 to prevent extrapolating underground
      interpolatedAltitude = Math.max(0, current.altitude + verticalRate * extrapolationMs)
      interpolatedGroundspeed = current.groundspeed

      const stationaryTurnRate = calculateTurnRate(previous.heading, current.heading, interval)
      const turnDecay = Math.exp(-extrapolationMs / 10000)
      const extrapolatedTurnDeg = stationaryTurnRate * (extrapolationMs / 1000) * turnDecay
      interpolatedHeading = normalizeAngle(current.heading + extrapolatedTurnDeg)

      const avgExtrapolationHeading = lerpAngle(current.heading, interpolatedHeading, 0.5)
      const deadReckonedPos = deadReckonPosition(
        current.latitude,
        current.longitude,
        avgExtrapolationHeading,
        current.groundspeed,
        extrapolationMs
      )

      interpolatedLat = deadReckonedPos.lat
      interpolatedLon = deadReckonedPos.lon
    }
  } else if (t <= 1.0) {
    // INTERPOLATION PHASE (0 <= t <= 1.0)
    // Use Hermite spline interpolation for smooth curved paths
    // This guarantees we arrive at the target position at t=1.0 with no jumps

    // Get curved position and heading using Hermite splines
    const hermiteResult = hermiteInterpolatePosition(
      previous.latitude,
      previous.longitude,
      previous.heading,
      previous.groundspeed,
      current.latitude,
      current.longitude,
      current.heading,
      current.groundspeed,
      t,
      interval
    )

    interpolatedLat = hermiteResult.lat
    interpolatedLon = hermiteResult.lon
    interpolatedHeading = hermiteResult.heading

    // Use LINEAR interpolation for altitude to maintain consistent climb/descent rate
    // (smoothstep causes slowdown at ends which looks wrong for steady climbs/descents)
    interpolatedAltitude = lerp(previous.altitude, current.altitude, t)
    // Use smoothstep easing for speed (more natural acceleration/deceleration)
    interpolatedGroundspeed = lerp(previous.groundspeed, current.groundspeed, smoothstep(t))

  } else {
    // EXTRAPOLATION PHASE (t > 1.0) - Dead reckoning
    // Use heading and groundspeed to predict position

    // Time elapsed since we reached the "current" position (at t=1.0)
    // NOT total time since current.timestamp - that would cause a jump!
    const extrapolationMs = (t - 1.0) * interval

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

    // Continue altitude at the same vertical rate during extrapolation
    // This maintains smooth climbs/descents instead of stair-stepping
    // Clamp to 0 to prevent extrapolating underground
    interpolatedAltitude = Math.max(0, current.altitude + verticalRate * extrapolationMs)
    // Hold groundspeed at final value during extrapolation
    interpolatedGroundspeed = current.groundspeed
  }

  // Calculate pitch and roll from physics with smooth interpolation
  let pitch = 0
  let roll = 0

  if (orientationEnabled) {
    // Calculate orientation at START of interpolation period (t=0)
    // Use previous segment's physics (vertical rate and turn rate from before current segment)
    const prevOrientation = calculateOrientation(
      previousVerticalRate,
      previous.groundspeed,
      previousTurnRate,
      orientationIntensity
    )

    // Calculate orientation at END of interpolation period (t=1)
    // Use current segment's physics (vertical rate and turn rate for this segment)
    const currOrientation = calculateOrientation(
      verticalRate,
      current.groundspeed,
      turnRate,
      orientationIntensity
    )

    // Smoothly interpolate orientation synchronized with position
    // Orientation completes transition at the same time as position (when next VATSIM data arrives)
    const orientationSmoothingFactor = 1.0
    const tOrientation = Math.min(1.0, t / orientationSmoothingFactor)

    // Use smootherstep (even gentler than smoothstep) for very gradual transitions
    const easedT = smootherstep(tOrientation)
    pitch = lerp(prevOrientation.pitch, currOrientation.pitch, easedT)
    roll = lerp(prevOrientation.roll, currOrientation.roll, easedT)
  }

  return {
    ...current,
    interpolatedLatitude: interpolatedLat,
    interpolatedLongitude: interpolatedLon,
    interpolatedAltitude: interpolatedAltitude,
    interpolatedHeading: interpolatedHeading,
    interpolatedGroundspeed: interpolatedGroundspeed,
    interpolatedPitch: pitch,
    interpolatedRoll: roll,
    verticalRate: verticalRate * 60000,  // Convert ft/ms to ft/min
    turnRate: turnRate,
    isInterpolated: true
  }
}

/**
 * Calculate distance between two coordinates in nautical miles using haversine formula.
 *
 * If altitudes are provided (in feet MSL), calculates 3D slant range.
 * Otherwise calculates 2D great-circle surface distance.
 *
 * @param lat1 - First position latitude in degrees (geographic coordinates)
 * @param lon1 - First position longitude in degrees (geographic coordinates)
 * @param lat2 - Second position latitude in degrees (geographic coordinates)
 * @param lon2 - Second position longitude in degrees (geographic coordinates)
 * @param alt1Feet - Optional first position altitude in feet MSL
 * @param alt2Feet - Optional second position altitude in feet MSL
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
  alt1Feet?: number,
  alt2Feet?: number
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

  const horizontalDistanceNM = R * c

  // If altitudes provided, calculate 3D slant range
  if (alt1Feet !== undefined && alt2Feet !== undefined) {
    const altDiffFeet = alt2Feet - alt1Feet
    // Convert altitude difference to nautical miles (1 NM = 6076.12 feet)
    const altDiffNM = altDiffFeet / 6076.12
    return Math.sqrt(horizontalDistanceNM * horizontalDistanceNM + altDiffNM * altDiffNM)
  }

  return horizontalDistanceNM
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

