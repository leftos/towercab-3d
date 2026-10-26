/**
 * Weather interpolation constants
 *
 * Configuration for METAR weather interpolation and auto-airport switching features.
 */

import type { WeatherQualityPreset } from '@/types'

// ============================================================================
// WEATHER INTERPOLATION
// ============================================================================

/**
 * Number of METAR stations to use for interpolation
 * More stations = smoother transitions but more API calls
 */
export const INTERPOLATION_STATION_COUNT = 3

/**
 * Maximum search radius for METAR stations in nautical miles
 * Stations beyond this distance are not considered
 */
export const INTERPOLATION_RADIUS_NM = 100

/**
 * Exponent for inverse distance weighting
 * - 1 = linear (1/d)
 * - 2 = inverse square (1/d^2) - default, gives more weight to closer stations
 * - 3 = inverse cube (1/d^3) - heavily weighted toward nearest
 */
export const INTERPOLATION_DISTANCE_POWER = 2

/**
 * Minimum weight threshold for including a station
 * Stations with weight below this are excluded from interpolation
 */
export const INTERPOLATION_MIN_WEIGHT = 0.05

/**
 * Altitude band for matching cloud layers when interpolating (feet)
 * Cloud layers within this altitude difference are considered the same layer
 */
export const CLOUD_ALTITUDE_BAND_FEET = 500

/**
 * Throttle interval for weather interpolation updates (ms)
 * Limits how often interpolation is recalculated as camera moves
 */
export const INTERPOLATION_UPDATE_THROTTLE_MS = 2000

/**
 * Minimum distance camera must move before re-fetching weather (degrees)
 * Approximately 0.05 degrees = 3 nautical miles
 */
export const INTERPOLATION_POSITION_THRESHOLD_DEG = 0.05

// ============================================================================
// AUTO-AIRPORT SWITCHING
// ============================================================================

/**
 * Interval for checking camera distance to airports (ms)
 * Lower = more responsive but more CPU usage
 */
export const AUTO_SWITCH_CHECK_INTERVAL_MS = 2000

/**
 * Hysteresis distance for preventing rapid airport switching (nm)
 * Must move this far past the nearest airport boundary before switching back
 */
export const AUTO_SWITCH_HYSTERESIS_NM = 5

/**
 * Minimum distance from current airport before considering a switch (nm)
 * Prevents switching when very close to current airport
 */
export const AUTO_SWITCH_MIN_DISTANCE_NM = 2

// ============================================================================
// WEATHER SMOOTHING / HYSTERESIS
// ============================================================================

/**
 * Transition time for visibility changes (seconds)
 * Controls how fast fog opacity/scale responds to METAR updates
 * Higher = smoother but slower to respond to real weather changes
 */
export const VISIBILITY_TRANSITION_TIME = 8.0

/**
 * Transition time for fog density changes (seconds)
 */
export const FOG_DENSITY_TRANSITION_TIME = 8.0

/**
 * Transition time for wind direction changes (seconds)
 * Uses circular interpolation to handle wrap-around at 360°
 */
export const WIND_DIRECTION_TRANSITION_TIME = 5.0

/**
 * Transition time for wind speed changes (seconds)
 */
export const WIND_SPEED_TRANSITION_TIME = 3.0

/**
 * Transition time for precipitation intensity fade in/out (seconds)
 * Controls how fast rain/snow particles ramp up or down
 */
export const PRECIPITATION_FADE_TIME = 4.0

/**
 * Hysteresis threshold for precipitation activation (seconds)
 * Precipitation must be reported for this long before showing
 * Prevents flickering when hovering near boundary between stations
 */
export const PRECIPITATION_ONSET_DELAY = 2.0

/**
 * Hysteresis threshold for precipitation deactivation (seconds)
 * Precipitation must be absent for this long before hiding
 */
export const PRECIPITATION_CESSATION_DELAY = 5.0

/**
 * Hysteresis threshold for thunderstorm activation (seconds)
 */
export const THUNDERSTORM_ONSET_DELAY = 1.0

/**
 * Hysteresis threshold for thunderstorm deactivation (seconds)
 */
export const THUNDERSTORM_CESSATION_DELAY = 8.0

/**
 * Minimum visibility change (statute miles) to trigger transition
 * Changes smaller than this are applied instantly
 */
export const VISIBILITY_CHANGE_THRESHOLD = 0.1

/**
 * Minimum wind direction change (degrees) to trigger transition
 */
export const WIND_DIRECTION_CHANGE_THRESHOLD = 5

/**
 * Minimum wind speed change (knots) to trigger transition
 */
export const WIND_SPEED_CHANGE_THRESHOLD = 2

// ============================================================================
// CESIUM CLOUD AND FOG STAGE
// ============================================================================

