/**
 * Formatting utilities for time, angles, and display values
 */

// Replay time formatting helpers

/**
 * Format seconds as relative time (e.g., "2m 30s ago")
 */
export function formatRelativeTime(totalSeconds: number): string {
  const seconds = Math.floor(totalSeconds % 60)
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes === 0) return `${seconds}s ago`
  return `${minutes}m ${seconds}s ago`
}

/**
 * Format timestamp as UTC time string (e.g., "14:30:00 UTC")
 */
export function formatUTCTime(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toISOString().slice(11, 19) + ' UTC'
}

/**
 * Format seconds as duration (e.g., "2:30")
 */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.floor(totalSeconds % 60)
  const minutes = Math.floor(totalSeconds / 60)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

// Angle formatting helpers

/**
 * Format heading angle with zero-padding (e.g., "045°")
 */
export function formatAngle(angle: number): string {
  return Math.round(((angle % 360) + 360) % 360).toString().padStart(3, '0') + '°'
}

/**
 * Format pitch angle with sign (e.g., "+15°" or "-10°")
 */
export function formatPitch(angle: number): string {
  const sign = angle >= 0 ? '+' : ''
  return sign + Math.round(angle) + '°'
}

/**
 * Format decimal hour to HH:MM (e.g., 14.5 -> "14:30")
 */
export function formatTimeHour(hour: number): string {
  const h = Math.floor(hour)
  const m = Math.round((hour - h) * 60)
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
}
