/**
 * Aircraft Timeline Types
 *
 * Unified data structures for per-aircraft observation timelines.
 * Supports interpolation across multiple data sources (VATSIM, vNAS, RealTraffic)
 * with source-appropriate display delays.
 */

/**
 * Data source identifier
 */
export type AircraftDataSource = 'vatsim' | 'vnas' | 'realtraffic' | 'replay' | 'broadcast'

/**
 * Single position observation for an aircraft.
 * Represents a snapshot of where the aircraft was at a specific moment.
 */
export interface AircraftObservation {
  // Position
  latitude: number
  longitude: number
  altitude: number // meters

  // Movement
  heading: number // degrees, nose direction
  groundspeed: number // knots
  groundTrack: number | null // degrees, direction of travel (for extrapolation)

  /**
   * True if heading came from actual ADS-B data (true_heading field).
   * False if heading was derived from track or is a fallback value.
   * This is important for distinguishing:
   * - Pushback (slow, but real heading data) → trust the heading
   * - Parked with no data (slow, heading=0 fallback) → derive from position delta
   */
  headingIsTrue: boolean

  // Extended ADS-B data (from RealTraffic, null for VATSIM/vNAS)
  /**
   * On-ground flag from ADS-B transponder.
   * true = on ground, false = airborne, null = unknown.
   * Use this instead of groundspeed threshold when available.
   */
  onGround: boolean | null

  /**
   * Pitch angle in degrees.
   * For broadcast source: pre-interpolated pitch from main app.
   * For other sources: null (calculated from vertical rate).
   * Positive = nose up, negative = nose down.
   */
  pitch: number | null

  /**
   * Bank/roll angle in degrees from ADS-B.
   * Positive = right bank, negative = left bank.
   * Use this directly instead of calculating from turn rate when available.
   */
  roll: number | null

  /**
   * Vertical rate in feet per minute from ADS-B (baro_rate).
   * Positive = climbing, negative = descending.
   * Use this instead of calculating from altitude deltas when available.
   */
  verticalRate: number | null

  // Timing
  /** When this position was TRUE (apiTimestamp, vnas timestamp, etc.) in ms since epoch */
  observedAt: number
  /** When we received this data (Date.now()) in ms since epoch */
  receivedAt: number

  // Source
  source: AircraftDataSource

  /**
   * Display delay that was appropriate when this observation was created.
   * Used for interpolation to prevent position jumps when source changes.
   * Value in milliseconds.
   */
  displayDelay: number
}

/**
 * Metadata associated with an aircraft (non-positional data)
 */
export interface AircraftMetadata {
  cid: number
  aircraftType: string | null
  transponder: string
  departure: string | null
  arrival: string | null
  /**
   * True if this is a parked aircraft from RealTraffic parkedtraffic query.
   * Parked aircraft have been stationary for 10min-24h.
   */
  isParked?: boolean
}

/**
 * Merge aircraft metadata, preserving valuable data from VATSIM when vNAS provides positions.
 *
 * vNAS provides frequent position updates but lacks flight plan data (cid, transponder,
 * departure, arrival). VATSIM provides this data but only every 15 seconds.
 * This function ensures we keep VATSIM's flight plan data while using vNAS for positions.
 *
 * Priority rules:
 * - cid: Prefer non-zero (VATSIM provides real CID, vNAS always sends 0)
 * - transponder: Prefer non-empty (VATSIM provides squawk, vNAS sends '')
 * - departure/arrival: Prefer non-null (from VATSIM flight plan)
 * - aircraftType: Prefer non-null, incoming takes precedence if both exist
 * - isParked: Preserve existing value if incoming doesn't specify
 */
