/**
 * Unified Aircraft Data Source
 *
 * Provides timing and mode information for the interpolation system.
 * The actual aircraft data comes from the timeline store.
 *
 * In LIVE mode: Returns current timestamp
 * In REPLAY mode: Returns effective timestamp based on segment progress (snapshot-based)
 * In IMPORTED mode: Returns effective timestamp mapped across imported time range
 */

import { useReplayStore } from '../stores/replayStore'
import type { PlaybackMode } from '../types/replay'

export interface AircraftDataSource {
  /** Effective "now" timestamp for interpolation factor calculation */
  timestamp: number
  /** Current playback mode */
  playbackMode: PlaybackMode
}

/**
 * Get timing and mode information for the interpolation system.
 *
 * This function is designed to be called from the animation loop each frame.
 * It reads directly from store state (not React subscriptions) for performance.
 *
 * @returns AircraftDataSource with timestamp and playback mode
 */
export function getAircraftDataSource(): AircraftDataSource {
  const replayState = useReplayStore.getState()
  const { playbackMode, currentIndex, segmentProgress, getActiveSnapshots } = replayState

  if (playbackMode === 'live') {
    return {
      timestamp: Date.now(),
      playbackMode: 'live',
    }
  }

  // IMPORTED MODE: Map segmentProgress (0-1) across the full time range
  if (playbackMode === 'imported') {
    const { importedTimeRange } = replayState
    if (!importedTimeRange) {
      return { timestamp: Date.now(), playbackMode }
    }
    const duration = importedTimeRange.end - importedTimeRange.start
    const effectiveNow = importedTimeRange.start + segmentProgress * duration
    return { timestamp: effectiveNow, playbackMode }
  }

  // REPLAY MODE: Calculate effective timestamp based on segment progress (buffer replay)
  const snapshots = getActiveSnapshots()
  const currentSnapshot = snapshots[currentIndex]
  const nextSnapshot = snapshots[currentIndex + 1]

  if (!currentSnapshot) {
    return {
      timestamp: Date.now(),
      playbackMode,
    }
  }

  // If at end of snapshots, use current snapshot's timestamp
  if (!nextSnapshot) {
    return {
      timestamp: currentSnapshot.timestamp,
      playbackMode,
    }
  }

  // Calculate effective "now" between current and next snapshot
  const interval = nextSnapshot.timestamp - currentSnapshot.timestamp
  const effectiveNow = currentSnapshot.timestamp + segmentProgress * interval

  return {
    timestamp: effectiveNow,
    playbackMode,
  }
}
