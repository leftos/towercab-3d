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
// Babylon.js Night Lighting Multipliers
// =============================================================================

/**
 * Hemispheric light intensity multiplier at night (0.0-1.0)
 * Applied to ambient lighting for weather effects and 3D models
 */
export const BABYLON_NIGHT_HEMISPHERIC_MULT = 0.3

/**
 * Directional light intensity multiplier at night (0.0-1.0)
 * Applied to sun-like directional lighting
 */
export const BABYLON_NIGHT_DIRECTIONAL_MULT = 0.15

/**
 * Fog emissive color multiplier at night (0.0-1.0)
 * Reduces fog glow for darker nighttime appearance
 */
export const BABYLON_NIGHT_FOG_EMISSIVE_MULT = 0.3

/**
 * Cloud emissive color multiplier at night (0.0-1.0)
 * Slightly brighter than fog to simulate moonlight reflection
 */
export const BABYLON_NIGHT_CLOUD_EMISSIVE_MULT = 0.4

// =============================================================================
// Performance Constants
// =============================================================================

/**
 * Interval in milliseconds between sun position recalculations
 * Sun moves slowly, so we don't need to recalculate every frame
 * Immediate recalculation is triggered when time settings change
 */
export const SUN_POSITION_UPDATE_INTERVAL = 30000 // 30 seconds
