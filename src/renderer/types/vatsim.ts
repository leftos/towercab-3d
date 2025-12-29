// VATSIM API Response Types
// Based on https://data.vatsim.net/v3/vatsim-data.json

export interface VatsimData {
  general: VatsimGeneral
  pilots: PilotData[]
  controllers: ControllerData[]
  atis: AtisData[]
  servers: ServerData[]
  prefiles: PrefileData[]
  facilities: FacilityData[]
  ratings: RatingData[]
  pilot_ratings: PilotRatingData[]
}

export interface VatsimGeneral {
  version: number
  reload: number
  update: string
  update_timestamp: string
  connected_clients: number
  unique_users: number
}

export interface PilotData {
  cid: number
  name: string
  callsign: string
  server: string
  pilot_rating: number
  latitude: number
  longitude: number
  altitude: number // Altitude in FEET (from VATSIM API - will be converted to meters on ingestion)
  groundspeed: number
  transponder: string
  heading: number
  qnh_i_hg: number
  qnh_mb: number
  flight_plan: FlightPlan | null
  logon_time: string
  last_updated: string
}

export interface FlightPlan {
  flight_rules: 'I' | 'V' | 'Y' | 'Z'
  aircraft: string
  aircraft_faa: string
  aircraft_short: string
  departure: string
  arrival: string
  alternate: string
  cruise_tas: string
  altitude: string
  deptime: string
  enroute_time: string
  fuel_time: string
  remarks: string
  route: string
  revision_id: number
  assigned_transponder: string
}

export interface ControllerData {
  cid: number
  name: string
  callsign: string
  frequency: string
  facility: number
  rating: number
  server: string
  visual_range: number
  text_atis: string[] | null
  last_updated: string
  logon_time: string
}

export interface AtisData {
  cid: number
  name: string
  callsign: string
  frequency: string
  facility: number
  rating: number
  server: string
  visual_range: number
  atis_code: string
  text_atis: string[]
  last_updated: string
  logon_time: string
}

export interface ServerData {
  ident: string
  hostname_or_ip: string
  location: string
  name: string
  clients_connection_allowed: number
  client_connections_allowed: boolean
  is_sweatbox: boolean
}

export interface PrefileData {
  cid: number
  name: string
  callsign: string
  flight_plan: FlightPlan
  last_updated: string
}

export interface FacilityData {
  id: number
  short: string
  long: string
}

export interface RatingData {
  id: number
  short: string
  long: string
}

export interface PilotRatingData {
  id: number
  short_name: string
  long_name: string
}

// Internal types for aircraft state management
export interface AircraftState {
  callsign: string
  cid: number
  latitude: number
  longitude: number
  altitude: number        // Altitude in METERS (converted from VATSIM feet)
  groundspeed: number
  heading: number
  /**
   * Ground track (direction of actual movement) in degrees (0-360).
   *
   * When available from vNAS (trueGroundTrack), use this for extrapolation
   * instead of heading. Ground track represents the actual direction of
   * travel, while heading may differ due to crosswind (crab angle).
   *
   * If null/undefined, interpolation will calculate track from position changes.
   */
  groundTrack?: number | null
  /**
   * True heading (nose direction) in degrees (0-360).
   * From RealTraffic ADS-B data. Use this for visual display instead of
   * groundTrack, especially for ground aircraft where heading differs
   * from direction of movement (pushback, crosswind taxi).
   */
  trueHeading?: number | null
  /**
   * Rate of turn in degrees per second. Negative = turning left.
   * From RealTraffic ADS-B data. Critical for predicting aircraft turns
   * during interpolation.
   */
  trackRate?: number | null
  /**
   * Roll/bank angle in degrees. Negative = left bank.
   * From RealTraffic ADS-B data. Used for visual display.
   */
  roll?: number | null
  /**
   * Barometric vertical rate in feet per minute.
   * Positive = climbing, negative = descending.
   * From RealTraffic ADS-B data.
   */
  baroRate?: number | null
  /**
   * Age of position data in seconds since last ADS-B update.
   * From RealTraffic. Higher values indicate stale data - reduce
   * extrapolation confidence accordingly.
   */
  positionAge?: number | null
  /**
   * On-ground flag from ADS-B transponder.
   * 1 = on ground, 0 = airborne.
   */
  onGround?: number | null
  /**
   * Original API/ADS-B timestamp (Unix seconds) when this position was observed.
   * From RealTraffic record[10]. Used for stale data detection - if this value
   * hasn't changed between polls, the position data is stale and should not
   * create a new interpolation target.
   */
  apiTimestamp?: number | null
  transponder: string
  aircraftType: string | null
  departure: string | null
  arrival: string | null
  timestamp: number
  /**
   * Flag indicating this is a parked aircraft from RealTraffic parkedtraffic query.
   * Parked aircraft are culled first when total exceeds maxAircraftDisplay.
   */
  isParked?: boolean
}

export interface InterpolatedAircraftState extends AircraftState {
  // Interpolated values for smooth rendering
  interpolatedLatitude: number
  interpolatedLongitude: number
  interpolatedAltitude: number  // Interpolated altitude in METERS
  interpolatedHeading: number
  interpolatedGroundspeed: number
  // Emulated orientation (derived from physics)
  interpolatedPitch: number     // Degrees, positive = nose up
  interpolatedRoll: number      // Degrees, positive = right wing down
  verticalRate: number          // Vertical rate in METERS/MINUTE
  turnRate: number              // degrees/sec
  /**
   * Ground acceleration in knots per second.
   * Positive = accelerating, negative = decelerating.
   * Useful for distinguishing takeoff roll (accelerating) from landing roll (decelerating).
   */
  acceleration: number
  /**
   * Ground track (direction of movement) in degrees (0-360).
   * Calculated from position change. Differs from heading during:
   * - Pushback (track ≈ heading + 180°)
   * - Crosswind (crab angle)
   * - Stationary (defaults to heading when not moving)
   */
  track: number
  // True if we have previous state data for interpolation, false if showing raw data
  isInterpolated: boolean
}
