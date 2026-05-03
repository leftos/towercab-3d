/**
 * Aircraft Timeline Constants
 *
 * Configuration for the unified per-aircraft timeline interpolation system.
 */

import type { AircraftDataSource } from '../types/aircraft-timeline'

/**
 * Display delays per data source in milliseconds.
 *
 * These determine how far "behind real-time" aircraft are displayed.
 * The delay ensures we have enough observations for smooth interpolation.
 *
 * - VATSIM: 15s snapshots, need at least one full interval of history
 * - vNAS: 1Hz updates, just need a couple seconds of history
 * - RealTraffic: ~2s polls with 1.5-4.5s apiDelta, need ~5s for P90 coverage
 */
export const SOURCE_DISPLAY_DELAYS: Record<AircraftDataSource, number> = {
  vatsim: 17000, // 17 seconds (15s updates + 1s poll + 1s jitter buffer)
  vnas: 1500, // 1.5 seconds (1Hz updates, just need minimal buffer)
  realtraffic: 5000, // 5 seconds
  replay: 0, // No delay for replay - we're scrubbing through historical data
  broadcast: 50, // 50ms for inset broadcasts (~30-60Hz, need 2 observations for interpolation)
}

/**
 * Maximum age of observations to keep per aircraft (ms).
 *
 * Observations older than this are pruned to limit memory usage while
 * providing consistent replay history across all data sources.
 *
 * 5 minutes provides:
 * - VATSIM (15s intervals): ~20 observations
 * - vNAS (1Hz): ~300 observations
 * - RealTraffic (~2s): ~150 observations
 */
export const MAX_OBSERVATION_AGE_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Hard cap on observations per aircraft as a safety limit.
 *
 * Even with time-based pruning, we cap the count to prevent unbounded
 * growth if timestamps are corrupted or clock skew occurs.
 * At 1Hz for 5 minutes = 300, so 400 provides some headroom.
 */
export const MAX_OBSERVATIONS_PER_AIRCRAFT = 400

/**
 * Maximum extrapolation time before clamping (ms).
 *
 * If we're extrapolating beyond this duration, something is wrong
 * (aircraft stopped updating). We clamp extrapolation to prevent
 * aircraft from flying off into the distance.
 */
export const MAX_EXTRAPOLATION_TIME = 30000 // 30 seconds

/**
 * Time without any updates before removing aircraft from the timeline (ms).
 *
 * If we haven't received ANY data for this long, the aircraft is
 * considered gone (disconnected, out of range, etc.).
 */
export const AIRCRAFT_TIMEOUT = 30000 // 30 seconds

/**
 * How long to prefer vNAS observations over VATSIM for interpolation (ms).
 *
 * When vNAS data exists within this threshold, interpolation uses only vNAS
 * observations. After this period without vNAS updates (e.g., for idle/parked
 * aircraft), we fall back to VATSIM observations.
 *
 * VATSIM observations are always added to keep the timeline alive, but they're
 * only used for interpolation when vNAS data is stale.
 */
export const VNAS_PREFERENCE_THRESHOLD_MS = 30000 // 30 seconds

/**
 * Minimum time between observations to consider them distinct (ms).
 *
 * If two observations arrive within this window, we might skip one
 * to avoid cluttering the timeline with near-duplicate data.
 */
export const MIN_OBSERVATION_INTERVAL = 100 // 100ms

/**
 * How often to prune stale aircraft from the timeline store (ms).
 */
export const PRUNE_INTERVAL = 10000 // 10 seconds

// ============================================================================
// Dynamic Display Delay Constants
// ============================================================================
// These control the adaptive delay system that minimizes latency while
// ensuring we always have enough observations to interpolate (not extrapolate).

/**
 * Number of recent observation intervals to track when calculating
 * the dynamic display delay. We use the maximum interval in this window
 * to ensure we always have buffer for the worst recent case.
 */
export const DYNAMIC_DELAY_INTERVAL_WINDOW = 5

/**
 * Safety margin added on top of the maximum observed interval (ms).
 * This provides buffer for network jitter and timing variations.
 */
export const DYNAMIC_DELAY_JITTER_BUFFER_MS = 150

/**
 * Minimum dynamic display delay (ms).
 * Even with very fast updates, we need some buffer for smooth rendering.
 */
export const DYNAMIC_DELAY_MIN_MS = 150

/**
 * Maximum dynamic display delay (ms).
 * Cap for sporadic updates - beyond this, we accept extrapolation.
 */
export const DYNAMIC_DELAY_MAX_MS = 20000

/**
 * Default delay used when there aren't enough observations to calculate
 * a dynamic delay (ms). Conservative value for new aircraft.
 */
export const DYNAMIC_DELAY_BOOTSTRAP_MS = 2000

/**
 * Minimum observations needed before switching from bootstrap delay
 * to calculated dynamic delay. Need at least 3 to have 2 intervals.
 */
export const DYNAMIC_DELAY_MIN_OBSERVATIONS = 3

/**
 * Maximum rate at which delay can decrease (ms per second).
 * Prevents position jumps when delay shrinks too fast.
 */
export const DYNAMIC_DELAY_MAX_DECREASE_RATE = 500

/**
 * Maximum rate at which delay can increase (ms per second).
 * Without this, source flips like vNAS→VATSIM (target jumps from ~1.2s to ~15s
 * because the interval window now sees 15s VATSIM gaps) would snap displayTime
 * backwards by ~14s in a single frame. Rate-limiting matches the decrease cap
 * so transitions in either direction look the same.
 */
export const DYNAMIC_DELAY_MAX_INCREASE_RATE = 500

/**
 * Amount to increase delay when extrapolation is detected (ms).
 * This immediate bump ensures we don't extrapolate again on the next frame.
 */
export const DYNAMIC_DELAY_EXTRAPOLATION_BUMP_MS = 200

/**
 * Rate at which the extrapolation bump decays (ms per second).
 * After an extrapolation event, the bump gradually decreases
 * as observations arrive reliably.
 */
export const DYNAMIC_DELAY_EXTRAPOLATION_DECAY_RATE = 100
