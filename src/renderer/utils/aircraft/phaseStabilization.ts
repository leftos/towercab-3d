/**
 * Flight Phase Stabilization
 *
 * Provides stable phase detection by wrapping raw detection with:
 * 1. State machine with dwell times - phases must persist before confirming
 * 2. Hysteresis - separate enter/exit thresholds prevent oscillation
 * 3. Window-based acceleration - uses timeline history instead of noisy frame-to-frame
 * 4. Multi-signal roll classification - combines acceleration, speed, phase history
 * 5. Trajectory-based go-around detection - verifies actual approach trajectory
 */

import type { FlightPhase, PhaseDetectionResult, RunwayProximity, SmartSortContext } from './types'
import type { InterpolatedAircraftState } from '../../types/vatsim'
import type { AircraftTimeline, AircraftObservation } from '../../types/aircraft-timeline'
import {
  PHASE_DWELL_TIMES,
  STICKY_PHASE_EXIT_TIMES,
  ACCEL_WINDOW_MS,
  GO_AROUND_APPROACH_WINDOW_MS,
  MIN_OBSERVATIONS_FOR_ANALYSIS,
  ACCELERATION_HYSTERESIS,
  DISTANCE_HYSTERESIS,
  ROLL_PHASE_SCORES,
  METERS_TO_FEET,
  GO_AROUND_CLIMB_FPM,
  GO_AROUND_DISTANCE_NM,
} from '../../constants/flightPhase'
import { haversineDistanceNm } from './geoMath'

// Minimum speed (kts) before transitioning from landing_roll to taxi
// Aircraft below this speed can transition; above must stay in landing_roll
const LANDING_ROLL_MIN_EXIT_SPEED_KTS = 35

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

/**
 * Per-aircraft stabilization state.
 * Tracks confirmed phase, candidate phase, and timing for state machine.
 */
interface PhaseStabilizationState {
  // Core state machine
  confirmedPhase: FlightPhase
  candidatePhase: FlightPhase
  candidateStartTime: number
  phaseEntryTime: number

  // Hysteresis tracking
  accelState: 'accelerating' | 'decelerating' | 'neutral'
  distanceState: 'short' | 'long' | 'beyond'  // For final approach hysteresis

  // Roll phase tracking
  rollPhaseEntrySpeed: number
  rollPhaseEntryTime: number  // Track when we entered roll phase
  lastPhaseBeforeRoll: FlightPhase | null

  // Approach tracking for go-around
  approachStartTime: number | null
  wasOnSustainedApproach: boolean
}

/** Map of callsign -> stabilization state */
const stabilizationStates = new Map<string, PhaseStabilizationState>()

/**
 * Get or create stabilization state for an aircraft.
 */
function getOrCreateState(callsign: string, initialPhase: FlightPhase): PhaseStabilizationState {
  let state = stabilizationStates.get(callsign)
  if (!state) {
    const now = Date.now()
    state = {
      confirmedPhase: initialPhase,
      candidatePhase: initialPhase,
      candidateStartTime: now,
      phaseEntryTime: now,
      accelState: 'neutral',
      distanceState: 'beyond',
      rollPhaseEntrySpeed: 0,
      rollPhaseEntryTime: 0,
      lastPhaseBeforeRoll: null,
      approachStartTime: null,
      wasOnSustainedApproach: false,
    }
    stabilizationStates.set(callsign, state)
  }
  return state
}

/**
 * Clean up stale stabilization states (aircraft not seen recently).
 */
export function cleanupStabilizationStates(activeCallsigns: Set<string>): void {
  for (const callsign of stabilizationStates.keys()) {
    if (!activeCallsigns.has(callsign)) {
      stabilizationStates.delete(callsign)
    }
  }
}

/**
 * Clear all stabilization states (call when switching airports).
 */
export function clearStabilizationStates(): void {
  stabilizationStates.clear()
}

// ============================================================================
// WINDOW-BASED ACCELERATION
// ============================================================================

/**
 * Compute acceleration from a window of timeline observations.
 * This is much more stable than frame-to-frame acceleration.
 *
 * @returns Acceleration in knots/second and a confidence value (0-1)
 */
