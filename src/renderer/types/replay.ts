/**
 * Replay System Types
 *
 * Types for the VATSIM data replay system that allows users to:
 * - Record live traffic data as snapshots
 * - Scrub back through time
 * - Export/import replay data
 * - Return to live mode seamlessly
 */

import type { AircraftState } from './vatsim'

/**
 * Serializable version of AircraftState for JSON export
 * Converts Map entries to array format
 */
export interface SerializedAircraftState {
  callsign: string
  cid: number
  latitude: number
  longitude: number
  altitude: number
  groundspeed: number
  heading: number
  transponder: string
  aircraftType: string | null
  departure: string | null
  arrival: string | null
  timestamp: number
  // Extended fields from timeline/ADS-B data (optional for backward compat)
  groundTrack?: number | null
  onGround?: number | null  // 1 = on ground, 0 = airborne
  roll?: number | null
  baroRate?: number | null  // Vertical rate in fpm
}

/**
 * Snapshot of VATSIM state at a point in time
 * Captured every 15 seconds (matching VATSIM update rate)
 */
export interface VatsimSnapshot {
  /** Local timestamp when snapshot was captured (Date.now()) */
  timestamp: number
  /** VATSIM's update_timestamp from API response */
  vatsimTimestamp: number
  /** Current aircraft states (serialized for storage) */
  aircraftStates: SerializedAircraftState[]
  /** Interval between this and previous VATSIM update (typically 15000ms) */
  lastUpdateInterval: number
}

/**
 * Export file format for replay data
 */
export interface ReplayExportData {
  /** Format version for future compatibility */
  version: 1
  /** ISO timestamp when export was created */
  exportDate: string
  /** App version that created this export */
  appVersion: string
  /** ICAO code of airport if known */
  airport?: string
  /** Array of snapshots in chronological order */
  snapshots: VatsimSnapshot[]
}

/**
 * Current playback mode
 * - 'live': Showing real-time VATSIM data
 * - 'replay': Scrubbing through recorded live snapshots
 * - 'imported': Viewing imported replay file
 */
export type PlaybackMode = 'live' | 'replay' | 'imported'

/**
 * Available playback speed multipliers
 */
export type PlaybackSpeed = 0.5 | 1 | 2 | 4

/**
 * Helper functions for serializing/deserializing aircraft states
 */

export function serializeAircraftStates(states: Map<string, AircraftState>): SerializedAircraftState[] {
  return Array.from(states.values()).map(state => ({
    callsign: state.callsign,
    cid: state.cid,
    latitude: state.latitude,
    longitude: state.longitude,
    altitude: state.altitude,
    groundspeed: state.groundspeed,
    heading: state.heading,
    transponder: state.transponder,
    aircraftType: state.aircraftType,
    departure: state.departure,
    arrival: state.arrival,
    timestamp: state.timestamp,
    // Extended fields (will be null/undefined for basic VATSIM data)
    groundTrack: state.groundTrack ?? null,
    onGround: state.onGround ?? null,
    roll: state.roll ?? null,
    baroRate: state.baroRate ?? null
  }))
}

export function deserializeAircraftStates(states: SerializedAircraftState[]): Map<string, AircraftState> {
  const map = new Map<string, AircraftState>()
  for (const state of states) {
    map.set(state.callsign, {
      callsign: state.callsign,
      cid: state.cid,
      latitude: state.latitude,
      longitude: state.longitude,
      altitude: state.altitude,
      groundspeed: state.groundspeed,
      heading: state.heading,
      transponder: state.transponder,
      aircraftType: state.aircraftType,
      departure: state.departure,
      arrival: state.arrival,
      timestamp: state.timestamp,
      // Extended fields (backward compatible - may be undefined in old exports)
      groundTrack: state.groundTrack ?? null,
      onGround: state.onGround ?? null,
      roll: state.roll ?? null,
      baroRate: state.baroRate ?? null
    })
  }
  return map
}
