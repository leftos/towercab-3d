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
  vatsim: 17000,      // 17 seconds (15s updates + 1s poll + 1s jitter buffer)
  vnas: 1500,         // 1.5 seconds (1Hz updates, just need minimal buffer)
  realtraffic: 5000,  // 5 seconds
  replay: 0,          // No delay for replay - we're scrubbing through historical data
  broadcast: 50       // 50ms for inset broadcasts (~30-60Hz, need 2 observations for interpolation)
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
export const MAX_OBSERVATION_AGE_MS = 5 * 60 * 1000  // 5 minutes

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
export const MAX_EXTRAPOLATION_TIME = 30000  // 30 seconds

/**
 * Time without any updates before removing aircraft from the timeline (ms).
 *
 * If we haven't received ANY data for this long, the aircraft is
 * considered gone (disconnected, out of range, etc.).
 */
export const AIRCRAFT_TIMEOUT = 30000  // 30 seconds

/**
 * Minimum time between observations to consider them distinct (ms).
 *
 * If two observations arrive within this window, we might skip one
 * to avoid cluttering the timeline with near-duplicate data.
 */
export const MIN_OBSERVATION_INTERVAL = 100  // 100ms

/**
 * How often to prune stale aircraft from the timeline store (ms).
 */
export const PRUNE_INTERVAL = 10000  // 10 seconds
