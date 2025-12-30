/**
 * Camera-related type definitions
 *
 * This file centralizes all camera state and view mode types used across
 * the viewport system, camera hooks, and controls.
 *
 * @see viewportStore - Main store for per-viewport camera state
 * @see useCesiumCamera - Hook that applies camera state to Cesium viewer
 * @see useCameraInput - Hook for keyboard/mouse camera controls
 */

/**
 * Camera view mode
 *
 * - `3d`: Tower-based 3D view with user-controlled heading/pitch/FOV
 * - `topdown`: Orthographic-style view looking straight down from altitude
 */
export type ViewMode = '3d' | 'topdown'

/**
 * Aircraft following mode
 *
 * - `tower`: Camera stays at tower, rotates to track aircraft, zoom adjusts FOV
 * - `orbit`: Camera orbits around aircraft at configurable distance/heading/pitch
 */
export type FollowMode = 'tower' | 'orbit'

/**
 * Camera state saved before following an aircraft
 *
 * Used to restore the previous view when the user stops following.
 * Only captures view-related state, not position offsets.
 *
 * @see ViewportCameraState.preFollowState
 */
export interface PreFollowState {
  /** Camera heading in degrees (0-360, 0 = North) */
  heading: number
  /** Camera pitch in degrees (-90 to 90, negative = looking down) */
  pitch: number
  /** Field of view in degrees (10-120) */
  fov: number
  /** View mode when following started */
  viewMode: ViewMode
}

/**
 * Complete camera state for a single viewport
 *
 * This interface defines all camera parameters for a viewport, including:
 * - View mode (3D tower view vs top-down view)
 * - Camera orientation (heading, pitch, FOV)
 * - Position offset from tower center (in local ENU coordinates)
 * - Aircraft following state and parameters
 * - Orbit mode parameters
 *
 * State transitions for following mode:
 * ```
 * NOT_FOLLOWING (followingCallsign=null)
 *   → followAircraft() → FOLLOWING (followingCallsign set, preFollowState saved)
 *   → stopFollowing(restore=true) → NOT_FOLLOWING (preFollowState restored)
 *   → stopFollowing(restore=false) → NOT_FOLLOWING (stay at current view)
 * ```
 *
 * @example
 * // Default 3D tower view
 * const defaultState: ViewportCameraState = {
 *   viewMode: '3d',
 *   heading: 0,
 *   pitch: -15,
 *   fov: 60,
 *   positionOffsetX: 0,
 *   positionOffsetY: 0,
 *   positionOffsetZ: 0,
 *   topdownAltitude: 2000,
 *   followingCallsign: null,
 *   followMode: 'tower',
 *   followZoom: 1.0,
 *   preFollowState: null,
 *   orbitDistance: 500,
 *   orbitHeading: 315,
 *   orbitPitch: 15
 * }
 *
 * @example
 * // Following aircraft AAL123 in orbit mode
 * const followingState: ViewportCameraState = {
 *   // ... other fields
 *   followingCallsign: 'AAL123',
 *   followMode: 'orbit',
 *   orbitDistance: 1000,  // 1km from aircraft
 *   orbitHeading: 45,     // Look from northeast
 *   orbitPitch: -20,      // Look down 20 degrees
 *   preFollowState: {     // Saved for restore
 *     heading: 180,
 *     pitch: -15,
 *     fov: 60,
 *     viewMode: '3d'
 *   }
 * }
 */
export interface ViewportCameraState {
  // View mode
  /** Camera view mode: 3D tower view or top-down view */
  viewMode: ViewMode

  // Camera orientation (degrees)
  /** Camera heading in degrees (0-360, 0 = North, 90 = East, clockwise) */
  heading: number
  /** Camera pitch in degrees (-90 to 90, negative = looking down, 0 = horizon, positive = looking up) */
  pitch: number
  /** Field of view in degrees (10-120, smaller = more zoomed in) */
  fov: number

  // Position offset from tower (meters, in local ENU coordinates)
  /** Offset east (+) or west (-) from tower center in meters */
  positionOffsetX: number
  /** Offset north (+) or south (-) from tower center in meters (ENU: Y points up, not north!) */
  positionOffsetY: number
  /** Offset up (+) or down (-) from tower center in meters */
  positionOffsetZ: number

  // Top-down view altitude (meters above airport)
  /**
   * Altitude for top-down view in meters above airport elevation
   * Only used when viewMode === 'topdown'
   * Range: 500-50000 meters
   */
  topdownAltitude: number

  // Follow mode state
  /**
   * Callsign of aircraft being followed, or null if not following
   * When set, camera will track this aircraft according to followMode
   */
  followingCallsign: string | null
  /** Following mode: tower tracking or orbit */
  followMode: FollowMode
  /**
   * Zoom factor for tower follow mode (0.5-10.0, 1.0 = default)
   * Lower values = more zoomed in, higher = more zoomed out
   */
  followZoom: number
  /**
   * Camera state before following started, used to restore view when stopping
   * Null if not currently following or if follow state should not be restored
   */
  preFollowState: PreFollowState | null

  // Orbit follow mode parameters
  /** Distance from aircraft in orbit mode (50-5000 meters) */
  orbitDistance: number
  /**
   * Heading around aircraft in orbit mode (0-360 degrees)
   * 0 = view from north, 90 = view from east, etc.
   */
  orbitHeading: number
  /**
   * Pitch in orbit mode (-89 to 89 degrees)
   * Negative = looking down, 0 = horizontal, positive = looking up
   * Limited to ±89 to prevent gimbal lock
   */
  orbitPitch: number

  /**
   * Target for smooth camera pan animation
   * When set, the camera input system will smoothly animate heading/pitch toward this target.
   * Set when clicking an aircraft in the list to center it on screen.
   * Cleared when animation completes or user manually moves camera.
   */
  lookAtTarget: { heading: number; pitch: number } | null
}

/**
 * Camera bookmark state (subset of ViewportCameraState)
 *
 * Bookmarks capture only the camera view parameters, not follow state.
 * Used by the bookmark system (100 slots per airport, 0-99).
 *
 * @see viewportStore.saveBookmark
 * @see viewportStore.loadBookmark
 */
export interface CameraBookmark {
  /** Optional user-defined name for the bookmark */
  name?: string
  /** View mode (3D or top-down) */
  viewMode: ViewMode
  /** Camera heading in degrees (0-360) */
  heading: number
  /** Camera pitch in degrees (-90 to 90) */
  pitch: number
  /** Field of view in degrees (10-120) */
  fov: number
  /** Position offset east/west from tower in meters */
  positionOffsetX: number
  /** Position offset north/south from tower in meters */
  positionOffsetY: number
  /** Position offset up/down from tower in meters */
  positionOffsetZ: number
  /** Top-down view altitude in meters above airport */
  topdownAltitude: number
}
