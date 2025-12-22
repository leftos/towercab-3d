/**
 * Camera configuration and limits
 *
 * This file centralizes camera-related constants including FOV limits,
 * camera speeds, pitch/heading constraints, and orbit mode defaults.
 *
 * Used by: useCesiumCamera, useCameraInput, viewportStore
 */

// ============================================================================
// FIELD OF VIEW (FOV) LIMITS
// ============================================================================

/**
 * Minimum field of view in degrees
 *
 * Lower bound for camera zoom.
 * Smaller FOV = more zoomed in (telephoto effect)
 */
export const FOV_MIN = 10

/**
 * Maximum field of view in degrees
 *
 * Upper bound for camera zoom.
 * Larger FOV = more zoomed out (wide-angle effect)
 */
export const FOV_MAX = 120

/**
 * Default field of view in degrees
 *
 * Standard perspective matching human vision (~60°)
 */
export const FOV_DEFAULT = 60

// ============================================================================
// CAMERA MOVEMENT SPEEDS
// ============================================================================

/**
 * Camera movement speed multiplier
 *
 * Applied to WASD/arrow key movement.
 * Higher values = faster camera movement
 */
export const CAMERA_MOVE_SPEED_MULTIPLIER = 0.05

/**
 * Camera rotation speed (radians per pixel)
 *
 * Applied to mouse drag rotation.
 * Lower values = slower, smoother rotation
 */
export const CAMERA_ROTATION_SPEED = 0.005

/**
 * Camera zoom speed (FOV change per scroll tick)
 *
 * Applied to mouse wheel zoom.
 * Higher values = faster zoom
 */
export const CAMERA_ZOOM_SPEED = 0.1

// ============================================================================
// PITCH LIMITS
// ============================================================================

/**
 * Minimum camera pitch in degrees
 *
 * -90 = looking straight down
 */
export const PITCH_MIN = -90

/**
 * Maximum camera pitch in degrees
 *
 * +90 = looking straight up
 */
export const PITCH_MAX = 90

/**
 * Default camera pitch in degrees
 *
 * -15 = looking slightly downward (tower view default)
 */
export const PITCH_DEFAULT = -15

// ============================================================================
// HEADING
// ============================================================================

/**
 * Default camera heading in degrees
 *
 * 0 = North, 90 = East, 180 = South, 270 = West
 */
export const HEADING_DEFAULT = 0

// ============================================================================
// ORBIT FOLLOW MODE DEFAULTS
// ============================================================================

/**
 * Minimum orbit distance from aircraft in meters
 *
 * Prevents camera from getting too close to the followed aircraft.
 */
export const ORBIT_DISTANCE_MIN = 50

/**
 * Maximum orbit distance from aircraft in meters
 *
 * Limits how far the camera can orbit from the followed aircraft.
 */
export const ORBIT_DISTANCE_MAX = 5000

/**
 * Default orbit distance from aircraft in meters
 *
 * Standard distance for orbit following (500m = ~1/3 NM)
 */
export const ORBIT_DISTANCE_DEFAULT = 500

/**
 * Minimum orbit pitch in degrees
 *
 * Limited to -89° to prevent gimbal lock (avoid straight down)
 */
export const ORBIT_PITCH_MIN = -89

/**
 * Maximum orbit pitch in degrees
 *
 * Limited to +89° to prevent gimbal lock (avoid straight up)
 */
export const ORBIT_PITCH_MAX = 89

/**
 * Default orbit pitch in degrees
 *
 * Positive = looking up at aircraft from below
 */
export const ORBIT_PITCH_DEFAULT = 15

/**
 * Default orbit heading in degrees
 *
 * 315° = viewing from northwest (rear-left quarter)
 * Common "chase camera" angle for aircraft
 */
export const ORBIT_HEADING_DEFAULT = 315

// ============================================================================
// FOLLOW MODE
// ============================================================================

/**
 * Default follow zoom factor
 *
 * 1.0 = standard zoom
 * < 1.0 = zoomed in
 * > 1.0 = zoomed out
 */
export const FOLLOW_ZOOM_DEFAULT = 1.0

/**
 * Minimum follow zoom factor
 */
export const FOLLOW_ZOOM_MIN = 0.5

/**
 * Maximum follow zoom factor
 */
export const FOLLOW_ZOOM_MAX = 5.0

// ============================================================================
// TOP-DOWN VIEW
// ============================================================================

/**
 * Default altitude for top-down view in meters above airport
 *
 * 2000m (~6,500 ft) provides good overview of airport area
 */
export const TOPDOWN_ALTITUDE_DEFAULT = 2000

/**
 * Minimum altitude for top-down view in meters
 */
export const TOPDOWN_ALTITUDE_MIN = 500

/**
 * Maximum altitude for top-down view in meters
 */
export const TOPDOWN_ALTITUDE_MAX = 50000

// ============================================================================
// TERRAIN COLLISION
// ============================================================================

/**
 * Minimum camera height above ground level in meters
 *
 * Prevents camera from clipping through terrain.
 * Camera will be clamped to this height above terrain surface.
 */
export const CAMERA_MIN_AGL = 5
