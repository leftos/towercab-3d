/**
 * Night-time darkening constants
 *
 * These constants define the sun elevation thresholds for twilight phases
 * and brightness values used to darken satellite imagery at night.
 */

// =============================================================================
// Sun Elevation Thresholds (degrees)
// =============================================================================

/**
 * Sun elevation at horizon (sunrise/sunset)
 * Above this = full daylight
 */
export const SUN_ELEVATION_DAY = 0

/**
 * Civil twilight threshold (-6 degrees)
 * Enough light for outdoor activities without artificial lighting
 */
export const SUN_ELEVATION_CIVIL_TWILIGHT = -6

/**
 * Nautical twilight threshold (-12 degrees)
 * Horizon still visible at sea, stars becoming visible
 */
export const SUN_ELEVATION_NAUTICAL_TWILIGHT = -12

/**
 * Astronomical twilight threshold (-18 degrees)
 * Full darkness for astronomical observations
 */
export const SUN_ELEVATION_NIGHT = -18

// =============================================================================
// Imagery Brightness Values
// =============================================================================

/**
 * Minimum imagery brightness at full night (0.0-1.0)
 * This is the darkest the imagery will get at maximum intensity setting
 */
export const NIGHT_BRIGHTNESS_MIN = 0.15

/**
 * Brightness during nautical twilight transition point
 */
export const NIGHT_BRIGHTNESS_TWILIGHT = 0.3

/**
 * Brightness during civil twilight transition point
 */
export const NIGHT_BRIGHTNESS_CIVIL = 0.6

/**
 * Gamma boost for twilight (warmer tones near sunrise/sunset)
 */
export const NIGHT_GAMMA_BOOST = 1.15

// =============================================================================
// Performance Constants
// =============================================================================

/**
 * Interval in milliseconds between sun position recalculations
 * Sun moves slowly, so we don't need to recalculate every frame
 * Immediate recalculation is triggered when time settings change
 */
export const SUN_POSITION_UPDATE_INTERVAL = 30000 // 30 seconds

// =============================================================================
// Weather Particle Pre-warming Constants
// =============================================================================

/**
 * Camera position jump threshold (meters)
 * When camera moves more than this distance in a single update,
 * particle systems are recreated with pre-warming
 */
export const PARTICLE_PREWARM_JUMP_THRESHOLD = 500

// =============================================================================
// Cesium Environment Map
// =============================================================================

/**
 * CSS colour used as the ground colour of Cesium's dynamic environment map
 * A neutral grey with the same luminance as Cesium's olive default (#717145),
 * so image-based lighting keeps its brightness without tinting buildings or models
 */
export const ENVIRONMENT_MAP_GROUND_COLOR = '#6E6E6E'
