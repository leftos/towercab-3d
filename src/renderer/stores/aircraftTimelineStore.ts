/**
 * Aircraft Timeline Store
 *
 * Central store for per-aircraft observation timelines.
 * Provides unified interpolation across all data sources (VATSIM, vNAS, RealTraffic).
 *
 * ## Key Concepts
 *
 * 1. **Observation Timeline**: Each aircraft maintains a buffer of recent
 *    position observations (up to 5 minutes), each tagged with when it was
 *    observed and from which source. Time-based pruning ensures consistent
 *    replay duration across all data sources.
 *
 * 2. **Display Delay**: Each source has a different delay (VATSIM 15s, vNAS 2s,
 *    RealTraffic 5s). The delay for an aircraft is determined by its most recent source.
 *
 * 3. **Interpolation**: At render time, we calculate displayTime = now - delay,
 *    find observations bracketing that time, and interpolate between them.
 *
 * 4. **Extrapolation**: If displayTime is beyond our newest observation, we
 *    extrapolate using groundspeed and track.
 *
 * @see types/aircraft-timeline.ts - Type definitions
 * @see constants/aircraft-timeline.ts - Configuration constants
 */

import { create } from 'zustand'
import {
  AIRCRAFT_TIMEOUT,
  DYNAMIC_DELAY_BOOTSTRAP_MS,
  DYNAMIC_DELAY_EXTRAPOLATION_BUMP_MS,
  DYNAMIC_DELAY_EXTRAPOLATION_DECAY_RATE,
  DYNAMIC_DELAY_INTERVAL_WINDOW,
  DYNAMIC_DELAY_JITTER_BUFFER_MS,
  DYNAMIC_DELAY_MAX_DECREASE_RATE,
  DYNAMIC_DELAY_MAX_MS,
  DYNAMIC_DELAY_MIN_MS,
  DYNAMIC_DELAY_MIN_OBSERVATIONS,
  MAX_EXTRAPOLATION_TIME,
  MAX_OBSERVATION_AGE_MS,
  MAX_OBSERVATIONS_PER_AIRCRAFT,
  MIN_OBSERVATION_INTERVAL,
  PRUNE_INTERVAL,
  SOURCE_DISPLAY_DELAYS,
  VNAS_PREFERENCE_THRESHOLD_MS,
} from '../constants/aircraft-timeline'
import type {
  AircraftMetadata,
  AircraftObservation,
  AircraftTimeline,
  DynamicDelayState,
  TimelineInterpolationResult,
} from '../types/aircraft-timeline'
import { mergeAircraftMetadata } from '../types/aircraft-timeline'
import type { SerializedTimeline } from '../types/diagnostic'
import type { VatsimSnapshot } from '../types/replay'
import { calculateBearing } from '../utils/aircraft/geoMath'
import { useReplayStore } from './replayStore'
import { useSettingsStore } from './settingsStore'
import { useViewportStore } from './viewportStore'

// ============================================================================
// BROADCAST CALLBACK FOR INSET SYNCHRONIZATION
// ============================================================================
// The main app registers a callback to broadcast observations to insets.
// Insets don't register a callback, so they receive but don't re-broadcast.

type ObservationBroadcastCallback = (
  observations: Array<{
    callsign: string
    observation: AircraftObservation
    metadata: AircraftMetadata
  }>,
) => void

type RemovalBroadcastCallback = (callsigns: string[]) => void

let observationBroadcastCallback: ObservationBroadcastCallback | null = null
let removalBroadcastCallback: RemovalBroadcastCallback | null = null

/**
 * Register callbacks for broadcasting observations/removals to insets.
 * Called by SettingsSharedWorkerService in main app context only.
 */
export function registerBroadcastCallbacks(
  onObservations: ObservationBroadcastCallback,
  onRemovals: RemovalBroadcastCallback,
): void {
  observationBroadcastCallback = onObservations
  removalBroadcastCallback = onRemovals
}

/** A removed timeline kept for diagnostic export */
interface GraveyardEntry {
  timeline: AircraftTimeline
  removedAt: number
}

interface AircraftTimelineStore {
  // State
  timelines: Map<string, AircraftTimeline>

  // Recently removed timelines kept for diagnostic capture
  recentlyRemoved: Map<string, GraveyardEntry>

  // Per-aircraft last known good heading (for when current heading is unreliable)
  lastKnownHeadings: Map<string, number>

  // Per-aircraft last rendered position (for starting new reconciliations)
  lastRenderedPositions: Map<
    string,
    {
      latitude: number
      longitude: number
      altitude: number
    }
  >

  // Per-aircraft reconciliation state for smooth transitions.
  // Tracks what 'after' observation we're interpolating toward and where we started from.
  reconciliationStates: Map<
    string,
    {
      // The observation time of 'after' we're currently interpolating toward
      targetObservedAt: number
      // Position we were at when this target was set (our starting point)
      startLat: number
      startLon: number
      startAlt: number
      // displayTime when we started interpolating toward this target
      startDisplayTime: number
      // Anchor (oldest obs) when this reconciliation was created
      anchorObservedAt: number
    }
  >

  // Prune timer
  pruneTimer: NodeJS.Timeout | null

  // Actions - called by data sources
  addObservation: (callsign: string, observation: AircraftObservation, metadata: AircraftMetadata) => void

  addObservationBatch: (
    observations: Array<{
      callsign: string
      observation: AircraftObservation
      metadata: AircraftMetadata
    }>,
  ) => void

  removeAircraft: (callsign: string) => void
  pruneStaleAircraft: () => void
  startPruneTimer: () => void
  stopPruneTimer: () => void
  clear: () => void

  // Getters - called by rendering
  getInterpolatedState: (callsign: string, now: number) => TimelineInterpolationResult | null
  getInterpolatedStates: (now: number) => Map<string, TimelineInterpolationResult>
  getTimeline: (callsign: string) => AircraftTimeline | undefined

  /**
   * Get the data loading status for the overlay.
   * Returns whether we have aircraft in range and whether any are ready to render.
   */
  getDataLoadingStatus: () => {
    /** True if at least one aircraft is in range (has any observations) */
    hasAircraftInRange: boolean
    /** True if at least one aircraft has 2+ observations (ready to interpolate) */
    hasReadyAircraft: boolean
  }

  /**
   * Clear interpolation state (lastRenderedPositions and reconciliationStates).
   * Called when seeking/scrubbing to force aircraft to jump to the correct position
   * instead of smoothly transitioning from the old position.
   */
  clearInterpolationState: () => void

  // Replay support
  /**
   * Load serialized timelines into the store for imported replay playback.
   * Clears existing data and populates timelines from SerializedTimeline[].
   * Used for both v2 replay imports and diagnostic imports.
   */
  loadImportedTimelines: (serialized: SerializedTimeline[]) => void

  /**
   * Load legacy v1 replay snapshots into the timeline store.
   * Converts lossy VatsimSnapshot[] into observation timelines.
   * Used only for backward compatibility with v1 export files.
   */
  loadReplaySnapshots: (snapshots: VatsimSnapshot[]) => void

  /**
   * Get the time range of loaded replay data.
   * Returns null if no replay data is loaded.
   */
  getReplayTimeRange: () => { start: number; end: number } | null
}

/**
 * Interpolate between two values
 */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * Smoothstep easing function - creates an S-curve for natural motion
 * Returns 0 at t=0, 1 at t=1, with zero velocity at both ends
 */
function smoothstep(t: number): number {
  t = Math.max(0, Math.min(1, t))
  return t * t * (3 - 2 * t)
}

/**
 * Blend between linear and smoothstep interpolation
 * @param blend 0 = pure linear, 1 = pure smoothstep
 */
function lerpBlended(a: number, b: number, t: number, blend: number): number {
  const linearT = t
  const smoothT = smoothstep(t)
  const blendedT = linearT + (smoothT - linearT) * blend
  return a + (b - a) * blendedT
}

/**
 * Interpolate heading with wraparound (0-360)
 */
function lerpHeading(a: number, b: number, t: number): number {
  // Normalize to 0-360
  a = ((a % 360) + 360) % 360
  b = ((b % 360) + 360) % 360

  // Find shortest path
  let diff = b - a
  if (diff > 180) diff -= 360
  if (diff < -180) diff += 360

  const result = a + diff * t
  return ((result % 360) + 360) % 360
}

/**
 * Calculate heading from position delta between two observations.
 * Returns heading in degrees (0-360) or null if positions are too close.
 */
function calculateHeadingFromDelta(lat1: number, lon1: number, lat2: number, lon2: number): number | null {
  const latDelta = lat2 - lat1
  const lonDelta = lon2 - lon1

  // If positions are essentially the same, can't calculate heading
  const distance = Math.sqrt(latDelta * latDelta + lonDelta * lonDelta)
  if (distance < 0.00001) {
    // ~1 meter
    return null
  }

  // Calculate bearing from point 1 to point 2
  // Using simple flat-earth approximation (accurate for short distances)
  const lonDeltaCorrected = lonDelta * Math.cos((lat1 * Math.PI) / 180)
  let heading = (Math.atan2(lonDeltaCorrected, latDelta) * 180) / Math.PI

  // Normalize to 0-360
  if (heading < 0) heading += 360

  return heading
}

