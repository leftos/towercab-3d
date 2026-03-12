/**
 * Types for SharedWorker communication between main app and inset iframes
 *
 * These types are shared between:
 * - workers/shared-data.worker.ts (SharedWorker implementation)
 * - hooks/useSharedWorkerProvider.ts (main app provider)
 * - hooks/useSharedWorkerConsumer.ts (inset consumer)
 */

import type {
  CesiumSettings,
  GraphicsSettings,
  CameraSettings,
  WeatherSettings,
  MemorySettings,
  AircraftSettings,
  UISettings,
  ImageryProviderType,
  ImageryAdjustments,
  GlobalDisplaySettings,
} from './settings'
import type { AircraftState } from './vatsim'

/**
 * Message types for SharedWorker communication
 */
export type SharedWorkerMessageType =
  | 'aircraft-update'
  | 'observations-update' // Raw observations for timeline-based interpolation
  | 'aircraft-removals' // Aircraft that have been removed
  | 'model-info-update' // Model assignments for callsigns
  | 'settings-update'
  | 'weather-update'
  | 'cesium-token'
  | 'imagery-update'
  | 'airport-update'
  | 'viewport-camera'
  | 'register-inset'
  | 'unregister-inset'
  | 'inset-log' // Log forwarding from inset to main

/**
 * Inbound message from main app or inset
 */
export interface SharedWorkerInboundMessage {
  type: SharedWorkerMessageType
  payload?: unknown
  viewportId?: string // For viewport-specific messages
  source?: 'main' | 'inset'
}

/**
 * Outbound message to connected ports
 */
export interface SharedWorkerOutboundMessage {
  type: SharedWorkerMessageType
  payload: unknown
  viewportId?: string
  timestamp: number
}

/**
 * Serializable aircraft state for SharedWorker transfer
 * Matches InterpolatedAircraftState but without non-serializable fields
 */
export interface SerializedAircraftState {
  callsign: string
  cid: number
  latitude: number
  longitude: number
  altitude: number
  groundspeed: number
  heading: number
  groundTrack: number | null
  transponder: string
  aircraftType: string
  departure: string
  arrival: string
  timestamp: number

  // Interpolated values
  interpolatedLatitude: number
  interpolatedLongitude: number
  interpolatedAltitude: number
  interpolatedHeading: number
  interpolatedGroundspeed: number
  interpolatedPitch: number
  interpolatedRoll: number

  // Rates
  verticalRate: number
  turnRate: number
  acceleration: number
  track: number

  isInterpolated: boolean
}

/**
 * Serialized settings for SharedWorker transfer
 * Contains only the data portions of the settings store (no actions)
 */
export interface SerializedSettings {
  cesium: CesiumSettings
  graphics: GraphicsSettings
  camera: CameraSettings
  weather: WeatherSettings
  memory: MemorySettings
  aircraft: AircraftSettings
  ui: UISettings
  /** Global display settings (datablocks, labels, inset settings) */
  display: GlobalDisplaySettings
}

/**
 * Weather data sent to insets
 */
export interface SerializedWeather {
  fogDensity: number
  /** Visibility in statute miles (for weather-based datablock culling) */
  visibility: number
  cloudLayers: Array<{
    altitude: number
    coverage: number
    type: string
  }>
}

/**
 * Imagery settings sent to insets
 * Allows insets to use the same imagery provider as the main app
 */
export interface SerializedImagery {
  /** Selected imagery provider ('cesium' or 'google') */
  provider: ImageryProviderType
  /** Google Maps API key (required when provider is 'google') */
  googleMapsApiKey: string
  /** Color adjustments for Cesium Ion imagery */
  cesiumAdjustments: ImageryAdjustments
  /** Color adjustments for Google Maps imagery */
  googleAdjustments: ImageryAdjustments
}

/**
 * Camera state update from inset to main
 */
export interface CameraStateUpdate {
  heading?: number
  pitch?: number
  fov?: number
  positionOffsetX?: number
  positionOffsetY?: number
  positionOffsetZ?: number
  followingCallsign?: string | null
  orbitDistance?: number
  orbitHeading?: number
  orbitPitch?: number
}

/**
 * Aircraft update payload
 */
export interface AircraftUpdatePayload {
  aircraft: SerializedAircraftState[]
  timestamp: number
}

/**
 * Settings update payload
 */
export interface SettingsUpdatePayload {
  settings: SerializedSettings
}

/**
 * Weather update payload
 */
export interface WeatherUpdatePayload {
  weather: SerializedWeather
}

/**
 * Cesium token payload
 */
export interface CesiumTokenPayload {
  token: string
}

/**
 * Serialized airport data for insets
 */
export interface SerializedAirport {
  icao: string
  name: string
  latitude: number
  longitude: number
  elevation: number // meters
  towerHeight: number // meters above ground
}

/**
 * Airport update payload
 */
export interface AirportUpdatePayload {
  airport: SerializedAirport | null
}

/**
 * Serialized model info for a callsign
 * Contains the resolved model URL and rendering parameters
 */
export interface SerializedModelInfo {
  callsign: string
  /** URL/path to the GLB model file (null if pending conversion) */
  modelUrl: string | null
  /** Non-uniform scale [x, y, z] */
  scale: [number, number, number]
  /** Rotation offset in degrees (180 for FSLTL models) */
  rotationOffset: number
  /** Whether this is an FSLTL/VMR model (affects brightness/livery handling) */
  isFsltl: boolean
}

/**
 * Model info update payload
 * Sent when model assignments change for aircraft
 */
export interface ModelInfoUpdatePayload {
  models: SerializedModelInfo[]
  timestamp: number
}

/**
 * Convert AircraftState to SerializedAircraftState
 * Used when we only have basic aircraft state (not interpolated)
 */
export function serializeBasicAircraftState(state: AircraftState): SerializedAircraftState {
  return {
    callsign: state.callsign,
    cid: state.cid,
    latitude: state.latitude,
    longitude: state.longitude,
    altitude: state.altitude,
    groundspeed: state.groundspeed,
    heading: state.heading,
    groundTrack: null,
    transponder: state.transponder,
    aircraftType: state.aircraftType ?? '',
    departure: state.departure ?? '',
    arrival: state.arrival ?? '',
    timestamp: state.timestamp,

    // Use base values as interpolated values
    interpolatedLatitude: state.latitude,
    interpolatedLongitude: state.longitude,
    interpolatedAltitude: state.altitude,
    interpolatedHeading: state.heading,
    interpolatedGroundspeed: state.groundspeed,
    interpolatedPitch: 0,
    interpolatedRoll: 0,

    // Default rates
    verticalRate: 0,
    turnRate: 0,
    acceleration: 0,
    track: state.heading,

    isInterpolated: false,
  }
}
