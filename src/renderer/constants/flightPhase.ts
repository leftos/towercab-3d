/**
 * Flight Phase Detection Constants
 *
 * Thresholds, hysteresis values, and dwell times for stable phase detection.
 * These values are tuned to prevent oscillation with 1Hz vNAS updates.
 */

import type { FlightPhase } from '../utils/aircraft/types'

// ============================================================================
// DISTANCE THRESHOLDS (nautical miles unless noted)
// ============================================================================

/** Short final approach distance - within this range = short_final */
export const SHORT_FINAL_NM = 2

/** Long final approach distance - within this range = long_final */
export const LONG_FINAL_NM = 6

/** Pattern airspace distance from airport */
export const PATTERN_DISTANCE_NM = 5

/** Maximum distance for go-around detection */
export const GO_AROUND_DISTANCE_NM = 3

// ============================================================================
// ALTITUDE THRESHOLDS (feet)
// ============================================================================

/**
 * Ground altitude threshold (feet AGL).
 * 100ft AGL accounts for GPS inaccuracy while avoiding false positives from low pattern work.
 * Note: AGL is calculated from airport elevation, not actual terrain.
 */
export const GROUND_ALTITUDE_AGL_FT = 100

/** Typical traffic pattern altitude ceiling */
export const PATTERN_ALTITUDE_FT = 2000

// ============================================================================
// SPEED THRESHOLDS (knots)
// ============================================================================

/** Pushback maximum speed - pushback is typically 2-5 kts */
export const PUSHBACK_MAX_SPEED_KTS = 8

/** Below this speed = truly stopped (accounts for GPS jitter) */
export const STOPPED_SPEED_KTS = 2

/** Maximum ground speed for taxi operations */
export const TAXI_MAX_SPEED_KTS = 40

// ============================================================================
// ALIGNMENT THRESHOLDS (degrees)
// ============================================================================

/** Runway alignment tolerance - generous for wind correction/crab angle */
export const RUNWAY_ALIGNMENT_DEG = 25

// ============================================================================
// PROXIMITY THRESHOLDS (feet)
// ============================================================================

/** Distance from runway threshold to be considered "holding short" */
export const HOLDING_SHORT_DISTANCE_FT = 500

/** Runway width buffer for on-runway detection */
export const RUNWAY_WIDTH_BUFFER_FT = 150

/** Minimum runway length before data quality is suspect */
export const MIN_RUNWAY_LENGTH_FT = 500

// ============================================================================
// VERTICAL RATE THRESHOLDS (feet per minute)
// ============================================================================

/**
 * Descent rate threshold. Typical approach is 500-700fpm, landing flare is 100-200fpm.
 * Use -200fpm to avoid false positives from level flight altitude corrections (±50fpm).
 */
export const DESCENDING_THRESHOLD_FPM = -200

/** Climbing threshold */
export const CLIMBING_THRESHOLD_FPM = 200

/** Go-around detection - must be climbing aggressively */
export const GO_AROUND_CLIMB_FPM = 500

// ============================================================================
// HYSTERESIS THRESHOLDS
// Separate enter/exit values to prevent oscillation at boundaries.
// "enter" = threshold to enter the state, "exit" = threshold to leave it.
// ============================================================================

export interface HysteresisThreshold {
  enter: number
  exit: number
}

/** Distance hysteresis for approach phases (nautical miles) */
export const DISTANCE_HYSTERESIS = {
  /** Short final: enter at 2.0nm, stay until 2.4nm */
  shortFinal: { enter: 2.0, exit: 2.4 },
  /** Long final: enter at 6.0nm, stay until 6.5nm */
  longFinal: { enter: 6.0, exit: 6.5 },
  /** Go-around proximity: enter at 3.0nm, stay until 4.0nm */
  goAround: { enter: 3.0, exit: 4.0 },
} as const

/** Distance hysteresis for ground operations (feet) */
export const DISTANCE_HYSTERESIS_FT = {
  /** Holding short: enter at 500ft, stay until 700ft */
  holdingShort: { enter: 500, exit: 700 },
} as const

/** Speed hysteresis (knots) */
export const SPEED_HYSTERESIS = {
  /** Stopped: enter below 2kts, stay stopped until above 5kts */
  stopped: { enter: 2, exit: 5 },
  /** Ground operations: enter below 40kts, stay ground until above 55kts */
  groundOps: { enter: 40, exit: 55 },
  /** Pushback: enter below 8kts, stay pushback until above 12kts */
  pushback: { enter: 8, exit: 12 },
} as const

