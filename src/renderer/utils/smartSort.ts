/**
 * Smart Sort Algorithm for Tower Controller Aircraft List
 *
 * Prioritizes aircraft based on operational urgency for tower controllers.
 * Aircraft on short final or departing need immediate attention,
 * while parked aircraft at gates are low priority.
 *
 * Priority Score = Base Phase Score + Distance Modifier + Speed Modifier
 *
 * Score Ranges (higher = more urgent):
 * - Critical (900-1000): Short final, departure roll
 * - High (600-899): Approach, holding short, lined up
 * - Medium (300-599): Taxiing, pattern work
 * - Low (0-299): Parked, distant, departing climb
 */

import type { Runway } from '../types/airport'
import type { InterpolatedAircraftState } from '../types/vatsim'

// ============================================================================
// TYPES
// ============================================================================

/** Detected phase of flight for an aircraft */
export type FlightPhase =
  | 'short_final'      // < 2nm from threshold, aligned, descending
  | 'long_final'       // 2-6nm from threshold, aligned, descending
  | 'departure_roll'   // On runway, accelerating, departing from this airport
  | 'landing_roll'     // On runway, decelerating, arriving at this airport
  | 'go_around'        // Was on approach, now climbing - missed approach
  | 'lined_up'         // On runway, stationary
  | 'holding_short'    // Near runway, stopped
  | 'pattern'          // In traffic pattern
  | 'pushback'         // Moving backwards from gate (track opposite to heading)
  | 'active_taxi'      // Moving on ground, not on runway
  | 'stopped_taxi'     // Stopped on ground (ramp, taxiway, gate)
  | 'departing_climb'  // Airborne, climbing, heading away
  | 'distant_arrival'  // Airborne, > 6nm, inbound
  | 'unknown'          // Cannot determine phase

/** Priority tier for UI grouping */
export type PriorityTier = 'critical' | 'high' | 'medium' | 'low'

/** Result of smart sort scoring */
export interface SmartSortResult {
  callsign: string
  phase: FlightPhase
  tier: PriorityTier
  score: number
  /** Runway the aircraft is associated with (if any) */
  runway: string | null
  /** Distance to nearest runway threshold in nm */
  runwayDistance: number | null
}

/** Airport context for smart sort calculations */
export interface SmartSortContext {
  /** Airport latitude */
  airportLat: number
  /** Airport longitude */
  airportLon: number
  /** Airport elevation in feet MSL */
  airportElevationFt: number
  /** Available runways with threshold coordinates */
  runways: Runway[]
  /** Airport ICAO code */
  icao: string
}

// ============================================================================
// CONSTANTS
// ============================================================================

// Base phase scores
const PHASE_SCORES: Record<FlightPhase, number> = {
  go_around: 550,      // Missed approach - highest priority, unexpected event
  short_final: 500,
  departure_roll: 450,
  landing_roll: 425,   // Just landed, still on runway - high priority
  long_final: 400,
  lined_up: 350,
  holding_short: 300,
  pattern: 250,
  pushback: 125,       // Pushing back - will need to taxi soon
  active_taxi: 150,
  stopped_taxi: 50,    // Stopped on ramp/taxiway/gate - lowest ground priority
  distant_arrival: 100,
  departing_climb: 75,
  unknown: 25
}

// Thresholds
const SHORT_FINAL_NM = 2
const LONG_FINAL_NM = 6
const PATTERN_ALTITUDE_FT = 2000  // Typical patterns are 1000-1500ft AGL, use 2000 for margin
const PATTERN_DISTANCE_NM = 5
const GROUND_ALTITUDE_AGL_FT = 300
const PUSHBACK_MAX_SPEED_KTS = 8  // Pushback is typically 2-5 kts
const STOPPED_SPEED_KTS = 1       // Below 1 kt is truly stopped
const RUNWAY_ALIGNMENT_DEG = 25  // Generous for wind correction/crab angle
const HOLDING_SHORT_DISTANCE_FT = 500
const RUNWAY_WIDTH_BUFFER_FT = 150
// Descent rate threshold - typical approach is 500-700fpm, landing flare is 100-200fpm
// Use -200fpm to avoid false positives from level flight altitude corrections (±50fpm)
const DESCENDING_THRESHOLD_FPM = -200
const CLIMBING_THRESHOLD_FPM = 200
// Go-around detection: must be climbing aggressively near runway
const GO_AROUND_CLIMB_FPM = 500
const GO_AROUND_DISTANCE_NM = 3
const GO_AROUND_HISTORY_MS = 30000  // Look back 30 seconds for approach phase

