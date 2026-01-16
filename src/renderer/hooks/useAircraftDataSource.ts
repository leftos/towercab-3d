/**
 * Unified Aircraft Data Source
 *
 * Provides timing and mode information for the interpolation system.
 * The actual aircraft data comes from the timeline store.
 *
 * In LIVE mode: Returns current timestamp
 * In REPLAY/IMPORTED mode: Returns effective timestamp based on segment progress
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
      playbackMode: 'live'
    }
  }

  // REPLAY or IMPORTED MODE: Calculate effective timestamp based on segment progress
  const snapshots = getActiveSnapshots()
  const currentSnapshot = snapshots[currentIndex]
  const nextSnapshot = snapshots[currentIndex + 1]

  if (!currentSnapshot) {
    return {
      timestamp: Date.now(),
      playbackMode
    }
  }

  // If at end of snapshots, use current snapshot's timestamp
  if (!nextSnapshot) {
    return {
      timestamp: currentSnapshot.timestamp,
      playbackMode
    }
  }

  // Calculate effective "now" between current and next snapshot
  // effectiveNow = currentSnapshot.timestamp + segmentProgress * interval
  const interval = nextSnapshot.timestamp - currentSnapshot.timestamp
  const effectiveNow = currentSnapshot.timestamp + (segmentProgress * interval)

  return {
    timestamp: effectiveNow,
    playbackMode
  }
}