/** Altitude hysteresis (feet AGL) */
export const ALTITUDE_HYSTERESIS = {
  /** Ground level: enter below 100ft, stay ground until above 150ft */
  ground: { enter: 100, exit: 150 },
  /** Pattern altitude: enter below 2000ft, stay pattern until above 2500ft */
  pattern: { enter: 2000, exit: 2500 },
} as const

/** Vertical rate hysteresis (feet per minute) */
export const VERTICAL_RATE_HYSTERESIS = {
  /** Descending: enter below -200fpm, stay descending until above -100fpm */
  descending: { enter: -200, exit: -100 },
  /** Climbing: enter above 200fpm, stay climbing until below 100fpm */
  climbing: { enter: 200, exit: 100 },
  /** Go-around climb: enter above 500fpm, stay go-around until below 300fpm */
  goAroundClimb: { enter: 500, exit: 300 },
} as const

/** Acceleration hysteresis (knots per second) */
export const ACCELERATION_HYSTERESIS = {
  /** Accelerating: enter above 0.8 kts/s, stay accelerating until below 0.3 kts/s */
  accelerating: { enter: 0.8, exit: 0.3 },
  /** Decelerating: enter below -0.8 kts/s, stay decelerating until above -0.3 kts/s */
  decelerating: { enter: -0.8, exit: -0.3 },
} as const

// ============================================================================
// DWELL TIMES
// Minimum time a phase must persist before confirming transition (milliseconds).
// Prevents rapid oscillation between phases.
// ============================================================================

/**
 * Dwell times per phase (milliseconds).
 * A phase must be detected for this long before it becomes the confirmed phase.
 */
export const PHASE_DWELL_TIMES: Record<FlightPhase, number> = {
  // Critical phases - fast confirmation (500-1000ms)
  short_final: 500,           // Need to see this quickly
  go_around: 1000,            // Urgent but avoid false positives
  departure_roll: 800,        // Important for sequencing
  landing_roll: 800,

  // High priority phases (1000-1500ms)
  long_final: 1000,
  lined_up: 1000,
  holding_short: 1500,

  // Medium priority phases (1500-2500ms)
  active_taxi: 2000,
  pattern: 2000,
  pushback: 1500,

  // Low priority phases (2000-3000ms)
  stopped_taxi: 2500,
  departing_climb: 2000,
  distant_arrival: 2500,

  // Fallback
  unknown: 500,
}

/**
 * Sticky phase exit times (milliseconds).
 * Once entered, these phases require a longer dwell time before exiting.
 * This prevents accidental exit due to momentary data noise.
 */
export const STICKY_PHASE_EXIT_TIMES: Partial<Record<FlightPhase, number>> = {
  landing_roll: 5000,      // Stay in landing_roll 5s minimum
  holding_short: 3000,     // Stay in holding_short 3s minimum
  departure_roll: 3000,    // Stay in departure_roll 3s minimum
}

// ============================================================================
// WINDOW SIZES FOR TRAJECTORY ANALYSIS
// ============================================================================

/** Window size for computing windowed acceleration (milliseconds) */
export const ACCEL_WINDOW_MS = 4000

/** Window size for go-around approach trajectory analysis (milliseconds) */
export const GO_AROUND_APPROACH_WINDOW_MS = 10000

/** Minimum observations needed for trajectory analysis */
export const MIN_OBSERVATIONS_FOR_ANALYSIS = 3

/** Sustained approach threshold before go-around is possible (milliseconds) */
export const SUSTAINED_APPROACH_THRESHOLD_MS = 8000

// ============================================================================
// ROLL PHASE CLASSIFICATION SCORES
// Used for multi-signal departure/landing roll detection.
// ============================================================================

export const ROLL_PHASE_SCORES = {
  // Acceleration signals
  acceleratingPositive: 30,
  acceleratingNegative: 30,

  // Speed trajectory signals
  speedGained15Plus: 25,
  speedLost15Plus: 25,

  // Current speed signals
  highSpeed100Plus: 15,
  midSpeed30to80: 10,

  // Previous phase signals
  wasLinedUp: 30,
  wasShortFinal: 35,
  wasLongFinal: 25,

  // Flight plan signals
  flightPlanDeparture: 20,
  flightPlanArrival: 20,

  // Margin required for clear winner
  decisionMargin: 15,
} as const

// ============================================================================
// CONVERSION FACTORS
// ============================================================================

/** Meters to feet */
export const METERS_TO_FEET = 3.28084

/** Feet to meters */
export const FEET_TO_METERS = 0.3048
