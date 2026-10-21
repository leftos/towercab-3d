/**
 * Pure inputs of the Cesium cloud and fog stage (`useCesiumWeatherStages`):
 * cloud layer uniforms from the weather store, fog visibility, settings gating
 * and the anchor of the stage's east-north-up frame. Kept free of Cesium so
 * they can be unit tested.
 */

import {
  CLOUD_THICKNESS_DEFAULT_M,
  STATUTE_MILES_TO_METERS,
  WEATHER_STAGE_AIRPORT_REANCHOR_DISTANCE_M,
  WEATHER_STAGE_GROUND_BLEND_MS,
  WEATHER_STAGE_MAX_LAYERS,
  WEATHER_STAGE_MIN_VISIBILITY_SM,
  WEATHER_STAGE_NO_FOG_VISIBILITY_SM,
  WEATHER_STAGE_NOISE_ORIGIN_RESET_M,
  WEATHER_STAGE_REANCHOR_DISTANCE_M,
} from '@/constants'
import type { CloudLayer, ViewMode, WeatherRenderer } from '@/types'
import { haversineDistanceNm } from '@/utils/aircraft/geoMath'
import { nmToMeters } from '@/utils/coordinates'

/** One cloud slab as the shader's vec4(base, thickness, coverage, active) wants it */
export interface CloudLayerUniform {
  /** Cloud base in meters above the anchor's ground */
  base: number
  /** Slab thickness in meters */
  thickness: number
  /** Sky fraction covered, 0..1 */
  coverage: number
}

/**
 * Cloud layers for the stage: clear layers dropped, lowest first, at most the
 * four the shader takes, each with the slab thickness of its cover code.
 *
 * @param layers - Weather store cloud layers (altitude in meters AGL)
 * @param thicknessByType - Slab thickness in meters by METAR cover code
 * @returns The layers the stage draws
 */
export function buildCloudLayerUniforms(
  layers: readonly CloudLayer[],
  thicknessByType: Readonly<Record<string, number>>,
): CloudLayerUniform[] {
  return layers
    .filter((layer) => layer.coverage > 0)
    .sort((a, b) => a.altitude - b.altitude)
    .slice(0, WEATHER_STAGE_MAX_LAYERS)
    .map((layer) => ({
      base: layer.altitude,
      thickness: thicknessByType[layer.type] ?? CLOUD_THICKNESS_DEFAULT_M,
      coverage: layer.coverage,
    }))
}

/**
 * Fog visibility for the stage in meters, or 0 for no fog.
 *
 * @param visibSM - METAR visibility in statute miles, undefined without a METAR
 * @param visibilityScale - The `visibilityScale` weather setting (2 = see twice as far)
 * @returns Visibility in meters, 0 at 10 SM and above or without a METAR
 */
export function stageVisibilityMeters(visibSM: number | undefined, visibilityScale: number): number {
  if (visibSM === undefined || visibSM >= WEATHER_STAGE_NO_FOG_VISIBILITY_SM) {
    return 0
  }
  return Math.max(visibSM, WEATHER_STAGE_MIN_VISIBILITY_SM) * STATUTE_MILES_TO_METERS * visibilityScale
}

/** Settings and scene state that decide whether and what the stage draws */
export interface WeatherStageGateInput {
  renderer: WeatherRenderer
  showWeatherEffects: boolean
  showClouds: boolean
  showBabylonFog: boolean
  viewMode: ViewMode
  /** Whether the scene uses the logarithmic depth buffer the stage's depth path needs */
  logDepth: boolean
}

/** What the stage draws */
export interface WeatherStageGates {
  /** Whether the stage is in the scene at all */
  stage: boolean
  clouds: boolean
  fog: boolean
  /** The stage is wanted but hidden because the logarithmic depth buffer is off */
  missingLogDepth: boolean
}

/**
 * Settings gating of the stage: `showClouds` gates the clouds and
 * `showBabylonFog` the fog, under the `showWeatherEffects` master switch; the
 * top-down view and the Babylon renderer draw none, and without the
 * logarithmic depth buffer the stage hides itself.
 *
 * @param input - Settings, view mode, renderer switch and depth buffer state
 * @returns What the stage draws
 */
export function weatherStageGates(input: WeatherStageGateInput): WeatherStageGates {
  const active = input.renderer === 'cesium' && input.showWeatherEffects && input.viewMode !== 'topdown'
  const wanted = active && (input.showClouds || input.showBabylonFog)
  if (!wanted || !input.logDepth) {
    return { stage: false, clouds: false, fog: false, missingLogDepth: wanted }
  }
  return { stage: true, clouds: input.showClouds, fog: input.showBabylonFog, missingLogDepth: false }
}

