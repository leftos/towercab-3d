// vNAS (Virtual Network Air Traffic Control System) Types
// These types match the Rust types in src-tauri/src/vnas.rs

/**
 * vNAS environment for connecting to different VATSIM environments
 */
export type VnasEnvironment = 'live' | 'sweatbox1' | 'sweatbox2'

/**
 * Session state for vNAS connection lifecycle
 */
export type VnasSessionState =
  | 'disconnected'
  | 'authenticating'
  | 'connecting'
  | 'joiningSession'
  | 'waitingForSession'  // TC3D connected before CRC - waiting for CRC to create session
  | 'subscribing'
  | 'connected'
  | 'unavailable'  // vNAS feature not compiled in

/**
 * Aircraft position update from vNAS (1Hz updates)
 * This provides real-time position data supplementing VATSIM's 15-second polling
 */
export interface VnasAircraft {
  callsign: string
  typeCode: string
  isHeavy: boolean
  lat: number
  lon: number
  trueHeading: number
  trueGroundTrack: number | null
  altitudeTrue: number      // True altitude in meters
  altitudeAgl: number       // Altitude above ground in meters
  voiceType: number         // 0=Unknown, 1=Full, 2=ReceiveOnly, 3=TextOnly
  timestamp: number         // Unix timestamp in ms
}

/**
 * vNAS connection status
 */
export interface VnasStatus {
  state: VnasSessionState
  environment: VnasEnvironment
  facilityId: string | null
  error: string | null
  /** Whether vNAS feature is compiled into the backend */
  available: boolean
}
