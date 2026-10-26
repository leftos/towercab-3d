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
  WEATHER_STAGE_FOG_EASE_MS,
  WEATHER_STAGE_FULL_FOG_VISIBILITY_SM,
  WEATHER_STAGE_GROUND_BLEND_MS,
  WEATHER_STAGE_INSET_FULL_AREA_RATIO,
  WEATHER_STAGE_INSET_STEP_DOWN_AREA_RATIO,
  WEATHER_STAGE_MAX_LAYERS,
  WEATHER_STAGE_MIN_VISIBILITY_SM,
  WEATHER_STAGE_NO_FOG_VISIBILITY_SM,
  WEATHER_STAGE_NOISE_ORIGIN_RESET_M,
  WEATHER_STAGE_PRESETS,
  WEATHER_STAGE_REANCHOR_DISTANCE_M,
  WEATHER_STAGE_SUN_SHADE_COVERAGE,
  type WeatherStageQuality,
} from '@/constants'
import type { CloudLayer, ViewMode, WeatherQualityPreset } from '@/types'
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
 * Whether each cloud layer is shaded from direct sun by a higher layer of BKN or
 * more (WEATHER_STAGE_SUN_SHADE_COVERAGE): a shaded layer's top is lit no
 * brighter than its underside, so its tops seen through gaps in it do not shine.
 *
 * @param layers - The stage's layers (`buildCloudLayerUniforms`)
 * @returns Per layer, 1 when shaded and 0 when lit, in the same order
 */
export function layerSunShade(layers: readonly CloudLayerUniform[]): number[] {
  return layers.map((layer) =>
    layers.some((above) => above.base > layer.base && above.coverage >= WEATHER_STAGE_SUN_SHADE_COVERAGE) ? 1 : 0,
  )
}

/**
 * Strength of the stage's fog against the METAR's, so visibility crossing
 * 10 SM fades the fog in instead of switching it on.
 *
 * @param visibSM - Visibility in statute miles
 * @returns 0 at WEATHER_STAGE_NO_FOG_VISIBILITY_SM and above, 1 at
 *   WEATHER_STAGE_FULL_FOG_VISIBILITY_SM and below, linear in between
 */
export function stageFogFade(visibSM: number): number {
  const width = WEATHER_STAGE_NO_FOG_VISIBILITY_SM - WEATHER_STAGE_FULL_FOG_VISIBILITY_SM
  return Math.min(Math.max((WEATHER_STAGE_NO_FOG_VISIBILITY_SM - visibSM) / width, 0), 1)
}

/**
 * Fog density for the stage per meter: one over the visibility in meters, scaled by `stageFogFade`.
 *
 * @param visibSM - Visibility in statute miles, undefined without a METAR
 * @param visibilityScale - The `visibilityScale` weather setting (2 = see twice as far)
 * @returns Density per meter, 0 at 10 SM and above or without a METAR
 */
export function stageFogDensity(visibSM: number | undefined, visibilityScale: number): number {
  if (visibSM === undefined) {
    return 0
  }
  const fade = stageFogFade(visibSM)
  if (fade === 0) {
    return 0
  }
  return fade / (Math.max(visibSM, WEATHER_STAGE_MIN_VISIBILITY_SM) * STATUTE_MILES_TO_METERS * visibilityScale)
}

/**
 * An ease of the stage's fog density after a visibility step: the gap between
 * the density shown and the new target when the step came, closed over
 * WEATHER_STAGE_FOG_EASE_MS. The ease is decided by `nextFogEase`.
 */
export interface FogEase {
  /** Density shown minus the new target when the ease started, per meter */
  gap: number
  startMs: number
}

/** An ease with nothing left to close: the density is the target */
export const NO_FOG_EASE: FogEase = { gap: 0, startMs: 0 }

/**
 * Starts an ease toward a new target's fog density from the density shown now.
 *
 * @param currentDensity - Density shown now (`easedFogDensity` of the previous ease)
 * @param targetDensity - The new METAR's density (`stageFogDensity`)
 * @param nowMs - Time of the step
 */
