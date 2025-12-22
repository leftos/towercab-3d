/**
 * Weather-related type definitions
 *
 * This file centralizes weather data types used by the METAR parsing service
 * and weather visualization system.
 *
 * @see weatherStore - Store for managing weather state
 * @see MetarService - Service for fetching and parsing METAR data
 * @see useBabylonOverlay - Hook that renders fog dome and cloud layers
 */

/**
 * Cloud layer parsed from METAR data
 *
 * METAR cloud reporting format:
 * - FEW = Few clouds (1-2 oktas, 12.5-25% coverage)
 * - SCT = Scattered (3-4 oktas, 37.5-50% coverage)
 * - BKN = Broken (5-7 oktas, 62.5-87.5% coverage)
 * - OVC = Overcast (8 oktas, 100% coverage)
 *
 * An okta is 1/8th of the sky covered by clouds.
 *
 * @example
 * // METAR: "BKN015" = Broken clouds at 1,500 ft AGL
 * const brokenLayer: CloudLayer = {
 *   altitude: 457.2,    // 1,500 ft converted to meters
 *   coverage: 0.75,     // BKN = 0.75 (75% coverage)
 *   type: 'BKN'
 * }
 *
 * @example
 * // METAR: "OVC025" = Overcast at 2,500 ft AGL
 * const overcastLayer: CloudLayer = {
 *   altitude: 762,      // 2,500 ft converted to meters
 *   coverage: 1.0,      // OVC = 1.0 (100% coverage)
 *   type: 'OVC'
 * }
 */
export interface CloudLayer {
  /**
   * Altitude of cloud base in meters above ground level (AGL)
   *
   * METAR reports clouds in feet AGL, converted to meters by:
   * ```
   * meters = feet * 0.3048
   * ```
   *
   * Note: This is AGL (Above Ground Level), not MSL (Mean Sea Level).
   * To get MSL altitude: MSL = AGL + airport_elevation
   */
  altitude: number

  /**
   * Cloud coverage as a decimal (0-1)
   *
   * Mapping from METAR codes:
   * - FEW: 0.25 (1-2 oktas)
   * - SCT: 0.50 (3-4 oktas)
   * - BKN: 0.75 (5-7 oktas)
   * - OVC: 1.00 (8 oktas)
   * - SKC/CLR/NSC/NCD: 0 (clear)
   *
   * Used to determine:
   * - Cloud plane opacity in 3D visualization
   * - Whether to cull aircraft labels below clouds
   * - Ceiling (lowest BKN or OVC layer)
   */
  coverage: number

  /**
   * Original METAR cloud cover type code
   *
   * Preserved for debugging and display purposes.
   * Common values: 'FEW', 'SCT', 'BKN', 'OVC', 'SKC', 'CLR', 'NSC', 'NCD'
   */
  type: string
}

/**
 * Flight category based on METAR conditions
 *
 * FAA/ICAO flight categories based on ceiling and visibility:
 * - VFR (Visual Flight Rules): Ceiling ≥ 3000 ft AND visibility ≥ 5 SM
 * - MVFR (Marginal VFR): Ceiling 1000-3000 ft OR visibility 3-5 SM
 * - IFR (Instrument Flight Rules): Ceiling 500-1000 ft OR visibility 1-3 SM
 * - LIFR (Low IFR): Ceiling < 500 ft OR visibility < 1 SM
 */
export type FlightCategory = 'VFR' | 'MVFR' | 'IFR' | 'LIFR'

/**
 * Visibility-based fog density
 *
 * Computed from METAR visibility and used for Cesium fog rendering.
 *
 * Reference visibility values:
 * - ≥10 SM: No fog (density = 0)
 * - 3-10 SM: Light fog (MVFR)
 * - 1-3 SM: Moderate fog (IFR)
 * - 0.25-1 SM: Dense fog (LIFR)
 * - <0.25 SM: Very dense fog (density = 0.015)
 *
 * Density calculation uses logarithmic scale for natural perception:
 * ```
 * density = maxDensity * (1 - normalized_log_visibility)
 * ```
 *
 * @see weatherStore - Stores computed fog density
 * @see useBabylonOverlay - Renders fog dome based on density
 */