/**
 * Check if an observation's heading is reliable.
 *
 * For VATSIM/vNAS: Always reliable (from simulator, accurate even during pushback)
 * For RealTraffic: Only reliable when true_heading was available from ADS-B.
 *   If true_heading was null, heading was derived from track or is a fallback value.
 */
function isHeadingReliable(obs: AircraftObservation): boolean {
  return obs.headingIsTrue
}

/**
 * Extrapolate position from an observation using groundspeed and track
 */
function extrapolatePosition(
  obs: AircraftObservation,
  extrapolationTimeMs: number,
): { latitude: number; longitude: number; altitude: number } {
  const seconds = extrapolationTimeMs / 1000
  const minutes = seconds / 60
  const track = obs.groundTrack ?? obs.heading
  const speedMps = obs.groundspeed * 0.514444 // knots to m/s
  const distance = speedMps * seconds

  // Simple flat-earth approximation (accurate for short extrapolations)
  const trackRad = (track * Math.PI) / 180
  const latOffset = (distance * Math.cos(trackRad)) / 111320
  const lonOffset = (distance * Math.sin(trackRad)) / (111320 * Math.cos((obs.latitude * Math.PI) / 180))

  // Extrapolate altitude using vertical rate if available
  // verticalRate is in feet per minute (fpm), need to convert to meters
  const FEET_TO_METERS = 0.3048
  let altitude = obs.altitude
  if (obs.verticalRate !== null) {
    // Use actual ADS-B vertical rate
    const altitudeChangeMeters = obs.verticalRate * FEET_TO_METERS * minutes
    altitude = Math.max(0, obs.altitude + altitudeChangeMeters)
  }
  // If no verticalRate, keep altitude constant (no way to estimate without history)

  return {
    latitude: obs.latitude + latOffset,
    longitude: obs.longitude + lonOffset,
    altitude,
  }
}

/**
 * Prune observations by age and count.
 *
 * Removes observations older than MAX_OBSERVATION_AGE_MS, while also
 * enforcing MAX_OBSERVATIONS_PER_AIRCRAFT as a hard cap.
 *
 * @param observations - Array of observations (oldest first)
 * @param now - Current time in ms (for age calculation)
 * @returns Pruned array and whether any pruning occurred
 */
function pruneObservations(
  observations: AircraftObservation[],
  now: number,
): { pruned: AircraftObservation[]; wasPruned: boolean } {
  const cutoffTime = now - MAX_OBSERVATION_AGE_MS

  // Filter out observations older than the cutoff
  let result = observations.filter((obs) => obs.observedAt >= cutoffTime)

  // Always keep at least 2 observations for interpolation (if we have them)
  if (result.length < 2 && observations.length >= 2) {
    result = observations.slice(-2)
  } else if (result.length < 1 && observations.length >= 1) {
    result = observations.slice(-1)
  }

  // Apply hard cap as safety limit
  if (result.length > MAX_OBSERVATIONS_PER_AIRCRAFT) {
    result = result.slice(-MAX_OBSERVATIONS_PER_AIRCRAFT)
  }

  return {
    pruned: result,
    wasPruned: result.length !== observations.length,
  }
}

// ============================================================================
// DYNAMIC DISPLAY DELAY
// ============================================================================

/**
 * Calculate observation intervals from a list of observations.
 * Returns intervals between consecutive observations based on receivedAt timestamps.
 *
 * @param observations - Array of observations (oldest first), should already be
 *                       filtered to the preferred source (e.g., vNAS-only when vNAS is active)
 * @param maxIntervals - Maximum number of intervals to return
 * @returns Array of intervals in milliseconds (most recent last)
 */
function calculateObservationIntervals(observations: AircraftObservation[], maxIntervals: number): number[] {
  if (observations.length < 2) return []

  const intervals: number[] = []
  // Start from the end (most recent) and work backwards
  const startIdx = Math.max(0, observations.length - maxIntervals - 1)

  for (let i = startIdx; i < observations.length - 1; i++) {
    const interval = observations[i + 1].receivedAt - observations[i].receivedAt
    if (interval > 0) {
      intervals.push(interval)
    }
  }

  return intervals
}

/**
 * Filter observations to prefer vNAS when recent.
 * This is the same logic used in interpolateTimeline for consistency.
 */
function filterObservationsForSource(observations: AircraftObservation[], now: number): AircraftObservation[] {
  const newestVnasObs = observations.filter((o) => o.source === 'vnas').pop()
  const hasRecentVnas = newestVnasObs && now - newestVnasObs.receivedAt < VNAS_PREFERENCE_THRESHOLD_MS

  if (hasRecentVnas) {
    const vnasOnly = observations.filter((o) => o.source === 'vnas')
    if (vnasOnly.length > 0) {
      return vnasOnly
    }
  }

  return observations
}

/**
 * Calculate the target display delay from observation intervals.
 * Uses the maximum recent interval plus a jitter buffer to ensure
 * we always have enough time for interpolation.
 *
 * @param intervals - Recent observation intervals in ms
 * @returns Target delay in milliseconds
 */
function calculateTargetDelay(intervals: number[]): number {
  if (intervals.length === 0) {
    return DYNAMIC_DELAY_BOOTSTRAP_MS
  }

  // Use max interval to handle worst-case timing
  const maxInterval = Math.max(...intervals)

  // Add jitter buffer and clamp to bounds
  const targetDelay = maxInterval + DYNAMIC_DELAY_JITTER_BUFFER_MS

  return Math.max(DYNAMIC_DELAY_MIN_MS, Math.min(DYNAMIC_DELAY_MAX_MS, targetDelay))
}

/**
 * Update dynamic delay state based on new observations.
 * Called when adding observations to update the interval history
 * and recalculate the target delay.
 *
 * @param existingState - Current dynamic delay state (or undefined for new aircraft)
 * @param observations - Current observation array (after adding new observation)
 * @param now - Current timestamp
 * @returns Updated dynamic delay state
 */
function updateDynamicDelayState(
  existingState: DynamicDelayState | undefined,
  observations: AircraftObservation[],
  now: number,
): DynamicDelayState {
  // Filter observations to prefer vNAS when active (same logic as interpolation)
  const filteredObs = filterObservationsForSource(observations, now)

  // Calculate intervals from filtered observations
  const intervals = calculateObservationIntervals(filteredObs, DYNAMIC_DELAY_INTERVAL_WINDOW)

  // Calculate target delay
  const targetDelayMs = calculateTargetDelay(intervals)

  if (!existingState) {
    // New aircraft - initialize with target as current
    // (or bootstrap delay if we don't have enough data yet)
    const initialDelay =
      observations.length < DYNAMIC_DELAY_MIN_OBSERVATIONS ? DYNAMIC_DELAY_BOOTSTRAP_MS : targetDelayMs

    return {
      currentDelayMs: initialDelay,
      targetDelayMs,
      lastUpdateTime: now,
      intervalHistory: intervals,
      extrapolationBumpMs: 0,
    }
  }

  // Return updated state (currentDelayMs and extrapolationBumpMs will be smoothed at interpolation time)
  return {
    currentDelayMs: existingState.currentDelayMs,
    targetDelayMs,
    lastUpdateTime: existingState.lastUpdateTime,
    intervalHistory: intervals,
    extrapolationBumpMs: existingState.extrapolationBumpMs,
  }
}

/**
 * Apply smooth delay transition.
 * Increases are applied immediately (safe - adds buffer).
 * Decreases are rate-limited to prevent position jumps.
 * Extrapolation bump is included and decays over time.
 *
 * @param state - Current dynamic delay state
 * @param now - Current timestamp
 * @param isExtrapolating - Whether we're currently extrapolating
 * @returns Updated current delay and new state
 */
