/**
 * API endpoints and polling configuration
 *
 * This file centralizes external API URLs and polling/refresh intervals
 * for data fetching services.
 *
 * Used by: VatsimService, MetarService, AirportService
 */

// ============================================================================
// API ENDPOINTS
// ============================================================================

/**
 * VATSIM data feed API endpoint
 *
 * Returns current pilot, controller, and ATIS data for the VATSIM network.
 * Data format: JSON (v3 API)
 *
 * @see https://data.vatsim.net/v3/vatsim-data.json
 */
export const VATSIM_DATA_URL = 'https://data.vatsim.net/v3/vatsim-data.json'

/**
 * Aviation Weather API endpoint for METAR data
 *
 * Government-provided METAR (weather) data for airports worldwide.
 * Data format: Text (parsed by MetarService)
 *
 * @see https://aviationweather.gov/api/data/metar
 */
export const AVIATION_WEATHER_URL = 'https://aviationweather.gov/api/data/metar'

/**
 * Airport database GitHub repository URL
 *
 * mwgg/Airports repository contains 28,000+ airports with coordinates,
 * elevations, and timezone data.
 * Data format: JSON
 *
 * @see https://github.com/mwgg/Airports
 */
export const AIRPORTS_DB_URL = 'https://raw.githubusercontent.com/mwgg/Airports/master/airports.json'

/**
 * OurAirports runway data URL
 *
 * Comprehensive runway data for airports worldwide including:
 * - Threshold coordinates (lat/lon for both ends)
 * - Runway headings (true)
 * - Dimensions (length, width)
 * - Surface type and operational status
 *
 * Data format: CSV (~3MB, ~45,000 runways)
 * Updated: Weekly
 *
 * @see https://ourairports.com/data/
 */
export const RUNWAYS_DB_URL = 'https://davidmegginson.github.io/ourairports-data/runways.csv'

// ============================================================================
// VATSIM POLLING CONFIGURATION
// ============================================================================

/**
 * VATSIM data poll interval in milliseconds
 *
 * How often to fetch new data from VATSIM API.
 * Set to 3 seconds to catch updates quickly, even though VATSIM only
 * updates every ~15 seconds. This ensures we get new data as soon as
 * it's available.
 *
 * Default: 3000ms (3 seconds)
 */
export const VATSIM_POLL_INTERVAL = 3000

/**
 * Expected VATSIM data update interval in milliseconds
 *
 * Actual time between VATSIM server-side data updates.
 * Used for interpolation timing calculations.
 *
 * Default: 15000ms (15 seconds)
 */
export const VATSIM_ACTUAL_UPDATE_INTERVAL = 15000

// ============================================================================
// WEATHER REFRESH CONFIGURATION
// ============================================================================

/**
 * Weather (METAR) refresh interval in milliseconds
 *
 * How often to fetch new METAR data for the current airport.
 * METAR data typically updates hourly, but we refresh more frequently
 * to catch intermediate updates (SPECI).
 *
 * Default: 300000ms (5 minutes)
 */
export const WEATHER_REFRESH_INTERVAL = 300000

/**
 * Minimum time between nearest METAR fetches in milliseconds
 *
 * Throttle for position-based weather fetches to avoid excessive API calls
 * when camera moves frequently.
 *
 * Default: 30000ms (30 seconds)
 */
export const NEAREST_METAR_THROTTLE = 30000

/**
 * Position change threshold for nearest METAR refetch in degrees
 *
 * Minimum camera movement required to trigger a new nearest METAR fetch.
 * ~0.05° ≈ 3 nautical miles
 *
 * Default: 0.05 degrees
 */
export const POSITION_CHANGE_THRESHOLD = 0.05

// ============================================================================
// CACHING CONFIGURATION
// ============================================================================

/**
 * Tile cache time-to-live in milliseconds
 *
 * How long to keep terrain/imagery tiles in cache before considering them stale.
 * Used by service worker tile caching.
 *
 * Default: 86400000ms (24 hours)
 */
export const TILE_CACHE_TTL = 86400000

// ============================================================================
// RETRY CONFIGURATION
// ============================================================================

/**
 * Maximum number of retry attempts for failed API requests
 *
 * Default: 3 retries
 */
export const API_MAX_RETRIES = 3

/**
 * Retry delay in milliseconds
 *
 * Delay before retrying a failed API request.
 * Uses exponential backoff: delay * (attempt^2)
 *
 * Default: 1000ms (1 second base delay)
 */
export const API_RETRY_DELAY = 1000