export function startFogEase(currentDensity: number, targetDensity: number, nowMs: number): FogEase {
  return { gap: currentDensity - targetDensity, startMs: nowMs }
}

/**
 * Fog density to draw: the target plus what is left of the ease's gap, which
 * closes with a smoothstep over WEATHER_STAGE_FOG_EASE_MS.
 *
 * @param ease - The last METAR step's ease (`startFogEase`), or NO_FOG_EASE
 * @param targetDensity - Density the fog is heading to now
 * @param nowMs - Current time, on the clock `ease.startMs` was taken on
 * @returns Density per meter, never below 0; exactly the target once the ease has run
 */
export function easedFogDensity(ease: FogEase, targetDensity: number, nowMs: number): number {
  const x = Math.min(Math.max((nowMs - ease.startMs) / WEATHER_STAGE_FOG_EASE_MS, 0), 1)
  if (x === 1 || ease.gap === 0) {
    return targetDensity
  }
  const remaining = 1 - x * x * (3 - 2 * x)
  return Math.max(0, targetDensity + ease.gap * remaining)
}

/** The inputs the fog's ease is decided on */
export interface FogEaseInput {
  /** Visibility input in SM (`effectiveVisibilitySM`), undefined when there is none */
  visibilitySM: number | undefined
  /** Whether the fog gate is open (`gates.fog`) */
  gateOpen: boolean
  /** Target density per meter (`stageFogDensity`, or 0 when the gate is closed) */
  targetDensity: number
}

/**
 * Ease to use after the fog's inputs changed. A visibility step (the gate open on
 * both runs and the visibility input changed, METAR or interpolated) eases from
 * the density drawn at this instant; any other change of the target (the
 * visibility scale, the gate opening or closing, a view change) applies at once;
 * with nothing changed the ease in flight is left alone.
 *
 * @param ease - The ease in flight
 * @param previous - The inputs the last run drew with
 * @param next - This run's inputs
 * @param nowMs - Current time
 * @returns The ease to draw with
 */
export function nextFogEase(ease: FogEase, previous: FogEaseInput, next: FogEaseInput, nowMs: number): FogEase {
  if (next.gateOpen && previous.gateOpen && next.visibilitySM !== previous.visibilitySM) {
    return startFogEase(easedFogDensity(ease, previous.targetDensity, nowMs), next.targetDensity, nowMs)
  }
  if (next.targetDensity !== previous.targetDensity) {
    return NO_FOG_EASE
  }
  return ease
}

/** Invalid preset values already warned about, so a bad stored value warns once */
const WARNED_INVALID_PRESETS = new Set<string>()

/**
 * The stored preset, or High for a value that is no preset (an imported or
 * hand-edited settings file), warned about once per distinct value.
 */
function validStagePreset(preset: WeatherQualityPreset): WeatherQualityPreset {
  if (WEATHER_STAGE_PRESETS[preset]) return preset
  if (!WARNED_INVALID_PRESETS.has(preset)) {
    WARNED_INVALID_PRESETS.add(preset)
    console.warn(`[WeatherStage] Unknown weather quality preset "${preset}"; using High`)
  }
  return 'high'
}

/**
 * The stage's knobs at a quality preset.
 *
 * @param preset - The `stageQuality` weather setting, or the preset an inset resolved
 * @returns The preset's knobs; High's, with one warning per distinct bad value, for a stored value that is no preset
 */
export function weatherStageQuality(preset: WeatherQualityPreset): WeatherStageQuality {
  return WEATHER_STAGE_PRESETS[validStagePreset(preset)]
}

/** One preset below each preset; Low stays Low */
const PRESET_ONE_STEP_DOWN: Readonly<Record<WeatherQualityPreset, WeatherQualityPreset>> = {
  high: 'medium',
  medium: 'low',
  low: 'low',
}

