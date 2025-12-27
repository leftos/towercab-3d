/**
 * Aircraft Utilities
 *
 * Barrel export for aircraft-related utility functions.
 */

// Types
export type {
  FlightPhase,
  PriorityTier,
  SmartSortResult,
  SmartSortContext,
  PhaseDetectionResult,
  RunwayProximity
} from './types'

// Geographic math
export {
  haversineDistanceNm,
  haversineDistanceFt,
  calculateBearing,
  headingDifference
} from './geoMath'

// Flight phase detection
export {
  detectFlightPhase,
  recordPhase,
  cleanupPhaseHistory,
  clearPhaseHistory
} from './flightPhaseDetector'
