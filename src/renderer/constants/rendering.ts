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
 * Ground speed threshold in knots for determining if aircraft is on ground
 *
 * Aircraft with groundspeed below this threshold are considered on the ground:
 * - Display orange datablocks (ground traffic)
 * - Position at ground elevation + small offset
 * - Show groundspeed only (no altitude) in datablock
 *
 * Aircraft with groundspeed >= this threshold are considered airborne:
 * - Display green datablocks (airborne traffic)
 * - Position at reported altitude
 * - Show altitude and groundspeed in datablock
 *
 * Standard ATC threshold: 40 knots
 */
export const GROUNDSPEED_THRESHOLD_KNOTS = 40

/**
 * Low altitude threshold for terrain sampling in meters AGL
 *
 * Aircraft below this altitude (above ground level) will have terrain
 * sampled even if their groundspeed exceeds GROUNDSPEED_THRESHOLD_KNOTS.
 * This ensures landing aircraft get terrain samples before they slow down,
 * preventing clipping through runways during landing roll.
 *
 * 300 meters ≈ 1000 feet AGL - covers final approach and landing roll
 */
export const LOW_ALTITUDE_AGL_THRESHOLD_M = 300

/**
 * Terrain offset for ground aircraft in meters
 *
 * Vertical offset above sampled terrain elevation for aircraft on the ground.
 * Prevents z-fighting and ensures aircraft appear resting on the surface.
 *
 * Minimal offset (0.1m) to prevent z-fighting while keeping aircraft on ground.
 */
export const GROUND_AIRCRAFT_TERRAIN_OFFSET = 0.1

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

/**
 * Default model color RGB values (light gray)
 *
 * Used for MIX color blend mode to apply subtle tinting to aircraft models.
 * Values: 0.0 to 1.0
 */
export const MODEL_DEFAULT_COLOR_RGB = [0.9, 0.9, 0.9] as const

/**
 * Model color blend amount (0-1)
 *
 * Controls how much of the default color is mixed with original textures:
 * - 0.0 = Original textures (no tint)
 * - 1.0 = Full replacement with default color
 * - 0.15 = Subtle blend that preserves textures while adding consistent tint
 */
export const MODEL_COLOR_BLEND_AMOUNT = 0.15

/**
 * Model brightness range (multiplier)
 * - Minimum: 0.5x (darker models)
 * - Default: 1.0x (original light gray tint)
 * - Maximum: 3.0x (brightest with emissive glow)
 */
export const MODEL_BRIGHTNESS_MIN = 0.5
export const MODEL_BRIGHTNESS_MAX = 3.0

/**
 * Calculate model tint color based on brightness multiplier
 *
 * Brightness multiplier adjusts the tint color RGB values:
 * - 0.5 = [0.45, 0.45, 0.45] (darker gray)
 * - 1.0 = [0.9, 0.9, 0.9] (default light gray)
 * - 1.1+ = [1.0, 1.0, 1.0] (white, clamped at 1.0 per channel)
 * - 3.0 = [1.0, 1.0, 1.0] (white, maximum brightness)
 *
 * @param brightness - Brightness multiplier (0.5-3.0)
 * @returns RGB array suitable for Cesium.Color constructor
 */
export function getModelColorRgb(brightness: number): readonly [number, number, number] {
  const baseColor = 0.9
  const adjustedValue = Math.min(baseColor * brightness, 1.0) // Clamp at 1.0
  return [adjustedValue, adjustedValue, adjustedValue] as const
}

/**
 * Calculate color blend amount for emissive effect at high brightness
 *
 * Creates a glow/emissive effect when brightness exceeds 1.1:
 * - 0.5-1.1 brightness: blend amount = 0.15 (subtle texture blending)
 * - 1.1-3.0 brightness: blend amount increases to 1.0 (brightening/glow effect)
 *
 * Higher blend amounts make the white tint more opaque, creating a brighter/glowing appearance.
 *
 * @param brightness - Brightness multiplier (0.5-3.0)
 * @returns Color blend amount (0.15-1.0)
 */
