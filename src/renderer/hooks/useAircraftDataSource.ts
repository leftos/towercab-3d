/**
 * Unified Aircraft Data Source
 *
 * Provides a single interface for aircraft state data that works for both
 * live VATSIM mode and replay mode. This abstraction allows the interpolation
 * system to remain agnostic about where the data comes from.
 *
 * ## Data Sources
 *
 * In LIVE mode:
 *   - Primary: vNAS (1Hz real-time updates, ~30NM radius from subscribed facility)
 *   - Fallback: VATSIM HTTP polling (15-second updates, global)
 *   - Aircraft in vNAS range use vNAS data; others use VATSIM data
 *
 * In REPLAY/IMPORTED mode:
 *   - Returns cached deserialized snapshot data from replayStore
 */

import { useReplayStore } from '../stores/replayStore'
import { useVatsimStore } from '../stores/vatsimStore'
import { useVnasStore } from '../stores/vnasStore'
import { useRealTrafficStore } from '../stores/realTrafficStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useGlobalSettingsStore } from '../stores/globalSettingsStore'
import { SNAPSHOT_INTERVAL_MS } from '../constants/replay'
import { calculateDistanceNM } from '../utils/interpolation'
import type { AircraftState } from '../types/vatsim'
import type { PlaybackMode, SerializedAircraftState } from '../types/replay'

export interface AircraftDataSource {
  /** Current aircraft states (target for interpolation) */
  aircraftStates: Map<string, AircraftState>
  /** Previous aircraft states (source for interpolation) */
  previousStates: Map<string, AircraftState>
  /** Effective "now" timestamp for interpolation factor calculation */
  timestamp: number
  /** Interval between updates (for interpolation timing) */
  updateInterval: number
  /** Current playback mode */
  playbackMode: PlaybackMode
}

const emptySource: AircraftDataSource = {
  aircraftStates: new Map(),
  previousStates: new Map(),
  timestamp: Date.now(),
  updateInterval: SNAPSHOT_INTERVAL_MS,
  playbackMode: 'live'
}

// ============================================================================
// DESERIALIZATION CACHE
// ============================================================================
// Cache deserialized Maps to avoid creating 200+ objects per frame.
// Only deserialize when snapshot index changes.

interface CachedDeserializedSnapshot {
  /** The snapshot's timestamp (used as cache key) */
  snapshotTimestamp: number
  /** Deserialized aircraft states with timestamps already set */
  aircraftStates: Map<string, AircraftState>
}

// Cache for current and next snapshots (we only need 2 at a time)
let cachedCurrentSnapshot: CachedDeserializedSnapshot | null = null
let cachedNextSnapshot: CachedDeserializedSnapshot | null = null

/**
 * Deserialize a snapshot's aircraft states with timestamp pre-set.
 * This merges deserialization and timestamp-setting into one pass.
 */
function deserializeWithTimestamp(
  states: SerializedAircraftState[],
  timestamp: number
): Map<string, AircraftState> {
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
      timestamp // Use the provided timestamp, not the serialized one
    })
  }
  return map
}

/**
 * Get cached deserialized snapshot, or deserialize and cache if needed.
 */
function getCachedSnapshot(
  snapshotTimestamp: number,
  states: SerializedAircraftState[],
  cache: CachedDeserializedSnapshot | null,
  setCache: (c: CachedDeserializedSnapshot) => void
): Map<string, AircraftState> {
  // Check if already cached
  if (cache && cache.snapshotTimestamp === snapshotTimestamp) {
    return cache.aircraftStates
  }

  // Deserialize and cache
  const deserialized = deserializeWithTimestamp(states, snapshotTimestamp)
  setCache({ snapshotTimestamp, aircraftStates: deserialized })
  return deserialized
}

/**
 * Filter aircraft states by distance from reference position.
 * Used to limit replay data to aircraft near the current view.
 */
function filterByDistance(
  states: Map<string, AircraftState>,
  refLat: number,
  refLon: number,
  radiusNM: number
): Map<string, AircraftState> {
  const filtered = new Map<string, AircraftState>()
  for (const [callsign, state] of states) {
    const distance = calculateDistanceNM(refLat, refLon, state.latitude, state.longitude)
    if (distance <= radiusNM) {
      filtered.set(callsign, state)
    }
  }
  return filtered
}

/**
 * Filter target states to only include callsigns present in source states.
 * Ensures both maps have matching callsigns for proper interpolation.
 */
function filterToMatchCallsigns(
  targetStates: Map<string, AircraftState>,
  sourceCallsigns: Set<string>
): Map<string, AircraftState> {
  const filtered = new Map<string, AircraftState>()
  for (const [callsign, state] of targetStates) {
    if (sourceCallsigns.has(callsign)) {
      filtered.set(callsign, state)
    }
  }
  return filtered
}

/**
 * Get aircraft data from the appropriate source based on playback mode.
 *
 * This function is designed to be called from the animation loop each frame.
 * It reads directly from store state (not React subscriptions) for performance.
 *
 * @returns AircraftDataSource with current/previous states and timing info
 */