function applyDelayTransition(
  state: DynamicDelayState,
  now: number,
  isExtrapolating: boolean,
): { delayMs: number; updatedState: DynamicDelayState } {
  const { currentDelayMs, targetDelayMs, lastUpdateTime, extrapolationBumpMs } = state
  const elapsed = now - lastUpdateTime

  // Calculate new extrapolation bump
  let newExtrapolationBump = extrapolationBumpMs

  if (isExtrapolating) {
    // Extrapolation detected - ensure we have at least the minimum bump.
    // Only set the bump if it's less than the target bump value (don't accumulate).
    // This prevents runaway delay increases while still reacting to extrapolation.
    newExtrapolationBump = Math.min(
      Math.max(newExtrapolationBump, DYNAMIC_DELAY_EXTRAPOLATION_BUMP_MS),
      DYNAMIC_DELAY_MAX_MS - targetDelayMs, // Don't exceed max
    )
  } else if (newExtrapolationBump > 0) {
    // Decay the bump when not extrapolating
    const decay = (elapsed / 1000) * DYNAMIC_DELAY_EXTRAPOLATION_DECAY_RATE
    newExtrapolationBump = Math.max(0, newExtrapolationBump - decay)
  }

  // Effective target includes the extrapolation bump
  const effectiveTarget = Math.min(DYNAMIC_DELAY_MAX_MS, targetDelayMs + newExtrapolationBump)

  let newDelay: number

  // Increasing delay - apply immediately (safe)
  if (effectiveTarget >= currentDelayMs) {
    newDelay = effectiveTarget
  } else {
    // Decreasing delay - rate limit
    const maxDecrease = (elapsed / 1000) * DYNAMIC_DELAY_MAX_DECREASE_RATE
    newDelay = Math.max(effectiveTarget, currentDelayMs - maxDecrease)
  }

  return {
    delayMs: newDelay,
    updatedState: {
      ...state,
      currentDelayMs: newDelay,
      lastUpdateTime: now,
      extrapolationBumpMs: newExtrapolationBump,
    },
  }
}

/**
 * Find the two observations that bracket a given time.
 * Returns [before, after] or [null, first] or [last, null] for edge cases.
 */
function findBracketingObservations(
  observations: AircraftObservation[],
  displayTime: number,
): [AircraftObservation | null, AircraftObservation | null] {
  if (observations.length === 0) {
    return [null, null]
  }

  if (observations.length === 1) {
    const obs = observations[0]
    if (displayTime >= obs.observedAt) {
      return [obs, null] // Extrapolate forward
    } else {
      return [null, obs] // Extrapolate backward (rare)
    }
  }

  // Binary search would be more efficient, but linear is fine for small arrays
  for (let i = 0; i < observations.length - 1; i++) {
    const before = observations[i]
    const after = observations[i + 1]

    if (before.observedAt <= displayTime && displayTime <= after.observedAt) {
      return [before, after]
    }
  }

  // displayTime is outside the range
  const first = observations[0]
  const last = observations[observations.length - 1]

  if (displayTime < first.observedAt) {
    return [null, first] // Before all observations
  } else {
    return [last, null] // After all observations (extrapolate)
  }
}

/**
 * Derive a reliable heading from observations.
 *
 * Priority:
 * 1. If current observation has reliable heading, use it
 * 2. Calculate from position delta between observations
 * 3. Fall back to lastKnownHeading
 * 4. Fall back to observation's heading (even if unreliable)
 */
function deriveHeading(
  observations: AircraftObservation[],
  before: AircraftObservation | null,
  after: AircraftObservation | null,
  lastKnownHeading: number | null,
): { heading: number; isReliable: boolean } {
  // Get the most relevant observation for heading
  const primaryObs = after ?? before
  if (!primaryObs) {
    return { heading: lastKnownHeading ?? 0, isReliable: false }
  }

  // If the observation's heading is reliable, use it
  if (isHeadingReliable(primaryObs)) {
    return { heading: primaryObs.heading, isReliable: true }
  }

  // Try to calculate heading from position delta
  // Look for two observations with enough position change
  for (let i = observations.length - 1; i > 0; i--) {
    const newer = observations[i]
    const older = observations[i - 1]

    const calculatedHeading = calculateHeadingFromDelta(
      older.latitude,
      older.longitude,
      newer.latitude,
      newer.longitude,
    )

    if (calculatedHeading !== null) {
      return { heading: calculatedHeading, isReliable: true }
    }
  }

  // Fall back to last known heading if we have one
  if (lastKnownHeading !== null) {
    return { heading: lastKnownHeading, isReliable: false }
  }

  // Last resort: use the observation's heading even if unreliable
  return { heading: primaryObs.heading, isReliable: false }
}

// Reconciliation state for smooth transitions after extrapolation
type ReconciliationState = {
  targetObservedAt: number // The 'after' observation we're heading toward
  startLat: number // Where we were when we started
  startLon: number
  startAlt: number
  startDisplayTime: number // displayTime when we started
  anchorObservedAt: number // Anchor (oldest obs) when this reconciliation was created
}

/**
 * Compute interpolated/extrapolated state for an aircraft
 *
 * @param timeline - The aircraft's observation timeline
 * @param now - Current time in milliseconds
 * @param lastKnownHeading - Previously known reliable heading (for stationary aircraft)
 * @param reconciliation - Current reconciliation state (for smooth transitions)
 * @param lastRenderedPos - The position we rendered last frame (for starting new reconciliations)
 * @returns Interpolation result, updated heading, and updated reconciliation state
 */
