/**
 * Diagnostic Package Types
 *
 * Types for exporting/importing diagnostic packages that capture
 * raw aircraft timeline data and app state for bug reproduction.
 * Unlike replay snapshots (lossy 15s aggregates), diagnostic packages
 * preserve per-observation fidelity needed for debugging interpolation,
 * terrain clamping, and source-transition issues.
 */

import type {
  AircraftObservation,
  AircraftMetadata,
  AircraftDataSource,
  DynamicDelayState
} from './aircraft-timeline'

/**
 * Serialized version of an AircraftTimeline for JSON export.
 * Preserves all observation data, metadata, and dynamic delay state.
 */
export interface SerializedTimeline {
  callsign: string
  observations: AircraftObservation[]
  metadata: AircraftMetadata
  lastSource: AircraftDataSource
  lastReceivedAt: number
  dynamicDelay?: DynamicDelayState
}

/**
 * Snapshot of relevant app state at the time of diagnostic export.
 * Provides context for reproducing the exact conditions.
 */
export interface DiagnosticAppState {
  airport: { icao: string; towerHeight: number } | null
  camera: {
    latitude: number
    longitude: number
    altitude: number
    heading: number
    pitch: number
  }
  vnas: { connected: boolean; sessionActive: boolean }
  vatsim: { lastTimestamp: number | null }
  realTraffic: { connected: boolean }
  weather: { metar: string | null }
  settings: {
    sourceDisplayDelays: Record<string, number>
    enableDynamicDisplayDelay: boolean
    groundspeedThresholdKnots: number
  }
}

/**
 * Complete diagnostic package for export/import.
 * Contains raw timeline data and app state snapshot.
 */
export interface DiagnosticPackage {
  version: 1
  exportedAt: number
  appVersion: string
  timelines: SerializedTimeline[]
  appState: DiagnosticAppState
}