export function getModelColorBlendAmount(brightness: number): number {
  const BASE_BLEND_AMOUNT = 0.15
  const BRIGHTNESS_THRESHOLD = 1.1
  const MAX_BLEND_AMOUNT = 1.0

  if (brightness <= BRIGHTNESS_THRESHOLD) {
    return BASE_BLEND_AMOUNT
  }

  // Map brightness 1.1 -> 0.15, MODEL_BRIGHTNESS_MAX -> 1.0 (full emissive glow)
  const excessBrightness = brightness - BRIGHTNESS_THRESHOLD
  const maxExcess = MODEL_BRIGHTNESS_MAX - BRIGHTNESS_THRESHOLD
  const blendIncrease = (excessBrightness / maxExcess) * (MAX_BLEND_AMOUNT - BASE_BLEND_AMOUNT)

  return Math.min(BASE_BLEND_AMOUNT + blendIncrease, MAX_BLEND_AMOUNT)
}

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

// ============================================================================
// DATABLOCK POSITIONING
// ============================================================================

/**
 * Vertical height multiplier for datablock attachment point
 *
 * Multiplied by aircraft wingspan to determine how far above the aircraft
 * the datablock label is positioned. Higher values raise the label further.
 *
 * Default: ~0.4 of wingspan (closer to aircraft)
 * Example: For B738 with 35m wingspan, label attaches ~14m above aircraft
 */
export const DATABLOCK_HEIGHT_MULTIPLIER = 0.4

/**
 * Vertical height multiplier for leader line endpoint
 *
 * Multiplied by aircraft wingspan to determine how far above the aircraft
 * the leader line connects (where the line ends at the aircraft).
 * Smaller than DATABLOCK_HEIGHT_MULTIPLIER to position endpoint above fuselage
 * but below the label itself.
 *
 * Default: ~0.25 of wingspan (positioned above fuselage)
 * Example: For B738 with 35m wingspan, leader line connects ~8.75m above center
 */
export const DATABLOCK_LEADER_LINE_HEIGHT_MULTIPLIER = 0.25

/**
 * Horizontal offset for datablock attachment point in meters
 *
 * Shifts the leader line connection point to the left (negative) or right (positive)
 * of the aircraft center. Useful for avoiding overlap with aircraft models.
 *
 * Default: -2 meters (slightly to the left of aircraft center)
 */
export const DATABLOCK_HORIZONTAL_OFFSET_M = -10

// ============================================================================
// LANDING FLARE EMULATION
// ============================================================================

/**
 * Altitude AGL (meters) where flare pitch-up begins
 *
 * Aircraft below this altitude while descending will begin to pitch up
 * to simulate the landing flare maneuver. Typical values:
 * - Small aircraft: 10-20 feet (3-6m)
 * - Regional jets: 20-30 feet (6-9m)
 * - Airliners: 30-50 feet (9-15m)
 *
 * Default: 15 meters (~50 feet) - suitable for all aircraft types
 */
export const FLARE_START_ALTITUDE_METERS = 15

/**
 * Altitude AGL (meters) where full flare pitch is achieved
 *
 * At this altitude, the aircraft will have reached its maximum flare pitch.
 * Just before touchdown.
 *
 * Default: 2 meters (~6 feet)
 */
export const FLARE_END_ALTITUDE_METERS = 2

/**
 * Target nose-up pitch angle during flare (degrees)
 *
 * The pitch the aircraft will transition toward during the flare.
 * Typical landing attitudes are 3-8 degrees nose up.
 *
 * Default: 6 degrees
 */
export const FLARE_TARGET_PITCH_DEGREES = 6

/**
 * Minimum descent rate (m/min) to trigger flare
 *
 * Prevents flare during level flight at low altitude.
 * Must be negative (descending). Aircraft must be descending faster
 * than this rate to trigger the flare.
 *
 * Default: -50 m/min (~165 fpm descent)
 */
export const FLARE_MIN_DESCENT_RATE = -50