export function computeWindowedAcceleration(
  timeline: AircraftTimeline | undefined
): { acceleration: number; confidence: number } {
  if (!timeline || timeline.observations.length < 2) {
    return { acceleration: 0, confidence: 0 }
  }

  const now = Date.now()
  const observations = timeline.observations

  // Find observations within window
  const windowStart = now - ACCEL_WINDOW_MS
  const inWindow = observations.filter(obs => obs.observedAt >= windowStart)

  if (inWindow.length < 2) {
    return { acceleration: 0, confidence: 0 }
  }

  // Get oldest and newest in window
  const oldest = inWindow[0]
  const newest = inWindow[inWindow.length - 1]

  const timeDeltaMs = newest.observedAt - oldest.observedAt
  if (timeDeltaMs < 500) {
    // Need at least 500ms for meaningful acceleration
    return { acceleration: 0, confidence: 0 }
  }

  const speedDelta = newest.groundspeed - oldest.groundspeed
  const acceleration = (speedDelta / timeDeltaMs) * 1000  // knots/sec

  // Confidence based on number of observations and time coverage
  const coverage = Math.min(1, timeDeltaMs / ACCEL_WINDOW_MS)
  const observationDensity = Math.min(1, inWindow.length / 4)
  const confidence = coverage * observationDensity

  return { acceleration, confidence }
}

/**
 * Get recent observations from timeline within a time window.
 */
function getRecentObservations(
  timeline: AircraftTimeline | undefined,
  windowMs: number
): AircraftObservation[] {
  if (!timeline) return []

  const now = Date.now()
  const windowStart = now - windowMs
  return timeline.observations.filter(obs => obs.observedAt >= windowStart)
}

// ============================================================================
// TRAJECTORY ANALYSIS
// ============================================================================

/**
 * Analyze vertical trajectory from observations.
 */
function analyzeVerticalTrajectory(
  observations: AircraftObservation[]
): 'climbing' | 'descending' | 'level' {
  if (observations.length < 2) return 'level'

  const first = observations[0]
  const last = observations[observations.length - 1]
  const altitudeChangeFt = (last.altitude - first.altitude) * METERS_TO_FEET

  const timeDeltaMin = (last.observedAt - first.observedAt) / 60000
  if (timeDeltaMin < 0.1) return 'level'

  const fpm = altitudeChangeFt / timeDeltaMin

  if (fpm > 300) return 'climbing'
  if (fpm < -300) return 'descending'
  return 'level'
}

/**
 * Analyze distance trajectory relative to a runway.
 * Determines if aircraft was closing, opening, or maintaining distance.
 */
function analyzeDistanceTrajectory(
  observations: AircraftObservation[],
  runway: RunwayProximity | null,
  airportLat: number,
  airportLon: number
): 'closing' | 'opening' | 'stable' {
  if (observations.length < 2) return 'stable'

  const first = observations[0]
  const last = observations[observations.length - 1]

  // Use runway threshold if available, otherwise airport center
  const targetLat = runway ? runway.runway.lowEnd.lat : airportLat
  const targetLon = runway ? runway.runway.lowEnd.lon : airportLon

  const firstDist = haversineDistanceNm(first.latitude, first.longitude, targetLat, targetLon)
  const lastDist = haversineDistanceNm(last.latitude, last.longitude, targetLat, targetLon)

  const distChange = lastDist - firstDist

  // More than 0.1nm change is significant
  if (distChange < -0.1) return 'closing'
  if (distChange > 0.1) return 'opening'
  return 'stable'
}

// ============================================================================
// GO-AROUND DETECTION
// ============================================================================

/**
 * Validate go-around using trajectory analysis.
 * More robust than just checking recent phase history.
 */
