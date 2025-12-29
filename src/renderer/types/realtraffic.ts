/**
 * RealTraffic API Type Definitions
 *
 * Types for the RealTraffic (RTAPI) integration, providing real-world ADS-B
 * aircraft data as an alternative to VATSIM network data.
 *
 * RealTraffic API Documentation: https://www.flyrealtraffic.com/api/
 * API Version: v5
 *
 * @see realTrafficStore - Store that manages RealTraffic data
 * @see RealTrafficService - Service that handles API communication
 */

// ============================================================================
// AUTHENTICATION TYPES
// ============================================================================

/**
 * RealTraffic authentication request payload
 *
 * Sent to POST /v5/auth to start a session.
 */
export interface RTAuthRequest {
  /** RealTraffic license key (from RealTraffic.lic or manual entry) */
  lic: string
}

/**
 * RealTraffic authentication response
 *
 * Returned from POST /v5/auth.
 * Note: Field names use exact casing from API (GUID is uppercase).
 */
export interface RTAuthResponse {
  /** API status code (200 = success) */
  status: number
  /** Session GUID for subsequent API calls (uppercase from API) */
  GUID: string
  /** License type: 0 = Standard, 2 = Professional */
  type: number
  /** Rate limit for traffic requests in milliseconds */
  rrl: number
  /** Rate limit for weather requests in milliseconds */
  wrrl: number
  /** License expiry timestamp (Unix seconds) */
  expiry: number
  /** Error message (present when status !== 200) */
  message?: string
}

// ============================================================================
// TRAFFIC REQUEST TYPES
// ============================================================================

/**
 * RealTraffic traffic request payload
 *
 * Sent to POST /v5/traffic to fetch aircraft data.
 */
export interface RTTrafficRequest {
  /** Session GUID from authentication */
  guid: string
  /** Query type (1 = bounding box) */
  querytype: number
  /** Minimum latitude of bounding box */
  latmin: number
  /** Maximum latitude of bounding box */
  latmax: number
  /** Minimum longitude of bounding box */
  lonmin: number
  /** Maximum longitude of bounding box */
  lonmax: number
  /** Time offset in minutes into the past (Pro license only, 0 = real-time) */
  toffset?: number
}

// ============================================================================
// TRAFFIC RESPONSE TYPES
// ============================================================================

/**
 * Single aircraft record from RealTraffic API
 *
 * Array indices based on API_traffic.py documentation:
 * [0] hexid - ICAO 24-bit aircraft address (hex string)
 * [1] lat - Latitude
 * [2] lon - Longitude
 * [3] track - Ground track in degrees (direction of travel)
 * [4] baro_alt - Barometric altitude in feet
 * [5] gs - Ground speed in knots
 * [6] squawk - Transponder squawk code
 * [7] source - Data source identifier
 * [8] type - ICAO aircraft type code (e.g., "B738", "A320")
 * [9] tail - Aircraft registration (e.g., "N12345")
 * [10] timestamp - Unix timestamp of position report
 * [11] from_iata - Departure airport IATA code
 * [12] to_iata - Arrival airport IATA code
 * [13] cs_icao - ICAO callsign (e.g., "DAL123")
 * [14] on_ground - 0 = airborne, 1 = on ground
 * [15] baro_rate - Vertical rate in feet per minute
 * [16] cs_iata - IATA callsign/flight number
 */
export interface RTTrafficRecord {
  /** ICAO 24-bit aircraft address (hex string, unique identifier) */
  hexid: string
  /** Latitude in decimal degrees */
  lat: number
  /** Longitude in decimal degrees */
  lon: number
  /** Ground track (direction of travel) in degrees (0-360) */
  track: number
  /** Barometric altitude in feet */
  baro_alt: number
  /** Ground speed in knots */
  gs: number
  /** Transponder squawk code (4 digits) */
  squawk: string
  /** Data source identifier */
  source: string
  /** ICAO aircraft type code (e.g., "B738", "A320", "C172") */
  type: string
  /** Aircraft registration/tail number (e.g., "N12345", "G-ABCD") */
  tail: string
  /** Unix timestamp of this position report */
  timestamp: number
  /** Departure airport IATA code (e.g., "LAX", "JFK") */
  from_iata: string
  /** Arrival airport IATA code (e.g., "SFO", "BOS") */
  to_iata: string
  /** ICAO callsign (e.g., "DAL123", "BAW456") */
  cs_icao: string
  /** On ground flag: 0 = airborne, 1 = on ground */
  on_ground: number
  /** Barometric vertical rate in feet per minute (positive = climbing) */
  baro_rate: number
  /** IATA flight number/callsign */
  cs_iata: string
}

/**
 * Raw traffic record from RealTraffic API
 *
 * Data comes as an array with values at these indices:
 * [0] hexid, [1] lat, [2] lon, [3] track, [4] baro_alt, [5] gs,
 * [6] squawk, [7] source, [8] type, [9] tail, [10] timestamp,
 * [11] from_iata, [12] to_iata, [13] cs_icao, [14] on_ground,
 * [15] baro_rate, [16] cs_iata, ...
 */
