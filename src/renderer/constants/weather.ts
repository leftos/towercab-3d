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

// ============================================================================
// WEATHER SMOOTHING / HYSTERESIS
// ============================================================================

/**
 * Transition time for visibility changes (seconds)
 * Controls how fast fog opacity/scale responds to METAR updates
 * Higher = smoother but slower to respond to real weather changes
 */
export const VISIBILITY_TRANSITION_TIME = 8.0

/**
 * Transition time for fog density changes (seconds)
 */
export const FOG_DENSITY_TRANSITION_TIME = 8.0

/**
 * Transition time for wind direction changes (seconds)
 * Uses circular interpolation to handle wrap-around at 360°
 */
export const WIND_DIRECTION_TRANSITION_TIME = 5.0

/**
 * Transition time for wind speed changes (seconds)
 */
export const WIND_SPEED_TRANSITION_TIME = 3.0

/**
 * Transition time for precipitation intensity fade in/out (seconds)
 * Controls how fast rain/snow particles ramp up or down
 */
export const PRECIPITATION_FADE_TIME = 4.0

/**
 * Hysteresis threshold for precipitation activation (seconds)
 * Precipitation must be reported for this long before showing
 * Prevents flickering when hovering near boundary between stations
 */
export const PRECIPITATION_ONSET_DELAY = 2.0

/**
 * Hysteresis threshold for precipitation deactivation (seconds)
 * Precipitation must be absent for this long before hiding
 */
export const PRECIPITATION_CESSATION_DELAY = 5.0

/**
 * Hysteresis threshold for thunderstorm activation (seconds)
 */
export const THUNDERSTORM_ONSET_DELAY = 1.0

/**
 * Hysteresis threshold for thunderstorm deactivation (seconds)
 */
export const THUNDERSTORM_CESSATION_DELAY = 8.0

/**
 * Minimum visibility change (statute miles) to trigger transition
 * Changes smaller than this are applied instantly
 */
export const VISIBILITY_CHANGE_THRESHOLD = 0.1

/**
 * Minimum wind direction change (degrees) to trigger transition
 */
export const WIND_DIRECTION_CHANGE_THRESHOLD = 5

/**
 * Minimum wind speed change (knots) to trigger transition
 */
export const WIND_SPEED_CHANGE_THRESHOLD = 2