// ============================================================================
// PHASE HISTORY TRACKING (for go-around detection)
// ============================================================================

interface PhaseHistoryEntry {
  phase: FlightPhase
  timestamp: number
}

// Track recent phase history per aircraft (for detecting approach → climb transitions)
const phaseHistory = new Map<string, PhaseHistoryEntry[]>()

/**
 * Record a phase observation for an aircraft
 */
function recordPhase(callsign: string, phase: FlightPhase): void {
  const now = Date.now()
  const history = phaseHistory.get(callsign) || []

  // Add new entry
  history.push({ phase, timestamp: now })

  // Prune old entries (keep last 60 seconds)
  const cutoff = now - 60000
  const pruned = history.filter(entry => entry.timestamp > cutoff)

  phaseHistory.set(callsign, pruned)
}

/**
 * Check if aircraft was recently on approach or landing roll
 * (for go-around / balked landing detection)
 */
function wasRecentlyOnApproach(callsign: string): boolean {
  const history = phaseHistory.get(callsign)
  if (!history) return false

  const cutoff = Date.now() - GO_AROUND_HISTORY_MS
  return history.some(entry =>
    entry.timestamp > cutoff &&
    (entry.phase === 'short_final' || entry.phase === 'long_final' || entry.phase === 'landing_roll')
  )
}

/**
 * Clean up stale entries from phase history (call periodically)
 */
export function cleanupPhaseHistory(): void {
  const now = Date.now()
  const cutoff = now - 120000 // Remove aircraft not seen in 2 minutes

  for (const [callsign, history] of phaseHistory.entries()) {
    const latestEntry = history[history.length - 1]
    if (!latestEntry || latestEntry.timestamp < cutoff) {
      phaseHistory.delete(callsign)
    }
  }
}

/**
 * Clear all phase history (call when switching airports to prevent memory leaks)
 */
