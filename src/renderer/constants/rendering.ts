/**
 * Rendering configuration constants
 *
 * This file centralizes magic numbers and configuration values used for
 * 3D rendering, aircraft models, shadows, and visual effects.
 *
 * Used by: CesiumViewer, useBabylonOverlay
 */

// ============================================================================
// AIRCRAFT MODEL POOL
// ============================================================================

/**
 * Maximum number of aircraft cone fallback meshes to pool
 *
 * Cones are used when:
 * - No 3D model is available for the aircraft type
 * - Model loading fails
 * - Fallback display mode is enabled
 */
export const CONE_POOL_SIZE = 100

/**
 * Maximum number of full 3D aircraft models to pool
 *
 * Models are loaded from:
 * - mods/aircraft/{TYPE}/model.glb (user mods)
 * - Built-in aircraft models (future feature)
 */
export const MODEL_POOL_SIZE = 50

// ============================================================================
// SHADOW CONFIGURATION
// ============================================================================

/**
 * Maximum distance for shadow rendering in kilometers
 *
 * Shadows beyond this distance are not rendered to improve performance.
 * Matches Cesium Sandcastle examples to reduce banding artifacts.
 *
 * Default: 10km (10,000 meters)
 */
export const SHADOW_MAX_DISTANCE_KM = 10

/**
 * Shadow disc radius in meters
 *
 * Circular shadow mesh rendered beneath each aircraft at ground level.
 * Radius controls the size of the shadow projection.
 */
export const SHADOW_DISC_RADIUS = 3.5

// ============================================================================
// AIRCRAFT POSITIONING
// ============================================================================

/**
 * Terrain offset for ground aircraft in meters
 *
 * Vertical offset above sampled terrain elevation for aircraft on the ground.
 * Prevents z-fighting and ensures aircraft appear resting on the surface.
 *
 * Reduced from 5m to 0.5m for more realistic ground positioning.
 */
export const GROUND_AIRCRAFT_TERRAIN_OFFSET = 0.5

/**
 * Terrain offset for flying aircraft in meters
 *
 * Base offset added to altitude for aircraft in flight.
 * Accounts for geoid offset (ellipsoid vs MSL difference).
 */
export const FLYING_AIRCRAFT_TERRAIN_OFFSET = 5

// ============================================================================
// COLORS (RGBA)
// ============================================================================

/**
 * Default cone color for aircraft without 3D models (blue)
 *
 * RGBA format: [Red, Green, Blue, Alpha]
 * Values: 0.0 to 1.0
 */
export const CONE_BLUE_COLOR = [0.2, 0.4, 1.0, 1.0] as const

/**
 * Shadow color (semi-transparent black)
 *
 * RGBA format: [Red, Green, Blue, Alpha]
 * Alpha = 0.3 for subtle shadow effect
 */
export const SHADOW_COLOR = [0, 0, 0, 0.3] as const

// ============================================================================
// RENDERING PERFORMANCE
// ============================================================================

/**
 * Label projection check threshold in pixels
 *
 * Labels within this distance from screen center when aircraft is far away
 * are considered suspicious and may indicate invalid transform matrices.
 *
 * Used to detect and prevent labels from appearing at screen center incorrectly.
 */
export const LABEL_CENTER_SCREEN_THRESHOLD_PX = 5

/**
 * Minimum distance for label projection check in meters
 *
 * Only check for suspicious center-screen projections if aircraft is
 * further than this distance from the camera.
 */
export const LABEL_PROJECTION_MIN_DISTANCE_M = 100
