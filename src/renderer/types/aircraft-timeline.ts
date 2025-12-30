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
export type AircraftDataSource = 'vatsim' | 'vnas' | 'realtraffic' | 'replay'

/**
 * Single position observation for an aircraft.
 * Represents a snapshot of where the aircraft was at a specific moment.
 */
export interface AircraftObservation {
  // Position
  latitude: number
  longitude: number
  altitude: number  // meters

  // Movement
  heading: number       // degrees, nose direction
  groundspeed: number   // knots
  groundTrack: number | null  // degrees, direction of travel (for extrapolation)

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
  altitude: number  // meters
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
