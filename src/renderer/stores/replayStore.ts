import { create } from 'zustand'
import { DIAGNOSTIC_VERSION } from '../constants/diagnostic'
import {
  DEFAULT_PLAYBACK_SPEED,
  REPLAY_EXPORT_VERSION,
  REPLAY_FILE_PREFIX,
  SNAPSHOT_INTERVAL_MS,
} from '../constants/replay'
import type { DiagnosticAppState, DiagnosticPackage, SerializedTimeline } from '../types/diagnostic'
import type { PlaybackMode, PlaybackSpeed, ReplayExportData, ReplayExportDataV2, VatsimSnapshot } from '../types/replay'
import { serializeAircraftStates } from '../types/replay'
import type { AircraftState } from '../types/vatsim'
import { useAircraftTimelineStore } from './aircraftTimelineStore'
import { useAirportStore } from './airportStore'
import { useSettingsStore } from './settingsStore'

/**
 * Replay store state interface
 */
interface ReplayState {
  // Recording
  /** Live snapshots collected during session (circular buffer) */
  snapshots: VatsimSnapshot[]
  /** Whether recording is active (always true unless explicitly paused) */
  isRecording: boolean

  // Playback
  /** Current playback mode: live, replay (buffer), or imported */
  playbackMode: PlaybackMode
  /** Whether playback is running (false = paused) */
  isPlaying: boolean
  /** Current playback speed multiplier */
  playbackSpeed: PlaybackSpeed
  /** Current position in snapshots array (buffer replay only) */
  currentIndex: number
  /** Interpolation progress: 0-1 within segment (buffer) or across time range (imported) */
  segmentProgress: number
  /** Timestamp when current playback segment started (for timing) */
  playbackStartTime: number
  /** Index when current playback segment started */
  playbackStartIndex: number

  // Imported replay (unified: v1 snapshots, v2 timelines, and diagnostic packages)
  /** Imported replay snapshots for v1 legacy imports (converted to timelines on load) */
  importedSnapshots: VatsimSnapshot[] | null
  /** Time range of loaded imported timelines (min/max observedAt) */
  importedTimeRange: { start: number; end: number } | null
  /** App state from imported file (diagnostic or v2 replay) */
  importedAppState: DiagnosticAppState | null
}

/**
 * Replay store actions interface
 */
interface ReplayActions {
  // Recording
  /** Add a new snapshot to the buffer (called by vatsimStore) */
  addSnapshot: (aircraftStates: Map<string, AircraftState>, vatsimTimestamp: number, lastUpdateInterval: number) => void
  /** Start/stop recording */
  setRecording: (recording: boolean) => void
  /** Clear all recorded snapshots */
  clearSnapshots: () => void

  // Playback control
  /** Start or resume playback */
  play: () => void
  /** Pause playback */
  pause: () => void
  /** Return to live mode */
  goLive: () => void
  /** Seek to specific snapshot index (buffer replay) */
  seekTo: (index: number) => void
  /** Step backward one snapshot */
  stepBackward: () => void
  /** Step forward one snapshot */
  stepForward: () => void
  /** Set playback speed */
  setPlaybackSpeed: (speed: PlaybackSpeed) => void
  /** Update playback progress (called by animation frame) */
  updatePlayback: (deltaMs: number) => void

  // Import/Export
  /** Export current replay data to downloadable file (v2 format) */
  exportReplay: () => void
  /** Import replay data from file (handles v1, v2, and diagnostic formats) */
  importReplay: (data: ReplayExportData | DiagnosticPackage) => boolean
  /** Clear imported replay data */
  clearImportedReplay: () => void

  // Getters
  /** Get the snapshots array for current mode (live or imported) */
  getActiveSnapshots: () => VatsimSnapshot[]
  /** Get current snapshot based on playback position */
  getCurrentSnapshot: () => VatsimSnapshot | null
  /** Get next snapshot for interpolation */
  getNextSnapshot: () => VatsimSnapshot | null
  /** Get max snapshots based on settings */
  getMaxSnapshots: () => number
  /** Get total duration in seconds of active replay */
  getTotalDuration: () => number
  /** Get current playback time in seconds from start */
  getCurrentTime: () => number
}

