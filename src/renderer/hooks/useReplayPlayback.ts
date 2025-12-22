import { useEffect, useRef } from 'react'
import { useReplayStore } from '../stores/replayStore'

/**
 * Hook that manages replay playback timing.
 *
 * This hook is now simplified to ONLY advance the playback position.
 * The actual aircraft interpolation is handled by useAircraftInterpolation,
 * which reads from the appropriate data source (live or replay) via
 * getAircraftDataSource().
 *
 * ## Responsibilities
 * - Run a playback animation loop when not in live mode
 * - Advance playback position (currentIndex, segmentProgress) based on elapsed time
 * - Respect playback speed setting
 *
 * ## NOT Responsible For (anymore)
 * - Interpolating between snapshots (handled by useAircraftInterpolation)
 * - Injecting data into vatsimStore (eliminated - no more injectReplayData)
 *
 * @example
 * ```tsx
 * function ReplayTimeline() {
 *   // Just call the hook - it manages playback timing automatically
 *   useReplayPlayback()
 *
 *   return <TimelineUI />
 * }
 * ```
 */
export function useReplayPlayback(): void {
  const lastFrameTimeRef = useRef<number>(0)
  const animationFrameRef = useRef<number | null>(null)

  // Subscribe to playbackMode to start/stop the loop
  const playbackMode = useReplayStore((state) => state.playbackMode)

  // Subscribe to isPlaying to start/stop the loop
  const isPlaying = useReplayStore((state) => state.isPlaying)

  useEffect(() => {
    if (playbackMode === 'live' || !isPlaying) {
      // In live mode or when paused, nothing to do
      return
    }

    function playbackLoop(timestamp: number) {
      const deltaMs = lastFrameTimeRef.current > 0
        ? timestamp - lastFrameTimeRef.current
        : 16.67 // Assume 60fps for first frame

      lastFrameTimeRef.current = timestamp

      // Read fresh state from store to check if still playing
      const { isPlaying: stillPlaying, updatePlayback } = useReplayStore.getState()

      if (stillPlaying) {
        updatePlayback(deltaMs)
        // Continue the loop only while playing
        animationFrameRef.current = requestAnimationFrame(playbackLoop)
      }
    }

    // Start the loop
    lastFrameTimeRef.current = 0
    animationFrameRef.current = requestAnimationFrame(playbackLoop)

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }
    }
  }, [playbackMode, isPlaying])
}

export default useReplayPlayback
