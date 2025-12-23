/**
 * Weather interpolation constants
 *
 * Configuration for METAR weather interpolation and auto-airport switching features.
 */

// ============================================================================
// WEATHER INTERPOLATION
// ============================================================================

/**
 * Number of METAR stations to use for interpolation
 * More stations = smoother transitions but more API calls
 */
export const INTERPOLATION_STATION_COUNT = 3

/**
 * Maximum search radius for METAR stations in nautical miles
 * Stations beyond this distance are not considered
 */
export const INTERPOLATION_RADIUS_NM = 100

/**
 * Exponent for inverse distance weighting
 * - 1 = linear (1/d)
 * - 2 = inverse square (1/d^2) - default, gives more weight to closer stations
 * - 3 = inverse cube (1/d^3) - heavily weighted toward nearest
 */
export const INTERPOLATION_DISTANCE_POWER = 2

/**
 * Minimum weight threshold for including a station
 * Stations with weight below this are excluded from interpolation
 */
export const INTERPOLATION_MIN_WEIGHT = 0.05

/**
 * Altitude band for matching cloud layers when interpolating (feet)
 * Cloud layers within this altitude difference are considered the same layer
 */
export const CLOUD_ALTITUDE_BAND_FEET = 500

/**
 * Throttle interval for weather interpolation updates (ms)
 * Limits how often interpolation is recalculated as camera moves
 */
export const INTERPOLATION_UPDATE_THROTTLE_MS = 2000

/**
 * Minimum distance camera must move before re-fetching weather (degrees)
 * Approximately 0.05 degrees = 3 nautical miles
 */
export const INTERPOLATION_POSITION_THRESHOLD_DEG = 0.05

// ============================================================================
// AUTO-AIRPORT SWITCHING
// ============================================================================

/**
 * Interval for checking camera distance to airports (ms)
 * Lower = more responsive but more CPU usage
 */
export const AUTO_SWITCH_CHECK_INTERVAL_MS = 2000

/**
 * Hysteresis distance for preventing rapid airport switching (nm)
 * Must move this far past the nearest airport boundary before switching back
 */
export const AUTO_SWITCH_HYSTERESIS_NM = 5

/**
 * Minimum distance from current airport before considering a switch (nm)
 * Prevents switching when very close to current airport
 */
export const AUTO_SWITCH_MIN_DISTANCE_NM = 2