/**
 * The preset an inset viewport's stage uses, from its size against the main viewport:
 * the main view's preset from WEATHER_STAGE_INSET_FULL_AREA_RATIO of the main area, one
 * step down from WEATHER_STAGE_INSET_STEP_DOWN_AREA_RATIO, and Low below that.
 *
 * @param mainPreset - The main view's preset (the `stageQuality` weather setting)
 * @param insetArea - The inset's area in CSS pixels squared
 * @param mainArea - The main viewport's area in the same unit
 * @returns The inset's preset; the main preset, with a warning, when either area is not positive
 */
export function insetStageQuality(
  mainPreset: WeatherQualityPreset,
  insetArea: number,
  mainArea: number,
): WeatherQualityPreset {
  const preset = validStagePreset(mainPreset)
  if (!(insetArea > 0) || !(mainArea > 0)) {
    console.warn(
      `[WeatherStage] Inset area ${insetArea} or main area ${mainArea} is not positive; using the main preset ${preset}`,
    )
    return preset
  }
  const ratio = insetArea / mainArea
  if (ratio >= WEATHER_STAGE_INSET_FULL_AREA_RATIO) return preset
  if (ratio >= WEATHER_STAGE_INSET_STEP_DOWN_AREA_RATIO) return PRESET_ONE_STEP_DOWN[preset]
  return 'low'
}

/** A viewport's kind and the areas its quality preset depends on */
export interface ViewportStagePresetInput {
  /** The `stageQuality` weather setting, the main view's preset */
  stageQuality: WeatherQualityPreset
  /** Whether the viewport is an inset */
  isInset: boolean
  /** The inset's area in CSS pixels squared; null when it cannot be read */
  insetArea: number | null
  /** The main window's area in the same unit; null when it cannot be read */
  mainArea: number | null
}

/**
 * The quality preset a viewport's stage uses: the `stageQuality` setting in the
 * main view, or an inset at its size against the main window (`insetStageQuality`).
 *
 * @param input - The stored preset, the viewport's kind and the areas
 * @returns The preset this viewport's stage uses
 */
export function stagePresetForViewport({
  stageQuality,
  isInset,
  insetArea,
  mainArea,
}: ViewportStagePresetInput): WeatherQualityPreset {
  if (!isInset || insetArea === null || mainArea === null) return validStagePreset(stageQuality)
  return insetStageQuality(stageQuality, insetArea, mainArea)
}

/** Cesium `scene.fog` values the weather hook writes */
export interface SceneFogValues {
  /** Whether the scene's own fog is on at all */
  enabled: boolean
  /** Fog density, how quickly distant terrain fades */
  density: number
  /** How strongly the fog shows on screen */
  visualDensityScalar: number
  /** Screen space error factor: terrain loads coarser while fogged */
  screenSpaceErrorFactor: number
  /** Floor on how dark the fog may get */
  minimumBrightness: number
}

/** Cesium's default fog, applied whenever METAR visibility does not tune it */
const SCENE_FOG_DEFAULT = {
  density: 0.0006,
  visualDensityScalar: 0.15,
  screenSpaceErrorFactor: 2.0,
  minimumBrightness: 0.03,
} as const

/** Fog density the derived values reach their densest look at (see weatherStore's visibilityToFogDensity) */
const SCENE_FOG_DENSITY_MAX = 0.015

/** Scene fog brightness floor while tuned from METAR visibility, so dense fog is not black */
const SCENE_FOG_TUNED_MINIMUM_BRIGHTNESS = 0.1

/**
 * Extinction the stage's fog uses, from the quality knob and the user's `fogIntensity`.
 *
 * The shader multiplies the optical depth integral by `u_fogExtinction`, so fogIntensity 1
 * keeps the base extinction, 2 doubles the optical depth and 0 removes the fog.
 *
 * @param baseExtinction - The active preset's `fogExtinction` (see `weatherStageQuality`)
 * @param fogIntensity - The `fogIntensity` weather setting
 * @returns Extinction for the shader, floored at 0
 */
