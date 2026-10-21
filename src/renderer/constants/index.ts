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
  AIRCRAFT_POOL_SIZE,
  // Facade shader
  FACADE_BAY_WIDTH_M,
  FACADE_FADE_END,
  FACADE_FADE_START,
  FACADE_FLOOR_HEIGHT_M,
  FACADE_LIT_SHARE,
  FACADE_WINDOW_HI,
  FACADE_WINDOW_LO,
  // Colors
  FALLBACK_MODEL_COLOR,
  FSLTL_MODEL_HEIGHT_OFFSET,
  // Aircraft positioning
  GROUND_AIRCRAFT_TERRAIN_OFFSET,
  // Rendering performance
  LABEL_CENTER_SCREEN_THRESHOLD_PX,
  LABEL_PROJECTION_MIN_DISTANCE_M,
  MODEL_POOL_SIZE,
  SHADOW_COLOR,
  SHADOW_DISC_RADIUS,
  // Shadow configuration
  SHADOW_MAX_DISTANCE_KM,
} from './rendering'

// ============================================================================
// CAMERA CONSTANTS
// ============================================================================

export {
  // Airport transition
  AIRPORT_FLYTO_DURATION,
  // Camera speeds
  CAMERA_MOVE_SPEED_MULTIPLIER,
  CAMERA_ROTATION_SPEED,
  CAMERA_ZOOM_SPEED,
  // Follow mode
  FOLLOW_ZOOM_DEFAULT,
  FOLLOW_ZOOM_MAX,
  FOLLOW_ZOOM_MIN,
  FOV_DEFAULT,
  FOV_MAX,
  // FOV limits
  FOV_MIN,
  GLOBE_FLYTO_DURATION,
  // Globe view (main menu)
  GLOBE_VIEW_HEIGHT,
  // Heading
  HEADING_DEFAULT,
  ORBIT_DISTANCE_DEFAULT,
  ORBIT_DISTANCE_MAX,
  // Orbit mode
  ORBIT_DISTANCE_MIN,
  ORBIT_HEADING_DEFAULT,
  ORBIT_PITCH_DEFAULT,
  ORBIT_PITCH_MAX,
  ORBIT_PITCH_MIN,
  PITCH_DEFAULT,
  PITCH_MAX,
  // Pitch limits
  PITCH_MIN,
  // Top-down view
  TOPDOWN_ALTITUDE_DEFAULT,
  TOPDOWN_ALTITUDE_MAX,
  TOPDOWN_ALTITUDE_MIN,
} from './camera'

// ============================================================================
// API CONSTANTS
// ============================================================================

export {
  AIRPORTS_DB_URL,
  // Retry configuration
  API_MAX_RETRIES,
  API_RETRY_DELAY,
  AVIATION_WEATHER_URL,
  NEAREST_METAR_THROTTLE,
  POSITION_CHANGE_THRESHOLD,
  // Caching
  TILE_CACHE_TTL,
  VATSIM_ACTUAL_UPDATE_INTERVAL,
  // API endpoints
  VATSIM_DATA_URL,
  // VATSIM polling
  VATSIM_POLL_INTERVAL,
  // Weather refresh
  WEATHER_REFRESH_INTERVAL,
} from './api'

// ============================================================================
// BABYLON.JS CONSTANTS
// ============================================================================

export {
  CAMERA_MAX_Z,
  // Scene and camera
  CAMERA_MIN_Z,
  // Cloud ceiling visibility
  CLOUD_CEILING_COVERAGE_THRESHOLD,
  DIRECTIONAL_LIGHT_INTENSITY,
  HEMISPHERIC_LIGHT_GROUND_COLOR,
  // Lighting
  HEMISPHERIC_LIGHT_INTENSITY,
  // Unit conversions
  STATUTE_MILES_TO_METERS,
} from './babylon'

// ============================================================================
// REPLAY CONSTANTS
// ============================================================================

export {
  // Memory estimates
  BYTES_PER_AIRCRAFT_STATE,
  DEFAULT_PLAYBACK_SPEED,
  DEFAULT_REPLAY_DURATION_MINUTES,
  estimateReplayMemoryMB,
  MAX_REPLAY_DURATION_MINUTES,
  MIN_REPLAY_DURATION_MINUTES,
  // Playback configuration
  PLAYBACK_SPEEDS,
  PLAYBACK_UI_UPDATE_INTERVAL_MS,
  // Export file format
  REPLAY_EXPORT_VERSION,
  REPLAY_FILE_EXTENSION,
  REPLAY_FILE_PREFIX,
  // Snapshot configuration
  SNAPSHOT_INTERVAL_MS,
} from './replay'

// ============================================================================
// PRECIPITATION CONSTANTS
// ============================================================================

