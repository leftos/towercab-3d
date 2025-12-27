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

import type { InterpolatedAircraftState } from '../types/vatsim'
import type {
  FlightPhase,
  PriorityTier,
  SmartSortResult,
  SmartSortContext
} from './aircraft/types'
import {
  detectFlightPhase,
  recordPhase,
  cleanupPhaseHistory
} from './aircraft/flightPhaseDetector'
import { haversineDistanceNm } from './aircraft/geoMath'

// Re-export types for backwards compatibility
export type { FlightPhase, PriorityTier, SmartSortResult, SmartSortContext }
export { cleanupPhaseHistory, clearPhaseHistory } from './aircraft/flightPhaseDetector'

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