export type RTRawRecord = (string | number | null)[]

/**
 * RealTraffic traffic response
 *
 * Returned from POST /v5/traffic.
 */
export interface RTTrafficResponse {
  /** API status code (200 = success) */
  status: number
  /** Aircraft records keyed by hex ID, values are arrays */
  data: Record<string, RTRawRecord>
  /** Updated rate limit for traffic requests (milliseconds) */
  rrl: number
  /** Updated rate limit for weather requests (milliseconds) */
  wrrl: number
  /** Data epoch timestamp */
  dataepoch?: number
  /** Total aircraft count */
  full_count?: number
  /** Error message (present when status !== 200) */
  message?: string
}

// ============================================================================
// PARKED TRAFFIC TYPES
// ============================================================================

/**
 * Raw parked aircraft record from RealTraffic API
 *
 * Parked traffic uses a simpler format with these indices:
 * [0] latitude
 * [1] longitude
 * [2] gate_id (format: "ICAO_GATE", e.g., "YSSY_101")
 * [3] aircraft type (e.g., "A388", "B738")
 * [4] tail number (e.g., "VH-OQA")
 * [5] timestamp (Unix seconds when aircraft was last moving)
 * [6] callsign (ATC callsign)
 * [7] heading/track (for orientation on ground)
 */
export type RTParkedRecord = (string | number | null)[]

/**
 * RealTraffic parked traffic response
 *
 * Returned from POST /v5/traffic with querytype=parkedtraffic.
 * Aircraft whose last groundspeed was zero and position timestamp
 * is 10 minutes to 24 hours old.
 */
export interface RTParkedTrafficResponse {
  /** API status code (200 = success) */
  status: number
  /** Parked aircraft records keyed by hex ID */
  data: Record<string, RTParkedRecord>
  /** Updated rate limit for traffic requests (milliseconds) */
  rrl: number
  /** Total aircraft count in system */
  full_count?: number
  /** Data source */
  source?: string
  /** Data epoch timestamp */
  dataepoch?: number
  /** Error message (present when status !== 200) */
  message?: string
}

// ============================================================================
// ERROR TYPES
// ============================================================================

/**
 * RealTraffic API error response
 */
export interface RTErrorResponse {
  /** Error code */
  error: number
  /** Error message */
  message?: string
}

/**
 * RealTraffic error codes
 *
 * Known error codes from the API:
 * - 401: Invalid or expired session
 * - 403: License invalid or expired
 * - 429: Rate limit exceeded
 */
export const RT_ERROR_CODES = {
  INVALID_SESSION: 401,
  LICENSE_INVALID: 403,
  RATE_LIMITED: 429
} as const

// ============================================================================
// STORE TYPES
// ============================================================================

/**
 * RealTraffic connection status
 */
export type RTConnectionStatus =
  | 'disconnected'   // Not connected, no session
  | 'connecting'     // Authenticating
  | 'connected'      // Active session
  | 'error'          // Connection or auth error

/**
 * RealTraffic store state interface
 *
 * Used by realTrafficStore.ts
 */
export interface RealTrafficStoreState {
  // Connection state
  status: RTConnectionStatus
  sessionGuid: string | null
  isPro: boolean
  error: string | null

  // Rate limiting
  trafficRateLimit: number  // Milliseconds between traffic requests
  weatherRateLimit: number  // Milliseconds between weather requests

  // Historical data (Pro license only)
  timeOffset: number  // Minutes into the past (0 = real-time)

  // Reference position for bounding box queries
  referencePosition: { latitude: number; longitude: number } | null
}

// ============================================================================
// SETTINGS TYPES
// ============================================================================

/**
 * Data source selection for aircraft traffic
 *
 * Controls which source provides aircraft position data:
 * - 'vatsim': VATSIM network (virtual ATC, 15s updates)
 * - 'realtraffic': RealTraffic API (real-world ADS-B, ~3s updates)
 */
export type DataSourceType = 'vatsim' | 'realtraffic'

/**
 * RealTraffic-specific settings
 *
 * Stored in settings.realtraffic
 */
export interface RealTrafficSettings {
  /**
   * License key for RealTraffic API
   *
   * User can enter manually, or auto-detected from RealTraffic.lic
   */
  licenseKey: string

  /**
   * Attempt to auto-detect license from RealTraffic.lic file
   *
   * File location: %APPDATA%/InsideSystems/RealTraffic.lic (Windows)
   * Only works in Tauri desktop mode (not remote browser)
   */
  autoDetectLicense: boolean

  /**
   * Query radius in nautical miles
   *
   * Aircraft within this radius of the reference position will be fetched.
   * Range: 10-200 NM, Default: 100 NM
   */
  radiusNm: number
}

/**
 * Default RealTraffic settings
 */
export const DEFAULT_REALTRAFFIC_SETTINGS: RealTrafficSettings = {
  licenseKey: '',
  autoDetectLicense: true,
  radiusNm: 100
}
