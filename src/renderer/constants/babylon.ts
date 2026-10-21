/**
 * Babylon.js rendering configuration constants
 * Used by: useBabylonScene, utils/weatherVisibility, utils/weatherStage
 */

// ============================================================================
// Scene and Camera Configuration
// ============================================================================

/**
 * Camera near clipping plane distance in meters.
 * Increased from default to avoid z-fighting at globe scale.
 */
export const CAMERA_MIN_Z = 1

/**
 * Camera far clipping plane distance in meters.
 * Set very far to handle globe-scale rendering.
 */
export const CAMERA_MAX_Z = 1e10

// ============================================================================
// Cloud Ceiling Visibility Culling
// ============================================================================

/**
 * Cloud coverage threshold for visibility culling (0-1).
 * Coverage >= 0.75 indicates BKN (broken) or OVC (overcast) layers
 * that block line-of-sight to aircraft.
 */
export const CLOUD_CEILING_COVERAGE_THRESHOLD = 0.75

// ============================================================================
// Lighting Configuration
// ============================================================================

/**
 * Hemispheric ambient light intensity (0-2).
 * Provides overall scene illumination.
 */
export const HEMISPHERIC_LIGHT_INTENSITY = 1.0

/**
 * Hemispheric light ground color (RGB).
 * Simulates light reflected from ground.
 */
export const HEMISPHERIC_LIGHT_GROUND_COLOR = [0.5, 0.5, 0.5] as const

/**
 * Directional light intensity (0-2).
 * Simulates sunlight for shadows and highlights.
 */
export const DIRECTIONAL_LIGHT_INTENSITY = 0.6

// ============================================================================
// Unit Conversions
// ============================================================================

/**
 * Conversion factor from statute miles to meters.
 * Used for METAR visibility conversions.
 */
export const STATUTE_MILES_TO_METERS = 1609.34
