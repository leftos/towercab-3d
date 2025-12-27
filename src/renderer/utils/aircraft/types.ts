/**
 * Aircraft Utilities - Shared Types
 *
 * Type definitions used across aircraft utility modules.
 */

import type { Runway } from '../../types/airport'

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

/** Result of flight phase detection */
export interface PhaseDetectionResult {
  phase: FlightPhase
  runway: string | null
  runwayDistance: number | null
}

/** Runway proximity data for phase detection */
export interface RunwayProximity {
  runway: Runway
  endIdent: string
  distanceNm: number
  distanceFt: number
  isAligned: boolean
  isInbound: boolean
  /** Lateral offset from extended centerline in feet (for parallel runway disambiguation) */
  lateralOffsetFt: number
}