/**
 * Knobs of the Cesium cloud and fog post-process stage at one quality preset.
 *
 * - `steps`: raymarch steps per cloud layer crossing (shader maximum 256)
 * - `resolutionScale`: cloud pass resolution relative to the canvas (0.25..1); read when
 *   the stage is created, independent of the canvas's own resolution
 * - `densityScale`: cloud extinction per meter at full density
 * - `fogExtinction`: k in the fog transmittance exp(-k * distance / visibility)
 * - `fogHeightScale`: height in meters over which fog density falls by 1/e
 * - `radius`: radius in meters around the anchor that cloud layers cover
 */
export interface WeatherStageQuality {
  readonly steps: number
  readonly resolutionScale: number
  readonly densityScale: number
  readonly fogExtinction: number
  readonly fogHeightScale: number
  readonly radius: number
}

/**
 * Knobs of the stage per quality preset. Only the cost knobs (steps, resolutionScale,
 * radius) differ; the look knobs (densityScale, fogExtinction, fogHeightScale) are equal.
 *
 * High: the deck curves down with the earth, so from a tower cab an overcast base at
 * 2,000 ft ends about 0.15 deg above the horizon at 100 km (a flat 40 km deck leaves a
 * degree of clear sky). About 120 km would reach the horizon, but would need 144 steps at
 * the same step length; 100 km keeps the sliver small for 120 steps, which keep the step
 * length of 48 steps over 40 km. Medium and Low trade a wider band of clear sky at the
 * horizon and a coarser cloud pass for frame time.
 */
export const WEATHER_STAGE_PRESETS: Readonly<Record<WeatherQualityPreset, WeatherStageQuality>> = {
  low: {
    steps: 48,
    resolutionScale: 0.25,
    densityScale: 0.04,
    fogExtinction: 1.0,
    fogHeightScale: 400,
    radius: 40000,
  },
  medium: {
    steps: 72,
    resolutionScale: 0.375,
    densityScale: 0.04,
    fogExtinction: 1.0,
    fogHeightScale: 400,
    radius: 60000,
  },
  high: {
    steps: 120,
    resolutionScale: 0.5,
    densityScale: 0.04,
    fogExtinction: 1.0,
    fogHeightScale: 400,
    radius: 100000,
  },
}

/** Inset area, as a fraction of the main viewport's, from which an inset uses the main view's preset */
export const WEATHER_STAGE_INSET_FULL_AREA_RATIO = 0.5

/** Inset area fraction from which an inset uses one preset below the main view's; under it, Low */
export const WEATHER_STAGE_INSET_STEP_DOWN_AREA_RATIO = 0.15

/** Quiet time after an inset resize before a changed preset rebuilds the stage, in ms */
export const WEATHER_STAGE_INSET_RESIZE_SETTLE_MS = 300

/** Cloud slab thickness in meters by METAR cover code */
export const CLOUD_THICKNESS_BY_TYPE_M: Readonly<Record<string, number>> = {
  FEW: 250,
  SCT: 350,
  BKN: 450,
  OVC: 600,
}

/** Cloud slab thickness in meters for a cover code missing from CLOUD_THICKNESS_BY_TYPE_M */
export const CLOUD_THICKNESS_DEFAULT_M = 400

/** Cloud layers the stage shader takes (u_layer0..u_layer3) */
export const WEATHER_STAGE_MAX_LAYERS = 4

/** Visibility (statute miles) at and above which the stage draws no fog */
export const WEATHER_STAGE_NO_FOG_VISIBILITY_SM = 10

/** Lowest visibility (statute miles) the stage's fog uses, so 0 SM stays finite */
export const WEATHER_STAGE_MIN_VISIBILITY_SM = 0.05

/**
 * Distance in meters a followed aircraft (orbit mode without an airport) moves
 * before the cloud anchor follows it; small against the cloud radius, large
 * enough that a terrain sample is not taken every frame
 */
export const WEATHER_STAGE_REANCHOR_DISTANCE_M = 5000

/**
 * Distance in meters the reference moves within the same airport (a custom
 * tower position, a tower switch) before the cloud anchor follows it
 */
export const WEATHER_STAGE_AIRPORT_REANCHOR_DISTANCE_M = 100

/**
 * Distance in meters between the anchor and the cloud noise origin past which
 * the origin moves to the anchor: one deliberate noise pop per this distance,
 * keeping the horizontal drift from rotated re-anchor axes under about 40 m per
 * WEATHER_STAGE_REANCHOR_DISTANCE_M step before it
 */
export const WEATHER_STAGE_NOISE_ORIGIN_RESET_M = 50000

/** How often (ms) the stage checks whether its anchor should move, and retries a failed terrain sample */
export const WEATHER_STAGE_REANCHOR_CHECK_MS = 1000

/** Time (ms) over which a change in the anchor's ground height blends into the cloud deck */
export const WEATHER_STAGE_GROUND_BLEND_MS = 5000