export function mergeAircraftMetadata(
  existing: AircraftMetadata | undefined,
  incoming: AircraftMetadata,
): AircraftMetadata {
  if (!existing) {
    return incoming
  }

  return {
    // Prefer non-zero CID (VATSIM provides real CID, vNAS sends 0)
    cid: incoming.cid !== 0 ? incoming.cid : existing.cid,

    // Prefer non-empty transponder (VATSIM provides squawk, vNAS sends '')
    transponder: incoming.transponder !== '' ? incoming.transponder : existing.transponder,

    // Prefer non-null departure/arrival (from VATSIM flight plan)
    departure: incoming.departure ?? existing.departure,
    arrival: incoming.arrival ?? existing.arrival,

    // Prefer non-null aircraftType, incoming takes precedence if both exist
    aircraftType: incoming.aircraftType ?? existing.aircraftType,

    // Preserve isParked if incoming doesn't specify
    isParked: incoming.isParked ?? existing.isParked,
  }
}

/**
 * State for dynamic display delay calculation per aircraft.
 * Tracks observation intervals to adaptively minimize delay while
 * ensuring enough buffer for interpolation.
 */
export interface DynamicDelayState {
  /** Currently applied delay (ms), smoothed toward target */
  currentDelayMs: number
  /** Target delay calculated from observation intervals (ms) */
  targetDelayMs: number
  /** Timestamp when last delay transition started (for rate limiting decreases) */
  lastUpdateTime: number
  /** Recent observation intervals (ms), used to calculate target delay */
  intervalHistory: number[]
  /**
   * Extra delay added when extrapolation was detected (ms).
   * This bumps the delay immediately when we had to extrapolate,
   * ensuring we don't extrapolate again on the next frame.
   * Decays over time as observations arrive reliably.
   */
  extrapolationBumpMs: number
}

/**
 * Complete timeline for a single aircraft.
 * Contains a ring buffer of observations and current metadata.
 */
export interface AircraftTimeline {
  callsign: string

  /** Ring buffer of observations, oldest first, newest last */
  observations: AircraftObservation[]

  /** Metadata from most recent observation */
  metadata: AircraftMetadata

  /** Most recent data source (determines display delay) */
  lastSource: AircraftDataSource

  /** When we last received any data for this aircraft */
  lastReceivedAt: number

  /**
   * Dynamic delay state for adaptive latency minimization.
   * Optional for backwards compatibility - will be initialized on first use.
   */
  dynamicDelay?: DynamicDelayState
}

/**
 * Result of timeline interpolation/extrapolation.
 * Contains the computed position and debug info.
 * This is converted to the full InterpolatedAircraftState by the rendering layer.
 */
export interface TimelineInterpolationResult {
  callsign: string

  // Interpolated/extrapolated position
  latitude: number
  longitude: number
  altitude: number // meters
  heading: number
  groundspeed: number
  groundTrack: number | null

  // Extended ADS-B data (passed through from observations when available)
  /**
   * On-ground flag from ADS-B transponder.
   * true = on ground, false = airborne, null = unknown.
   */
  onGround: boolean | null

  /**
   * Pitch angle in degrees (interpolated from observations if available).
   * For broadcast source: pre-interpolated pitch from main app.
   * For other sources: null (calculated by rendering layer from vertical rate).
   */
  pitch: number | null

  /**
   * Bank/roll angle in degrees from ADS-B (interpolated).
   * Positive = right bank, negative = left bank.
   */
  roll: number | null

  /**
   * Vertical rate in feet per minute from ADS-B (interpolated).
   * Positive = climbing, negative = descending.
   */
  verticalRate: number | null

  // Metadata
  cid: number
  aircraftType: string | null
  transponder: string
  departure: string | null
  arrival: string | null

  // Source info
  source: AircraftDataSource

  // Debug/status info
  /** Current display delay being used (ms) */
  displayDelay: number
  /** True if extrapolating beyond last observation */
  isExtrapolating: boolean
  /** Age of the most recent observation (ms since receivedAt) */
  observationAge: number
  /** Number of observations in timeline */
  observationCount: number
  /** The displayTime used for this interpolation */
  displayTime: number
}
