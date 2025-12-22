/**
 * Replay System Constants
 *
 * Configuration values for the VATSIM data replay system
 */

// ============================================================================
// SNAPSHOT CONFIGURATION
// ============================================================================

/**
 * Expected interval between VATSIM updates in milliseconds
 * Snapshots are captured at this rate (every 15 seconds)
 */
export const SNAPSHOT_INTERVAL_MS = 15000

/**
 * Default maximum replay buffer duration in minutes
 * Users can configure this from 1-60 minutes
 */
export const DEFAULT_REPLAY_DURATION_MINUTES = 15

/**
 * Minimum replay buffer duration in minutes
 */
export const MIN_REPLAY_DURATION_MINUTES = 1

/**
 * Maximum replay buffer duration in minutes
 */
export const MAX_REPLAY_DURATION_MINUTES = 60

// ============================================================================
// PLAYBACK CONFIGURATION
// ============================================================================

/**
 * Available playback speed options
 */
export const PLAYBACK_SPEEDS = [0.5, 1, 2, 4] as const

/**
 * Default playback speed (1x = real-time)
 */
export const DEFAULT_PLAYBACK_SPEED = 1

/**
 * Minimum time to show between scrubber updates during playback (ms)
 * Prevents excessive UI updates while maintaining smooth playback
 */
export const PLAYBACK_UI_UPDATE_INTERVAL_MS = 100

// ============================================================================
// MEMORY ESTIMATES
// ============================================================================

/**
 * Estimated bytes per aircraft state (for memory usage display)
 * Includes callsign, position, velocity, flight plan info
 */
export const BYTES_PER_AIRCRAFT_STATE = 200

/**
 * Calculate estimated memory usage for replay buffer
 * @param durationMinutes - Buffer duration in minutes
 * @param averageAircraftCount - Average number of aircraft in range
 * @returns Estimated memory usage in MB
 */
export function estimateReplayMemoryMB(durationMinutes: number, averageAircraftCount: number = 100): number {
  const snapshotCount = Math.ceil(durationMinutes * 60 / 15)
  const bytesPerSnapshot = averageAircraftCount * BYTES_PER_AIRCRAFT_STATE * 2 // current + previous states
  const totalBytes = snapshotCount * bytesPerSnapshot
  return totalBytes / (1024 * 1024)
}

// ============================================================================
// EXPORT FILE FORMAT
// ============================================================================

/**
 * Current replay export format version
 */
export const REPLAY_EXPORT_VERSION = 1

/**
 * File extension for replay exports (without dot)
 */
export const REPLAY_FILE_EXTENSION = 'json'

/**
 * Suggested file name prefix for replay exports
 */
export const REPLAY_FILE_PREFIX = 'towercab-replay'
