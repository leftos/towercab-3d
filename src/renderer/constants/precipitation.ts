/**
 * Precipitation and weather effects constants
 *
 * Configuration for rain, snow, and lightning particle effects
 * based on METAR weather data.
 *
 * @see useBabylonPrecipitation - Hook that uses these constants
 * @see weatherStore - Store that provides precipitation/wind data
 */

// ============================================================================
// RAIN PARTICLE CONFIGURATION
// ============================================================================

/** Base emit rate for rain particles (particles/second) */
export const RAIN_EMIT_RATE_BASE = 100000

/** Rain particle minimum lifetime (seconds) */
export const RAIN_PARTICLE_LIFETIME_MIN = 0.15

/** Rain particle maximum lifetime (seconds) */
export const RAIN_PARTICLE_LIFETIME_MAX = 0.25

/** Rain particle minimum size - height of streak (meters) */
export const RAIN_PARTICLE_SIZE_MIN = 0.3

/** Rain particle maximum size - height of streak (meters) */
export const RAIN_PARTICLE_SIZE_MAX = 0.6

/** Rain particle minimum X scale - makes streaks thin */
export const RAIN_SCALE_X_MIN = 0.05

/** Rain particle maximum X scale - makes streaks thin */
export const RAIN_SCALE_X_MAX = 0.1

/** Rain fall velocity (meters/second, negative = down) - visual speed, not realistic */
export const RAIN_VELOCITY = -450

/** Rain velocity variance (absolute value subtracted/added to base) */
export const RAIN_VELOCITY_VARIANCE = 20

/** Rain particle gravity (meters/second²) */
export const RAIN_GRAVITY = -5

/** Rain particle minimum emit power */
export const RAIN_EMIT_POWER_MIN = 1.0

/** Rain particle maximum emit power */
export const RAIN_EMIT_POWER_MAX = 1.2

/** Rain particle color 1 (RGBA) - white/blue, mostly opaque */
export const RAIN_COLOR_1: readonly [number, number, number, number] = [0.8, 0.85, 1.0, 0.7]

/** Rain particle color 2 (RGBA) - slightly darker */
export const RAIN_COLOR_2: readonly [number, number, number, number] = [0.7, 0.75, 0.9, 0.5]

/** Maximum number of rain particles */
export const RAIN_PARTICLE_CAPACITY = 50000

/** Rain emitter box half-size (meters) - horizontal extent around camera */
export const RAIN_EMITTER_BOX_HALF_SIZE = 100

/** Rain emitter box height range (meters) - vertical spawn range */
export const RAIN_EMITTER_BOX_HEIGHT = 20

/** Rain horizontal drift range (meters/second) - base drift without wind */
export const RAIN_DRIFT_RANGE = 1

/** Rain wind gravity strength (meters/second²) - how much wind curves rain trajectory */
export const RAIN_WIND_GRAVITY = -20

// ============================================================================
// SNOW PARTICLE CONFIGURATION
// ============================================================================

/** Base emit rate for snow particles (particles/second) */
export const SNOW_EMIT_RATE_BASE = 2000

/** Snow particle lifetime in seconds */
export const SNOW_PARTICLE_LIFETIME = 4.0

/** Snow particle minimum size (meters) */
export const SNOW_PARTICLE_SIZE_MIN = 0.1

/** Snow particle maximum size (meters) */
export const SNOW_PARTICLE_SIZE_MAX = 0.3

/** Snow fall velocity (meters/second, negative = down) */
export const SNOW_VELOCITY = -3

/** Snow horizontal drift velocity range (meters/second) - base drift without wind */
export const SNOW_DRIFT_RANGE = 1

/** Snow particle color (RGBA) - white */
export const SNOW_COLOR: readonly [number, number, number, number] = [1.0, 1.0, 1.0, 0.8]

/** Maximum number of snow particles */
export const SNOW_PARTICLE_CAPACITY = 5000

