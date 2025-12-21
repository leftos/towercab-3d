/**
 * Babylon.js rendering configuration constants
 * Used by: useBabylonOverlay, useBabylonScene, useBabylonWeather, useBabylonLabels
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
// Cloud Layer Configuration
// ============================================================================

/**
 * Maximum number of cloud layers that can be rendered simultaneously.
 * Matches max METAR cloud layers (typically 3-4).
 */
export const CLOUD_POOL_SIZE = 4

/**
 * Diameter of cloud plane meshes in meters (50km).
 * Large enough to cover horizon from typical ATC tower heights.
 */
export const CLOUD_PLANE_DIAMETER = 50000

/**
 * Cloud plane mesh rotation to horizontal (radians).
 * Planes are created in XY, rotated to XZ for horizontal clouds.
 */
export const CLOUD_PLANE_ROTATION_X = Math.PI / 2

/**
 * Cloud material diffuse color (RGB).
 * Slightly blue-tinted white for realistic cloud appearance.
 */
export const CLOUD_DIFFUSE_COLOR = [0.95, 0.95, 0.98] as const

/**
 * Cloud material emissive color (RGB).
 * Subtle self-illumination for visibility.
 */
export const CLOUD_EMISSIVE_COLOR = [0.4, 0.4, 0.45] as const

/**
 * Base alpha transparency for cloud materials (0-1).
 * Multiplied by cloud coverage (0.125-1.0) and user opacity setting.
 */
export const CLOUD_BASE_ALPHA = 0.5

// ============================================================================
// Fog Dome Configuration
// ============================================================================

/**
 * Base diameter of fog dome mesh before scaling.
 * Actual size is determined by METAR visibility distance.
 */
export const FOG_DOME_BASE_DIAMETER = 2

/**
 * Number of segments for fog dome sphere mesh.
 * Higher values = smoother sphere, but more polygons.
 */
export const FOG_DOME_SEGMENTS = 32

/**
 * Fog dome material diffuse color (RGB).
 * Light gray-blue for realistic fog appearance.
 */
export const FOG_DIFFUSE_COLOR = [0.8, 0.8, 0.82] as const

/**
 * Fog dome material emissive color (RGB).
 * Subtle self-illumination for visibility in low light.
 */
export const FOG_EMISSIVE_COLOR = [0.6, 0.6, 0.65] as const

/**
 * Fog dome material specular color (RGB).
 * Set to black (no specular highlights).
 */
export const FOG_SPECULAR_COLOR = [0, 0, 0] as const

/**
 * Base alpha transparency for fog dome material (0-1).
 * Adjusted dynamically based on visibility conditions.
 */
export const FOG_BASE_ALPHA = 0.3

/**
 * Fresnel effect bias for fog dome opacity (0-1).
 * Controls transparency at center vs edges.
 * Lower = more transparent center.
 */
export const FOG_FRESNEL_BIAS = 0.1

/**
 * Fresnel effect power for fog dome opacity.
 * Controls sharpness of edge falloff.
 * Higher = sharper transition.
 */
export const FOG_FRESNEL_POWER = 3

// ============================================================================
// Visibility-Based Fog Adjustment
// ============================================================================

/**
 * Visibility threshold for extremely low visibility conditions (statute miles).
 * Visibility <= 1/4 SM triggers heavy fog rendering.
 */
export const VISIBILITY_THRESHOLD_EXTREMELY_LOW = 0.25

/**
 * Visibility threshold for low visibility conditions (statute miles).
 * Visibility <= 1 SM triggers moderate to heavy fog.
 */
export const VISIBILITY_THRESHOLD_LOW = 1.0

/**
 * Visibility threshold for moderate visibility conditions (statute miles).
 * Visibility <= 3 SM triggers light fog.
 */
export const VISIBILITY_THRESHOLD_MODERATE = 3.0

/**
 * Visibility threshold for decent visibility conditions (statute miles).
 * Visibility <= 6 SM triggers very light haze.
 */
export const VISIBILITY_THRESHOLD_DECENT = 6.0

/**
 * Fog alpha at extremely low visibility (<= 1/4 SM).
 */
export const FOG_ALPHA_EXTREMELY_LOW = 0.5

/**
 * Fog alpha at low visibility (1/4 to 1 SM) - minimum value at 1 SM.
 */
export const FOG_ALPHA_LOW_MIN = 0.25

/**
 * Fog alpha at moderate visibility (1 to 3 SM) - minimum value at 3 SM.
 */
export const FOG_ALPHA_MODERATE_MIN = 0.1

/**
 * Fog alpha at decent visibility (3 to 6 SM) - minimum value at 6 SM.
 */
export const FOG_ALPHA_DECENT_MIN = 0.03

/**
 * Fog alpha at good visibility (> 6 SM) - barely visible hint.
 */
export const FOG_ALPHA_GOOD = 0.03

/**
 * Fresnel bias at extremely low visibility (<= 1/4 SM).
 * Higher bias = fog visible even at center of view.
 */
export const FOG_FRESNEL_BIAS_EXTREMELY_LOW = 0.3

/**
 * Fresnel bias at low visibility (1/4 to 1 SM) - minimum value at 1 SM.
 */
export const FOG_FRESNEL_BIAS_LOW_MIN = 0.15

/**
 * Fresnel bias at moderate/decent/good visibility (>= 1 SM).
 */
export const FOG_FRESNEL_BIAS_MODERATE = 0.1

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