export function getAircraftDataSource(): AircraftDataSource {
  const replayState = useReplayStore.getState()
  const { playbackMode, currentIndex, segmentProgress, getActiveSnapshots } = replayState

  if (playbackMode === 'live') {
    // Check which data source is configured
    const dataSource = useGlobalSettingsStore.getState().realtraffic.dataSource

    if (dataSource === 'realtraffic') {
      // REALTRAFFIC MODE: Use RealTraffic API data
      const rtState = useRealTrafficStore.getState()

      // Only use RealTraffic if connected and has data
      if (rtState.status === 'connected' && rtState.aircraftStates.size > 0) {
        return {
          aircraftStates: rtState.aircraftStates,
          previousStates: rtState.previousStates,
          timestamp: Date.now(),
          updateInterval: rtState.updateInterval,
          playbackMode: 'live'
        }
      }

      // RealTraffic not connected/no data - return empty (don't fall back to VATSIM)
      // This makes it clear to the user they need to connect RealTraffic
      return {
        aircraftStates: new Map(),
        previousStates: new Map(),
        timestamp: Date.now(),
        updateInterval: SNAPSHOT_INTERVAL_MS,
        playbackMode: 'live'
      }
    }

    // VATSIM MODE: Merge vNAS (1Hz) and VATSIM (15s) data
    // vNAS data takes priority for aircraft within its subscription range
    const vatsimState = useVatsimStore.getState()
    const vnasState = useVnasStore.getState()

    // If vNAS is connected and has data, merge with VATSIM
    if (vnasState.status.state === 'connected' && vnasState.aircraftStates.size > 0) {
      // Start with VATSIM data as base
      const mergedAircraftStates = new Map(vatsimState.aircraftStates)
      const mergedPreviousStates = new Map(vatsimState.previousStates)

      // Overlay vNAS data (higher frequency, more current)
      for (const [callsign, state] of vnasState.aircraftStates) {
        mergedAircraftStates.set(callsign, state)
      }
      for (const [callsign, state] of vnasState.previousStates) {
        mergedPreviousStates.set(callsign, state)
      }

      // Use vNAS update interval (1 second) for aircraft with vNAS data
      // but fall back to VATSIM interval for overall timing
      const updateInterval = vnasState.aircraftStates.size > 0
        ? 1000 // vNAS is 1Hz
        : (vatsimState.lastUpdateInterval || SNAPSHOT_INTERVAL_MS)

      return {
        aircraftStates: mergedAircraftStates,
        previousStates: mergedPreviousStates,
        timestamp: Date.now(),
        updateInterval,
        playbackMode: 'live'
      }
    }

    // vNAS not connected - use VATSIM data only
    return {
      aircraftStates: vatsimState.aircraftStates,
      previousStates: vatsimState.previousStates,
      timestamp: Date.now(),
      updateInterval: vatsimState.lastUpdateInterval || SNAPSHOT_INTERVAL_MS,
      playbackMode: 'live'
    }
  }

  // REPLAY or IMPORTED MODE: Get current and next snapshots for interpolation
  const snapshots = getActiveSnapshots()
  const currentSnapshot = snapshots[currentIndex]
  const nextSnapshot = snapshots[currentIndex + 1]

  if (!currentSnapshot) {
    return { ...emptySource, playbackMode }
  }

  // Get reference position and radius for filtering replay data
  const vatsimState = useVatsimStore.getState()
  const { referencePosition } = vatsimState
  const { aircraftDataRadiusNM } = useSettingsStore.getState().memory

  // If there's no next snapshot (at the end), just show current snapshot statically
  if (!nextSnapshot) {
    // Use cached deserialization
    let aircraftStates = getCachedSnapshot(
      currentSnapshot.timestamp,
      currentSnapshot.aircraftStates,
      cachedCurrentSnapshot,
      (c) => { cachedCurrentSnapshot = c }
    )

    // Filter by distance if we have a reference position
    if (referencePosition) {
      aircraftStates = filterByDistance(
        aircraftStates,
        referencePosition.latitude,
        referencePosition.longitude,
        aircraftDataRadiusNM
      )
    }

    return {
      aircraftStates,
      previousStates: aircraftStates, // Same as current when at end
      timestamp: currentSnapshot.timestamp,
      updateInterval: currentSnapshot.lastUpdateInterval,
      playbackMode
    }
  }

  // We have both current and next snapshots - set up for interpolation BETWEEN them
  //
  // The interpolation system expects:
  // - previousStates: where we're coming FROM (with older timestamps)
  // - aircraftStates: where we're going TO (with newer timestamps)
  // - timestamp: effective "now" between the two
  //
  // Interpolation factor t = (now - prevTimestamp) / (currTimestamp - prevTimestamp)
  // We want t ≈ segmentProgress, so:
  // - prevTimestamp = currentSnapshot.timestamp
  // - currTimestamp = nextSnapshot.timestamp
  // - now = currentSnapshot.timestamp + segmentProgress * interval

  const interval = nextSnapshot.timestamp - currentSnapshot.timestamp
  const effectiveNow = currentSnapshot.timestamp + (segmentProgress * interval)

  // Use cached deserialization - only deserializes when snapshot changes
  // Current snapshot is the SOURCE (previousStates), next snapshot is the TARGET (aircraftStates)
  let previousStates = getCachedSnapshot(
    currentSnapshot.timestamp,
    currentSnapshot.aircraftStates,
    cachedCurrentSnapshot,
    (c) => { cachedCurrentSnapshot = c }
  )

  let aircraftStates = getCachedSnapshot(
    nextSnapshot.timestamp,
    nextSnapshot.aircraftStates,
    cachedNextSnapshot,
    (c) => { cachedNextSnapshot = c }
  )

  // Filter by distance if we have a reference position
  // This allows replays to be viewed from any location
  if (referencePosition) {
    previousStates = filterByDistance(
      previousStates,
      referencePosition.latitude,
      referencePosition.longitude,
      aircraftDataRadiusNM
    )
    // Filter aircraftStates to only include callsigns in previousStates
    // This ensures consistent data for interpolation
    aircraftStates = filterToMatchCallsigns(aircraftStates, new Set(previousStates.keys()))
  }

  return {
    aircraftStates,
    previousStates,
    timestamp: effectiveNow,
    updateInterval: interval,
    playbackMode
  }
}
