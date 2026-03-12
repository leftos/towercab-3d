/**
 * Aircraft Utilities
 *
 * Barrel export for aircraft-related utility functions.
 */

// Flight phase detection
export {
  cleanupPhaseHistory,
  clearPhaseHistory,
  detectFlightPhase,
  recordPhase,
} from './flightPhaseDetector'

// Geographic math
export {
  calculateBearing,
  haversineDistanceFt,
  haversineDistanceNm,
  headingDifference,
} from './geoMath'
// Types
export type {
  FlightPhase,
  PhaseDetectionResult,
  PriorityTier,
  RunwayProximity,
  SmartSortContext,
  SmartSortResult,
} from './types'