function interpolateTimeline(
  timeline: AircraftTimeline,
  now: number,
  lastKnownHeading: number | null,
  reconciliation: ReconciliationState | undefined,
  lastRenderedPos: { latitude: number; longitude: number; altitude: number } | undefined,
  enableDynamicDelay: boolean,
): {
  result: TimelineInterpolationResult
  newLastKnownHeading: number
  newReconciliation: ReconciliationState | null
  newDynamicDelay: DynamicDelayState | null
} | null {
  const { observations: allObservations, metadata, lastSource, callsign, dynamicDelay } = timeline

  if (allObservations.length === 0) {
    return null
  }

  // Filter observations to prefer vNAS when recent.
  // vNAS stops sending updates for idle/parked aircraft to save bandwidth, but we keep
  // VATSIM observations in the timeline as a fallback. When vNAS data is fresh (within
  // VNAS_PREFERENCE_THRESHOLD_MS), we use only vNAS observations for interpolation.
  // This provides smooth 1Hz interpolation when vNAS is active, and seamless fallback
  // to VATSIM's 15s updates when vNAS goes quiet.
  const observations = filterObservationsForSource(allObservations, now)

  // Get display delay from the most recent observation in our filtered set
  // This prevents position jumps when source changes (e.g., vNAS → VATSIM after landing)
  // because each observation remembers its own display delay from when it was created.
  // Fallback to SOURCE_DISPLAY_DELAYS[lastSource] for migration (old observations without displayDelay)
  const newestObs = observations[observations.length - 1]
  const oldestObs = observations[0]

  // Determine display delay: use dynamic delay if enabled and available, otherwise static
  let displayDelay: number
  let currentDynamicDelayState: DynamicDelayState | undefined

  if (enableDynamicDelay && dynamicDelay) {
    // Use current delay from dynamic state (includes any extrapolation bump from previous frames)
    displayDelay = dynamicDelay.currentDelayMs
    currentDynamicDelayState = dynamicDelay
  } else {
    // Static delay: use observation's recorded delay or fall back to source default
    displayDelay = newestObs.displayDelay ?? SOURCE_DISPLAY_DELAYS[lastSource]
  }

  // Calculate displayTime in the observation's time domain (server time) to handle clock skew.
  //
  // CRITICAL: We anchor to the OLDEST observation, not the newest. This ensures displayTime
  // progresses continuously with local time, regardless of when new observations arrive.
  //
  // If we anchored to newestObs, displayTime would jump whenever a new observation arrives:
  // - Before obs3: displayTime = obs2.observedAt - delay + 15000ms (waited 15s for update)
  // - After obs3: displayTime = obs3.observedAt - delay + 0ms (just received)
  // This causes a ~15s forward jump in displayTime, making aircraft visually snap.
  //
  // By anchoring to oldestObs, displayTime advances smoothly with local time:
  //   displayTime = oldestObs.observedAt + (now - oldestObs.receivedAt) - displayDelay
  //
  // As observations are pruned (MAX_OBSERVATIONS_PER_AIRCRAFT), the anchor stays fresh.
  const timeSinceOldestReceived = now - oldestObs.receivedAt
  const displayTime = oldestObs.observedAt + timeSinceOldestReceived - displayDelay

  // Find bracketing observations
  const [before, after] = findBracketingObservations(observations, displayTime)

  // DEBUG: Log interpolation state for ONE moving aircraft
  // Tracks position frame-to-frame to detect snaps
  // Only enabled when advanced.enableInterpolationDebugLogs is true in settings
  const debugLogsEnabled = useSettingsStore.getState().advanced?.enableInterpolationDebugLogs
  if (debugLogsEnabled) {
    const debugState = globalThis as Record<string, unknown>

    // Setup visibility change listener (once)
    if (!debugState.__visibilityListenerAdded && typeof document !== 'undefined') {
      debugState.__visibilityListenerAdded = true
      debugState.__lastVisibilityState = document.visibilityState
      document.addEventListener('visibilitychange', () => {
        const prevState = debugState.__lastVisibilityState
        const newState = document.visibilityState
        const ts = new Date().toISOString().slice(11, 23) // HH:MM:SS.mmm
        console.log(`[Interp] ${ts} 👁️ VISIBILITY: ${prevState} → ${newState}`)
        debugState.__lastVisibilityState = newState
        if (newState === 'visible') {
          debugState.__justBecameVisible = Date.now()
        }
      })
    }

    // Track the followed aircraft from viewport store
    // When user follows a new aircraft, switch debug logging to that aircraft
    const followedCallsign = useViewportStore.getState().getMainViewport()?.cameraState?.followingCallsign
    const currentTime = Date.now()

    // Check if current aircraft is the one we're tracking - update last seen time
    if (callsign === debugState.__interpDebugCallsign) {
      debugState.__interpDebugLastSeen = currentTime
    }

    // Auto-clear stale debug target when not following anyone
    // If we haven't seen the tracked aircraft in 5 seconds, clear it so we can pick a new one
    const STALE_THRESHOLD_MS = 5000
    const PICK_COOLDOWN_MS = 3000
    const lastSeen = debugState.__interpDebugLastSeen as number | undefined
    const lastPickAttempt = debugState.__interpDebugLastPickAttempt as number | undefined
    const isStale = debugState.__interpDebugCallsign && lastSeen && currentTime - lastSeen > STALE_THRESHOLD_MS

    if (isStale && !followedCallsign) {
      // Tracked aircraft disconnected and we're not following anyone - clear it
      const ts = new Date().toISOString().slice(11, 23)
      console.log(
        `[Interp] ${ts} DEBUG Aircraft ${debugState.__interpDebugCallsign} disconnected, will auto-pick new target`,
      )
      debugState.__interpDebugCallsign = null
      debugState.__interpDebugLastSeen = null
    }

    if (followedCallsign && followedCallsign !== debugState.__interpDebugCallsign) {
      // User started following a new aircraft - switch to tracking it
      debugState.__interpDebugCallsign = followedCallsign
      debugState.__interpDebugCounter = 0
      debugState.__interpLastLat = null
      debugState.__interpLastLon = null
      debugState.__interpLastObsCount = 0
      debugState.__interpLastOldestObsAt = null
      debugState.__interpLastNow = null
      debugState.__interpDebugLastSeen = currentTime
      debugState.__interpDebugLastPickAttempt = currentTime
      const ts = new Date().toISOString().slice(11, 23)
      console.log(`[Interp] ${ts} DEBUG Now tracking (followed): ${followedCallsign}`)
    } else if (!debugState.__interpDebugCallsign && newestObs.groundspeed > 50) {
      // Fallback: auto-pick first aircraft with positive airspeed if not following anyone
      // But only if we haven't tried recently (cooldown to avoid spam)
      const canPick = !lastPickAttempt || currentTime - lastPickAttempt > PICK_COOLDOWN_MS
      if (canPick) {
        debugState.__interpDebugCallsign = callsign
        debugState.__interpDebugCounter = 0
        debugState.__interpLastLat = null
        debugState.__interpLastLon = null
        debugState.__interpLastObsCount = 0
        debugState.__interpLastOldestObsAt = null
        debugState.__interpLastNow = null
        debugState.__interpDebugLastSeen = currentTime
        debugState.__interpDebugLastPickAttempt = currentTime
        const ts = new Date().toISOString().slice(11, 23)
        console.log(`[Interp] ${ts} DEBUG Now tracking: ${callsign} (gs=${newestObs.groundspeed.toFixed(0)}kts)`)
      }
    }

    if (callsign === debugState.__interpDebugCallsign) {
      debugState.__interpDebugCounter = ((debugState.__interpDebugCounter as number) || 0) + 1
      const counter = debugState.__interpDebugCounter as number
      const ts = new Date().toISOString().slice(11, 23) // HH:MM:SS.mmm

      // Calculate interpolation details
      const mode = before && after ? 'INTERP' : before ? 'EXTRAP_FWD' : after ? 'EXTRAP_BWD' : 'NONE'
      let t = 0
      let interval = 0
      if (before && after) {
        interval = after.observedAt - before.observedAt
        t = interval > 0 ? (displayTime - before.observedAt) / interval : 1
      }

      // Detect oldestObs change (anchor point shift)
      const prevOldestObsAt = debugState.__interpLastOldestObsAt as number | null
      const oldestObsChanged = prevOldestObsAt !== null && prevOldestObsAt !== oldestObs.observedAt

      // Detect now jump (time skip from background)
      const prevNow = debugState.__interpLastNow as number | null
      const nowDelta = prevNow !== null ? now - prevNow : 0
      const nowJumped = nowDelta > 100 // More than 100ms between frames = suspicious

      // Log every 60 frames (~1 second) OR when observation count changes OR anchor changes OR now jumps
      const obsCountChanged = observations.length !== debugState.__interpLastObsCount
      const shouldLog = counter % 60 === 1 || obsCountChanged || oldestObsChanged || nowJumped

      if (shouldLog) {
        const dtFromNewest = displayTime - newestObs.observedAt
        const visibility = typeof document !== 'undefined' ? document.visibilityState : 'unknown'
        const justVisible = debugState.__justBecameVisible && now - (debugState.__justBecameVisible as number) < 1000

        // Build info tags
        const tags: string[] = []
        if (obsCountChanged) tags.push('NEW_OBS')
        if (oldestObsChanged) tags.push(`ANCHOR_SHIFT(${prevOldestObsAt}→${oldestObs.observedAt})`)
        if (nowJumped) tags.push(`NOW_JUMP(+${nowDelta}ms)`)
        if (justVisible) tags.push('JUST_VISIBLE')
        if (visibility === 'hidden') tags.push('HIDDEN')

        const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : ''

        console.log(
          `[Interp] ${ts} ${callsign} ${mode} t=${t.toFixed(3)} obs=${observations.length} ` +
            `interval=${(interval / 1000).toFixed(1)}s dtNewest=${Math.round(dtFromNewest)}ms ` +
            `now=${now}${tagStr}`,
        )

        // Log observation timestamps when new data arrives or anchor changes
        if ((obsCountChanged || oldestObsChanged) && observations.length >= 2) {
          const obsInfo = observations
            .slice(0, 2)
            .concat(observations.slice(-2))
            .map((o, i) => `${i < 2 ? 'oldest' : 'newest'}[${i % 2}]: ${o.observedAt}`)
          console.log(`[Interp] ${ts}   Observations: ${obsInfo.join(', ')}`)
          console.log(
            `[Interp] ${ts}   displayTime=${displayTime} anchor=(obsAt=${oldestObs.observedAt}, rcvAt=${oldestObs.receivedAt})`,
          )
        }

        debugState.__interpLastObsCount = observations.length
      }

      // Update tracking state
      debugState.__interpLastOldestObsAt = oldestObs.observedAt
      debugState.__interpLastNow = now
    }
  }

  let latitude: number
  let longitude: number
  let altitude: number
  let groundspeed: number
  let groundTrack: number | null
  let onGround: boolean | null
  let pitch: number | null
  let roll: number | null
  let verticalRate: number | null
  let isExtrapolating = false
  let newReconciliation: ReconciliationState | null = null

  if (before && after) {
    // INTERPOLATION: displayTime is between two observations
    const interval = after.observedAt - before.observedAt
    const t = interval > 0 ? (displayTime - before.observedAt) / interval : 1

    // Check if we're targeting a new 'after' observation OR if anchor shifted.
    // Anchor shift invalidates reconciliation because startDisplayTime was calculated
    // with the old anchor, and displayTime has now jumped to a different value.
    const anchorChanged = reconciliation && reconciliation.anchorObservedAt !== oldestObs.observedAt
    const isNewTarget = !reconciliation || reconciliation.targetObservedAt !== after.observedAt || anchorChanged

    if (isNewTarget) {
      if (lastRenderedPos) {
        // We know exactly where the aircraft was - use that as start point
        newReconciliation = {
          targetObservedAt: after.observedAt,
          startLat: lastRenderedPos.latitude,
          startLon: lastRenderedPos.longitude,
          startAlt: lastRenderedPos.altitude,
          startDisplayTime: displayTime,
          anchorObservedAt: oldestObs.observedAt,
        }
        // Debug: log when starting new reconciliation
        const debugState = globalThis as Record<string, unknown>
        if (callsign === debugState.__interpDebugCallsign) {
          const ts = new Date().toISOString().slice(11, 23)
          const reason = anchorChanged ? 'ANCHOR_SHIFT' : 'NEW_TARGET'
          console.log(
            `[Interp] ${ts} ${callsign} ${reason} - using lastRenderedPos (${lastRenderedPos.latitude.toFixed(4)}, ${lastRenderedPos.longitude.toFixed(4)}) targetObs=${after.observedAt}`,
          )
        }
      } else {
        // First time seeing this aircraft - use 'before' as start
        newReconciliation = {
          targetObservedAt: after.observedAt,
          startLat: before.latitude,
          startLon: before.longitude,
          startAlt: before.altitude,
          startDisplayTime: before.observedAt,
          anchorObservedAt: oldestObs.observedAt,
        }
        // Debug
        const debugState = globalThis as Record<string, unknown>
        if (callsign === debugState.__interpDebugCallsign) {
          const ts = new Date().toISOString().slice(11, 23)
          console.log(
            `[Interp] ${ts} ${callsign} NEW TARGET - NO lastRenderedPos, using before (${before.latitude.toFixed(4)}, ${before.longitude.toFixed(4)}) targetObs=${after.observedAt}`,
          )
        }
      }
    } else {
      // Continue with existing reconciliation
      newReconciliation = reconciliation!
    }

    // Interpolate from start position to 'after' over the remaining time
    const duration = after.observedAt - newReconciliation.startDisplayTime
    const elapsed = displayTime - newReconciliation.startDisplayTime
    const reconT = duration > 0 ? Math.min(1, elapsed / duration) : 1

    latitude = lerp(newReconciliation.startLat, after.latitude, reconT)
    longitude = lerp(newReconciliation.startLon, after.longitude, reconT)

    // Phase-aware altitude interpolation: use easing only at phase transitions
    // to match pitch rate-limiting behavior. During steady climbs/descents, use linear.
    //
    // Calculate vertical rates for adjacent segments to detect phase changes:
    // - If rate changes significantly (level→climb, climb→level), use smoothstep
    // - If rate is consistent (steady climb), use linear
    let altitudeBlend = 0 // 0 = linear, 1 = full smoothstep
    if (observations.length >= 2 && interval > 0) {
      // Current segment vertical rate (m/min)
      const currentRate = (after.altitude - before.altitude) / (interval / 60000)

      // Check segment BEFORE current (if exists)
      const beforeIdx = observations.indexOf(before)
      let prevRate = currentRate // Default to same rate if no previous segment
      if (beforeIdx > 0) {
        const prevObs = observations[beforeIdx - 1]
        const prevInterval = before.observedAt - prevObs.observedAt
        if (prevInterval > 0) {
          prevRate = (before.altitude - prevObs.altitude) / (prevInterval / 60000)
        }
      }

      // Check segment AFTER current (if exists)
      const afterIdx = observations.indexOf(after)
      let nextRate = currentRate // Default to same rate if no next segment
      if (afterIdx < observations.length - 1) {
        const nextObs = observations[afterIdx + 1]
        const nextInterval = nextObs.observedAt - after.observedAt
        if (nextInterval > 0) {
          nextRate = (nextObs.altitude - after.altitude) / (nextInterval / 60000)
        }
      }

      // Calculate how much the rate is changing at segment boundaries
      // Large changes = phase transition, apply more easing
      // Small changes = steady state, stay linear
      const RATE_CHANGE_THRESHOLD = 100 // m/min - significant change threshold
      const prevRateChange = Math.abs(currentRate - prevRate)
      const nextRateChange = Math.abs(currentRate - nextRate)

      // Apply easing proportional to rate change, capped at 0.7 (not full smoothstep)
      // Use the larger of the two boundary changes
      const maxRateChange = Math.max(prevRateChange, nextRateChange)
      altitudeBlend = Math.min(0.7, maxRateChange / (RATE_CHANGE_THRESHOLD * 3))
    }

    altitude = lerpBlended(newReconciliation.startAlt, after.altitude, reconT, altitudeBlend)
    groundspeed = lerp(before.groundspeed, after.groundspeed, t) // Speed uses observation-based t
    groundTrack =
      before.groundTrack !== null && after.groundTrack !== null
        ? lerpHeading(before.groundTrack, after.groundTrack, t)
        : (after.groundTrack ?? before.groundTrack)

    // FALLBACK: Calculate groundTrack from position change when not provided by data source
    // This is essential for VATSIM data which doesn't include ground track.
    // Without this, pushback detection fails because track defaults to heading.
    if (groundTrack === null && interval > 0) {
      // Calculate distance moved in meters (approximate, using equirectangular projection)
      const latDiff = after.latitude - before.latitude
      const lonDiff = after.longitude - before.longitude
      const avgLat = (before.latitude + after.latitude) / 2
      const latMeters = latDiff * 111320 // 1 degree lat ≈ 111.32 km
      const lonMeters = lonDiff * 111320 * Math.cos((avgLat * Math.PI) / 180)
      const distanceMeters = Math.sqrt(latMeters * latMeters + lonMeters * lonMeters)

      // Require minimum movement to calculate reliable bearing:
      // - At least 3 meters total (exceeds typical GPS noise of 2-5m)
      // - OR at least 0.5 m/s average speed (ensures meaningful movement for short intervals)
      // This handles both:
      // - VATSIM (15s intervals): 3m threshold easily met at pushback speeds
      // - vNAS (1s intervals): 0.5 m/s = ~1 kt, needs at least slow taxi to calculate
      const intervalSeconds = interval / 1000
      const minDistanceForInterval = Math.max(3.0, 0.5 * intervalSeconds)

      if (distanceMeters > minDistanceForInterval) {
        groundTrack = calculateBearing(before.latitude, before.longitude, after.latitude, after.longitude)
      }
    }

    // Interpolate ADS-B data if available on both observations
    onGround = after.onGround // Use the later observation's ground state
    pitch =
      before.pitch !== null && after.pitch !== null ? lerp(before.pitch, after.pitch, t) : (after.pitch ?? before.pitch)
    roll = before.roll !== null && after.roll !== null ? lerp(before.roll, after.roll, t) : (after.roll ?? before.roll)

    // Vertical rate: prefer ADS-B data, otherwise calculate from observation altitude delta
    if (before.verticalRate !== null && after.verticalRate !== null) {
      // Both have ADS-B vertical rate - interpolate
      verticalRate = lerp(before.verticalRate, after.verticalRate, t)
    } else if (after.verticalRate !== null) {
      verticalRate = after.verticalRate
    } else if (before.verticalRate !== null) {
      verticalRate = before.verticalRate
    } else if (interval > 0) {
      // No ADS-B data - calculate from observation altitude delta
      // This gives a stable rate for the entire interpolation phase
      const altitudeDeltaMeters = after.altitude - before.altitude
      const intervalMinutes = interval / 60000
      const verticalRateMetersPerMin = altitudeDeltaMeters / intervalMinutes
      // Convert m/min to fpm for consistency with ADS-B data
      verticalRate = verticalRateMetersPerMin / 0.3048
    } else {
      verticalRate = null
    }
  } else if (before) {
    // EXTRAPOLATION FORWARD: displayTime is after all observations
    const extrapolationTime = displayTime - before.observedAt
    const clampedExtrapolation = Math.min(extrapolationTime, MAX_EXTRAPOLATION_TIME)

    const extrapolated = extrapolatePosition(before, clampedExtrapolation)
    latitude = extrapolated.latitude
    longitude = extrapolated.longitude
    altitude = extrapolated.altitude
    groundspeed = before.groundspeed
    groundTrack = before.groundTrack

    // FALLBACK: Calculate groundTrack from position change if not provided (e.g., VATSIM)
    // Use the last two observations to determine direction of travel
    if (groundTrack === null && observations.length >= 2) {
      const prev = observations[observations.length - 2]
      const obsInterval = before.observedAt - prev.observedAt

      if (obsInterval > 0) {
        // Calculate distance moved in meters (approximate, using equirectangular projection)
        const latDiff = before.latitude - prev.latitude
        const lonDiff = before.longitude - prev.longitude
        const avgLat = (prev.latitude + before.latitude) / 2
        const latMeters = latDiff * 111320
        const lonMeters = lonDiff * 111320 * Math.cos((avgLat * Math.PI) / 180)
        const distanceMeters = Math.sqrt(latMeters * latMeters + lonMeters * lonMeters)

        // Same threshold logic as interpolation case
        const intervalSeconds = obsInterval / 1000
        const minDistanceForInterval = Math.max(3.0, 0.5 * intervalSeconds)

        if (distanceMeters > minDistanceForInterval) {
          groundTrack = calculateBearing(prev.latitude, prev.longitude, before.latitude, before.longitude)
        }
      }
    }

    // Pass through ADS-B data from last observation
    onGround = before.onGround
    pitch = before.pitch
    roll = before.roll

    // Clear reconciliation during extrapolation - we'll start fresh when new data arrives
    // The lastRenderedPos (tracked by caller) will tell us where we were
    newReconciliation = null

    // Vertical rate: prefer ADS-B data, otherwise estimate from recent observations
    if (before.verticalRate !== null) {
      verticalRate = before.verticalRate
    } else if (observations.length >= 2) {
      // Calculate from the last two observations
      const prev = observations[observations.length - 2]
      const interval = before.observedAt - prev.observedAt
      if (interval > 0) {
        const altitudeDeltaMeters = before.altitude - prev.altitude
        const intervalMinutes = interval / 60000
        const verticalRateMetersPerMin = altitudeDeltaMeters / intervalMinutes
        verticalRate = verticalRateMetersPerMin / 0.3048 // Convert to fpm
      } else {
        verticalRate = null
      }
    } else {
      verticalRate = null
    }
    isExtrapolating = true
  } else if (after) {
    // EXTRAPOLATION BACKWARD: displayTime is before all observations (rare)
    // Just use the first observation as-is
    latitude = after.latitude
    longitude = after.longitude
    altitude = after.altitude
    groundspeed = after.groundspeed
    groundTrack = after.groundTrack
    // Pass through ADS-B data
    onGround = after.onGround
    pitch = after.pitch
    roll = after.roll
    verticalRate = after.verticalRate
    isExtrapolating = true
  } else {
    // No observations (shouldn't happen if we checked length > 0)
    return null
  }

  // Derive heading using our smart logic
  const { heading, isReliable } = deriveHeading(observations, before, after, lastKnownHeading)

  // Interpolate heading between observations for smooth animation
  // We always interpolate when we have two observations, even if headings are "unreliable"
  // (e.g., RealTraffic derived from track). This prevents jarring yaw snaps on ground.
  // The "unreliable" flag is for choosing which heading to trust, not for skipping interpolation.
  let finalHeading = heading
  if (before && after) {
    const interval = after.observedAt - before.observedAt
    const t = interval > 0 ? (displayTime - before.observedAt) / interval : 1
    // Use the headings from observations (whether true or derived) for smooth interpolation
    finalHeading = lerpHeading(before.heading, after.heading, t)
  }

  // Update lastKnownHeading if this heading is reliable
  const newLastKnownHeading = isReliable ? finalHeading : (lastKnownHeading ?? finalHeading)

  // Calculate observation age (how old is the most recent observation)
  const mostRecent = observations[observations.length - 1]
  const observationAge = now - mostRecent.receivedAt

  // Debug: Log position delta from last frame (only for tracked aircraft)
  const debugState = globalThis as Record<string, unknown>
  if (callsign === debugState.__interpDebugCallsign && lastRenderedPos) {
    const latDelta = (latitude - lastRenderedPos.latitude) * 111320
    const lonDelta = (longitude - lastRenderedPos.longitude) * 111320 * Math.cos((latitude * Math.PI) / 180)
    const distance = Math.sqrt(latDelta * latDelta + lonDelta * lonDelta)
    if (distance > 50) {
      const ts = new Date().toISOString().slice(11, 23)
      const justVisible = debugState.__justBecameVisible && now - (debugState.__justBecameVisible as number) < 2000
      const visibility = typeof document !== 'undefined' ? document.visibilityState : 'unknown'
      console.log(
        `[Interp] ${ts} ${callsign} ⚠️ SNAP! delta=${distance.toFixed(1)}m ` +
          `from=(${lastRenderedPos.latitude.toFixed(5)}, ${lastRenderedPos.longitude.toFixed(5)}) ` +
          `to=(${latitude.toFixed(5)}, ${longitude.toFixed(5)}) ` +
          `visibility=${visibility}${justVisible ? ' JUST_VISIBLE' : ''}`,
      )
    }
  }

  // Update dynamic delay state if enabled.
  // This applies smooth transitions and handles extrapolation bumps.
  // The updated state is returned so the caller can persist it for next frame.
  let newDynamicDelay: DynamicDelayState | null = null
  if (currentDynamicDelayState) {
    const { updatedState } = applyDelayTransition(currentDynamicDelayState, now, isExtrapolating)
    newDynamicDelay = updatedState
  }

  return {
    result: {
      callsign,
      latitude,
      longitude,
      altitude,
      heading: finalHeading,
      groundspeed,
      groundTrack,
      // Extended ADS-B data
      onGround,
      pitch,
      roll,
      verticalRate,
      // Metadata
      cid: metadata.cid,
      aircraftType: metadata.aircraftType,
      transponder: metadata.transponder,
      departure: metadata.departure,
      arrival: metadata.arrival,
      source: lastSource,
      displayDelay,
      isExtrapolating,
      observationAge,
      observationCount: observations.length,
      displayTime,
    },
    newLastKnownHeading,
    newReconciliation,
    newDynamicDelay,
  }
}