/** Position of the stage's east-north-up frame and what it is keyed on */
export interface WeatherAnchor {
  /** `airport:<ICAO>` at an airport, `free` while following an aircraft without one */
  key: string
  lat: number
  lon: number
  /** Ground height to use until terrain is sampled (the airport elevation), or null */
  groundHintM: number | null
}

/** The viewer's reference position: the tower, or the followed aircraft without an airport */
export interface WeatherReference {
  airportIcao: string | null
  lat: number | null
  lon: number | null
  /** Airport elevation in meters, used as the ground until terrain is sampled */
  groundHintM?: number | null
}

/**
 * The anchor the stage's frame should use. The anchor moves only once the
 * reference is far enough from it: WEATHER_STAGE_AIRPORT_REANCHOR_DISTANCE_M
 * within the same airport (a custom tower position arriving late), and
 * WEATHER_STAGE_REANCHOR_DISTANCE_M while following an aircraft without an
 * airport, so the terrain under it is not resampled every frame. Changing
 * airport, or leaving it for orbit-follow, always re-anchors.
 *
 * @param previous - The current anchor, or null before the first
 * @param reference - The viewer's reference position now
 * @returns `previous` itself when it still holds, else a new anchor, or null
 * without a reference position
 */
export function nextWeatherAnchor(previous: WeatherAnchor | null, reference: WeatherReference): WeatherAnchor | null {
  const { airportIcao, lat, lon } = reference
  if (lat === null || lon === null) {
    return null
  }
  const key = airportIcao ? `airport:${airportIcao}` : 'free'
  if (previous && previous.key === key) {
    const limitMeters = airportIcao ? WEATHER_STAGE_AIRPORT_REANCHOR_DISTANCE_M : WEATHER_STAGE_REANCHOR_DISTANCE_M
    const movedMeters = nmToMeters(haversineDistanceNm(previous.lat, previous.lon, lat, lon))
    if (movedMeters < limitMeters) {
      return previous
    }
  }
  return { key, lat, lon, groundHintM: reference.groundHintM ?? null }
}

/** The ground a frame sits on, and whether it came from a terrain sample or is a placeholder */
export interface FrameGround {
  /** Key of the anchor the ground belongs to */
  key: string
  /** Ellipsoid height in meters */
  groundM: number
  /** False for a placeholder: the airport elevation hint (an MSL height) or 0 */
  sampled: boolean
}

/**
 * Ground for the anchor's frame. A real provider's sample wins. Without one,
 * the frame keeps the previous ground at the same location; at a new
 * location it takes, as a placeholder, the previous ground of the same anchor
 * key (a same-airport re-anchor), then the airport elevation hint, then the
 * previous ground of any key (leaving an airport for orbit-follow), then 0.
 * A ground carried to a new location is never marked sampled. The bare
 * ellipsoid provider, active until the world terrain loads, samples every
 * point at 0, so its sample never counts.
 *
 * @param input.key - Key of the anchor the frame is built for
 * @param input.sampledM - Sampled terrain height, undefined before or without a sample
 * @param input.ellipsoidProvider - Whether the terrain provider is the bare ellipsoid
 * @param input.hintM - Airport elevation hint, or null
 * @param input.previous - Ground of the frame being replaced, or null
 * @param input.moved - Whether the frame moves to a new anchor (false for a resample at the same one)
 * @returns The frame's ground
 */
export function anchorGround(input: {
  key: string
  sampledM: number | undefined
  ellipsoidProvider: boolean
  hintM: number | null
  previous: FrameGround | null
  moved: boolean
}): FrameGround {
  const { key, sampledM, ellipsoidProvider, hintM, previous } = input
  if (!ellipsoidProvider && sampledM !== undefined && Number.isFinite(sampledM)) {
    return { key, groundM: sampledM, sampled: true }
  }
  if (previous && !input.moved) {
    return previous
  }
  const sameKeyM = previous?.key === key ? previous.groundM : null
  return { key, groundM: sameKeyM ?? hintM ?? previous?.groundM ?? 0, sampled: false }
}

/** Where the cloud noise field is fixed: the anchor it was set at */
export interface NoiseOriginAnchor {
  key: string
  lat: number
  lon: number
}

/**
 * Whether the noise origin moves to the anchor. Each re-anchor rotates the
 * frame's axes, so the horizontal noise offset drifts by an error that grows
 * with the distance from the noise origin; moving the origin once the anchor
 * is WEATHER_STAGE_NOISE_ORIGIN_RESET_M away trades that drift for one
 * deliberate pop. An anchor key change (airport switch) always moves it.
 *
 * @param origin - The current noise origin, or null before the first
 * @param anchor - The anchor the new frame is built for
 */
