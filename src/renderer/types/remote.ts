/**
 * Types for the host's observations WebSocket as remote browsers receive it (match `ObservationData` in
 * `src-tauri/src/server.rs`).
 */

/** One aircraft observation as the host broadcasts it */
export interface RemoteObservationData {
  callsign: string
  latitude: number
  longitude: number
  altitude: number
  heading: number
  groundspeed: number
  groundTrack: number
  verticalRate: number
  onGround: boolean
  /** Height above ground in metres; absent for sources without it and from hosts that predate the field */
  heightAboveGround?: number | null
  pitch: number | null
  roll: number | null
  source: string
  observedAt: number
  receivedAt: number
  typeCode: string | null
  origin: string | null
  destination: string | null
  flightRules: string | null
}
