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
 * Ground contact is entered below this height over the type's resting height (3 ft). Before the type's resting height
 * is learned, the drop rule decides contact instead (`DROP_CONTACT_*`).
 */
export const CONTACT_ENTER_HEIGHT_METERS = 3 * 0.3048

/**
 * Ground contact is left above this height over the type's resting height (5 ft); a stopped vNAS sample at or below
 * it is parked. Before the type's resting height is learned, the parked test takes the raw height.
 */
export const CONTACT_EXIT_HEIGHT_METERS = 5 * 0.3048

/** A vNAS sample under this groundspeed (kt) is a resting-height sample for its aircraft type */
export const RESTING_HEIGHT_MAX_GROUNDSPEED_KTS = 5

/** A vNAS sample at or above this raw height above ground (30 ft) is never a resting-height sample */
export const RESTING_HEIGHT_MAX_SAMPLE_METERS = 30 * 0.3048

/** Resting-height samples kept per aircraft type; the resting height is their median */
export const RESTING_HEIGHT_SAMPLE_WINDOW = 9

/** Resting-height samples a type needs before its resting height is learned */
export const RESTING_HEIGHT_MIN_SAMPLES = 3

/** Before the type's resting height is learned, contact is entered only below this raw height (20 ft) */
export const DROP_CONTACT_MAX_HEIGHT_METERS = 20 * 0.3048

/** Before the type's resting height is learned, contact is left above this raw height (20 ft + 5 ft) */
export const DROP_CONTACT_EXIT_HEIGHT_METERS = 25 * 0.3048

/** Span of frames over which the drop rule measures the height's rate (ms) */
export const DROP_CONTACT_RATE_WINDOW_MS = 1000

/**
 * The drop rule's frames may span at most this long (ms); a longer span (a paused frame loop, a seek forward) starts
 * them again, since a rate over it says nothing about the height now
 */
export const DROP_CONTACT_RATE_MAX_SPAN_MS = 2 * DROP_CONTACT_RATE_WINDOW_MS

/** The drop rule enters contact while the height's rate stays within this many m/s of 0 (1 ft/s) */
export const DROP_CONTACT_STEADY_RATE_MPS = 1 * 0.3048

/** The drop rule leaves contact when the height rises faster than this (3 ft/s, in m/s) */
export const DROP_CONTACT_EXIT_RATE_MPS = 3 * 0.3048

/** Time over which an aircraft's drawn height eases by its type's resting height when that is first learned (ms) */
export const RESTING_HEIGHT_EASE_MS = 250

/**
 * Span of vNAS samples over which a sample's own speed is measured (ms).
 *
 * The speed is the distance from the sample at or just before this long earlier to the sample, over the time
 * between them. Under STOPPED_SPEED_KTS the sample marks a stop: the silence after it is parking. A span rather
 * than the last two samples, because vNAS can repeat a position for a moving aircraft.
 */
export const VNAS_STOP_WINDOW_MS = 3000 // 3 seconds

/**
 * Receive interval after a stopped vNAS sample beyond which it is parking silence, not a late sample (ms).
 *
 * Such an interval is left out of the display-delay statistics, so a hold does not raise the delay.
 */
export const VNAS_PARKED_GAP_MS = 3000 // 3 seconds

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
 * Minimum observations needed before switching from the source's display delay
 * (the observation's displayDelay, else SOURCE_DISPLAY_DELAYS) to the delay
 * measured from observation intervals. Need at least 3 to have 2 intervals.
 */
export const DYNAMIC_DELAY_MIN_OBSERVATIONS = 3

/**
 * Maximum rate at which delay can decrease (ms per second).
 * Prevents position jumps when delay shrinks too fast. At 100 ms per second the aircraft plays at 1.1x
 * while the delay shrinks, so a new VATSIM aircraft's drop from 17 s to about 15.15 s takes about 18 s.
 */
export const DYNAMIC_DELAY_MAX_DECREASE_RATE = 100

/**
 * Maximum rate at which delay can increase (ms per second).
 * Without this, source flips like vNAS→VATSIM (target jumps from ~1.2s to ~15s
 * because the interval window now sees 15s VATSIM gaps) would snap displayTime
 * backwards by ~14s in a single frame. A rising delay plays the aircraft slower
 * than real time, so it stops guessing ahead instead of jumping; at 500 ms per
 * second that ~14s catch-up takes about 28s, against about 140s when the rise
 * matched the 100 ms per second decrease cap.
 */
export const DYNAMIC_DELAY_MAX_INCREASE_RATE = 500

/**
 * Most elapsed time one delay transition counts (ms). A frame gap longer than this (a hidden tab, a return to
 * live from buffer replay) moves the delay by this much worth of the rate limit, not by the whole gap: 100 ms
 * when the delay falls, 500 ms when it rises. Frames at 1 fps or faster ease at the full rate.
 */
export const DYNAMIC_DELAY_MAX_ELAPSED_MS = 1000

/**
 * Amount added to the delay target when extrapolation is detected (ms).
 * The delay rises toward the raised target at DYNAMIC_DELAY_MAX_INCREASE_RATE, so at 500 ms per second the
 * full bump takes 0.4 s to apply; until then the aircraft may keep extrapolating.
 */
export const DYNAMIC_DELAY_EXTRAPOLATION_BUMP_MS = 200

/**
 * Rate at which the extrapolation bump decays (ms per second).
 * After an extrapolation event, the bump gradually decreases
 * as observations arrive reliably.
 */
export const DYNAMIC_DELAY_EXTRAPOLATION_DECAY_RATE = 100