export function noiseOriginNeedsReset(origin: NoiseOriginAnchor | null, anchor: NoiseOriginAnchor): boolean {
  if (!origin || origin.key !== anchor.key) {
    return true
  }
  const distanceM = nmToMeters(haversineDistanceNm(origin.lat, origin.lon, anchor.lat, anchor.lon))
  return distanceM > WEATHER_STAGE_NOISE_ORIGIN_RESET_M
}

/**
 * Vertical deck shift a new frame starts with, so the deck slides from the old
 * ground to the new one. Only a change between two sampled grounds of the
 * same anchor key blends; a placeholder ground is replaced at once, since
 * blending from it would slide the deck by up to the airport's elevation.
 *
 * @param previous - The frame being replaced (its ground and blend start), or null
 * @param next - Ground of the new frame
 * @param nowMs - Time the new frame arrives
 * @returns New ground minus the old one plus the old shift still blending, or 0
 */
export function groundShiftStart(
  previous: { ground: FrameGround; shiftStartM: number; shiftStartMs: number } | null,
  next: FrameGround,
  nowMs: number,
): number {
  if (!previous || previous.ground.key !== next.key || !previous.ground.sampled || !next.sampled) {
    return 0
  }
  return next.groundM - previous.ground.groundM + groundBlendShift(previous.shiftStartM, nowMs - previous.shiftStartMs)
}

/** A vector in a frame's east-north-up axes, in meters */
export interface EnuVector {
  x: number
  y: number
  z: number
}

/**
 * Noise offset of a frame: its origin's horizontal position from the noise
 * origin. The vertical part of that chord is the earth's curvature drop
 * (about d² / 2R), which grows with each re-anchor and would pop the noise,
 * so the noise is fixed to the deck vertically and to the world horizontally.
 *
 * @param fromNoiseOrigin - Frame origin minus noise origin, in the frame's axes
 * @returns The offset with its vertical component dropped
 */
export function horizontalNoiseOffset(fromNoiseOrigin: EnuVector): EnuVector {
  return { x: fromNoiseOrigin.x, y: fromNoiseOrigin.y, z: 0 }
}

/**
 * Remaining vertical shift of the cloud deck after its anchor's ground height
 * changed, so the deck slides to the new height instead of jumping.
 *
 * @param startShiftM - New ground height minus the old one when the new frame arrived, plus any shift still blending
 * @param elapsedMs - Time since the new frame arrived
 * @returns Shift in meters, falling linearly to 0 over WEATHER_STAGE_GROUND_BLEND_MS
 */
export function groundBlendShift(startShiftM: number, elapsedMs: number): number {
  const remaining = Math.max(0, 1 - elapsedMs / WEATHER_STAGE_GROUND_BLEND_MS)
  return remaining === 0 ? 0 : startShiftM * remaining
}

/**
 * Visibility the stage's fog uses: the interpolated visibility while weather
 * interpolation is active (as the store does for cloud layers and fog
 * density), else the METAR's.
 *
 * @param input.metarSM - Current METAR visibility in statute miles, undefined without one
 * @param input.useInterpolation - Whether weather interpolation drives the weather store
 * @param input.interpolatedSM - Interpolated visibility, undefined before the first result
 * @returns Visibility in statute miles, undefined without either
 */
export function effectiveVisibilitySM(input: {
  metarSM: number | undefined
  useInterpolation: boolean
  interpolatedSM: number | undefined
}): number | undefined {
  if (input.useInterpolation && input.interpolatedSM !== undefined) {
    return input.interpolatedSM
  }
  return input.metarSM
}

/**
 * Whether the stage has anything to draw; without a frame (no anchor yet),
 * or with no cloud layers and no fog, it is disabled so its passes cost nothing.
 *
 * @param layerCount - Cloud layers the stage draws
 * @param visibilityMeters - Fog visibility, 0 for no fog
 * @param hasFrame - Whether the stage's east-north-up frame is set
 */
export function weatherStageHasWork(layerCount: number, visibilityMeters: number, hasFrame: boolean): boolean {
  return hasFrame && (layerCount > 0 || visibilityMeters > 0)
}

/**
 * Whether the Babylon fog dome and cloud meshes draw: when the switch picks
 * Babylon, and also when the Cesium stage cannot draw because the scene has
 * no logarithmic depth buffer, so the view never loses its weather.
 *
 * @param renderer - The renderer switch
 * @param logDepth - The scene's live `logarithmicDepthBuffer`
 */
export function babylonDrawsWeather(renderer: WeatherRenderer, logDepth: boolean): boolean {
  return renderer === 'babylon' || !logDepth
}
