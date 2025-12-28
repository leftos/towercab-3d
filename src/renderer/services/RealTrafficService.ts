/**
 * RealTraffic API Service
 *
 * Handles authentication and data fetching from the RealTraffic API (RTAPI).
 * Provides real-world ADS-B aircraft data as an alternative to VATSIM.
 *
 * @see realTrafficStore - Store that manages RealTraffic state
 * @see types/realtraffic.ts - Type definitions for API responses
 */

import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/utils/tauriApi'
import type {
  RTAuthResponse,
  RTTrafficResponse,
  RTRawRecord
} from '../types/realtraffic'
import type { AircraftState } from '../types/vatsim'
import {
  REALTRAFFIC_DEFAULT_POLL_INTERVAL,
  REALTRAFFIC_MIN_POLL_INTERVAL,
  REALTRAFFIC_MAX_RETRIES,
  REALTRAFFIC_RETRY_DELAY,
  FEET_TO_METERS,
  NM_TO_DEGREES
} from '../constants/realtraffic'

/**
 * RealTraffic auth result from Tauri command
 */
interface TauriAuthResult {
  success: boolean
  guid?: string
  isPro?: boolean
  trafficRateLimit?: number
  weatherRateLimit?: number
  error?: string
}

/**
 * Authentication result from RealTraffic API
 */
export interface AuthResult {
  success: boolean
  guid?: string
  isPro?: boolean
  trafficRateLimit?: number
  weatherRateLimit?: number
  error?: string
}

/**
 * Traffic fetch result from RealTraffic API
 */
export interface TrafficResult {
  success: boolean
  aircraft?: AircraftState[]
  trafficRateLimit?: number
  error?: string
}

/**
 * RealTraffic API Service
 *
 * Singleton service for communicating with the RealTraffic API.
 */
class RealTrafficService {
  private sessionGuid: string | null = null
  private isPro: boolean = false
  private trafficRateLimit: number = REALTRAFFIC_DEFAULT_POLL_INTERVAL
  private weatherRateLimit: number = REALTRAFFIC_DEFAULT_POLL_INTERVAL