export function stageFogExtinction(baseExtinction: number, fogIntensity: number): number {
  return Math.max(0, baseExtinction * fogIntensity)
}

/**
 * The values to write to Cesium's `scene.fog`, from the fog toggle, the METAR
 * fog density and whether the Cesium stage draws the fog itself.
 *
 * While the stage fogs the scene in its composite pass, the scene's own fog stays
 * at Cesium's default (it still coarsens terrain LOD) instead of fogging the
 * terrain twice, whatever the visibility. While the stage draws no fog (the
 * Babylon overlay drawing instead, or the fog toggled off), the scene's fog is
 * tuned from `fogDensity` as it always has been.
 *
 * @param input.fogEnabled - `showWeatherEffects && showCesiumFog`
 * @param input.fogDensity - Fog density derived from METAR visibility (0 to 0.015)
 * @param input.stageDrawsFog - Whether the Cesium stage draws the fog (`gates.fog`)
 * @returns The enabled flag and the four values to copy onto `scene.fog`
 */
export function sceneFogValues(input: {
  fogEnabled: boolean
  fogDensity: number
  stageDrawsFog: boolean
}): SceneFogValues {
  if (!input.fogEnabled || input.stageDrawsFog || input.fogDensity <= 0) {
    return { enabled: input.fogEnabled, ...SCENE_FOG_DEFAULT }
  }
  // Dense fog shows strongly: 0.15 at no density up to 1.0 at SCENE_FOG_DENSITY_MAX.
  const visualDensityScalar = Math.min(
    1.0,
    SCENE_FOG_DEFAULT.visualDensityScalar + (input.fogDensity / SCENE_FOG_DENSITY_MAX) * 0.85,
  )
  return {
    enabled: true,
    density: input.fogDensity,
    visualDensityScalar,
    screenSpaceErrorFactor: SCENE_FOG_DEFAULT.screenSpaceErrorFactor,
    minimumBrightness: SCENE_FOG_TUNED_MINIMUM_BRIGHTNESS,
  }
}

/** Settings and scene state that decide whether and what the stage draws */
export interface WeatherStageGateInput {
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
 * top-down view draws none, and without the logarithmic depth buffer the
 * stage hides itself.
 *
 * @param input - Settings, view mode and depth buffer state
 * @returns What the stage draws
 */
export function weatherStageGates(input: WeatherStageGateInput): WeatherStageGates {
  const active = input.showWeatherEffects && input.viewMode !== 'topdown'
  const wanted = active && (input.showClouds || input.showBabylonFog)
  if (!wanted || !input.logDepth) {
    return { stage: false, clouds: false, fog: false, missingLogDepth: wanted }
  }
  return { stage: true, clouds: input.showClouds, fog: input.showBabylonFog, missingLogDepth: false }
}

/**
 * Whether the stage actually draws the fog now: the fog gate is on and the
 * stage has an anchor frame to draw in.
 *
 * `gates.fog` alone only says the settings ask for fog. With no anchor (no
 * airport picked yet, or orbit-follow before the followed aircraft appears) the
 * stage stays off, so Cesium's own scene fog must keep being tuned from METAR
 * visibility instead of holding clear-weather values.
 *
 * @param gatesFog - Whether the settings gate asks the stage for fog (`gates.fog`)
 * @param hasAnchor - Whether the stage has an anchor frame yet
 * @returns True only when both hold
 */
export function stageDrawsFog(gatesFog: boolean, hasAnchor: boolean): boolean {
  return gatesFog && hasAnchor
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
 * @param fogDensity - Fog density per meter, 0 for no fog
 * @param hasFrame - Whether the stage's east-north-up frame is set
 */
export function weatherStageHasWork(layerCount: number, fogDensity: number, hasFrame: boolean): boolean {
  return hasFrame && (layerCount > 0 || fogDensity > 0)
}