type ReplayStore = ReplayState & ReplayActions

/**
 * Replay Store
 *
 * Manages VATSIM data snapshots for replay functionality:
 * - Records live snapshots in a circular buffer
 * - Supports playback at various speeds
 * - Handles import/export of replay data (v2: full-fidelity timelines)
 * - Maintains live recording even when viewing imported replays
 */
export const useReplayStore = create<ReplayStore>((set, get) => ({
  // Initial state
  snapshots: [],
  isRecording: true,
  playbackMode: 'live',
  isPlaying: false,
  playbackSpeed: DEFAULT_PLAYBACK_SPEED as PlaybackSpeed,
  currentIndex: 0,
  segmentProgress: 0,
  playbackStartTime: 0,
  playbackStartIndex: 0,
  importedSnapshots: null,
  importedTimeRange: null,
  importedAppState: null,

  // ========================================================================
  // RECORDING
  // ========================================================================

  addSnapshot: (aircraftStates, vatsimTimestamp, lastUpdateInterval) => {
    const { isRecording, snapshots, getMaxSnapshots } = get()

    if (!isRecording) return

    const maxSnapshots = getMaxSnapshots()
    const timestamp = Date.now()

    const snapshot: VatsimSnapshot = {
      timestamp,
      vatsimTimestamp,
      aircraftStates: serializeAircraftStates(aircraftStates),
      lastUpdateInterval,
    }

    // Add to circular buffer efficiently using slice instead of shift
    const newSnapshots = snapshots.length >= maxSnapshots ? [...snapshots.slice(1), snapshot] : [...snapshots, snapshot]

    set({ snapshots: newSnapshots })
  },

  setRecording: (recording) => {
    set({ isRecording: recording })
  },

  clearSnapshots: () => {
    set({ snapshots: [], currentIndex: 0, segmentProgress: 0 })
  },

  // ========================================================================
  // PLAYBACK CONTROL
  // ========================================================================

  play: () => {
    const { playbackMode, getActiveSnapshots, currentIndex, importedTimeRange, segmentProgress } = get()

    // Imported mode uses continuous time-based playback
    if (playbackMode === 'imported') {
      if (!importedTimeRange) return
      const startProgress = segmentProgress >= 1 ? 0 : segmentProgress
      set({
        isPlaying: true,
        playbackStartTime: Date.now(),
        segmentProgress: startProgress,
      })
      return
    }

    const snapshots = getActiveSnapshots()
    if (snapshots.length < 2) return

    // If we're at the end, restart from beginning
    const startIndex = currentIndex >= snapshots.length - 1 ? 0 : currentIndex

    set({
      isPlaying: true,
      playbackMode: playbackMode === 'live' ? 'replay' : playbackMode,
      playbackStartTime: Date.now(),
      playbackStartIndex: startIndex,
      currentIndex: startIndex,
      segmentProgress: 0,
    })
  },

  pause: () => {
    set({ isPlaying: false })
  },

  goLive: () => {
    set({
      playbackMode: 'live',
      isPlaying: false,
      currentIndex: 0,
      segmentProgress: 0,
      importedAppState: null,
      importedTimeRange: null,
    })
  },

  seekTo: (index) => {
    const snapshots = get().getActiveSnapshots()
    const clampedIndex = Math.max(0, Math.min(snapshots.length - 1, index))

    // Clear interpolation state so aircraft jump to the correct position
    useAircraftTimelineStore.getState().clearInterpolationState()

    set({
      currentIndex: clampedIndex,
      segmentProgress: 0,
      isPlaying: false,
      playbackMode: get().playbackMode === 'live' ? 'replay' : get().playbackMode,
      playbackStartTime: Date.now(),
      playbackStartIndex: clampedIndex,
    })
  },

  stepBackward: () => {
    const { currentIndex, playbackMode, getActiveSnapshots } = get()
    const snapshots = getActiveSnapshots()

    const newIndex = playbackMode === 'live' ? Math.max(0, snapshots.length - 2) : Math.max(0, currentIndex - 1)

    // Clear interpolation state so aircraft jump to the correct position
    useAircraftTimelineStore.getState().clearInterpolationState()

    set({
      currentIndex: newIndex,
      segmentProgress: 0,
      isPlaying: false,
      playbackMode: playbackMode === 'live' ? 'replay' : playbackMode,
    })
  },

  stepForward: () => {
    const { currentIndex, getActiveSnapshots, playbackMode } = get()
    const snapshots = getActiveSnapshots()
    const newIndex = Math.min(snapshots.length - 1, currentIndex + 1)

    // Clear interpolation state so aircraft jump to the correct position
    useAircraftTimelineStore.getState().clearInterpolationState()

    set({
      currentIndex: newIndex,
      segmentProgress: 0,
      isPlaying: false,
      playbackMode: playbackMode === 'live' ? 'replay' : playbackMode,
    })
  },

  setPlaybackSpeed: (speed) => {
    // Reset timing when speed changes
    const { currentIndex } = get()
    set({
      playbackSpeed: speed,
      playbackStartTime: Date.now(),
      playbackStartIndex: currentIndex,
    })
  },

  updatePlayback: (deltaMs) => {
    const {
      isPlaying,
      playbackSpeed,
      playbackMode,
      currentIndex,
      segmentProgress,
      getActiveSnapshots,
      importedTimeRange,
    } = get()

    if (!isPlaying) return

    // Imported mode: segmentProgress is 0-1 across the full time range
    if (playbackMode === 'imported') {
      if (!importedTimeRange) return
      const durationMs = importedTimeRange.end - importedTimeRange.start
      if (durationMs <= 0) return
      const progressDelta = (deltaMs * playbackSpeed) / durationMs
      const newProgress = segmentProgress + progressDelta
      if (newProgress >= 1) {
        set({ isPlaying: false, segmentProgress: 1 })
      } else {
        set({ segmentProgress: newProgress })
      }
      return
    }

    const snapshots = getActiveSnapshots()
    if (snapshots.length < 2) return

    // Calculate progress based on speed
    // Each segment is SNAPSHOT_INTERVAL_MS (15 seconds) of real time
    const progressPerMs = playbackSpeed / SNAPSHOT_INTERVAL_MS
    let newProgress = segmentProgress + deltaMs * progressPerMs
    let newIndex = currentIndex

    // Advance through segments as needed
    while (newProgress >= 1 && newIndex < snapshots.length - 2) {
      newProgress -= 1
      newIndex++
    }

    // Check if reached end
    if (newIndex >= snapshots.length - 2 && newProgress >= 1) {
      set({
        isPlaying: false,
        currentIndex: snapshots.length - 1,
        segmentProgress: 0,
      })
      return
    }

    set({
      currentIndex: newIndex,
      segmentProgress: Math.min(1, newProgress),
    })
  },

  // ========================================================================
  // IMPORT / EXPORT
  // ========================================================================

  exportReplay: () => {
    // Serialize the timeline store's observation data (v2 format)
    const timelineStore = useAircraftTimelineStore.getState()
    const timelines = timelineStore.timelines

    if (timelines.size === 0) {
      console.warn('[Replay] No timeline data to export')
      return
    }

    const serialized: SerializedTimeline[] = []
    for (const [callsign, timeline] of timelines) {
      serialized.push({
        callsign,
        observations: [...timeline.observations],
        metadata: { ...timeline.metadata },
        lastSource: timeline.lastSource,
        lastReceivedAt: timeline.lastReceivedAt,
        dynamicDelay: timeline.dynamicDelay
          ? { ...timeline.dynamicDelay, intervalHistory: [...timeline.dynamicDelay.intervalHistory] }
          : undefined,
      })
    }

    const currentAirport = useAirportStore.getState().currentAirport

    const exportData: ReplayExportDataV2 = {
      version: REPLAY_EXPORT_VERSION as 2,
      exportDate: new Date().toISOString(),
      appVersion: APP_VERSION,
      airport: currentAirport?.icao,
      timelines: serialized,
    }

    // Create and download file
    const json = JSON.stringify(exportData)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)

    const date = new Date()
    const dateStr = date.toISOString().slice(0, 10)
    const timeStr = date.toISOString().slice(11, 16).replace(':', '')
    const airportStr = currentAirport?.icao || 'unknown'
    const filename = `${REPLAY_FILE_PREFIX}-${airportStr}-${dateStr}-${timeStr}.json`

    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)

    console.log(`[Replay] Exported ${serialized.length} timelines to ${filename}`)
  },

  importReplay: (data) => {
    if (!data || typeof data !== 'object') {
      console.error('[Replay] Invalid import data: not an object')
      return false
    }

    const version = (data as { version?: number }).version

    // Detect diagnostic package format
    if (isDiagnosticPackage(data)) {
      return importDiagnosticPackage(data as DiagnosticPackage, set, get)
    }

    // V2 replay format (observation-based)
    if (version === 2) {
      return importV2Replay(data as ReplayExportDataV2, set, get)
    }

    // V1 legacy format (snapshot-based)
    if (version === 1) {
      return importV1Replay(data as ReplayExportData, set, get)
    }

    console.error(`[Replay] Unsupported version: ${version}`)
    return false
  },

  clearImportedReplay: () => {
    const { playbackMode } = get()

    set({
      importedSnapshots: null,
      importedTimeRange: null,
      importedAppState: null,
      playbackMode: playbackMode === 'imported' ? 'live' : playbackMode,
      currentIndex: 0,
      segmentProgress: 0,
      isPlaying: false,
    })
  },

  // ========================================================================
  // GETTERS
  // ========================================================================

  getActiveSnapshots: () => {
    const { playbackMode, snapshots, importedSnapshots } = get()
    if (playbackMode === 'imported' && importedSnapshots) {
      return importedSnapshots
    }
    return snapshots
  },

  getCurrentSnapshot: () => {
    const { currentIndex, getActiveSnapshots } = get()
    const snapshots = getActiveSnapshots()
    return snapshots[currentIndex] || null
  },

  getNextSnapshot: () => {
    const { currentIndex, getActiveSnapshots } = get()
    const snapshots = getActiveSnapshots()
    return snapshots[currentIndex + 1] || null
  },

  getMaxSnapshots: () => {
    const maxMinutes = useSettingsStore.getState().memory.maxReplayDurationMinutes
    return Math.ceil((maxMinutes * 60) / 15) // 15 second intervals
  },

  getTotalDuration: () => {
    const { playbackMode, importedTimeRange } = get()
    if (playbackMode === 'imported' && importedTimeRange) {
      return (importedTimeRange.end - importedTimeRange.start) / 1000
    }
    const snapshots = get().getActiveSnapshots()
    if (snapshots.length < 2) return 0
    return ((snapshots.length - 1) * SNAPSHOT_INTERVAL_MS) / 1000
  },

  getCurrentTime: () => {
    const { playbackMode, importedTimeRange, currentIndex, segmentProgress } = get()
    if (playbackMode === 'imported' && importedTimeRange) {
      return (segmentProgress * (importedTimeRange.end - importedTimeRange.start)) / 1000
    }
    return ((currentIndex + segmentProgress) * SNAPSHOT_INTERVAL_MS) / 1000
  },
}))