export function clearPhaseHistory(): void {
  phaseHistory.clear()
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Calculate distance between two points in nautical miles
 */
function haversineDistanceNm(
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
function haversineDistanceFt(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  return haversineDistanceNm(lat1, lon1, lat2, lon2) * 6076.12
}

/**
 * Calculate bearing from point 1 to point 2 in degrees
 */
function calculateBearing(
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
function headingDifference(h1: number, h2: number): number {
  let diff = h2 - h1
  while (diff > 180) diff -= 360
  while (diff < -180) diff += 360
  return diff
}

/**
 * Check if aircraft heading is aligned with runway (within tolerance)
 */
function isAlignedWithRunway(
  aircraftHeading: number,
  runwayHeading: number,
  tolerance: number = RUNWAY_ALIGNMENT_DEG
): boolean {
  const diff = Math.abs(headingDifference(aircraftHeading, runwayHeading))
  return diff <= tolerance
}

/**
 * Check if aircraft is inbound to a runway threshold
 */
function isInboundToThreshold(
  aircraftLat: number, aircraftLon: number,
  aircraftHeading: number,
  thresholdLat: number, thresholdLon: number
): boolean {
  const bearingToThreshold = calculateBearing(
    aircraftLat, aircraftLon,
    thresholdLat, thresholdLon
  )
  const diff = Math.abs(headingDifference(aircraftHeading, bearingToThreshold))
  return diff <= 30 // Within 30 degrees of heading toward threshold
}

/**
 * Check if aircraft is likely on a runway surface.
 *
 * This uses a simplified geometric approximation for performance:
 * 1. First checks if aircraft is within runway length of both thresholds
 *    (ensures aircraft is roughly "between" the two ends)
 * 2. Then calculates lateral distance from centerline using bearing math
 *
 * Note: This approximation may include areas slightly beyond thresholds
 * (overrun/stopway areas) which is acceptable for tower controller purposes
 * since aircraft in those areas are still operationally "on the runway".
 *
 * A more precise algorithm would use point-in-polygon with runway corners,
 * but the haversine + bearing approach is faster for real-time use.
 */
function isOnRunway(
  aircraftLat: number, aircraftLon: number,
  runway: Runway
): boolean {
  const distToLow = haversineDistanceFt(
    aircraftLat, aircraftLon,
    runway.lowEnd.lat, runway.lowEnd.lon
  )
  const distToHigh = haversineDistanceFt(
    aircraftLat, aircraftLon,
    runway.highEnd.lat, runway.highEnd.lon
  )

  // Check if aircraft is roughly between thresholds
  // Must be within runway length distance from both ends
  const runwayLengthFt = runway.lengthFt || 10000
  if (distToLow > runwayLengthFt || distToHigh > runwayLengthFt) {
    return false
  }

  // Calculate lateral (perpendicular) distance from runway centerline
  // by finding the angle between runway heading and bearing to aircraft
  const runwayHeading = runway.lowEnd.headingTrue
  const bearingFromLow = calculateBearing(
    runway.lowEnd.lat, runway.lowEnd.lon,
    aircraftLat, aircraftLon
  )
  const angleOff = Math.abs(headingDifference(runwayHeading, bearingFromLow))
  const lateralDistFt = distToLow * Math.sin(angleOff * Math.PI / 180)

  // Allow runway half-width plus buffer for GPS inaccuracy
  const runwayHalfWidth = (runway.widthFt || 150) / 2 + RUNWAY_WIDTH_BUFFER_FT
  return lateralDistFt <= runwayHalfWidth
}

// ============================================================================
// PHASE DETECTION
// ============================================================================

interface RunwayProximity {
  runway: Runway
  endIdent: string
  distanceNm: number
  distanceFt: number
  isAligned: boolean
  isInbound: boolean
  /** Lateral offset from extended centerline in feet (for parallel runway disambiguation) */
  lateralOffsetFt: number
}

/**
 * Calculate lateral offset (perpendicular distance) from a runway's extended centerline.
 * This is crucial for distinguishing between parallel runways (e.g., 07L vs 07R).
 *
 * @returns Lateral offset in feet (absolute value - always positive)
 */
function calculateLateralOffset(
  aircraftLat: number,
  aircraftLon: number,
  thresholdLat: number,
  thresholdLon: number,
  runwayHeading: number
): number {
  // Calculate distance from threshold to aircraft
  const distFt = haversineDistanceFt(aircraftLat, aircraftLon, thresholdLat, thresholdLon)

  // Calculate bearing from threshold to aircraft
  const bearingToAircraft = calculateBearing(thresholdLat, thresholdLon, aircraftLat, aircraftLon)

  // Calculate angle off centerline (difference between bearing to aircraft and runway heading)
  // For inbound aircraft, they're behind the threshold, so we use the reciprocal
  const angleOff = headingDifference(runwayHeading, bearingToAircraft)

  // Lateral offset is the perpendicular distance from centerline
  // Use sine because we want the perpendicular component
  const lateralFt = Math.abs(distFt * Math.sin(angleOff * Math.PI / 180))

  return lateralFt
}

/**
 * Find a runway the aircraft is aligned with (by heading).
 * For parallel runways, uses lateral offset to pick the correct one.
 * Returns the best-matching runway threshold based on alignment and lateral offset.
 */
function findAlignedRunway(
  aircraftLat: number,
  aircraftLon: number,
  aircraftHeading: number,
  runways: Runway[]
): RunwayProximity | null {
  if (runways.length === 0) return null

  let bestMatch: RunwayProximity | null = null

  for (const runway of runways) {
    // Check low end
    if (runway.lowEnd.lat !== 0 || runway.lowEnd.lon !== 0) {
      const isAligned = isAlignedWithRunway(aircraftHeading, runway.lowEnd.headingTrue)
      if (isAligned) {
        const distNm = haversineDistanceNm(
          aircraftLat, aircraftLon,
          runway.lowEnd.lat, runway.lowEnd.lon
        )
        const isInbound = isInboundToThreshold(
          aircraftLat, aircraftLon, aircraftHeading,
          runway.lowEnd.lat, runway.lowEnd.lon
        )
        const lateralOffsetFt = calculateLateralOffset(
          aircraftLat, aircraftLon,
          runway.lowEnd.lat, runway.lowEnd.lon,
          runway.lowEnd.headingTrue
        )
        // For parallel runways: prefer smaller lateral offset
        // For non-parallel: prefer closer distance
        const isBetterMatch = !bestMatch ||
          lateralOffsetFt < bestMatch.lateralOffsetFt ||
          (lateralOffsetFt === bestMatch.lateralOffsetFt && distNm < bestMatch.distanceNm)

        if (isBetterMatch) {
          bestMatch = {
            runway,
            endIdent: runway.lowEnd.ident,
            distanceNm: distNm,
            distanceFt: distNm * 6076.12,
            isAligned: true,
            isInbound,
            lateralOffsetFt
          }
        }
      }
    }

    // Check high end
    if (runway.highEnd.lat !== 0 || runway.highEnd.lon !== 0) {
      const isAligned = isAlignedWithRunway(aircraftHeading, runway.highEnd.headingTrue)
      if (isAligned) {
        const distNm = haversineDistanceNm(
          aircraftLat, aircraftLon,
          runway.highEnd.lat, runway.highEnd.lon
        )
        const isInbound = isInboundToThreshold(
          aircraftLat, aircraftLon, aircraftHeading,
          runway.highEnd.lat, runway.highEnd.lon
        )
        const lateralOffsetFt = calculateLateralOffset(
          aircraftLat, aircraftLon,
          runway.highEnd.lat, runway.highEnd.lon,
          runway.highEnd.headingTrue
        )
        // For parallel runways: prefer smaller lateral offset
        const isBetterMatch = !bestMatch ||
          lateralOffsetFt < bestMatch.lateralOffsetFt ||
          (lateralOffsetFt === bestMatch.lateralOffsetFt && distNm < bestMatch.distanceNm)

        if (isBetterMatch) {
          bestMatch = {
            runway,
            endIdent: runway.highEnd.ident,
            distanceNm: distNm,
            distanceFt: distNm * 6076.12,
            isAligned: true,
            isInbound,
            lateralOffsetFt
          }
        }
      }
    }
  }

  return bestMatch
}

/**
 * Find the nearest runway threshold and compute proximity data
 */
function findNearestRunwayThreshold(
  aircraftLat: number,
  aircraftLon: number,
  aircraftHeading: number,
  runways: Runway[]
): RunwayProximity | null {
  if (runways.length === 0) return null

  let nearest: RunwayProximity | null = null

  for (const runway of runways) {
    // Check low end
    if (runway.lowEnd.lat !== 0 || runway.lowEnd.lon !== 0) {
      const distNm = haversineDistanceNm(
        aircraftLat, aircraftLon,
        runway.lowEnd.lat, runway.lowEnd.lon
      )
      const isAligned = isAlignedWithRunway(aircraftHeading, runway.lowEnd.headingTrue)
      const isInbound = isInboundToThreshold(
        aircraftLat, aircraftLon, aircraftHeading,
        runway.lowEnd.lat, runway.lowEnd.lon
      )
      const lateralOffsetFt = calculateLateralOffset(
        aircraftLat, aircraftLon,
        runway.lowEnd.lat, runway.lowEnd.lon,
        runway.lowEnd.headingTrue
      )

      if (!nearest || distNm < nearest.distanceNm) {
        nearest = {
          runway,
          endIdent: runway.lowEnd.ident,
          distanceNm: distNm,
          distanceFt: distNm * 6076.12,
          isAligned,
          isInbound,
          lateralOffsetFt
        }
      }
    }

    // Check high end
    if (runway.highEnd.lat !== 0 || runway.highEnd.lon !== 0) {
      const distNm = haversineDistanceNm(
        aircraftLat, aircraftLon,
        runway.highEnd.lat, runway.highEnd.lon
      )
      const isAligned = isAlignedWithRunway(aircraftHeading, runway.highEnd.headingTrue)
      const isInbound = isInboundToThreshold(
        aircraftLat, aircraftLon, aircraftHeading,
        runway.highEnd.lat, runway.highEnd.lon
      )
      const lateralOffsetFt = calculateLateralOffset(
        aircraftLat, aircraftLon,
        runway.highEnd.lat, runway.highEnd.lon,
        runway.highEnd.headingTrue
      )

      if (!nearest || distNm < nearest.distanceNm) {
        nearest = {
          runway,
          endIdent: runway.highEnd.ident,
          distanceNm: distNm,
          distanceFt: distNm * 6076.12,
          isAligned,
          isInbound,
          lateralOffsetFt
        }
      }
    }
  }

  return nearest
}

/**
 * Detect the flight phase of an aircraft
 */
function detectFlightPhase(
  aircraft: InterpolatedAircraftState,
  context: SmartSortContext
): { phase: FlightPhase; runway: string | null; runwayDistance: number | null } {
  const altitudeFt = aircraft.interpolatedAltitude * 3.28084 // meters to feet
  const aglFt = altitudeFt - context.airportElevationFt
  const speedKts = aircraft.interpolatedGroundspeed
  const heading = aircraft.interpolatedHeading
  const track = aircraft.track  // Direction of movement
  const verticalRateFpm = aircraft.verticalRate * 3.28084 // m/min to ft/min
  const lat = aircraft.interpolatedLatitude
  const lon = aircraft.interpolatedLongitude

  const distFromAirportNm = haversineDistanceNm(lat, lon, context.airportLat, context.airportLon)

  // Find nearest runway
  const nearestRwy = findNearestRunwayThreshold(lat, lon, heading, context.runways)
  const runwayIdent = nearestRwy?.endIdent || null
  const runwayDistanceNm = nearestRwy?.distanceNm || null

  // Check flight plan to determine if arriving or departing
  // Normalize ICAO codes for comparison (uppercase, handle null)
  const arrivalIcao = aircraft.arrival?.toUpperCase() || ''
  const departureIcao = aircraft.departure?.toUpperCase() || ''
  const currentIcao = context.icao.toUpperCase()
  const isArrivingHere = arrivalIcao === currentIcao
  const isDepartingHere = departureIcao === currentIcao

  // Check if on a runway surface (checked BEFORE speed-based ground check)
  const onRunwaySurface = nearestRwy && context.runways.some(r => isOnRunway(lat, lon, r))

  // === RUNWAY SURFACE PHASES ===
  // Check this FIRST regardless of speed - aircraft on takeoff roll can exceed 80+ kts
  // before liftoff, but they're still on the runway and need proper phase detection
  if (onRunwaySurface && aglFt < GROUND_ALTITUDE_AGL_FT) {
    // Must be aligned with runway for departure/landing roll, otherwise crossing
    const isAlignedWithRwy = nearestRwy?.isAligned ?? false

    if (!isAlignedWithRwy) {
      // Crossing the runway (not aligned with runway heading)
      return { phase: 'active_taxi', runway: null, runwayDistance: null }
    }

    if (speedKts < STOPPED_SPEED_KTS) {
      // Stopped on runway = lined up
      return { phase: 'lined_up', runway: runwayIdent, runwayDistance: runwayDistanceNm }
    }

    // Moving on runway - use acceleration to determine departure vs landing roll
    // Positive acceleration = accelerating = takeoff roll
    // Negative acceleration = decelerating = landing roll
    // This handles go-arounds (accelerating on destination runway) correctly
    const accel = aircraft.acceleration  // knots per second
    const ACCEL_THRESHOLD = 0.5  // Minimum acceleration to be considered significant

    if (accel > ACCEL_THRESHOLD) {
      // Accelerating = takeoff roll (even if this is the arrival airport - could be go-around)
      return { phase: 'departure_roll', runway: runwayIdent, runwayDistance: runwayDistanceNm }
    } else if (accel < -ACCEL_THRESHOLD) {
      // Decelerating = landing roll
      return { phase: 'landing_roll', runway: runwayIdent, runwayDistance: runwayDistanceNm }
    } else {
      // Acceleration near zero - use speed + flight plan as fallback
      // High speed (>60 kts) on runway is almost certainly a roll, not stopped
      if (speedKts > 60) {
        // At high speed, use flight plan to determine direction
        if (isArrivingHere) {
          return { phase: 'landing_roll', runway: runwayIdent, runwayDistance: runwayDistanceNm }
        } else {
          return { phase: 'departure_roll', runway: runwayIdent, runwayDistance: runwayDistanceNm }
        }
      }
      // Lower speed with neutral acceleration - use flight plan
      if (isArrivingHere) {
        return { phase: 'landing_roll', runway: runwayIdent, runwayDistance: runwayDistanceNm }
      } else if (isDepartingHere) {
        return { phase: 'departure_roll', runway: runwayIdent, runwayDistance: runwayDistanceNm }
      } else {
        // No clear signal - default to departure (lined up for takeoff)
        return { phase: 'departure_roll', runway: runwayIdent, runwayDistance: runwayDistanceNm }
      }
    }
  }

  // === OTHER GROUND PHASES (not on runway) ===
  // Use speed < 40 kts as ground indicator for non-runway operations
  // Aircraft rarely taxi faster than 30-40 kts; runway ops handled above
  const isOnGround = aglFt < GROUND_ALTITUDE_AGL_FT && speedKts < 40

  if (isOnGround) {
    // Near runway threshold but not on it
    if (nearestRwy && nearestRwy.distanceFt < HOLDING_SHORT_DISTANCE_FT && speedKts < STOPPED_SPEED_KTS) {
      return { phase: 'holding_short', runway: runwayIdent, runwayDistance: runwayDistanceNm }
    }

    // Check for pushback: moving slowly with track opposite to heading
    // Pushback: aircraft faces one direction but moves backwards
    if (speedKts > 0.3 && speedKts < PUSHBACK_MAX_SPEED_KTS) {
      const trackHeadingDiff = Math.abs(headingDifference(track, heading))
      // If track is 90-180° from heading, aircraft is moving backwards or sideways
      // Use 90° threshold to catch curved pushbacks (not just straight back)
      if (trackHeadingDiff > 90) {
        return { phase: 'pushback', runway: null, runwayDistance: null }
      }
    }

    // If moving at all, it's taxi - stopped is the last resort
    if (speedKts > STOPPED_SPEED_KTS) {
      return { phase: 'active_taxi', runway: null, runwayDistance: null }
    }

    // Truly stationary - stopped is the fallback when nothing else matches
    return { phase: 'stopped_taxi', runway: null, runwayDistance: null }
  }

  // === AIRBORNE PHASES ===
  // Key insight: alignment with runway is the primary discriminator between
  // approach/departure and pattern work. Aircraft in the pattern fly crosswind,
  // downwind (opposite heading), and base (perpendicular) - NOT aligned with runway.

  const isDescending = verticalRateFpm < DESCENDING_THRESHOLD_FPM
  const isClimbing = verticalRateFpm > CLIMBING_THRESHOLD_FPM

  // For arriving aircraft, use the nearest runway they're aligned with
  // For departing aircraft, find the runway that matches their heading (not nearest by distance)
  const alignedRunway = findAlignedRunway(lat, lon, heading, context.runways)

  // Check if aircraft is on approach to any runway (aligned + inbound)
  if (alignedRunway && alignedRunway.isInbound) {
    if (alignedRunway.distanceNm < SHORT_FINAL_NM) {
      // Within 2nm and aligned = definitely short final
      return { phase: 'short_final', runway: alignedRunway.endIdent, runwayDistance: alignedRunway.distanceNm }
    } else if (alignedRunway.distanceNm < LONG_FINAL_NM) {
      // Within 6nm, aligned, inbound = on approach (accept any non-climbing)
      if (!isClimbing) {
        return { phase: 'long_final', runway: alignedRunway.endIdent, runwayDistance: alignedRunway.distanceNm }
      }
    }
  }

  // Go-around detection: climbing aggressively near runway, low altitude
  // KEY: Must have been recently observed on approach (short_final or long_final)
  // This prevents false positives from normal departures
  if (verticalRateFpm > GO_AROUND_CLIMB_FPM && aglFt < PATTERN_ALTITUDE_FT) {
    const goAroundRunway = alignedRunway || nearestRwy
    if (goAroundRunway && goAroundRunway.distanceNm < GO_AROUND_DISTANCE_NM) {
      // Only flag as go-around if we recently saw this aircraft on approach
      if (wasRecentlyOnApproach(aircraft.callsign)) {
        return { phase: 'go_around', runway: goAroundRunway.endIdent, runwayDistance: goAroundRunway.distanceNm }
      }
    }
  }

  // Check if aircraft is departing (climbing + aligned with a runway heading away)
  if (isClimbing && distFromAirportNm < 10) {
    if (alignedRunway && !alignedRunway.isInbound) {
      // Climbing and aligned with runway heading = departing that runway
      return { phase: 'departing_climb', runway: alignedRunway.endIdent, runwayDistance: alignedRunway.distanceNm }
    } else {
      // Climbing but not aligned (turned out) - don't show runway
      return { phase: 'departing_climb', runway: null, runwayDistance: null }
    }
  }

  // Check for base-to-final turn (close to runway, heading toward it, descending)
  // This should be treated as approach, not pattern
  if (nearestRwy && nearestRwy.distanceNm < 2 && nearestRwy.isInbound && isDescending) {
    // Close, heading toward runway, descending = on approach even if not perfectly aligned
    return { phase: 'long_final', runway: nearestRwy.endIdent, runwayDistance: nearestRwy.distanceNm }
  }

  // Pattern work: within pattern airspace, low altitude, NOT on approach
  // Must be: not heading toward any runway AND not climbing
  // AND flight plan suggests local/pattern work:
  //   - Same departure and arrival airport (touch-and-go training)
  //   - No flight plan at all
  //   - Departure from here with no arrival filed
  //   - Neither departure nor arrival filed
  if (distFromAirportNm < PATTERN_DISTANCE_NM && aglFt < PATTERN_ALTITUDE_FT && !isClimbing) {
    // Check if flight plan suggests pattern work
    const isSameDepArr = departureIcao !== '' && departureIcao === arrivalIcao
    const hasNoFlightPlan = departureIcao === '' && arrivalIcao === ''
    const isDepartingHereNoArrival = isDepartingHere && arrivalIcao === ''
    const couldBePatternWork = isSameDepArr || hasNoFlightPlan || isDepartingHereNoArrival

    if (couldBePatternWork) {
      // Check if heading toward any runway threshold (even if not aligned)
      const isApproachingAnyRunway = context.runways.some(rwy => {
        // Check both ends
        const inboundToLow = isInboundToThreshold(lat, lon, heading, rwy.lowEnd.lat, rwy.lowEnd.lon)
        const inboundToHigh = isInboundToThreshold(lat, lon, heading, rwy.highEnd.lat, rwy.highEnd.lon)
        return inboundToLow || inboundToHigh
      })

      if (!isApproachingAnyRunway) {
        // Not heading toward any runway = pattern work
        return { phase: 'pattern', runway: null, runwayDistance: null }
      }
    }
  }

  // Distant arrival (inbound to airport but not yet on approach)
  const bearingToAirport = calculateBearing(lat, lon, context.airportLat, context.airportLon)
  const isHeadingToAirport = Math.abs(headingDifference(heading, bearingToAirport)) < 45
  if (isHeadingToAirport && (isDescending || isArrivingHere)) {
    return { phase: 'distant_arrival', runway: null, runwayDistance: null }
  }

  return { phase: 'unknown', runway: null, runwayDistance: null }
}

// ============================================================================
// SCORING
// ============================================================================

/**
 * Calculate the smart sort priority score for an aircraft
 */
function calculatePriorityScore(
  aircraft: InterpolatedAircraftState,
  phase: FlightPhase,
  context: SmartSortContext
): number {
  // Base score from phase
  let score = PHASE_SCORES[phase]

  // Distance modifier: closer = higher priority (max ±200)
  const distFromAirportNm = haversineDistanceNm(
    aircraft.interpolatedLatitude,
    aircraft.interpolatedLongitude,
    context.airportLat,
    context.airportLon
  )
  const distanceModifier = Math.max(-200, Math.min(200, (10 - distFromAirportNm) * 20))
  score += distanceModifier

  // Speed modifier: faster = higher priority (max +150)
  const speedModifier = Math.min(150, aircraft.interpolatedGroundspeed * 0.5)
  score += speedModifier

  return Math.max(0, Math.round(score))
}

/**
 * Determine priority tier from score
 */
function getTierFromScore(score: number): PriorityTier {
  if (score >= 900) return 'critical'
  if (score >= 600) return 'high'
  if (score >= 300) return 'medium'
  return 'low'
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Calculate smart sort results for a list of aircraft
 *
 * @param aircraft - List of interpolated aircraft states
 * @param context - Airport context with runway data
 * @returns Sorted list of smart sort results (highest priority first)
 */
export function calculateSmartSort(
  aircraft: InterpolatedAircraftState[],
  context: SmartSortContext
): SmartSortResult[] {
  const results: SmartSortResult[] = []

  // Periodically clean up stale phase history (roughly every call is fine, it's cheap)
  cleanupPhaseHistory()

  for (const ac of aircraft) {
    const { phase, runway, runwayDistance } = detectFlightPhase(ac, context)
    const score = calculatePriorityScore(ac, phase, context)
    const tier = getTierFromScore(score)

    // Record phase for go-around detection (need history of approach phases)
    recordPhase(ac.callsign, phase)

    results.push({
      callsign: ac.callsign,
      phase,
      tier,
      score,
      runway,
      runwayDistance
    })
  }

  // Sort by score descending (highest priority first)
  results.sort((a, b) => b.score - a.score)

  return results
}

/**
 * Get a human-readable label for a flight phase
 */
export function getPhaseLabel(phase: FlightPhase): string {
  const labels: Record<FlightPhase, string> = {
    short_final: 'Short Final',
    long_final: 'Final',
    departure_roll: 'Rolling',
    landing_roll: 'Roll Out',
    go_around: 'Go Around',
    lined_up: 'Lined Up',
    holding_short: 'Hold Short',
    pattern: 'Pattern',
    pushback: 'Pushback',
    active_taxi: 'Taxi',
    stopped_taxi: 'Stopped',
    departing_climb: 'Climbing',
    distant_arrival: 'Inbound',
    unknown: ''
  }
  return labels[phase]
}

/**
 * Get a short abbreviation for a flight phase (for compact display)
 */
export function getPhaseAbbrev(phase: FlightPhase): string {
  const abbrevs: Record<FlightPhase, string> = {
    short_final: 'FIN',
    long_final: 'APP',
    departure_roll: 'RLL',   // Rolling (departure)
    landing_roll: 'RLO',     // Roll Out (landing)
    go_around: 'G/A',        // Go Around
    lined_up: 'LUP',
    holding_short: 'HLD',
    pattern: 'PAT',
    pushback: 'PBK',
    active_taxi: 'TXI',
    stopped_taxi: 'STP',
    departing_climb: 'CLB',
    distant_arrival: 'INB',
    unknown: ''
  }
  return abbrevs[phase]
}

/**
 * Get the CSS class for a priority tier
 */
export function getTierClass(tier: PriorityTier): string {
  return `priority-${tier}`
}