export {
  // Emitter
  EMITTER_BOX_SIZE,
  EMITTER_HEIGHT_ABOVE_CAMERA,
  EMITTER_HEIGHT_RANGE,
  GUST_DURATION_MAX,
  GUST_DURATION_MIN,
  GUST_INTERVAL_MAX,
  GUST_INTERVAL_MIN,
  GUST_RAMP_FRACTION,
  INTENSITY_HEAVY,
  // Intensity
  INTENSITY_LIGHT,
  INTENSITY_MODERATE,
  // Wind
  KNOTS_TO_MS,
  LIGHTNING_FLASH_DURATION_MS,
  LIGHTNING_FLASH_INTENSITY,
  LIGHTNING_INTERVAL_MAX,
  // Lightning
  LIGHTNING_INTERVAL_MIN,
  LIGHTNING_MULTI_FLASH_DELAY_MS,
  LIGHTNING_MULTI_FLASH_MAX,
  LIGHTNING_MULTI_FLASH_PROBABILITY,
  // METAR codes
  METAR_PRECIP_CODES,
  PRECIP_VIS_FACTOR_MAX,
  PRECIP_VIS_FACTOR_MIN,
  // Visibility scaling
  PRECIP_VIS_THRESHOLD_HIGH,
  PRECIP_VIS_THRESHOLD_LOW,
  RAIN_COLOR_1,
  RAIN_COLOR_2,
  RAIN_DRIFT_RANGE,
  RAIN_EMIT_POWER_MAX,
  RAIN_EMIT_POWER_MIN,
  // Rain particles
  RAIN_EMIT_RATE_BASE,
  RAIN_EMITTER_BOX_HALF_SIZE,
  RAIN_EMITTER_BOX_HEIGHT,
  RAIN_GRAVITY,
  RAIN_PARTICLE_CAPACITY,
  RAIN_PARTICLE_LIFETIME_MAX,
  RAIN_PARTICLE_LIFETIME_MIN,
  RAIN_PARTICLE_SIZE_MAX,
  RAIN_PARTICLE_SIZE_MIN,
  RAIN_SCALE_X_MAX,
  RAIN_SCALE_X_MIN,
  RAIN_VELOCITY,
  RAIN_VELOCITY_VARIANCE,
  RAIN_WIND_GRAVITY,
  SNOW_COLOR,
  SNOW_DRIFT_RANGE,
  // Snow particles
  SNOW_EMIT_RATE_BASE,
  SNOW_EMITTER_BOX_HEIGHT,
  SNOW_EMITTER_HEIGHT,
  SNOW_PARTICLE_CAPACITY,
  SNOW_PARTICLE_LIFETIME,
  SNOW_PARTICLE_SIZE_MAX,
  SNOW_PARTICLE_SIZE_MIN,
  SNOW_VELOCITY,
  SNOW_WIND_GRAVITY,
  VARIABLE_WIND_VARIANCE,
  WIND_EFFECT_SCALE,
} from './precipitation'

// ============================================================================
// WEATHER INTERPOLATION CONSTANTS
// ============================================================================

export {
  // Auto-airport switching
  AUTO_SWITCH_CHECK_INTERVAL_MS,
  AUTO_SWITCH_HYSTERESIS_NM,
  AUTO_SWITCH_MIN_DISTANCE_NM,
  CLOUD_ALTITUDE_BAND_FEET,
  // Cesium cloud and fog stage
  CLOUD_THICKNESS_BY_TYPE_M,
  CLOUD_THICKNESS_DEFAULT_M,
  FOG_DENSITY_TRANSITION_TIME,
  INTERPOLATION_DISTANCE_POWER,
  INTERPOLATION_MIN_WEIGHT,
  INTERPOLATION_POSITION_THRESHOLD_DEG,
  INTERPOLATION_RADIUS_NM,
  // Interpolation settings
  INTERPOLATION_STATION_COUNT,
  INTERPOLATION_UPDATE_THROTTLE_MS,
  PRECIPITATION_CESSATION_DELAY,
  PRECIPITATION_FADE_TIME,
  PRECIPITATION_ONSET_DELAY,
  THUNDERSTORM_CESSATION_DELAY,
  THUNDERSTORM_ONSET_DELAY,
  VISIBILITY_CHANGE_THRESHOLD,
  // Weather smoothing / hysteresis
  VISIBILITY_TRANSITION_TIME,
  WEATHER_STAGE_AIRPORT_REANCHOR_DISTANCE_M,
  WEATHER_STAGE_GROUND_BLEND_MS,
  WEATHER_STAGE_MAX_LAYERS,
  WEATHER_STAGE_MIN_VISIBILITY_SM,
  WEATHER_STAGE_NO_FOG_VISIBILITY_SM,
  WEATHER_STAGE_NOISE_ORIGIN_RESET_M,
  WEATHER_STAGE_QUALITY,
  WEATHER_STAGE_REANCHOR_CHECK_MS,
  WEATHER_STAGE_REANCHOR_DISTANCE_M,
  WIND_DIRECTION_CHANGE_THRESHOLD,
  WIND_DIRECTION_TRANSITION_TIME,
  WIND_SPEED_CHANGE_THRESHOLD,
  WIND_SPEED_TRANSITION_TIME,
} from './weather'

// ============================================================================
// LIGHTING / NIGHT DARKENING CONSTANTS
// ============================================================================

export {
  // Cesium environment map
  ENVIRONMENT_MAP_GROUND_COLOR,
  NIGHT_BRIGHTNESS_CIVIL,
  // Imagery brightness values
  NIGHT_BRIGHTNESS_MIN,
  NIGHT_BRIGHTNESS_TWILIGHT,
  NIGHT_GAMMA_BOOST,
  // Weather particle pre-warming
  PARTICLE_PREWARM_JUMP_THRESHOLD,
  SUN_ELEVATION_CIVIL_TWILIGHT,
  // Sun elevation thresholds
  SUN_ELEVATION_DAY,
  SUN_ELEVATION_NAUTICAL_TWILIGHT,
  SUN_ELEVATION_NIGHT,
  // Performance
  SUN_POSITION_UPDATE_INTERVAL,
} from './lighting'

// ============================================================================
// VNAS CONSTANTS
// ============================================================================

export { VNAS_ENVIRONMENT_OPTIONS, type VnasEnvironmentOption } from './vnas'