function isValidGoAround(
  aircraft: InterpolatedAircraftState,
  timeline: AircraftTimeline | undefined,
  nearestRunway: RunwayProximity | null,
  state: PhaseStabilizationState,
  context: SmartSortContext
): boolean {
  // 1. Must have been on sustained approach
  if (!state.wasOnSustainedApproach) return false

  // 2. Must be near runway (within 3nm)
  if (!nearestRunway || nearestRunway.distanceNm > GO_AROUND_DISTANCE_NM) return false

  // 3. Check vertical trajectory from timeline
  if (timeline) {
    const recentObs = getRecentObservations(timeline, GO_AROUND_APPROACH_WINDOW_MS)
    if (recentObs.length >= MIN_OBSERVATIONS_FOR_ANALYSIS) {
      // Split observations: first half for approach verification, last few for current state
      const midpoint = Math.floor(recentObs.length / 2)
      const approachObs = recentObs.slice(0, midpoint)
      const currentObs = recentObs.slice(-3)

      // Verify approach trajectory: was descending AND closing to runway
      const wasDescending = analyzeVerticalTrajectory(approachObs) === 'descending'
      const wasClosing = analyzeDistanceTrajectory(
        approachObs, nearestRunway, context.airportLat, context.airportLon
      ) === 'closing'

      if (!wasDescending && !wasClosing) return false

      // Verify now climbing
      const isNowClimbing = analyzeVerticalTrajectory(currentObs) === 'climbing'
      if (!isNowClimbing) return false
    }
  }

  // 4. Current vertical rate check (fallback if timeline is sparse)
  const verticalRateFpm = aircraft.verticalRate * METERS_TO_FEET * 60  // m/s to fpm
  if (verticalRateFpm < GO_AROUND_CLIMB_FPM * 0.6) return false  // Allow some margin

  return true
}

// ============================================================================
// ROLL PHASE CLASSIFICATION
// ============================================================================

/**
 * Classify roll phase using multiple signals.
 * More robust than relying solely on noisy acceleration.
 */
function classifyRollPhase(
  aircraft: InterpolatedAircraftState,
  timeline: AircraftTimeline | undefined,
  state: PhaseStabilizationState,
  context: SmartSortContext
): 'departure_roll' | 'landing_roll' | 'ambiguous' {
  let departureScore = 0
  let landingScore = 0

  // 1. Windowed acceleration (primary signal, but requires confidence)
  const { acceleration, confidence } = computeWindowedAcceleration(timeline)
  if (confidence > 0.5) {
    if (acceleration > ACCELERATION_HYSTERESIS.accelerating.exit) {
      departureScore += ROLL_PHASE_SCORES.acceleratingPositive
    }
    if (acceleration < ACCELERATION_HYSTERESIS.decelerating.exit) {
      landingScore += ROLL_PHASE_SCORES.acceleratingNegative
    }
  }

  // 2. Speed trajectory since entering runway
  if (state.rollPhaseEntrySpeed > 0) {
    const speedDelta = aircraft.interpolatedGroundspeed - state.rollPhaseEntrySpeed
    if (speedDelta > 15) departureScore += ROLL_PHASE_SCORES.speedGained15Plus
    if (speedDelta < -15) landingScore += ROLL_PHASE_SCORES.speedLost15Plus
  }

  // 3. Current speed (contextual hint)
  const speed = aircraft.interpolatedGroundspeed
  if (speed > 100) departureScore += ROLL_PHASE_SCORES.highSpeed100Plus
  if (speed > 30 && speed < 80) landingScore += ROLL_PHASE_SCORES.midSpeed30to80

  // 4. What phase were we before entering the runway?
  const prevPhase = state.lastPhaseBeforeRoll
  if (prevPhase === 'lined_up') departureScore += ROLL_PHASE_SCORES.wasLinedUp
  if (prevPhase === 'short_final') landingScore += ROLL_PHASE_SCORES.wasShortFinal
  if (prevPhase === 'long_final') landingScore += ROLL_PHASE_SCORES.wasLongFinal

  // 5. Flight plan (if available)
  const icao = context.icao.toUpperCase()
  if (aircraft.departure?.toUpperCase() === icao) departureScore += ROLL_PHASE_SCORES.flightPlanDeparture
  if (aircraft.arrival?.toUpperCase() === icao) landingScore += ROLL_PHASE_SCORES.flightPlanArrival

  // Require clear winner
  const margin = ROLL_PHASE_SCORES.decisionMargin
  if (departureScore > landingScore + margin) return 'departure_roll'
  if (landingScore > departureScore + margin) return 'landing_roll'
  return 'ambiguous'
}

// ============================================================================
// HYSTERESIS HELPERS
// ============================================================================

/**
 * Apply hysteresis to acceleration state.
 */
