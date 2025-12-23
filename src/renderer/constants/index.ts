/**
 * Central constants barrel export
 *
 * This file provides a single entry point for importing constants from across
 * the application. All constants are organized into domain-specific files.
 *
 * @example
 * // Import specific constants
 * import { FOV_DEFAULT, VATSIM_POLL_INTERVAL } from '@/constants'
 *
 * // Or import everything from a domain
 * import * as CameraConstants from '@/constants/camera'
 */

// ============================================================================
// RENDERING CONSTANTS
// ============================================================================

export {
  // Aircraft model pool
  CONE_POOL_SIZE,
  MODEL_POOL_SIZE,

  // Shadow configuration
  SHADOW_MAX_DISTANCE_KM,
  SHADOW_DISC_RADIUS,

  // Aircraft positioning
  GROUND_AIRCRAFT_TERRAIN_OFFSET,
  FLYING_AIRCRAFT_TERRAIN_OFFSET,

  // Colors
  CONE_BLUE_COLOR,
  SHADOW_COLOR,

  // Rendering performance
  LABEL_CENTER_SCREEN_THRESHOLD_PX,
  LABEL_PROJECTION_MIN_DISTANCE_M
} from './rendering'

// ============================================================================
// CAMERA CONSTANTS
// ============================================================================

export {
  // FOV limits
  FOV_MIN,
  FOV_MAX,
  FOV_DEFAULT,

  // Camera speeds
  CAMERA_MOVE_SPEED_MULTIPLIER,
  CAMERA_ROTATION_SPEED,
  CAMERA_ZOOM_SPEED,

  // Pitch limits
  PITCH_MIN,
  PITCH_MAX,
  PITCH_DEFAULT,

  // Heading
  HEADING_DEFAULT,

  // Orbit mode
  ORBIT_DISTANCE_MIN,
  ORBIT_DISTANCE_MAX,
  ORBIT_DISTANCE_DEFAULT,
  ORBIT_PITCH_MIN,
  ORBIT_PITCH_MAX,
  ORBIT_PITCH_DEFAULT,
  ORBIT_HEADING_DEFAULT,

  // Follow mode
  FOLLOW_ZOOM_DEFAULT,
  FOLLOW_ZOOM_MIN,
  FOLLOW_ZOOM_MAX,

  // Top-down view
  TOPDOWN_ALTITUDE_DEFAULT,
  TOPDOWN_ALTITUDE_MIN,
  TOPDOWN_ALTITUDE_MAX
} from './camera'

// ============================================================================
// API CONSTANTS
// ============================================================================

export {
  // API endpoints
  VATSIM_DATA_URL,
  AVIATION_WEATHER_URL,
  AIRPORTS_DB_URL,

  // VATSIM polling
  VATSIM_POLL_INTERVAL,
  VATSIM_ACTUAL_UPDATE_INTERVAL,

  // Weather refresh
  WEATHER_REFRESH_INTERVAL,
  NEAREST_METAR_THROTTLE,
  POSITION_CHANGE_THRESHOLD,

  // Caching
  TILE_CACHE_TTL,

  // Retry configuration
  API_MAX_RETRIES,
  API_RETRY_DELAY
} from './api'

// ============================================================================
// BABYLON.JS CONSTANTS
// ============================================================================

export {
  // Scene and camera
  CAMERA_MIN_Z,
  CAMERA_MAX_Z,

  // Cloud layers
  CLOUD_POOL_SIZE,
  CLOUD_PLANE_DIAMETER,
  CLOUD_PLANE_ROTATION_X,
  CLOUD_DIFFUSE_COLOR,
  CLOUD_EMISSIVE_COLOR,
  CLOUD_BASE_ALPHA,

  // Fog dome
  FOG_DOME_BASE_DIAMETER,
  FOG_DOME_SEGMENTS,
  FOG_DIFFUSE_COLOR,
  FOG_EMISSIVE_COLOR,
  FOG_SPECULAR_COLOR,
  FOG_BASE_ALPHA,
  FOG_FRESNEL_BIAS,
  FOG_FRESNEL_POWER,

  // Visibility-based fog adjustment
  VISIBILITY_THRESHOLD_EXTREMELY_LOW,
  VISIBILITY_THRESHOLD_LOW,
  VISIBILITY_THRESHOLD_MODERATE,
  VISIBILITY_THRESHOLD_DECENT,
  FOG_ALPHA_EXTREMELY_LOW,
  FOG_ALPHA_LOW_MIN,
  FOG_ALPHA_MODERATE_MIN,
  FOG_ALPHA_DECENT_MIN,
  FOG_ALPHA_GOOD,
  FOG_FRESNEL_BIAS_EXTREMELY_LOW,
  FOG_FRESNEL_BIAS_LOW_MIN,
  FOG_FRESNEL_BIAS_MODERATE,

  // Cloud ceiling visibility
  CLOUD_CEILING_COVERAGE_THRESHOLD,

  // Cloud patchiness (noise-based)
  CLOUD_NOISE_TEXTURE_SIZE,
  CLOUD_NOISE_OCTAVES,
  CLOUD_NOISE_SCALE,
  CLOUD_NOISE_PERSISTENCE,
  CLOUD_COVERAGE_THRESHOLD_OFFSET,
  CLOUD_EDGE_SOFTNESS,
  CLOUD_RADIAL_FADE_START,
  CLOUD_RADIAL_FADE_END,
  CLOUD_ROTATION_SPEED,
  CLOUD_ROTATION_SPEED_VARIANCE,
  CLOUD_ROTATION_CHANGE_INTERVAL,
  CLOUD_ROTATION_TRANSITION_TIME,
  CLOUD_LAYER_MATCH_ALTITUDE_THRESHOLD,
  CLOUD_LAYER_MATCH_COVERAGE_THRESHOLD,
  CLOUD_LAYER_ALTITUDE_TRANSITION_SPEED,
  CLOUD_LAYER_COVERAGE_TRANSITION_SPEED,
  CLOUD_LAYER_FADE_SPEED,
  CLOUD_LAYER_COVERAGE_REGEN_THRESHOLD,

  // Lighting
  HEMISPHERIC_LIGHT_INTENSITY,
  HEMISPHERIC_LIGHT_GROUND_COLOR,
  DIRECTIONAL_LIGHT_INTENSITY,

  // Unit conversions
  STATUTE_MILES_TO_METERS
} from './babylon'

