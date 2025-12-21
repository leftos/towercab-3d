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