function updateAccelState(
  currentState: 'accelerating' | 'decelerating' | 'neutral',
  acceleration: number
): 'accelerating' | 'decelerating' | 'neutral' {
  const { accelerating, decelerating } = ACCELERATION_HYSTERESIS

  if (currentState === 'accelerating') {
    // Stay accelerating until below exit threshold
    if (acceleration < accelerating.exit) return 'neutral'
    return 'accelerating'
  }

  if (currentState === 'decelerating') {
    // Stay decelerating until above exit threshold
    if (acceleration > decelerating.exit) return 'neutral'
    return 'decelerating'
  }

  // Neutral - check entry thresholds
  if (acceleration > accelerating.enter) return 'accelerating'
  if (acceleration < decelerating.enter) return 'decelerating'
  return 'neutral'
}

/**
 * Apply hysteresis to distance state for final approach phases.
 * Prevents oscillation between short_final and long_final at the 2nm boundary.
 */
function updateDistanceState(
  currentState: 'short' | 'long' | 'beyond',
  distanceNm: number | null
): 'short' | 'long' | 'beyond' {
  if (distanceNm === null) return 'beyond'

  const { shortFinal, longFinal } = DISTANCE_HYSTERESIS

  if (currentState === 'short') {
    // Stay in short until distance exceeds exit threshold
    if (distanceNm > shortFinal.exit) {
      // Check if we're still in long final range
      if (distanceNm < longFinal.exit) return 'long'
      return 'beyond'
    }
    return 'short'
  }

  if (currentState === 'long') {
    // Can transition to short if below entry threshold
    if (distanceNm < shortFinal.enter) return 'short'
    // Stay in long until distance exceeds exit threshold
    if (distanceNm > longFinal.exit) return 'beyond'
    return 'long'
  }

  // Beyond - check entry thresholds
  if (distanceNm < shortFinal.enter) return 'short'
  if (distanceNm < longFinal.enter) return 'long'
  return 'beyond'
}

// ============================================================================
// APPROACH TRACKING
// ============================================================================

/**
 * Update approach tracking state for go-around detection.
 */
function updateApproachTracking(state: PhaseStabilizationState, rawPhase: FlightPhase): void {
  const now = Date.now()
  const isOnApproach = rawPhase === 'short_final' || rawPhase === 'long_final'

  if (isOnApproach) {
    if (state.approachStartTime === null) {
      state.approachStartTime = now
    }
    const approachDuration = now - state.approachStartTime
    if (approachDuration >= 8000) {  // 8 seconds sustained
      state.wasOnSustainedApproach = true
    }
  } else {
    // Off approach - check if we should reset
    // Keep wasOnSustainedApproach true for a short window after leaving approach
    // to catch go-arounds that happen just after touch-and-go
    if (state.approachStartTime !== null) {
      const timeSinceApproach = now - (state.approachStartTime + 8000)
      if (timeSinceApproach > 15000) {  // 15 seconds after sustained approach ended
        state.wasOnSustainedApproach = false
        state.approachStartTime = null
      }
    }
  }
}

/**
 * Track roll phase entry for speed comparison.
 */
function updateRollTracking(
  state: PhaseStabilizationState,
  currentPhase: FlightPhase,
  newPhase: FlightPhase,
  speed: number
): void {
  const isEnteringRoll = (newPhase === 'departure_roll' || newPhase === 'landing_roll') &&
                         (currentPhase !== 'departure_roll' && currentPhase !== 'landing_roll')

  if (isEnteringRoll) {
    state.rollPhaseEntrySpeed = speed
    state.rollPhaseEntryTime = Date.now()
    state.lastPhaseBeforeRoll = currentPhase
  }
}

// ============================================================================
// MAIN STABILIZATION FUNCTION
// ============================================================================

/**
 * Stabilize a flight phase detection result.
 *
 * Takes raw detection and applies:
 * 1. State machine with dwell times
 * 2. Multi-signal roll classification
 * 3. Trajectory-based go-around detection
 *
 * @param callsign Aircraft callsign
 * @param rawResult Raw detection result from detectRawFlightPhase
 * @param aircraft Current interpolated aircraft state
 * @param context Smart sort context (airport info, runways)
 * @param timeline Aircraft timeline for trajectory analysis
 * @param nearestRunway Nearest runway proximity info
 * @returns Stabilized phase
 */
