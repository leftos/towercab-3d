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
   * Height above the ground under it, in metres, raw as the source reports it (vNAS: the simulator's AGL of the
   * aircraft's reference point, so an aircraft at rest reads its resting height, which varies by type and simulator).
   * Absent for VATSIM and RealTraffic; replay carries what was recorded. Slow vNAS samples from -3 to 16 ft teach the
   * aircraft's own resting height and its type's; ground contact, the parked test and the flare use the height over the
   * aircraft's own, else its type's (`heightOverRest`). While it has neither, lane B decides contact and the
   * parked test and the flare take the raw height.
   */
  heightAboveGround?: number

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
  /**
   * When this position was TRUE, in Unix epoch ms.
   * - VATSIM: server's `update_timestamp` (NTP-correct UTC).
   * - vNAS: Rust `SystemTime::now()` at UDP receipt on the host machine.
   * - RealTraffic: API `apiTimestamp` (server clock).
   *
   * All sources land in Unix epoch ms, but they come from different machines.
   * Cross-source bracketing (`findBracketingObservations`) assumes those clocks
   * are roughly NTP-synchronised — a host with a clock drifted by tens of seconds
   * will produce misordered observations. This is intentional: defending against
   * arbitrary clock skew would mean discarding the per-source `observedAt`
   * information that the displayDelay buffer relies on for accurate interpolation.
   */
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
}

/** Heights above ground (metres) of the run of samples contact is entered on while an aircraft has no resting height */
export interface SettleRun {
  lowest: number
  /** The second-lowest sample's height; the provisional resting height is taken from it */
  secondLowest: number
  highest: number
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
  /**
   * Groundspeed of the newest observation (knots), as reported. Differs from `groundspeed` while an aircraft is
   * held standing still at its first report.
   */
  reportedGroundspeed: number

  // Extended ADS-B data (passed through from observations when available)
  /**
   * On-ground flag for drawing, from the source's ground flag (ADS-B ground bit, vNAS 50/80 ft flag).
   * true = on ground, false = airborne, null = unknown. Null when the flag comes from a vNAS observation
   * and the result has no height above ground: the vNAS flag is for labels only.
   */
  onGround: boolean | null

  /**
   * Height above ground in metres at the displayed instant: lerped between two samples that carry it, the last
   * sample's while extrapolating or held. Null for sources without it, and once the samples carrying it are older
   * than `VNAS_PREFERENCE_THRESHOLD_MS`.
   */
  heightAboveGround: number | null

  /**
   * The run of height samples contact is entered on while the aircraft has no resting height: the shortest run of the
   * drawn list's samples ending at the bracket's `after` sample (its `before` sample while extrapolating or held) that
   * holds at least DROP_CONTACT_SETTLE_MIN_SAMPLES samples spanning at least DROP_CONTACT_SETTLE_SPAN_MS. Undefined
   * when the samples do not span it or a sample in it carries no height.
   */
  settleRun: SettleRun | undefined

  /**
   * Whether the bracket's earlier sample shows the aircraft stopped and the bracket's horizontal step is under
   * CONTACT_HOLD_MAX_ARM_STEP_M. The sample is stopped when its last step is under STOPPED_SPEED_KTS and so is the step
   * before it or its speed over the 3 s stop window, or when its step from the previous vNAS sample (however long
   * before) is under STOPPED_SPEED_KTS and that sample is itself stopped. False while extrapolating or held, and for a
   * sample from another source.
   */
  bracketStartStopped: boolean

  /**
   * The observed time less the received time (ms) of the sample display time is anchored to, the drawn list's oldest:
   * display time is the frame's time plus this, less the display delay. When the drawn list switches source (vNAS
   * alone or mixed with VATSIM), its oldest sample can change source and display time moves by this offset's change.
   */
  displayAnchorOffsetMs: number

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
