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
  transponder: string
  aircraftType: string | null
  departure: string | null
  arrival: string | null
  timestamp: number
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
  // True if we have previous state data for interpolation, false if showing raw data
  isInterpolated: boolean
}