export type FogDensity = number

/**
 * Ceiling information derived from METAR cloud layers
 *
 * Ceiling is defined as the lowest BKN (broken) or OVC (overcast) layer.
 * FEW and SCT layers do not constitute a ceiling.
 */
export interface Ceiling {
  /** Altitude of ceiling in meters AGL, or null if no ceiling exists */
  altitude: number | null
  /** Cloud type that forms the ceiling ('BKN' or 'OVC'), or null */
  type: string | null
}

// ============================================================================
// PRECIPITATION TYPES
// ============================================================================

/**
 * Type of precipitation from METAR weather codes
 *
 * METAR codes mapped to precipitation types:
 * - RA → rain
 * - SN → snow
 * - DZ → drizzle (light rain)
 * - GR, GS → hail
 * - PL, SG, IC → ice (frozen precipitation)
 * - UP → unknown precipitation
 */
export type PrecipitationType = 'rain' | 'snow' | 'drizzle' | 'hail' | 'ice' | 'unknown'

/**
 * Intensity of precipitation from METAR modifier
 *
 * METAR uses prefixes to indicate intensity:
 * - `-` prefix = light (e.g., -RA = light rain)
 * - no prefix = moderate (e.g., RA = moderate rain)
 * - `+` prefix = heavy (e.g., +RA = heavy rain)
 */
export type PrecipitationIntensity = 'light' | 'moderate' | 'heavy'

/**
 * Single precipitation type parsed from METAR
 *
 * @example
 * // METAR: "+RASN" = heavy rain and snow
 * const rain: Precipitation = { type: 'rain', intensity: 'heavy', code: '+RA' }
 * const snow: Precipitation = { type: 'snow', intensity: 'heavy', code: '+SN' }
 */
export interface Precipitation {
  /** Type of precipitation */
  type: PrecipitationType
  /** Intensity from METAR modifier */
  intensity: PrecipitationIntensity
  /** Original METAR code (e.g., '+RA', '-SN', 'DZ') */
  code: string
}

/**
 * Complete precipitation state for weather effects rendering
 *
 * @example
 * // Thunderstorm with heavy rain
 * const state: PrecipitationState = {
 *   active: true,
 *   types: [{ type: 'rain', intensity: 'heavy', code: '+RA' }],
 *   visibilityFactor: 1.5,
 *   hasThunderstorm: true
 * }
 */
export interface PrecipitationState {
  /** Whether any precipitation is occurring */
  active: boolean
  /** Array of precipitation types (can have multiple, e.g., rain+snow) */
  types: Precipitation[]
  /** Visibility-based particle multiplier (lower vis = more particles) */
  visibilityFactor: number
  /** Whether thunderstorm (TS) code is present - triggers lightning */
  hasThunderstorm: boolean
}

// ============================================================================
// WIND TYPES
// ============================================================================

/**
 * Wind state parsed from METAR
 *
 * METAR wind format: DDDSSKT or DDDSSGSSGKT
 * - DDD = direction in degrees (or VRB for variable)
 * - SS = speed in knots
 * - G = gust indicator
 * - SSG = gust speed in knots
 *
 * @example
 * // METAR: "28009G15KT" = 280° at 9kt gusting 15kt
 * const wind: WindState = {
 *   direction: 280,
 *   speed: 9,
 *   gustSpeed: 15,
 *   isVariable: false
 * }
 *
 * @example
 * // METAR: "VRB05KT" = variable at 5kt
 * const wind: WindState = {
 *   direction: 0,
 *   speed: 5,
 *   gustSpeed: null,
 *   isVariable: true
 * }
 */
export interface WindState {
  /** Wind direction in degrees (0-360, meteorological: direction wind is FROM) */
  direction: number
  /** Wind speed in knots */
  speed: number
  /** Gust speed in knots, or null if no gusts reported */
  gustSpeed: number | null
  /** Whether wind is variable direction (VRB in METAR) */
  isVariable: boolean
}