// ========================================================================
// IMPORT HELPERS (module-private)
// ========================================================================

function isDiagnosticPackage(data: unknown): data is DiagnosticPackage {
  const obj = data as Record<string, unknown>
  return (
    obj.version === DIAGNOSTIC_VERSION &&
    Array.isArray(obj.timelines) &&
    obj.appState !== undefined &&
    obj.exportedAt !== undefined
  )
}

function calculateTimeRange(timelines: SerializedTimeline[]): { start: number; end: number } | null {
  let minTime = Infinity
  let maxTime = -Infinity
  for (const timeline of timelines) {
    for (const obs of timeline.observations) {
      if (obs.observedAt < minTime) minTime = obs.observedAt
      if (obs.observedAt > maxTime) maxTime = obs.observedAt
    }
  }
  return minTime < Infinity && maxTime > -Infinity ? { start: minTime, end: maxTime } : null
}

function importDiagnosticPackage(
  data: DiagnosticPackage,
  set: (state: Partial<ReplayState>) => void,
  _get: () => ReplayStore,
): boolean {
  if (!Array.isArray(data.timelines) || data.timelines.length === 0) {
    console.error('[Replay] Invalid diagnostic data: no timelines')
    return false
  }

  const timeRange = calculateTimeRange(data.timelines)

  // Load timelines into the timeline store
  useAircraftTimelineStore.getState().loadImportedTimelines(data.timelines)

  set({
    playbackMode: 'imported',
    importedAppState: data.appState,
    importedTimeRange: timeRange,
    importedSnapshots: null,
    currentIndex: 0,
    segmentProgress: 0,
    isPlaying: false,
  })

  console.log(
    `[Replay] Imported diagnostic: ${data.timelines.length} timelines` +
      (data.appState.airport ? ` from ${data.appState.airport.icao}` : ''),
  )
  return true
}