export function stabilizePhase(
  callsign: string,
  rawResult: PhaseDetectionResult,
  aircraft: InterpolatedAircraftState,
  context: SmartSortContext,
  timeline: AircraftTimeline | undefined,
  nearestRunway: RunwayProximity | null
): FlightPhase {
  const now = Date.now()
  const rawPhase = rawResult.phase
  const state = getOrCreateState(callsign, rawPhase)

  // Update approach tracking for go-around detection
  updateApproachTracking(state, rawPhase)

  // Update acceleration state with hysteresis
  const { acceleration } = computeWindowedAcceleration(timeline)
  state.accelState = updateAccelState(state.accelState, acceleration)

  // Update distance state with hysteresis (for final approach phases)
  const distanceNm = rawResult.runwayDistance
  state.distanceState = updateDistanceState(state.distanceState, distanceNm)

  // Handle roll phase with multi-signal classification
  let effectiveRawPhase = rawPhase
  if (rawPhase === 'departure_roll' || rawPhase === 'landing_roll') {
    const rollClass = classifyRollPhase(aircraft, timeline, state, context)
    if (rollClass !== 'ambiguous') {
      effectiveRawPhase = rollClass
    } else {
      // Ambiguous - keep current confirmed phase if it's a roll phase
      if (state.confirmedPhase === 'departure_roll' || state.confirmedPhase === 'landing_roll') {
        effectiveRawPhase = state.confirmedPhase
      }
    }
  }

  // Apply distance hysteresis to final approach phases
  // If raw says short_final but hysteresis says 'long', use long_final
  // If raw says long_final but hysteresis says 'short', use short_final
  if (rawPhase === 'short_final' || rawPhase === 'long_final') {
    if (state.distanceState === 'short') {
      effectiveRawPhase = 'short_final'
    } else if (state.distanceState === 'long') {
      effectiveRawPhase = 'long_final'
    }
    // If beyond, keep raw phase (will be handled by dwell times)
  }

  // Enhanced go-around detection using trajectory
  if (effectiveRawPhase === 'go_around') {
    if (!isValidGoAround(aircraft, timeline, nearestRunway, state, context)) {
      // Not a valid go-around - might be a normal departure
      if (state.confirmedPhase === 'departure_roll' || state.confirmedPhase === 'departing_climb') {
        effectiveRawPhase = state.confirmedPhase
      } else {
        effectiveRawPhase = 'departing_climb'
      }
    }
  }

  // Protect landing_roll from transitioning to taxi phases if still moving fast
  // This prevents premature exit due to GPS position noise at runway edge
  if (state.confirmedPhase === 'landing_roll') {
    const isTaxiPhase = effectiveRawPhase === 'active_taxi' ||
                        effectiveRawPhase === 'stopped_taxi' ||
                        effectiveRawPhase === 'holding_short'
    if (isTaxiPhase && aircraft.interpolatedGroundspeed > LANDING_ROLL_MIN_EXIT_SPEED_KTS) {
      // Still too fast to be taxiing - stay in landing_roll
      effectiveRawPhase = 'landing_roll'
    }
  }

  // Track roll entry before updating phase
  updateRollTracking(state, state.confirmedPhase, effectiveRawPhase, aircraft.interpolatedGroundspeed)

  // State machine: check if candidate phase should become confirmed
  if (effectiveRawPhase === state.candidatePhase) {
    // Same candidate - check if dwell time has elapsed
    const dwellTime = PHASE_DWELL_TIMES[effectiveRawPhase]
    const elapsed = now - state.candidateStartTime

    if (elapsed >= dwellTime) {
      // Check sticky phase exit time if leaving a sticky phase
      const stickyExitTime = STICKY_PHASE_EXIT_TIMES[state.confirmedPhase]
      if (stickyExitTime && effectiveRawPhase !== state.confirmedPhase) {
        const timeInCurrentPhase = now - state.phaseEntryTime
        if (timeInCurrentPhase < stickyExitTime) {
          // Not enough time in sticky phase - don't transition yet
          return state.confirmedPhase
        }
      }

      // Transition to new phase
      if (effectiveRawPhase !== state.confirmedPhase) {
        state.confirmedPhase = effectiveRawPhase
        state.phaseEntryTime = now
      }
    }
  } else {
    // New candidate - reset timer
    state.candidatePhase = effectiveRawPhase
    state.candidateStartTime = now
  }

  return state.confirmedPhase
}

/**
 * Get current stabilization state for debugging.
 */
export function getStabilizationState(callsign: string): PhaseStabilizationState | undefined {
  return stabilizationStates.get(callsign)
}