// ============================================================================
// REPLAY CONSTANTS
// ============================================================================

export {
  // Snapshot configuration
  SNAPSHOT_INTERVAL_MS,
  DEFAULT_REPLAY_DURATION_MINUTES,
  MIN_REPLAY_DURATION_MINUTES,
  MAX_REPLAY_DURATION_MINUTES,

  // Playback configuration
  PLAYBACK_SPEEDS,
  DEFAULT_PLAYBACK_SPEED,
  PLAYBACK_UI_UPDATE_INTERVAL_MS,

  // Memory estimates
  BYTES_PER_AIRCRAFT_STATE,
  estimateReplayMemoryMB,

  // Export file format
  REPLAY_EXPORT_VERSION,
  REPLAY_FILE_EXTENSION,
  REPLAY_FILE_PREFIX
} from './replay'

// ============================================================================
// PRECIPITATION CONSTANTS
// ============================================================================

export {
  // Rain particles
  RAIN_EMIT_RATE_BASE,
  RAIN_PARTICLE_LIFETIME_MIN,
  RAIN_PARTICLE_LIFETIME_MAX,
  RAIN_PARTICLE_SIZE_MIN,
  RAIN_PARTICLE_SIZE_MAX,
  RAIN_SCALE_X_MIN,
  RAIN_SCALE_X_MAX,
  RAIN_VELOCITY,
  RAIN_VELOCITY_VARIANCE,
  RAIN_GRAVITY,
  RAIN_EMIT_POWER_MIN,
  RAIN_EMIT_POWER_MAX,
  RAIN_COLOR_1,
  RAIN_COLOR_2,
  RAIN_PARTICLE_CAPACITY,
  RAIN_EMITTER_BOX_HALF_SIZE,
  RAIN_EMITTER_BOX_HEIGHT,
  RAIN_DRIFT_RANGE,
  RAIN_WIND_GRAVITY,

  // Snow particles
  SNOW_EMIT_RATE_BASE,
  SNOW_PARTICLE_LIFETIME,
  SNOW_PARTICLE_SIZE_MIN,
  SNOW_PARTICLE_SIZE_MAX,
  SNOW_VELOCITY,
  SNOW_DRIFT_RANGE,
  SNOW_COLOR,
  SNOW_PARTICLE_CAPACITY,
  SNOW_WIND_GRAVITY,
  SNOW_EMITTER_HEIGHT,
  SNOW_EMITTER_BOX_HEIGHT,

  // Emitter
  EMITTER_BOX_SIZE,
  EMITTER_HEIGHT_ABOVE_CAMERA,
  EMITTER_HEIGHT_RANGE,

  // Intensity
  INTENSITY_LIGHT,
  INTENSITY_MODERATE,
  INTENSITY_HEAVY,

  // Visibility scaling
  PRECIP_VIS_THRESHOLD_HIGH,
  PRECIP_VIS_THRESHOLD_LOW,
  PRECIP_VIS_FACTOR_MIN,
  PRECIP_VIS_FACTOR_MAX,

  // Lightning
  LIGHTNING_INTERVAL_MIN,
  LIGHTNING_INTERVAL_MAX,
  LIGHTNING_FLASH_DURATION_MS,
  LIGHTNING_FLASH_INTENSITY,
  LIGHTNING_MULTI_FLASH_PROBABILITY,
  LIGHTNING_MULTI_FLASH_DELAY_MS,
  LIGHTNING_MULTI_FLASH_MAX,

  // Wind
  KNOTS_TO_MS,
  WIND_EFFECT_SCALE,
  GUST_INTERVAL_MIN,
  GUST_INTERVAL_MAX,
  GUST_DURATION_MIN,
  GUST_DURATION_MAX,
  GUST_RAMP_FRACTION,
  VARIABLE_WIND_VARIANCE,

  // METAR codes
  METAR_PRECIP_CODES
} from './precipitation'