function importV2Replay(
  data: ReplayExportDataV2,
  set: (state: Partial<ReplayState>) => void,
  _get: () => ReplayStore,
): boolean {
  if (!Array.isArray(data.timelines) || data.timelines.length === 0) {
    console.error('[Replay] Invalid v2 import data: no timelines')
    return false
  }

  const timeRange = calculateTimeRange(data.timelines)

  // Load timelines into the timeline store
  useAircraftTimelineStore.getState().loadImportedTimelines(data.timelines)

  set({
    playbackMode: 'imported',
    importedAppState: data.appState ?? null,
    importedTimeRange: timeRange,
    importedSnapshots: null,
    currentIndex: 0,
    segmentProgress: 0,
    isPlaying: false,
  })

  console.log(
    `[Replay] Imported v2 replay: ${data.timelines.length} timelines from ${data.airport || 'unknown airport'}`,
  )
  return true
}

function importV1Replay(
  data: ReplayExportData,
  set: (state: Partial<ReplayState>) => void,
  _get: () => ReplayStore,
): boolean {
  if (data.version !== 1) {
    console.error(`[Replay] Expected v1, got version ${data.version}`)
    return false
  }

  const v1Data = data as { snapshots?: VatsimSnapshot[] }
  if (!Array.isArray(v1Data.snapshots) || v1Data.snapshots.length === 0) {
    console.error('[Replay] Invalid v1 import data: no snapshots')
    return false
  }

  // Convert v1 snapshots to timelines via loadReplaySnapshots, then
  // use the timeline store's time range for continuous scrubbing
  const timelineStore = useAircraftTimelineStore.getState()
  timelineStore.loadReplaySnapshots(v1Data.snapshots)

  const timeRange = timelineStore.getReplayTimeRange()

  set({
    importedSnapshots: null,
    importedTimeRange: timeRange,
    importedAppState: null,
    playbackMode: 'imported',
    currentIndex: 0,
    segmentProgress: 0,
    isPlaying: false,
  })

  console.log(
    `[Replay] Imported v1 replay: ${v1Data.snapshots.length} snapshots from ${data.airport || 'unknown airport'} (converted to timelines)`,
  )
  return true
}
