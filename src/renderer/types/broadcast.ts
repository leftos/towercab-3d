/**
 * Broadcast Types
 *
 * Types for the unified aircraft broadcasting system that serves both
 * inset iframes (via SharedWorker) and remote browsers (via WebSocket).
 *
 * Uses short property names to minimize MessagePack payload size.
 */

/**
 * Full aircraft state - sent for new aircraft or periodic full refresh.
 * Uses short property names to reduce serialization size.
 */
export interface AircraftFull {
  c: string           // callsign
  la: number          // latitude
  lo: number          // longitude
  al: number          // altitude (meters, ellipsoidal)
  hd: number          // heading (degrees)
  gs: number          // groundspeed (knots)
  pi: number          // pitch (degrees)
  ro: number          // roll (degrees)
  vr: number          // vertical rate (m/min)
  tr: number          // turn rate (deg/sec)
  ac: number          // acceleration (knots/sec)
  tk: number          // track (degrees)
  ty?: string | null  // aircraft type (e.g., "B738")
  dp?: string | null  // departure airport
  ar?: string | null  // arrival airport
  // Model info - allows insets to render MSFS models
  mu?: string | null  // model URL (file path to GLB)
  sc?: [number, number, number] | null  // model scale [x, y, z]
  ro_off?: number | null  // rotation offset (degrees)
  fsltl?: boolean | null  // is FSLTL/VMR model (for color blend logic)
}

/**
 * Delta aircraft state - only fields that changed since last broadcast.
 * Callsign is always present as the key.
 */
export interface AircraftDelta {
  c: string           // callsign (always present)
  la?: number         // latitude (if changed > 0.00001°)
  lo?: number         // longitude (if changed > 0.00001°)
  al?: number         // altitude (if changed > 1m)
  hd?: number         // heading (if changed > 0.5°)
  gs?: number         // groundspeed (if changed > 0.5kt)
  pi?: number         // pitch (if changed > 0.5°)
  ro?: number         // roll (if changed > 0.5°)
  vr?: number         // vertical rate (if changed > 10 m/min)
  tr?: number         // turn rate (if changed > 0.5 deg/sec)
  ac?: number         // acceleration (if changed > 0.5 kt/sec)
  tk?: number         // track (if changed > 0.5°)
  // Metadata rarely changes, only included if different
  ty?: string | null  // aircraft type
  dp?: string | null  // departure
  ar?: string | null  // arrival
  // Model info - only included when model changes
  mu?: string | null  // model URL
  sc?: [number, number, number] | null  // model scale
  ro_off?: number | null  // rotation offset
  fsltl?: boolean | null  // is FSLTL/VMR model
}

/**
 * Broadcast message from host to consumers.
 */
export interface BroadcastMessage {
  /** Sequence number for lag detection */
  seq: number
  /** Timestamp when broadcast was generated (ms) */
  t: number
  /** Full state for new aircraft */
  f: AircraftFull[]
  /** Delta updates for existing aircraft */
  d: AircraftDelta[]
  /** Callsigns of removed aircraft */
  r: string[]
}

/**
 * Feedback from consumer to host for rate adaptation.
 * Sent every ~500ms.
 */
export interface ConsumerFeedback {
  /** Unique consumer identifier */
  consumerId: string
  /** Sequence number of last successfully processed message */
  lastReceivedSeq: number
  /** Number of messages waiting to be processed (backlog) */
  bufferDepth: number
  /** Rolling average time to apply delta (ms) */
  avgProcessingMs: number
}

/**
 * Consumer state tracked by the broadcast service.
 */
export interface ConsumerState {
  /** Unique consumer identifier */
  id: string
  /** Last sequence number sent to this consumer */
  lastSentSeq: number
  /** Timestamp of last send (ms) */
  lastSendTime: number
  /** Current broadcast interval for this consumer (ms) */
  interval: number
  /** Transport type */
  transport: 'sharedworker' | 'websocket'
}

/**
 * Thresholds for determining if a field has "changed" enough to include in delta.
 * Smaller thresholds = more updates = higher bandwidth.
 * Larger thresholds = fewer updates = potential visual jitter.
 */
export const DELTA_THRESHOLDS = {
  /** Position change threshold in degrees (~1.1m at equator) */
  position: 0.000001,
  /** Altitude change threshold in meters */
  altitude: 0.1,
  /** Angle change threshold in degrees (heading, pitch, roll, track) */
  angle: 0.05,
  /** Speed change threshold in knots */
  speed: 0.05,
  /** Vertical rate change threshold in m/min */
  verticalRate: 5,
  /** Turn rate change threshold in deg/sec */
  turnRate: 0.25,
  /** Acceleration change threshold in knots/sec */
  acceleration: 0.25,
} as const

/**
 * Rate control constants.
 */
export const RATE_CONTROL = {
  /** Minimum broadcast interval (ms) - 30Hz */
  minInterval: 33,
  /** Maximum broadcast interval (ms) - 5Hz */
  maxInterval: 200,
  /** Default starting interval (ms) - 30Hz */
  defaultInterval: 33,
  /** Multiplier when slowing down */
  slowdownFactor: 1.5,
  /** Multiplier when speeding up */
  speedupFactor: 0.8,
  /** Lag threshold (sequence numbers behind) to trigger slowdown */
  lagThreshold: 5,
  /** Buffer depth threshold to trigger slowdown */
  bufferThreshold: 3,
  /** Processing time threshold (ms) to allow speedup */
  processingThreshold: 10,
  /** WebSocket buffer threshold (bytes) to skip frame */
  wsBufferThreshold: 50000,
  /** Feedback interval from consumers (ms) */
  feedbackInterval: 500,
} as const

/**
 * SharedWorker message types for main app ↔ inset communication.
 */
export type SharedWorkerMessageType =
  | 'register-main'
  | 'register-inset'
  | 'broadcast'
  | 'feedback'
  | 'consumer-connected'
  | 'consumer-disconnected'

export interface SharedWorkerMessage {
  type: SharedWorkerMessageType
  consumerId?: string
  data?: unknown
}