/** Snow wind gravity strength (meters/second²) - how much wind curves snow trajectory */
export const SNOW_WIND_GRAVITY = -5

// ============================================================================
// EMITTER CONFIGURATION
// ============================================================================

/** Emitter box width/depth around camera (meters) */
export const EMITTER_BOX_SIZE = 200

/** Emitter height above camera (meters) */
export const EMITTER_HEIGHT_ABOVE_CAMERA = 100

/** Emitter height range - particles spawn within this range (meters) */
export const EMITTER_HEIGHT_RANGE = 50

// ============================================================================
// INTENSITY MULTIPLIERS
// ============================================================================

/** Multiplier for light precipitation (-) */
export const INTENSITY_LIGHT = 0.5

/** Multiplier for moderate precipitation (no modifier) */
export const INTENSITY_MODERATE = 1.0

/** Multiplier for heavy precipitation (+) */
export const INTENSITY_HEAVY = 2.0

// ============================================================================
// VISIBILITY-BASED SCALING
// ============================================================================

/** Visibility threshold (SM) above which precipitation particles are minimal */
export const PRECIP_VIS_THRESHOLD_HIGH = 6.0

/** Visibility threshold (SM) below which precipitation particles are maximum */
export const PRECIP_VIS_THRESHOLD_LOW = 1.0

/** Minimum visibility factor (applied at high visibility) */
export const PRECIP_VIS_FACTOR_MIN = 0.5

/** Maximum visibility factor (applied at low visibility) */
export const PRECIP_VIS_FACTOR_MAX = 2.0

// ============================================================================
// LIGHTNING CONFIGURATION
// ============================================================================

/** Minimum interval between lightning flashes (seconds) */
export const LIGHTNING_INTERVAL_MIN = 5

/** Maximum interval between lightning flashes (seconds) */
export const LIGHTNING_INTERVAL_MAX = 15

/** Duration of a single lightning flash (milliseconds) */
export const LIGHTNING_FLASH_DURATION_MS = 100

/** Light intensity multiplier during flash (base is 1.0) */
export const LIGHTNING_FLASH_INTENSITY = 3.0

/** Probability of multi-flash (0-1) - simulates multiple strokes */
export const LIGHTNING_MULTI_FLASH_PROBABILITY = 0.3

/** Delay between flashes in a multi-flash sequence (milliseconds) */
export const LIGHTNING_MULTI_FLASH_DELAY_MS = 80

/** Maximum number of flashes in a multi-flash sequence */
export const LIGHTNING_MULTI_FLASH_MAX = 3

// ============================================================================
// WIND CONFIGURATION
// ============================================================================

/** Conversion factor: knots to meters per second */
export const KNOTS_TO_MS = 0.514444

/** Wind effect scale on particles (multiplier for visual effect) - 25.0 compensates for fast rain velocity */
export const WIND_EFFECT_SCALE = 40.0

/** Minimum interval between gusts (seconds) */
export const GUST_INTERVAL_MIN = 2

/** Maximum interval between gusts (seconds) */
export const GUST_INTERVAL_MAX = 8

/** Minimum gust duration (seconds) */
export const GUST_DURATION_MIN = 1

/** Maximum gust duration (seconds) */
export const GUST_DURATION_MAX = 3

/** Gust ramp-up time as fraction of gust duration (0-1) */
export const GUST_RAMP_FRACTION = 0.3

/** Variable wind direction variance (degrees, for VRB winds) */
export const VARIABLE_WIND_VARIANCE = 60

// ============================================================================
// METAR PRECIPITATION CODES
// ============================================================================

import type { PrecipitationType } from '@/types'

/** Mapping of METAR precipitation codes to precipitation types */
export const METAR_PRECIP_CODES: Record<string, PrecipitationType> = {
  'RA': 'rain',
  'SN': 'snow',
  'DZ': 'drizzle',
  'GR': 'hail',
  'GS': 'hail',
  'PL': 'ice',
  'SG': 'snow',
  'IC': 'snow',
  'UP': 'unknown'
}