  /**
   * Authenticate with RealTraffic API
   *
   * In Tauri desktop mode, uses Tauri commands to bypass CORS.
   * In browser/remote mode, uses the proxy endpoint which requires HTTP server.
   *
   * @param licenseKey - RealTraffic license key
   * @returns Authentication result with session GUID and license info
   */
  async authenticate(licenseKey: string): Promise<AuthResult> {
    if (!licenseKey) {
      return { success: false, error: 'No license key provided' }
    }

    // In Tauri mode, use Tauri command (bypasses CORS)
    if (isTauri()) {
      try {
        const result = await invoke<TauriAuthResult>('realtraffic_auth', { licenseKey })

        if (!result.success) {
          return { success: false, error: result.error || 'Authentication failed' }
        }

        // Store session info
        this.sessionGuid = result.guid || null
        this.isPro = result.isPro || false
        this.trafficRateLimit = Math.max(result.trafficRateLimit || REALTRAFFIC_DEFAULT_POLL_INTERVAL, REALTRAFFIC_MIN_POLL_INTERVAL)
        this.weatherRateLimit = result.weatherRateLimit || REALTRAFFIC_DEFAULT_POLL_INTERVAL

        return {
          success: true,
          guid: result.guid,
          isPro: result.isPro,
          trafficRateLimit: this.trafficRateLimit,
          weatherRateLimit: this.weatherRateLimit
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, error: `Authentication failed: ${message}` }
      }
    }

    // In browser mode, use proxy endpoint (requires HTTP server to be running)
    const url = '/api/realtraffic/auth'
    const payload = { licenseKey }

    try {
      const response = await this.fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      const data: RTAuthResponse = await response.json()

      // Check API status code (200 = success)
      if (data.status !== 200) {
        return { success: false, error: data.message || 'Authentication failed' }
      }

      // type 2 = Pro license
      const isPro = data.type === 2

      // Store session info (note: API uses uppercase GUID)
      this.sessionGuid = data.GUID
      this.isPro = isPro
      this.trafficRateLimit = Math.max(data.rrl, REALTRAFFIC_MIN_POLL_INTERVAL)
      this.weatherRateLimit = data.wrrl

      return {
        success: true,
        guid: data.GUID,
        isPro,
        trafficRateLimit: this.trafficRateLimit,
        weatherRateLimit: this.weatherRateLimit
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return { success: false, error: `Authentication failed: ${message}` }
    }
  }

  /**
   * Fetch traffic data from RealTraffic API
   *
   * In Tauri desktop mode, uses Tauri commands to bypass CORS.
   * In browser/remote mode, uses the proxy endpoint which requires HTTP server.
   *
   * @param centerLat - Center latitude for bounding box
   * @param centerLon - Center longitude for bounding box
   * @param radiusNm - Radius in nautical miles
   * @param timeOffset - Minutes into the past (Pro license only, 0 = real-time)
   * @returns Traffic data result with aircraft states
   */
  async fetchTraffic(
    centerLat: number,
    centerLon: number,
    radiusNm: number,
    timeOffset: number = 0
  ): Promise<TrafficResult> {
    if (!this.sessionGuid) {
      return { success: false, error: 'Not authenticated' }
    }

    // Calculate bounding box from center and radius
    // Account for latitude affecting longitude degrees
    const latOffset = radiusNm * NM_TO_DEGREES
    const lonOffset = radiusNm * NM_TO_DEGREES / Math.cos(centerLat * Math.PI / 180)

    const latMin = centerLat - latOffset
    const latMax = centerLat + latOffset
    const lonMin = centerLon - lonOffset
    const lonMax = centerLon + lonOffset

    // In Tauri mode, use Tauri command (bypasses CORS)
    if (isTauri()) {
      try {
        const params = {
          guid: this.sessionGuid,
          latMin,
          latMax,
          lonMin,
          lonMax,
          timeOffset: (timeOffset > 0 && this.isPro) ? timeOffset : undefined
        }

        const responseText = await invoke<string>('realtraffic_traffic', { params })
        const data: RTTrafficResponse = JSON.parse(responseText)

        // Check for API error status (e.g., 406 rate limit violation)
        // The API returns { status: 406, message: "...", server: "..." } when rate limited
        if (data.status && data.status !== 200) {
          const errorMessage = data.message || `API error: ${data.status}`
          console.warn('[RealTraffic] API error:', data.status, errorMessage)
          return {
            success: false,
            error: errorMessage,
            // Return current rate limit so caller doesn't reset to NaN
            trafficRateLimit: this.trafficRateLimit
          }
        }

        // Update rate limits from response (only if valid numbers)
        if (typeof data.rrl === 'number' && !isNaN(data.rrl)) {
          this.trafficRateLimit = Math.max(data.rrl, REALTRAFFIC_MIN_POLL_INTERVAL)
        }
        if (typeof data.wrrl === 'number' && !isNaN(data.wrrl)) {
          this.weatherRateLimit = data.wrrl
        }

        // Transform records to AircraftState
        // data.data is Record<hexid, RTRawRecord> where each value is an array
        const aircraft = Object.values(data.data || {}).map(record => this.transformRecord(record))

        return {
          success: true,
          aircraft,
          trafficRateLimit: this.trafficRateLimit
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('401')) {
          this.sessionGuid = null
          return { success: false, error: 'Session expired, please re-authenticate' }
        }
        return { success: false, error: `Traffic fetch failed: ${message}` }
      }
    }

    // In browser mode, use proxy endpoint (requires HTTP server to be running)
    const url = '/api/realtraffic/traffic'
    const payload = {
      guid: this.sessionGuid,
      lat1: latMin,
      lon1: lonMin,
      lat2: latMax,
      lon2: lonMax,
      toffset: (timeOffset > 0 && this.isPro) ? timeOffset : undefined
    }

    try {
      const response = await this.fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        if (response.status === 401) {
          // Session expired, clear it
          this.sessionGuid = null
          return { success: false, error: 'Session expired, please re-authenticate' }
        }
        if (response.status === 429) {
          return { success: false, error: 'Rate limit exceeded' }
        }
        const errorText = await response.text()
        return { success: false, error: `Traffic fetch failed: ${response.status} ${errorText}` }
      }

      const data: RTTrafficResponse = await response.json()

      // Update rate limits from response
      this.trafficRateLimit = Math.max(data.rrl, REALTRAFFIC_MIN_POLL_INTERVAL)
      this.weatherRateLimit = data.wrrl

      // Transform records to AircraftState
      // data.data is Record<hexid, RTRawRecord> where each value is an array
      const aircraft = Object.values(data.data).map(record => this.transformRecord(record))

      return {
        success: true,
        aircraft,
        trafficRateLimit: this.trafficRateLimit
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return { success: false, error: `Traffic fetch failed: ${message}` }
    }
  }

  /**
   * Transform a RealTraffic raw record (array) to AircraftState
   *
   * Maps RealTraffic API array indices to the internal AircraftState interface
   * used by the interpolation system.
   *
   * Full array indices from RealTraffic API v5:
   * [0] hexid, [1] lat, [2] lon, [3] track, [4] baro_alt, [5] gs,
   * [6] squawk, [7] source, [8] type, [9] tail, [10] timestamp,
   * [11] from_iata, [12] to_iata, [13] cs_icao, [14] on_ground,
   * [15] baro_rate, [16] cs_iata, [17] msg_type, [18] alt_geom,
   * [19] IAS, [20] TAS, [21] Mach, [22] track_rate, [23] roll,
   * [24] mag_heading, [25] true_heading, [26] geom_rate, [27] emergency,
   * [28] category, [29] nav_qnh, [30] mcp_alt, [31] fms_alt,
   * [32] selected_heading, [33] nav_modes, [34-38] nav accuracy fields,
   * [39] seen (position age), [40] rssi, [41-42] status bits,
   * [43] wind_dir, [44] wind_spd, [45] OAT, [46] TAT, [47] isICAOhex
   */
  private transformRecord(record: RTRawRecord): AircraftState {
    // Extract core values from array by index
    const hexid = String(record[0] ?? '')
    const lat = Number(record[1]) || 0
    const lon = Number(record[2]) || 0
    const track = Number(record[3]) || 0
    const baro_alt = Number(record[4]) || 0
    const gs = Number(record[5]) || 0
    const squawk = String(record[6] ?? '')
    // [7] source - provider code
    const type = String(record[8] ?? '')
    const tail = String(record[9] ?? '')
    // [10] timestamp - Unix timestamp when position was observed (used for stale detection)
    const api_timestamp = record[10] != null ? Number(record[10]) : null
    const from_iata = String(record[11] ?? '')
    const to_iata = String(record[12] ?? '')
    const cs_icao = String(record[13] ?? '')
    const on_ground = record[14] != null ? Number(record[14]) : null
    const baro_rate = record[15] != null ? Number(record[15]) : null // vertical rate in fpm
    // [16] cs_iata - IATA callsign
    // [17] msg_type - message source type

    // Extended ADS-B data (indices 18-47)
    // [18] alt_geom - GPS altitude (more accurate than baro)
    // [19-21] IAS, TAS, Mach
    const track_rate = record[22] != null ? Number(record[22]) : null // deg/sec, negative = left
    const roll = record[23] != null ? Number(record[23]) : null // degrees, negative = left
    // [24] mag_heading - magnetic heading
    const true_heading = record[25] != null ? Number(record[25]) : null // true heading (nose direction)
    // [26] geom_rate - geometric vertical rate
    // [27-38] emergency, category, nav data, accuracy fields
    const position_age = record[39] != null ? Number(record[39]) : null // seconds since last ADS-B update
    // [40-47] rssi, status bits, wind, temperature, hex validity

    // Use ICAO callsign if available, otherwise fall back to tail number
    // Some callsigns come with leading dots (e.g., ".N345AB") - strip them
    let callsign = cs_icao || tail || hexid
    if (callsign.startsWith('.')) {
      callsign = callsign.slice(1)
    }

    // Convert hex ID to numeric CID (for consistency with VATSIM)
    // Use parseInt with radix 16, but handle potential overflow for large hex values
    const cidFromHex = parseInt(hexid, 16)
    const cid = Number.isFinite(cidFromHex) ? cidFromHex : 0

    // For heading display: use true_heading if available (nose direction),
    // otherwise fall back to track (direction of movement)
    // This is especially important for ground aircraft where heading != track
    const displayHeading = (true_heading != null && !isNaN(true_heading)) ? true_heading : track

    return {
      callsign,
      cid,
      latitude: lat,
      longitude: lon,
      altitude: baro_alt * FEET_TO_METERS, // Convert feet to meters
      groundspeed: gs,
      heading: displayHeading, // Use true heading for display when available
      groundTrack: track, // Use ADS-B track for interpolation/extrapolation direction
      trueHeading: true_heading, // Store separately for explicit access
      trackRate: (track_rate != null && !isNaN(track_rate)) ? track_rate : null,
      roll: (roll != null && !isNaN(roll)) ? roll : null,
      baroRate: (baro_rate != null && !isNaN(baro_rate)) ? baro_rate : null,
      positionAge: (position_age != null && !isNaN(position_age)) ? position_age : null,
      onGround: on_ground,
      apiTimestamp: (api_timestamp != null && !isNaN(api_timestamp)) ? api_timestamp : null,
      transponder: squawk,
      aircraftType: type || null,
      departure: from_iata || null, // Note: IATA format
      arrival: to_iata || null,     // Note: IATA format
      timestamp: Date.now()
    }
  }

  /**
   * Fetch with retry logic (used for browser mode proxy requests)
   */
  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    retries: number = REALTRAFFIC_MAX_RETRIES
  ): Promise<Response> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, options)

        // Don't retry on client errors (4xx) except rate limiting
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          return response
        }

        // Retry on server errors (5xx) or rate limiting
        if (response.status >= 500 || response.status === 429) {
          if (attempt < retries) {
            await this.delay(REALTRAFFIC_RETRY_DELAY * Math.pow(2, attempt))
            continue
          }
        }

        return response
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error')
        if (attempt < retries) {
          await this.delay(REALTRAFFIC_RETRY_DELAY * Math.pow(2, attempt))
        }
      }
    }

    throw lastError || new Error('Request failed after retries')
  }

  /**
   * Delay helper for retry logic
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  // ============================================================================
  // GETTERS
  // ============================================================================

  /**
   * Check if currently authenticated
   */
  isAuthenticated(): boolean {
    return this.sessionGuid !== null
  }

  /**
   * Check if this is a Pro license
   */
  isProfessional(): boolean {
    return this.isPro
  }

  /**
   * Get current traffic rate limit in milliseconds
   */
  getTrafficRateLimit(): number {
    return this.trafficRateLimit
  }

  /**
   * Get current weather rate limit in milliseconds
   */
  getWeatherRateLimit(): number {
    return this.weatherRateLimit
  }

  /**
   * Get session GUID (for debugging)
   */
  getSessionGuid(): string | null {
    return this.sessionGuid
  }

  /**
   * Deauthenticate from RealTraffic API
   *
   * Releases the session on the server, allowing immediate reconnection.
   * Should be called when the app closes or stops polling.
   *
   * @returns True if deauth succeeded, false otherwise
   */
  async deauthenticate(): Promise<boolean> {
    if (!this.sessionGuid) {
      return true // No session to deauth
    }

    const guid = this.sessionGuid

    // In Tauri mode, use Tauri command
    if (isTauri()) {
      try {
        await invoke<void>('realtraffic_deauth', { guid })
        console.log('[RealTraffic] Deauthenticated successfully')
        this.clearSession()
        return true
      } catch (error) {
        console.warn('[RealTraffic] Deauth failed:', error)
        this.clearSession() // Clear local state anyway
        return false
      }
    }

    // In browser mode, use proxy endpoint
    try {
      const response = await fetch('/api/realtraffic/deauth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guid })
      })

      if (response.ok) {
        console.log('[RealTraffic] Deauthenticated successfully')
        this.clearSession()
        return true
      } else {
        console.warn('[RealTraffic] Deauth failed:', response.status)
        this.clearSession()
        return false
      }
    } catch (error) {
      console.warn('[RealTraffic] Deauth failed:', error)
      this.clearSession()
      return false
    }
  }

  /**
   * Clear session (logout) - clears local state only
   */
  clearSession(): void {
    this.sessionGuid = null
    this.isPro = false
    this.trafficRateLimit = REALTRAFFIC_DEFAULT_POLL_INTERVAL
    this.weatherRateLimit = REALTRAFFIC_DEFAULT_POLL_INTERVAL
  }
}

// Export singleton instance
export const realTrafficService = new RealTrafficService()
export default realTrafficService
