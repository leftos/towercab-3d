import { create } from 'zustand'
import type { VatsimSnapshot, PlaybackMode, PlaybackSpeed, ReplayExportData } from '../types/replay'
import { serializeAircraftStates, deserializeAircraftStates } from '../types/replay'
import type { AircraftState } from '../types/vatsim'
import { useSettingsStore } from './settingsStore'
import { useAirportStore } from './airportStore'
import {
  SNAPSHOT_INTERVAL_MS,
  DEFAULT_PLAYBACK_SPEED,
  REPLAY_EXPORT_VERSION,
  REPLAY_FILE_PREFIX
} from '../constants/replay'

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
  /** Current playback mode: live, replay (recorded), or imported */
  playbackMode: PlaybackMode
  /** Whether playback is running (false = paused) */
  isPlaying: boolean
  /** Current playback speed multiplier */
  playbackSpeed: PlaybackSpeed
  /** Current position in snapshots array */
  currentIndex: number
  /** Interpolation progress within current segment (0-1) */
  segmentProgress: number
  /** Timestamp when current playback segment started (for timing) */
  playbackStartTime: number
  /** Index when current playback segment started */
  playbackStartIndex: number

  // Imported replay
  /** Imported replay data (separate from live recording) */
  importedSnapshots: VatsimSnapshot[] | null
}

/**
 * Replay store actions interface
 */
interface ReplayActions {
  // Recording
  /** Add a new snapshot to the buffer (called by vatsimStore) */
  addSnapshot: (
    aircraftStates: Map<string, AircraftState>,
    vatsimTimestamp: number,
    lastUpdateInterval: number
  ) => void
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
  /** Seek to specific snapshot index */
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
  /** Export current replay data to downloadable file */
  exportReplay: () => void
  /** Import replay data from file */
  importReplay: (data: ReplayExportData) => boolean
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
 * - Handles import/export of replay data
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
      lastUpdateInterval
    }

    // Add to circular buffer efficiently using slice instead of shift
    const newSnapshots = snapshots.length >= maxSnapshots
      ? [...snapshots.slice(1), snapshot]
      : [...snapshots, snapshot]

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
    const { playbackMode, getActiveSnapshots, currentIndex } = get()
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
      segmentProgress: 0
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
      segmentProgress: 0
    })
  },

  seekTo: (index) => {
    const snapshots = get().getActiveSnapshots()
    const clampedIndex = Math.max(0, Math.min(snapshots.length - 1, index))

    set({
      currentIndex: clampedIndex,
      segmentProgress: 0,
      isPlaying: false,
      playbackMode: get().playbackMode === 'live' ? 'replay' : get().playbackMode,
      playbackStartTime: Date.now(),
      playbackStartIndex: clampedIndex
    })
  },

  stepBackward: () => {
    const { currentIndex, playbackMode, getActiveSnapshots } = get()
    const snapshots = getActiveSnapshots()

    // In live mode, user is conceptually at the end of the buffer (index = length - 1)
    // Step backward goes to length - 2, which with segmentProgress = 0 shows:
    //   - previousStates from snapshot[length-2] (15s ago)
    //   - aircraftStates from snapshot[length-1] (most recent)
    //   - t = 0, so aircraft appears at previousStates position (15s ago)
    const newIndex = playbackMode === 'live'
      ? Math.max(0, snapshots.length - 2)
      : Math.max(0, currentIndex - 1)

    set({
      currentIndex: newIndex,
      segmentProgress: 0,
      isPlaying: false,
      playbackMode: playbackMode === 'live' ? 'replay' : playbackMode
    })
  },

  stepForward: () => {
    const { currentIndex, getActiveSnapshots, playbackMode } = get()
    const snapshots = getActiveSnapshots()
    const newIndex = Math.min(snapshots.length - 1, currentIndex + 1)

    set({
      currentIndex: newIndex,
      segmentProgress: 0,
      isPlaying: false,
      playbackMode: playbackMode === 'live' ? 'replay' : playbackMode
    })
  },

  setPlaybackSpeed: (speed) => {
    // Reset timing when speed changes
    const { currentIndex } = get()
    set({
      playbackSpeed: speed,
      playbackStartTime: Date.now(),
      playbackStartIndex: currentIndex
    })
  },

  updatePlayback: (deltaMs) => {
    const { isPlaying, playbackSpeed, currentIndex, segmentProgress, getActiveSnapshots } = get()

    if (!isPlaying) return

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
        segmentProgress: 0
      })
      return
    }

    set({
      currentIndex: newIndex,
      segmentProgress: Math.min(1, newProgress)
    })
  },

  // ========================================================================
  // IMPORT / EXPORT
  // ========================================================================

  exportReplay: () => {
    const snapshots = get().getActiveSnapshots()

    if (snapshots.length === 0) {
      console.warn('[Replay] No snapshots to export')
      return
    }

    const currentAirport = useAirportStore.getState().currentAirport

    const exportData: ReplayExportData = {
      version: REPLAY_EXPORT_VERSION,
      exportDate: new Date().toISOString(),
      appVersion: '0.0.5-alpha', // TODO: Get from package.json
      airport: currentAirport?.icao,
      snapshots
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

    console.log(`[Replay] Exported ${snapshots.length} snapshots to ${filename}`)
  },

  importReplay: (data) => {
    // Validate format
    if (!data || typeof data !== 'object') {
      console.error('[Replay] Invalid import data: not an object')
      return false
    }

    if (data.version !== REPLAY_EXPORT_VERSION) {
      console.error(`[Replay] Unsupported version: ${data.version}`)
      return false
    }

    if (!Array.isArray(data.snapshots) || data.snapshots.length === 0) {
      console.error('[Replay] Invalid import data: no snapshots')
      return false
    }

    // Validate snapshot structure (spot check first one)
    const first = data.snapshots[0]
    if (
      typeof first.timestamp !== 'number' ||
      !Array.isArray(first.aircraftStates)
    ) {
      console.error('[Replay] Invalid snapshot structure')
      return false
    }

    set({
      importedSnapshots: data.snapshots,
      playbackMode: 'imported',
      currentIndex: 0,
      segmentProgress: 0,
      isPlaying: false
    })

    console.log(`[Replay] Imported ${data.snapshots.length} snapshots from ${data.airport || 'unknown airport'}`)
    return true
  },

  clearImportedReplay: () => {
    const { playbackMode } = get()

    set({
      importedSnapshots: null,
      playbackMode: playbackMode === 'imported' ? 'live' : playbackMode,
      currentIndex: 0,
      segmentProgress: 0,
      isPlaying: false
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
    return Math.ceil(maxMinutes * 60 / 15) // 15 second intervals
  },

  getTotalDuration: () => {
    const snapshots = get().getActiveSnapshots()
    if (snapshots.length < 2) return 0
    return (snapshots.length - 1) * SNAPSHOT_INTERVAL_MS / 1000
  },

  getCurrentTime: () => {
    const { currentIndex, segmentProgress } = get()
    return (currentIndex + segmentProgress) * SNAPSHOT_INTERVAL_MS / 1000
  }
}))

/**
 * Helper to convert snapshot to injectable state
 * Returns Map that can be used for aircraft state
 */
export function snapshotToState(snapshot: VatsimSnapshot): {
  aircraftStates: Map<string, AircraftState>
} {
  return {
    aircraftStates: deserializeAircraftStates(snapshot.aircraftStates)
  }
}
