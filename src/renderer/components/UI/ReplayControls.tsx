import { useRef, useCallback, useEffect } from 'react'
import { useReplayStore } from '../../stores/replayStore'
import { useReplayPlayback } from '../../hooks/useReplayPlayback'
import { PLAYBACK_SPEEDS } from '../../constants/replay'
import { formatRelativeTime, formatUTCTime, formatDuration } from '../../utils/formatting'
import type { PlaybackSpeed } from '../../types/replay'
import './ControlsBar.css'

interface ReplayControlsProps {
  onSettingsClick: () => void
}

function ReplayControls({ onSettingsClick }: ReplayControlsProps) {
  // Initialize replay playback engine
  useReplayPlayback()

  const scrubberRef = useRef<HTMLInputElement>(null)

  // Replay store - settings panel
  const replaySnapshots = useReplayStore((state) => state.snapshots)
  const importedSnapshots = useReplayStore((state) => state.importedSnapshots)

  // Replay store - playback controls
  const playbackMode = useReplayStore((state) => state.playbackMode)
  const isPlaying = useReplayStore((state) => state.isPlaying)
  const playbackSpeed = useReplayStore((state) => state.playbackSpeed)
  const currentIndex = useReplayStore((state) => state.currentIndex)
  const segmentProgress = useReplayStore((state) => state.segmentProgress)
  const getTotalDuration = useReplayStore((state) => state.getTotalDuration)
  const play = useReplayStore((state) => state.play)
  const pause = useReplayStore((state) => state.pause)
  const goLive = useReplayStore((state) => state.goLive)
  const seekTo = useReplayStore((state) => state.seekTo)
  const stepBackward = useReplayStore((state) => state.stepBackward)
  const stepForward = useReplayStore((state) => state.stepForward)
  const setPlaybackSpeed = useReplayStore((state) => state.setPlaybackSpeed)

  // Derive active snapshots for replay
  const activeSnapshots = playbackMode === 'imported' && importedSnapshots
    ? importedSnapshots
    : replaySnapshots

  // Computed values
  const isLive = playbackMode === 'live'
  const hasSnapshots = activeSnapshots.length >= 2
  const totalDuration = getTotalDuration()

  // Calculate current timestamp for display
  const currentSnapshot = activeSnapshots[currentIndex]
  const currentTimestamp = currentSnapshot?.timestamp || Date.now()
  const newestSnapshot = activeSnapshots[activeSnapshots.length - 1]
  const newestTimestamp = newestSnapshot?.timestamp || Date.now()
  const timeAgo = isLive ? 0 : (newestTimestamp - currentTimestamp) / 1000

  // Scrubber position
  const scrubberValue = currentIndex + segmentProgress
  const scrubberMax = Math.max(1, activeSnapshots.length - 1)

  const handleScrubberChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(e.target.value)
    const index = Math.floor(value)
    seekTo(index)
  }, [seekTo])

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      pause()
    } else {
      play()
    }
  }, [isPlaying, play, pause])

  const handleSpeedChange = useCallback((speed: PlaybackSpeed) => {
    setPlaybackSpeed(speed)
  }, [setPlaybackSpeed])

  // Keyboard shortcuts for replay
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return
      }

      switch (e.key) {
        case ' ':
          e.preventDefault()
          handlePlayPause()
          break
        case 'ArrowLeft':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault()
            stepBackward()
          }
          break
        case 'ArrowRight':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault()
            stepForward()
          }
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handlePlayPause, stepBackward, stepForward])

  return (
    <>
      <div className="replay-controls-left">
        <button
          className="timeline-btn step-btn"
          onClick={stepBackward}
          disabled={!hasSnapshots || (!isLive && currentIndex === 0)}
          title="Step backward (15s)"
        >
          <svg viewBox="0 0 24 24" width="16" height="16">
            <path fill="currentColor" d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
          </svg>
        </button>

        <button
          className="timeline-btn play-btn"
          onClick={handlePlayPause}
          disabled={!hasSnapshots}
          title={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? (
            <svg viewBox="0 0 24 24" width="20" height="20">
              <path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="20" height="20">
              <path fill="currentColor" d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        <button
          className="timeline-btn step-btn"
          onClick={stepForward}
          disabled={!hasSnapshots || isLive || currentIndex >= activeSnapshots.length - 1}
          title="Step forward (15s)"
        >
          <svg viewBox="0 0 24 24" width="16" height="16">
            <path fill="currentColor" d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
          </svg>
        </button>
      </div>

      <div className="replay-controls-center">
        <div className="timeline-scrubber">
          <input
            ref={scrubberRef}
            type="range"
            min="0"
            max={scrubberMax}
            step="0.01"
            value={scrubberValue}
            onChange={handleScrubberChange}
            disabled={!hasSnapshots}
            className="scrubber-input"
          />
          <div
            className="scrubber-progress"
            style={{ width: `${(scrubberValue / scrubberMax) * 100}%` }}
          />
        </div>

        <div className="timeline-time">
          {isLive ? (
            <span className="time-live-indicator">LIVE</span>
          ) : (
            <>
              <span className="time-relative">{formatRelativeTime(timeAgo)}</span>
              <span className="time-separator">-</span>
              <span className="time-absolute">{formatUTCTime(currentTimestamp)}</span>
            </>
          )}
          <span className="time-total">
            Buffer: {formatDuration(totalDuration)}
          </span>
        </div>
      </div>

      <div className="replay-controls-right">
        <div className="speed-selector">
          {PLAYBACK_SPEEDS.map((speed) => (
            <button
              key={speed}
              className={`speed-btn ${playbackSpeed === speed ? 'active' : ''}`}
              onClick={() => handleSpeedChange(speed as PlaybackSpeed)}
              disabled={isLive}
            >
              {speed}x
            </button>
          ))}
        </div>

        <button
          className={`live-btn ${isLive ? 'active' : ''}`}
          onClick={goLive}
          title="Return to live"
        >
          LIVE
        </button>

        <button
          className="control-button"
          onClick={onSettingsClick}
          title="Settings"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </>
  )
}

export default ReplayControls
