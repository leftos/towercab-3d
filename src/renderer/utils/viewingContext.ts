/**
 * Viewing Context Utilities
 *
 * Helper functions to determine if the camera has a specific location context
 * (viewing an airport or following an aircraft) vs viewing the globe from space.
 */

import type { Airport } from '@/types'
import type { FollowMode } from '@/types/camera'

/**
 * Check if we're actively orbit-following an aircraft
 */
export function isOrbitFollowing(followMode: FollowMode, followingCallsign: string | null): boolean {
  return followMode === 'orbit' && !!followingCallsign
}

/**
 * Check if we're orbit-following an aircraft without an airport selected
 */
export function isOrbitWithoutAirport(
  currentAirport: Airport | null,
  followMode: FollowMode,
  followingCallsign: string | null
): boolean {
  return !currentAirport && isOrbitFollowing(followMode, followingCallsign)
}

/**
 * Check if we have a viewing context (not just looking at globe from space)
 * True when either:
 * - An airport is selected, OR
 * - We're orbit-following an aircraft
 *
 * Use this to guard features that only make sense when viewing a specific location
 * (e.g., weather effects, terrain sampling)
 */
export function hasViewingContext(
  currentAirport: Airport | null,
  followMode: FollowMode,
  followingCallsign: string | null
): boolean {
  return !!currentAirport || isOrbitFollowing(followMode, followingCallsign)
}