export const useAircraftTimelineStore = create<AircraftTimelineStore>((set, get) => ({
  timelines: new Map(),
  recentlyRemoved: new Map(),
  lastKnownHeadings: new Map(),
  lastRenderedPositions: new Map(),
  reconciliationStates: new Map(),
  pruneTimer: null,

  /**
   * Add a single observation for an aircraft
   */
  addObservation: (callsign, observation, metadata) => {
    // Don't accept live data while viewing replay/imported
    if (useReplayStore.getState().playbackMode !== 'live') return

    const { timelines } = get()
    const existing = timelines.get(callsign)

    // Merge metadata to preserve VATSIM flight plan data when vNAS provides positions
    const mergedMetadata = mergeAircraftMetadata(existing?.metadata, metadata)

    let observations: AircraftObservation[]
    let pruned = false
    let oldestBefore: number | null = null
    let oldestAfter: number | null = null

    if (existing) {
      oldestBefore = existing.observations[0]?.observedAt ?? null

      // Check if this observation is too close to the last one
      const lastObs = existing.observations[existing.observations.length - 1]
      if (lastObs && observation.receivedAt - lastObs.receivedAt < MIN_OBSERVATION_INTERVAL) {
        // Too close, skip this observation but update metadata
        const updated = new Map(timelines)
        updated.set(callsign, {
          ...existing,
          metadata: mergedMetadata,
          lastSource: observation.source,
          lastReceivedAt: observation.receivedAt,
        })
        set({ timelines: updated })
        return
      }

      // Add to existing timeline
      observations = [...existing.observations, observation]

      // Prune old observations by age (and hard cap)
      const pruneResult = pruneObservations(observations, observation.receivedAt)
      observations = pruneResult.pruned
      pruned = pruneResult.wasPruned

      oldestAfter = observations[0]?.observedAt ?? null
    } else {
      // New aircraft
      observations = [observation]
      oldestAfter = observation.observedAt
    }

    // Update dynamic delay state
    const dynamicDelay = updateDynamicDelayState(existing?.dynamicDelay, observations, observation.receivedAt)

    // Debug: Log observation additions for tracked aircraft
    if (import.meta.env.DEV) {
      const debugState = globalThis as Record<string, unknown>
      if (callsign === debugState.__interpDebugCallsign) {
        const ts = new Date().toISOString().slice(11, 23)
        const anchorShift =
          oldestBefore !== null && oldestBefore !== oldestAfter ? ` ANCHOR_SHIFT(${oldestBefore}→${oldestAfter})` : ''
        const intervalInfo =
          dynamicDelay.intervalHistory.length > 0
            ? ` intervals=[${dynamicDelay.intervalHistory.map((i) => i.toFixed(0)).join(',')}]ms target=${dynamicDelay.targetDelayMs.toFixed(0)}ms`
            : ''
        console.log(
          `[Interp] ${ts} ${callsign} +OBS obsAt=${observation.observedAt} rcvAt=${observation.receivedAt} ` +
            `total=${observations.length}${pruned ? ' PRUNED' : ''}${anchorShift}${intervalInfo}`,
        )
      }
    }

    const updated = new Map(timelines)
    updated.set(callsign, {
      callsign,
      observations,
      metadata: mergedMetadata,
      lastSource: observation.source,
      lastReceivedAt: observation.receivedAt,
      dynamicDelay,
    })

    // Remove from graveyard if aircraft reappeared
    const { recentlyRemoved } = get()
    if (recentlyRemoved.has(callsign)) {
      const updatedGraveyard = new Map(recentlyRemoved)
      updatedGraveyard.delete(callsign)
      set({ timelines: updated, recentlyRemoved: updatedGraveyard })
    } else {
      set({ timelines: updated })
    }

    // Broadcast observation to insets and remote browsers
    if (observationBroadcastCallback) {
      observationBroadcastCallback([{ callsign, observation, metadata: mergedMetadata }])
    }
  },

  /**
   * Add a batch of observations (more efficient for snapshots)
   */
  addObservationBatch: (batch) => {
    if (useReplayStore.getState().playbackMode !== 'live') return
    const { timelines } = get()
    const updated = new Map(timelines)

    for (const { callsign, observation, metadata } of batch) {
      const existing = updated.get(callsign)

      // Merge metadata to preserve VATSIM flight plan data when vNAS provides positions
      const mergedMetadata = mergeAircraftMetadata(existing?.metadata, metadata)

      // Always add VATSIM observations to keep the timeline alive, even when vNAS
      // is active. This ensures we have fallback data when vNAS goes quiet for
      // idle/parked aircraft. The interpolation logic will prefer vNAS observations
      // when they're recent (within VNAS_PREFERENCE_THRESHOLD_MS).
      //
      // However, don't insert VATSIM observations that are older than our newest
      // observation - that would insert stale data into the middle of the timeline.
      if (observation.source === 'vatsim' && existing) {
        const newestExisting = existing.observations[existing.observations.length - 1]
        if (newestExisting && observation.observedAt <= newestExisting.observedAt) {
          // VATSIM observation is older than what we have - skip position but update metadata
          // The mergedMetadata already has the correct priority (VATSIM cid, transponder, departure, arrival)
          updated.set(callsign, {
            ...existing,
            metadata: mergedMetadata,
            // Update lastReceivedAt to keep the timeline alive
            lastReceivedAt: observation.receivedAt,
          })
          continue
        }
      }

      let observations: AircraftObservation[]
      let pruned = false
      let oldestBefore: number | null = null
      let oldestAfter: number | null = null

      if (existing) {
        oldestBefore = existing.observations[0]?.observedAt ?? null

        // Check if this observation is too close to the last one
        const lastObs = existing.observations[existing.observations.length - 1]
        if (lastObs && observation.receivedAt - lastObs.receivedAt < MIN_OBSERVATION_INTERVAL) {
          // Too close, skip but update metadata
          updated.set(callsign, {
            ...existing,
            metadata: mergedMetadata,
            lastSource: observation.source,
            lastReceivedAt: observation.receivedAt,
          })
          continue
        }

        observations = [...existing.observations, observation]

        // Prune old observations by age (and hard cap)
        const pruneResult = pruneObservations(observations, observation.receivedAt)
        observations = pruneResult.pruned
        pruned = pruneResult.wasPruned

        oldestAfter = observations[0]?.observedAt ?? null
      } else {
        observations = [observation]
        oldestAfter = observation.observedAt
      }

      // Update dynamic delay state
      const dynamicDelay = updateDynamicDelayState(existing?.dynamicDelay, observations, observation.receivedAt)

      // Debug: Log observation additions for tracked aircraft
      if (import.meta.env.DEV) {
        const debugState = globalThis as Record<string, unknown>
        if (callsign === debugState.__interpDebugCallsign) {
          const ts = new Date().toISOString().slice(11, 23)
          const anchorShift =
            oldestBefore !== null && oldestBefore !== oldestAfter ? ` ANCHOR_SHIFT(${oldestBefore}→${oldestAfter})` : ''
          const intervalInfo =
            dynamicDelay.intervalHistory.length > 0
              ? ` intervals=[${dynamicDelay.intervalHistory.map((i) => i.toFixed(0)).join(',')}]ms target=${dynamicDelay.targetDelayMs.toFixed(0)}ms`
              : ''
          console.log(
            `[Interp] ${ts} ${callsign} +OBS obsAt=${observation.observedAt} rcvAt=${observation.receivedAt} ` +
              `total=${observations.length}${pruned ? ' PRUNED' : ''}${anchorShift}${intervalInfo}`,
          )
        }
      }

      updated.set(callsign, {
        callsign,
        observations,
        metadata: mergedMetadata,
        lastSource: observation.source,
        lastReceivedAt: observation.receivedAt,
        dynamicDelay,
      })
    }

    // Remove reappeared aircraft from graveyard
    const { recentlyRemoved } = get()
    let updatedGraveyard: Map<string, GraveyardEntry> | null = null
    for (const { callsign } of batch) {
      if (recentlyRemoved.has(callsign)) {
        if (!updatedGraveyard) updatedGraveyard = new Map(recentlyRemoved)
        updatedGraveyard.delete(callsign)
      }
    }

    if (updatedGraveyard) {
      set({ timelines: updated, recentlyRemoved: updatedGraveyard })
    } else {
      set({ timelines: updated })
    }

    // Broadcast observations to insets (if callback registered by main app)
    if (observationBroadcastCallback && batch.length > 0) {
      observationBroadcastCallback(batch)
    }
  },

  /**
   * Remove an aircraft from the timeline
   */
  removeAircraft: (callsign) => {
    const { timelines, recentlyRemoved, lastKnownHeadings, lastRenderedPositions, reconciliationStates } = get()
    const timeline = timelines.get(callsign)
    if (timeline) {
      const updatedTimelines = new Map(timelines)
      updatedTimelines.delete(callsign)

      // Move to graveyard for diagnostic capture
      const updatedGraveyard = new Map(recentlyRemoved)
      updatedGraveyard.set(callsign, { timeline, removedAt: Date.now() })

      const updatedHeadings = new Map(lastKnownHeadings)
      updatedHeadings.delete(callsign)

      const updatedPositions = new Map(lastRenderedPositions)
      updatedPositions.delete(callsign)

      const updatedReconciliations = new Map(reconciliationStates)
      updatedReconciliations.delete(callsign)

      set({
        timelines: updatedTimelines,
        recentlyRemoved: updatedGraveyard,
        lastKnownHeadings: updatedHeadings,
        lastRenderedPositions: updatedPositions,
        reconciliationStates: updatedReconciliations,
      })

      // Broadcast removal to insets (if callback registered by main app)
      if (removalBroadcastCallback) {
        removalBroadcastCallback([callsign])
      }
    }
  },

  /**
   * Remove aircraft that haven't received updates recently
   */
  pruneStaleAircraft: () => {
    // Skip pruning in replay/imported modes — all data is historical
    const playbackMode = useReplayStore.getState().playbackMode
    if (playbackMode !== 'live') return

    const { timelines, recentlyRemoved, lastKnownHeadings, lastRenderedPositions, reconciliationStates } = get()
    const now = Date.now()
    const removedCallsigns: string[] = []

    const updatedTimelines = new Map(timelines)
    const updatedGraveyard = new Map(recentlyRemoved)
    const updatedHeadings = new Map(lastKnownHeadings)
    const updatedPositions = new Map(lastRenderedPositions)
    const updatedReconciliations = new Map(reconciliationStates)

    // Move timed-out aircraft to graveyard
    for (const [callsign, timeline] of timelines) {
      if (now - timeline.lastReceivedAt > AIRCRAFT_TIMEOUT) {
        updatedTimelines.delete(callsign)
        updatedGraveyard.set(callsign, { timeline, removedAt: now })
        updatedHeadings.delete(callsign)
        updatedPositions.delete(callsign)
        updatedReconciliations.delete(callsign)
        removedCallsigns.push(callsign)
      }
    }

    // Purge graveyard entries older than MAX_OBSERVATION_AGE_MS
    for (const [callsign, entry] of recentlyRemoved) {
      if (now - entry.removedAt > MAX_OBSERVATION_AGE_MS) {
        updatedGraveyard.delete(callsign)
      }
    }

    const graveyardChanged = updatedGraveyard.size !== recentlyRemoved.size

    if (removedCallsigns.length > 0 || graveyardChanged) {
      set({
        timelines: updatedTimelines,
        recentlyRemoved: updatedGraveyard,
        lastKnownHeadings: updatedHeadings,
        lastRenderedPositions: updatedPositions,
        reconciliationStates: updatedReconciliations,
      })

      // Broadcast removals to insets (if callback registered by main app)
      if (removedCallsigns.length > 0 && removalBroadcastCallback) {
        removalBroadcastCallback(removedCallsigns)
      }
    }
  },

  /**
   * Start the periodic prune timer
   */
  startPruneTimer: () => {
    const { pruneTimer } = get()
    if (pruneTimer) return

    const timer = setInterval(() => {
      get().pruneStaleAircraft()
    }, PRUNE_INTERVAL)

    set({ pruneTimer: timer })
  },

  /**
   * Stop the periodic prune timer
   */
  stopPruneTimer: () => {
    const { pruneTimer } = get()
    if (pruneTimer) {
      clearInterval(pruneTimer)
      set({ pruneTimer: null })
    }
  },

  /**
   * Clear all timelines
   */
  clear: () => {
    set({
      timelines: new Map(),
      recentlyRemoved: new Map(),
      lastKnownHeadings: new Map(),
      lastRenderedPositions: new Map(),
      reconciliationStates: new Map(),
    })
  },

  clearInterpolationState: () => {
    set({
      lastRenderedPositions: new Map(),
      reconciliationStates: new Map(),
    })
  },

  /**
   * Get interpolated state for a single aircraft
   *
   * NOTE: This is a pure getter - it does NOT update lastKnownHeadings.
   * Use getInterpolatedStates() for the main rendering loop, which
   * batches heading updates efficiently.
   */
  getInterpolatedState: (callsign, now) => {
    const { timelines, lastKnownHeadings } = get()
    const timeline = timelines.get(callsign)
    if (!timeline) return null

    const lastKnownHeading = lastKnownHeadings.get(callsign) ?? null
    const reconciliation = get().reconciliationStates.get(callsign)
    const lastPosition = get().lastRenderedPositions.get(callsign)
    const enableDynamicDelay = useSettingsStore.getState().advanced?.enableDynamicDisplayDelay ?? true
    const result = interpolateTimeline(
      timeline,
      now,
      lastKnownHeading,
      reconciliation,
      lastPosition,
      enableDynamicDelay,
    )

    // Return result without mutating store state
    // Heading/reconciliation/dynamicDelay updates are only applied by getInterpolatedStates() batch operation
    return result?.result ?? null
  },

  /**
   * Get interpolated states for all aircraft
   */
  getInterpolatedStates: (now) => {
    const { timelines, lastKnownHeadings, lastRenderedPositions, reconciliationStates } = get()
    const results = new Map<string, TimelineInterpolationResult>()
    const updatedHeadings = new Map(lastKnownHeadings)
    const updatedPositions = new Map(lastRenderedPositions)
    const updatedReconciliations = new Map(reconciliationStates)
    // Defer timeline Map creation until we actually need it (avoids allocation on every frame)
    let updatedTimelines: Map<string, AircraftTimeline> | null = null
    let headingsChanged = false
    let positionsChanged = false
    let reconciliationsChanged = false
    let timelinesChanged = false

    // Get dynamic delay setting once for all aircraft
    const enableDynamicDelay = useSettingsStore.getState().advanced?.enableDynamicDisplayDelay ?? true

    for (const [callsign, timeline] of timelines) {
      const lastKnownHeading = lastKnownHeadings.get(callsign) ?? null
      const lastPosition = lastRenderedPositions.get(callsign)
      const reconciliation = reconciliationStates.get(callsign)
      const interpolation = interpolateTimeline(
        timeline,
        now,
        lastKnownHeading,
        reconciliation,
        lastPosition,
        enableDynamicDelay,
      )

      if (interpolation) {
        results.set(callsign, interpolation.result)

        // Track heading updates
        if (interpolation.newLastKnownHeading !== lastKnownHeading) {
          updatedHeadings.set(callsign, interpolation.newLastKnownHeading)
          headingsChanged = true
        }

        // Update last rendered position for next frame
        const { latitude, longitude, altitude } = interpolation.result
        const prevPos = lastRenderedPositions.get(callsign)
        if (
          !prevPos ||
          prevPos.latitude !== latitude ||
          prevPos.longitude !== longitude ||
          prevPos.altitude !== altitude
        ) {
          updatedPositions.set(callsign, { latitude, longitude, altitude })
          positionsChanged = true
        }

        // Update reconciliation state
        if (interpolation.newReconciliation !== reconciliation) {
          if (interpolation.newReconciliation) {
            updatedReconciliations.set(callsign, interpolation.newReconciliation)
          } else {
            updatedReconciliations.delete(callsign)
          }
          reconciliationsChanged = true
        }

        // Update dynamic delay state on the timeline only if meaningful values changed.
        // Compare by value since applyDelayTransition always returns a new object.
        // Only currentDelayMs matters for rendering; extrapolationBumpMs affects future transitions.
        if (interpolation.newDynamicDelay) {
          const oldDelay = timeline.dynamicDelay
          const newDelay = interpolation.newDynamicDelay
          const delayChanged =
            !oldDelay ||
            oldDelay.currentDelayMs !== newDelay.currentDelayMs ||
            oldDelay.extrapolationBumpMs !== newDelay.extrapolationBumpMs

          if (delayChanged) {
            // Lazily create the Map copy only when we have changes
            if (!updatedTimelines) {
              updatedTimelines = new Map(timelines)
            }
            updatedTimelines.set(callsign, {
              ...timeline,
              dynamicDelay: newDelay,
            })
            timelinesChanged = true
          }
        }
      }
    }

    // Batch update state if anything changed
    if (headingsChanged || positionsChanged || reconciliationsChanged || timelinesChanged) {
      set({
        lastKnownHeadings: headingsChanged ? updatedHeadings : lastKnownHeadings,
        lastRenderedPositions: positionsChanged ? updatedPositions : lastRenderedPositions,
        reconciliationStates: reconciliationsChanged ? updatedReconciliations : reconciliationStates,
        timelines: timelinesChanged ? updatedTimelines! : timelines,
      })
    }

    return results
  },

  /**
   * Get the raw timeline for an aircraft (for debugging)
   */
  getTimeline: (callsign) => {
    return get().timelines.get(callsign)
  },

  /**
   * Get the data loading status for the overlay.
   * Returns whether we have aircraft in range and whether any are ready to render.
   */
  getDataLoadingStatus: () => {
    const { timelines } = get()
    let hasAircraftInRange = false
    let hasReadyAircraft = false

    for (const timeline of timelines.values()) {
      if (timeline.observations.length >= 1) {
        hasAircraftInRange = true
      }
      if (timeline.observations.length >= 2) {
        hasReadyAircraft = true
        break // Found a ready aircraft, no need to continue
      }
    }

    return { hasAircraftInRange, hasReadyAircraft }
  },

  /**
   * Load all replay snapshots into the timeline store.
   * Converts each snapshot into observations for all aircraft.
   */
  loadReplaySnapshots: (snapshots) => {
    // Clear existing data
    get().clear()

    if (snapshots.length === 0) return

    // Build timelines from all snapshots
    const timelines = new Map<string, AircraftTimeline>()

    for (const snapshot of snapshots) {
      const snapshotTime = snapshot.timestamp

      for (const state of snapshot.aircraftStates) {
        const callsign = state.callsign

        // Create observation from serialized state
        // Use extended fields if available (newer exports include these)
        const observation: AircraftObservation = {
          latitude: state.latitude,
          longitude: state.longitude,
          altitude: state.altitude,
          heading: state.heading,
          groundspeed: state.groundspeed,
          groundTrack: state.groundTrack ?? null,
          headingIsTrue: false, // Assume not true heading for VATSIM data
          onGround: state.onGround === 1 ? true : state.onGround === 0 ? false : null,
          pitch: null, // Not available in replay data
          roll: state.roll ?? null,
          verticalRate: state.baroRate ?? null,
          source: 'replay',
          observedAt: snapshotTime,
          receivedAt: snapshotTime,
          displayDelay: SOURCE_DISPLAY_DELAYS.replay, // No delay for replay - we're scrubbing through historical data
        }

        const metadata: AircraftMetadata = {
          cid: state.cid,
          aircraftType: state.aircraftType,
          transponder: state.transponder,
          departure: state.departure,
          arrival: state.arrival,
        }

        const existing = timelines.get(callsign)
        if (existing) {
          // Add to existing timeline
          existing.observations.push(observation)
          existing.metadata = metadata
          existing.lastSource = 'replay'
          existing.lastReceivedAt = snapshotTime
        } else {
          // Create new timeline
          timelines.set(callsign, {
            callsign,
            observations: [observation],
            metadata,
            lastSource: 'replay',
            lastReceivedAt: snapshotTime,
          })
        }
      }
    }

    // Prune observations by age (relative to latest snapshot)
    const latestSnapshotTime = snapshots[snapshots.length - 1]?.timestamp ?? Date.now()
    for (const timeline of timelines.values()) {
      const { pruned } = pruneObservations(timeline.observations, latestSnapshotTime)
      timeline.observations = pruned
    }

    set({ timelines, lastKnownHeadings: new Map() })
  },

  loadImportedTimelines: (serialized) => {
    get().clear()

    if (serialized.length === 0) return

    const timelines = new Map<string, AircraftTimeline>()

    for (const entry of serialized) {
      // Normalize observations for imported playback:
      // - Set receivedAt = observedAt so the interpolation anchor math works
      //   (interpolateTimeline computes: displayTime = oldest.observedAt + (now - oldest.receivedAt) - delay)
      //   With receivedAt = observedAt and delay = 0, displayTime = now, which is what we want.
      // - Set displayDelay = 0 (no delay for scrubbing historical data)
      const normalizedObs: AircraftObservation[] = entry.observations.map((obs) => ({
        ...obs,
        receivedAt: obs.observedAt,
        displayDelay: 0,
      }))

      timelines.set(entry.callsign, {
        callsign: entry.callsign,
        observations: normalizedObs,
        metadata: { ...entry.metadata },
        lastSource: entry.lastSource,
        lastReceivedAt: entry.lastReceivedAt,
        // Clear dynamic delay — not meaningful for imported playback
        dynamicDelay: undefined,
      })
    }

    set({ timelines, lastKnownHeadings: new Map() })
  },

  /**
   * Get the time range of loaded replay data.
   */
  getReplayTimeRange: () => {
    const { timelines } = get()
    if (timelines.size === 0) return null

    let minTime = Infinity
    let maxTime = -Infinity

    for (const timeline of timelines.values()) {
      for (const obs of timeline.observations) {
        if (obs.observedAt < minTime) minTime = obs.observedAt
        if (obs.observedAt > maxTime) maxTime = obs.observedAt
      }
    }

    if (minTime === Infinity || maxTime === -Infinity) return null

    return { start: minTime, end: maxTime }
  },
}))
