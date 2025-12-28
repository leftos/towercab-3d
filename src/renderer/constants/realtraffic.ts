/**
 * RealTraffic API Constants
 *
 * Configuration constants for the RealTraffic (RTAPI) integration.
 *
 * @see RealTrafficService - Service that uses these constants
 * @see realTrafficStore - Store that manages RealTraffic data
 */

// ============================================================================
// API ENDPOINTS
// ============================================================================

/**
 * RealTraffic API base URL
 *
 * All API endpoints are relative to this base URL.
 * Uses HTTPS for secure communication.
 */
export const REALTRAFFIC_API_URL = 'https://rtwa.flyrealtraffic.com/v5'

/**
 * Authentication endpoint (relative to base URL)
 *
 * POST /auth with license key to obtain session GUID
 */
export const REALTRAFFIC_AUTH_ENDPOINT = '/auth'

/**
 * Traffic data endpoint (relative to base URL)
 *
 * POST /traffic with session GUID and bounding box to get aircraft data
 */
export const REALTRAFFIC_TRAFFIC_ENDPOINT = '/traffic'

// ============================================================================
// LICENSE FILE CONFIGURATION
// ============================================================================

/**
 * License file path relative to user's home directory (Windows)
 *
 * Full path: %APPDATA%/InsideSystems/RealTraffic.lic
 * The license file is typically created by the RealTraffic application.
 */
export const REALTRAFFIC_LICENSE_PATH_WIN = 'AppData/Roaming/InsideSystems/RealTraffic.lic'

/**
 * License file path relative to user's home directory (macOS)
 *
 * Full path: ~/Library/Application Support/InsideSystems/RealTraffic.lic
 */
export const REALTRAFFIC_LICENSE_PATH_MAC = 'Library/Application Support/InsideSystems/RealTraffic.lic'

// ============================================================================
// POLLING CONFIGURATION
// ============================================================================

/**
 * Default poll interval in milliseconds
 *
 * This is the initial poll interval before the API returns the actual rate limit.
 * The API response includes 'rrl' (rate limit in ms) which overrides this value.
 *
 * Default: 3000ms (3 seconds)
 */
export const REALTRAFFIC_DEFAULT_POLL_INTERVAL = 3000

/**
 * Minimum poll interval in milliseconds
 *
 * Safety floor to prevent excessive API requests even if the server
 * returns a very low rate limit value.
 *
 * Default: 1000ms (1 second)
 */
export const REALTRAFFIC_MIN_POLL_INTERVAL = 1000

/**
 * Maximum poll interval in milliseconds
 *
 * Maximum time to wait between poll requests.
 *
 * Default: 10000ms (10 seconds)
 */
export const REALTRAFFIC_MAX_POLL_INTERVAL = 10000

// ============================================================================
// QUERY CONFIGURATION
// ============================================================================

/**
 * Default query radius in nautical miles
 *
 * Controls the bounding box size for traffic queries.
 * Larger radius = more aircraft but higher data usage.
 *
 * Default: 100 NM
 */
export const REALTRAFFIC_DEFAULT_RADIUS_NM = 100

/**
 * Minimum query radius in nautical miles
 *
 * Default: 10 NM
 */
export const REALTRAFFIC_MIN_RADIUS_NM = 10

/**
 * Maximum query radius in nautical miles
 *
 * Larger values may return excessive data or hit API limits.
 *
 * Default: 200 NM
 */
export const REALTRAFFIC_MAX_RADIUS_NM = 200

/**
 * Query type for bounding box queries
 *
 * The API supports different query types; type 1 is bounding box.
 */
export const REALTRAFFIC_QUERY_TYPE_BBOX = 1

// ============================================================================
// HISTORICAL DATA CONFIGURATION (Pro License)
// ============================================================================

/**
 * Maximum time offset in minutes for historical data
 *
 * Pro license allows querying historical data up to this many minutes in the past.
 *
 * Default: 60 minutes
 */
export const REALTRAFFIC_MAX_TIME_OFFSET = 60

/**
 * Minimum time offset step in minutes
 *
 * Granularity for time offset slider.
 *
 * Default: 1 minute
 */
export const REALTRAFFIC_TIME_OFFSET_STEP = 1

// ============================================================================
// RETRY CONFIGURATION
// ============================================================================

/**
 * Maximum retry attempts for failed requests
 *
 * Number of times to retry a failed API request before giving up.
 *
 * Default: 3 retries
 */
export const REALTRAFFIC_MAX_RETRIES = 3

/**
 * Base retry delay in milliseconds
 *
 * Initial delay before first retry. Uses exponential backoff:
 * delay * (attempt ^ 2)
 *
 * Default: 1000ms (1 second)
 */
export const REALTRAFFIC_RETRY_DELAY = 1000

/**
 * Session refresh interval in milliseconds
 *
 * How often to refresh the session to prevent expiry.
 * Sessions may expire if not used for extended periods.
 *
 * Default: 300000ms (5 minutes)
 */
export const REALTRAFFIC_SESSION_REFRESH_INTERVAL = 300000

// ============================================================================
// UNIT CONVERSION
// ============================================================================

/**
 * Feet to meters conversion factor
 *
 * Used to convert RealTraffic altitude (feet) to internal meters.
 */
export const FEET_TO_METERS = 0.3048

/**
 * Nautical miles to degrees (approximate at equator)
 *
 * 1 NM = 1/60 degree of latitude
 * Used for bounding box calculations.
 */
export const NM_TO_DEGREES = 1 / 60
