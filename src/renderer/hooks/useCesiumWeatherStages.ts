import * as Cesium from 'cesium'
import { useEffect, useRef, useState } from 'react'
import {
  CLOUD_THICKNESS_BY_TYPE_M,
  WEATHER_STAGE_MAX_LAYERS,
  WEATHER_STAGE_QUALITY,
  WEATHER_STAGE_REANCHOR_CHECK_MS,
} from '@/constants'
import { CLOUD_STAGE_FS, WEATHER_COMPOSITE_FS } from '@/hooks/weather/cloudStage.glsl'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWeatherStageStore } from '@/stores/weatherStageStore'
import { useWeatherStore } from '@/stores/weatherStore'
import type { ViewMode } from '@/types'
import {
  anchorGround,
  buildCloudLayerUniforms,
  effectiveVisibilitySM,
  type FrameGround,
  groundBlendShift,
  groundShiftStart,
  horizontalNoiseOffset,
  type NoiseOriginAnchor,
  nextWeatherAnchor,
  noiseOriginNeedsReset,
  stageVisibilityMeters,
  type WeatherAnchor,
  type WeatherReference,
  weatherStageGates,
  weatherStageHasWork,
} from '@/utils/weatherStage'

/** Name of the composite the hook adds to `scene.postProcessStages` */
export const WEATHER_STAGE_NAME = 'tc3dWeatherStage'
const CLOUD_PASS_NAME = 'tc3dWeatherClouds'
const COMPOSITE_PASS_NAME = 'tc3dWeatherComposite'

/** The stage's east-north-up frame on the ground under its anchor */
interface EnuFrame {
  anchor: WeatherAnchor
  fixedToEnu: Cesium.Matrix4
  ecefToEnuRotation: Cesium.Matrix3
  /** The ground the frame sits on (ellipsoid height) and whether it was sampled */
  ground: FrameGround
  /** This frame's origin from the noise origin, horizontal only, in this frame's axes */
  noiseOffset: Cesium.Cartesian3
  /** Vertical shift of the deck when the frame arrived, blending to 0 (see groundBlendShift) */
  shiftStartM: number
  shiftStartMs: number
}

/** Uniform values derived from the weather store and settings, refreshed when they change */
interface StageInputs {
  /** Always WEATHER_STAGE_MAX_LAYERS entries; unused slots are inactive (w = 0) */
  layers: Cesium.Cartesian4[]
  layerCount: number
  visibilityMeters: number
}

const NO_INPUTS: StageInputs = {
  layers: Array.from({ length: WEATHER_STAGE_MAX_LAYERS }, () => new Cesium.Cartesian4(0, 1, 0, 0)),
  layerCount: 0,
  visibilityMeters: 0,
}

/** Mutable state shared by the stage's hooks and its uniform callbacks */
interface StageRefs {
  frame: { current: EnuFrame | null }
  inputs: { current: StageInputs }
  stage: { current: Cesium.PostProcessStageComposite | null }
}

/** Where the noise field is fixed in the world; moved per `noiseOriginNeedsReset` */
interface NoiseOrigin extends NoiseOriginAnchor {
  point: Cesium.Cartesian3
}

function buildEnuFrame(
  anchor: WeatherAnchor,
  ground: FrameGround,
  previous: EnuFrame | null,
  noiseOrigin: NoiseOrigin,
): EnuFrame {
  const point = Cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat, ground.groundM)
  const enuToFixed = Cesium.Transforms.eastNorthUpToFixedFrame(point)
  const fixedToEnu = Cesium.Matrix4.inverseTransformation(enuToFixed, new Cesium.Matrix4())
  const ecefToEnuRotation = Cesium.Matrix4.getMatrix3(fixedToEnu, new Cesium.Matrix3())
  const fromOrigin = Cesium.Cartesian3.subtract(point, noiseOrigin.point, new Cesium.Cartesian3())
  const offset = horizontalNoiseOffset(
    Cesium.Matrix3.multiplyByVector(ecefToEnuRotation, fromOrigin, new Cesium.Cartesian3()),
  )
  const now = performance.now()
  return {
    anchor,
    fixedToEnu,
    ecefToEnuRotation,
    ground,
    noiseOffset: new Cesium.Cartesian3(offset.x, offset.y, offset.z),
    shiftStartM: groundShiftStart(previous, ground, now),
    shiftStartMs: now,
  }
}

function currentShift(frame: EnuFrame): number {
  return groundBlendShift(frame.shiftStartM, performance.now() - frame.shiftStartMs)
}

/** Enables the stage only while it has a frame and something to draw */
function syncStageEnabled(refs: StageRefs): void {
  const stage = refs.stage.current
  if (!stage) return
  const { layerCount, visibilityMeters } = refs.inputs.current
  stage.enabled = weatherStageHasWork(layerCount, visibilityMeters, refs.frame.current !== null)
}

function setFrame(refs: StageRefs, frame: EnuFrame | null): void {
  refs.frame.current = frame
  syncStageEnabled(refs)
}

/**
 * Builds the cloud and composite passes. Cesium reads uniforms only while the
 * stage is enabled, and `syncStageEnabled` enables it only with a frame, so
 * the uniform callbacks can count on one.
 *
 * @param startMs - Time the cloud drift counts from; kept for the viewer's lifetime so the drift does not snap back
 */
function createStage(viewer: Cesium.Viewer, refs: StageRefs, startMs: number): Cesium.PostProcessStageComposite {
  const { frame: frameRef, inputs: inputsRef } = refs
  const scratchCam = new Cesium.Cartesian3()
  const quality = WEATHER_STAGE_QUALITY
  const layerUniform = (index: number) => () => inputsRef.current.layers[index]
  const frame = (): EnuFrame => {
    if (!frameRef.current) {
      throw new Error('[WeatherStage] Stage drawn without a frame; syncStageEnabled should have disabled it')
    }
    return frameRef.current
  }

  const shared = {
    // The deck shift is added to the camera, which moves the whole field (noise included) relative to it.
    u_camPosEnu: () => {
      const current = frame()
      Cesium.Matrix4.multiplyByPoint(current.fixedToEnu, viewer.camera.positionWC, scratchCam)
      scratchCam.z += currentShift(current)
      return scratchCam
    },
    u_ecefToEnu: () => frame().ecefToEnuRotation,
    u_visibility: () => inputsRef.current.visibilityMeters,
    u_fogExtinction: () => quality.fogExtinction,
    u_fogHeightScale: () => quality.fogHeightScale,
  }

  const clouds = new Cesium.PostProcessStage({
    name: CLOUD_PASS_NAME,
    fragmentShader: CLOUD_STAGE_FS,
    textureScale: Cesium.Math.clamp(quality.resolutionScale, 0.25, 1),
    uniforms: {
      ...shared,
      u_layer0: layerUniform(0),
      u_layer1: layerUniform(1),
      u_layer2: layerUniform(2),
      u_layer3: layerUniform(3),
      u_layerCount: () => inputsRef.current.layerCount,
      u_steps: () => Cesium.Math.clamp(Math.round(quality.steps), 4, 128),
      u_densityScale: () => quality.densityScale,
      u_radius: () => quality.radius,
      u_time: () => (performance.now() - startMs) / 1000,
      u_noiseOffset: () => frame().noiseOffset,
    },
  })

  const composite = new Cesium.PostProcessStage({
    name: COMPOSITE_PASS_NAME,
    fragmentShader: WEATHER_COMPOSITE_FS,
    uniforms: { ...shared, cloudTexture: CLOUD_PASS_NAME },
  })

  return new Cesium.PostProcessStageComposite({
    name: WEATHER_STAGE_NAME,
    stages: [clouds, composite],
    inputPreviousStageTexture: false,
  })
}

/** What the anchor follows; read every WEATHER_STAGE_REANCHOR_CHECK_MS */
interface ReferenceInputs {
  airportIcao: string | null
  refLat: number | null
  refLon: number | null
  airportElevationM: number | null
  followedCallsign: string | null
  interpolatedAircraft: ReadonlyMap<string, { interpolatedLatitude: number; interpolatedLongitude: number }>
}

function currentReference(input: ReferenceInputs): WeatherReference {
  if (!input.airportIcao && input.followedCallsign) {
    const aircraft = input.interpolatedAircraft.get(input.followedCallsign)
    if (aircraft) {
      return { airportIcao: null, lat: aircraft.interpolatedLatitude, lon: aircraft.interpolatedLongitude }
    }
  }
  return {
    airportIcao: input.airportIcao,
    lat: input.refLat,
    lon: input.refLon,
    groundHintM: input.airportIcao ? input.airportElevationM : null,
  }
}

/**
 * The stage's anchor from `nextWeatherAnchor`: re-checked when the reference
 * inputs change, and every WEATHER_STAGE_REANCHOR_CHECK_MS, since a followed
 * aircraft moves without re-rendering the viewer.
 */
function useWeatherAnchor(viewer: Cesium.Viewer | null, reference: ReferenceInputs): WeatherAnchor | null {
  const { airportIcao, refLat, refLon, airportElevationM, followedCallsign, interpolatedAircraft } = reference
  const referenceRef = useRef<ReferenceInputs>(reference)
  referenceRef.current = reference
  const [anchor, setAnchor] = useState<WeatherAnchor | null>(null)

  useEffect(() => {
    const next = currentReference({
      airportIcao,
      refLat,
      refLon,
      airportElevationM,
      followedCallsign,
      interpolatedAircraft,
    })
    setAnchor((previous) => nextWeatherAnchor(previous, next))
  }, [airportIcao, refLat, refLon, airportElevationM, followedCallsign, interpolatedAircraft])

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return
    let lastCheckMs = 0
    return viewer.scene.preRender.addEventListener(() => {
      const now = performance.now()
      if (now - lastCheckMs < WEATHER_STAGE_REANCHOR_CHECK_MS) return
      lastCheckMs = now
      const next = currentReference(referenceRef.current)
      setAnchor((previous) => nextWeatherAnchor(previous, next))
    })
  }, [viewer])

  return anchor
}

/**
 * Keeps the stage's frame on the ground under the anchor: a placeholder ground
 * (see `anchorGround`) at once, then the terrain sample, taken again when the
 * terrain provider changes. A sample that fails or comes back without a
 * height is retried every WEATHER_STAGE_REANCHOR_CHECK_MS until one succeeds.
 * Clears the frame while the stage is off or there is no anchor.
 */
function useWeatherStageFrame(
  viewer: Cesium.Viewer | null,
  anchor: WeatherAnchor | null,
  stageOn: boolean,
  refs: StageRefs,
): void {
  const noiseOriginRef = useRef<NoiseOrigin | null>(null)
  const retryPendingRef = useRef(false)
  const [terrainVersion, setTerrainVersion] = useState(0)
  const [sampleAttempt, setSampleAttempt] = useState(0)

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return
    const removeTerrainListener = viewer.scene.terrainProviderChanged.addEventListener(() =>
      setTerrainVersion((version) => version + 1),
    )
    let lastCheckMs = 0
    const removeRetry = viewer.scene.preRender.addEventListener(() => {
      const now = performance.now()
      if (!retryPendingRef.current || now - lastCheckMs < WEATHER_STAGE_REANCHOR_CHECK_MS) return
      lastCheckMs = now
      retryPendingRef.current = false
      setSampleAttempt((attempt) => attempt + 1)
    })
    return () => {
      removeTerrainListener()
      removeRetry()
    }
  }, [viewer])

  // terrainVersion re-runs the sample once the world terrain replaces the bare ellipsoid provider,
  // and sampleAttempt re-runs a sample that failed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    retryPendingRef.current = false
    if (!viewer || viewer.isDestroyed() || !stageOn || !anchor) {
      setFrame(refs, null)
      return
    }
    let cancelled = false
    const { key, lat, lon, groundHintM } = anchor
    const ellipsoidProvider = viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider
    const applyGround = (sampledM: number | undefined): FrameGround => {
      const previous = refs.frame.current
      const ground = anchorGround({
        key,
        sampledM,
        ellipsoidProvider,
        hintM: groundHintM,
        previous: previous?.ground ?? null,
        moved: previous?.anchor !== anchor,
      })
      const kept = noiseOriginRef.current
      const origin =
        kept && !noiseOriginNeedsReset(kept, anchor)
          ? kept
          : { key, lat, lon, point: Cesium.Cartesian3.fromDegrees(lon, lat, ground.groundM) }
      noiseOriginRef.current = origin
      setFrame(refs, buildEnuFrame(anchor, ground, previous, origin))
      return ground
    }
    if (refs.frame.current?.anchor !== anchor) {
      applyGround(undefined)
    }
    if (ellipsoidProvider) {
      return
    }
    Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [Cesium.Cartographic.fromDegrees(lon, lat)])
      .then(([sample]) => {
        if (cancelled || viewer.isDestroyed()) return
        // The sample can come back without a height; the loaded globe tile is the next best source.
        const ground = applyGround(sample.height ?? viewer.scene.globe.getHeight(sample))
        retryPendingRef.current = !ground.sampled
        const source = ground.sampled ? 'sampled' : 'placeholder, retrying'
        console.log(`[WeatherStage] Anchored on ${key} at ${lat}, ${lon}, ground ${ground.groundM} m (${source})`)
      })
      .catch((error) => {
        if (cancelled) return
        retryPendingRef.current = true
        console.warn(
          `[WeatherStage] Terrain sample at ${lat}, ${lon} failed; keeping ground ${refs.frame.current?.ground.groundM} m and retrying:`,
          error,
        )
      })
    return () => {
      cancelled = true
    }
  }, [viewer, anchor, stageOn, terrainVersion, sampleAttempt, refs])
}

/**
 * Adds the stage to the scene while it is on, and keeps it last among the
 * scene's post-process stages: stages added later (the silhouette stage is
 * added a few frames after the viewer) would draw over the clouds and fog.
 * Removing destroys a stage, so a fresh one is added at the end. The cloud
 * drift start time is held for the viewer's lifetime, so neither re-creation
 * nor the stage going off and on snaps the drift back.
 */
function useWeatherStageComposite(viewer: Cesium.Viewer | null, stageOn: boolean, refs: StageRefs): void {
  const startMsRef = useRef<{ viewer: Cesium.Viewer; startMs: number } | null>(null)

  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !stageOn) return
    if (startMsRef.current?.viewer !== viewer) {
      startMsRef.current = { viewer, startMs: performance.now() }
    }
    const { startMs } = startMsRef.current
    const stages = viewer.scene.postProcessStages
    const addStage = () => {
      refs.stage.current = stages.add(createStage(viewer, refs, startMs)) as Cesium.PostProcessStageComposite
      syncStageEnabled(refs)
    }
    addStage()
    const keepLast = viewer.scene.preRender.addEventListener(() => {
      const current = refs.stage.current
      if (!current || stages.get(stages.length - 1) === current) return
      stages.remove(current)
      addStage()
    })
    return () => {
      keepLast()
      if (refs.stage.current && !viewer.isDestroyed()) {
        stages.remove(refs.stage.current)
      }
      refs.stage.current = null
    }
  }, [viewer, stageOn, refs])
}

/** Inputs of `useCesiumWeatherStages` from the viewer component */
export interface WeatherStagesOptions extends ReferenceInputs {
  viewMode: ViewMode
}

/**
 * Draws METAR cloud layers and visibility fog as one Cesium post-process
 * composite that stops every ray at the scene depth, so aircraft, buildings and
 * terrain in front of a cloud or fog hide it.
 *
 * Reads `weatherStore` (cloud layers; METAR visibility, or the interpolated
 * visibility while weather interpolation is on) and the weather settings:
 * `showClouds` gates the clouds, `showBabylonFog` the fog and `visibilityScale`
 * scales the fog visibility, under `showWeatherEffects`. Draws nothing in the
 * top-down view or while `weatherStageStore.renderer` is `'babylon'`, and is
 * disabled while there is no anchor or nothing to draw. Without a logarithmic
 * depth buffer on the scene the stage stays out (the Babylon overlay draws
 * instead) and one warning is logged. The stage is kept last among the scene's
 * post-process stages, so the aircraft silhouette outlines are fogged and
 * clouded too.
 *
 * The east-north-up frame sits on the ground under the anchor from
 * `nextWeatherAnchor`, checked every WEATHER_STAGE_REANCHOR_CHECK_MS: keyed on
 * the airport, or following an aircraft in orbit mode without one. A
 * placeholder ground (the airport elevation) holds until the terrain is
 * sampled (a failed sample is retried), and the terrain is resampled when its provider changes; changes
 * between two sampled grounds blend over WEATHER_STAGE_GROUND_BLEND_MS, and
 * the cloud noise stays fixed horizontally in the world when the anchor moves,
 * re-centred once the anchor is WEATHER_STAGE_NOISE_ORIGIN_RESET_M from its origin.
 *
 * @param viewer - Cesium viewer of this viewport (main or inset)
 * @param options - Reference position inputs and view mode of this viewport
 */
export function useCesiumWeatherStages(viewer: Cesium.Viewer | null, options: WeatherStagesOptions): void {
  const renderer = useWeatherStageStore((state) => state.renderer)
  const showWeatherEffects = useSettingsStore((state) => state.weather.showWeatherEffects)
  const showClouds = useSettingsStore((state) => state.weather.showClouds)
  const showBabylonFog = useSettingsStore((state) => state.weather.showBabylonFog)
  const visibilityScale = useSettingsStore((state) => state.weather.visibilityScale)
  const cloudLayers = useWeatherStore((state) => state.cloudLayers)
  const metarSM = useWeatherStore((state) => state.currentMetar?.visib)
  const useInterpolation = useWeatherStore((state) => state.useInterpolation)
  const interpolatedSM = useWeatherStore((state) => state.interpolatedWeather?.visibility)

  // The scene's flag is fixed when the viewer is created; it is false without fragmentDepth too.
  const logDepth = viewer && !viewer.isDestroyed() ? viewer.scene.logarithmicDepthBuffer : true
  const viewMode = options.viewMode
  const gates = weatherStageGates({ renderer, showWeatherEffects, showClouds, showBabylonFog, viewMode, logDepth })

  const refs = useRef<StageRefs>({
    frame: { current: null },
    inputs: { current: NO_INPUTS },
    stage: { current: null },
  }).current
  const warnedLogDepthRef = useRef(false)
  const anchor = useWeatherAnchor(viewer, options)

  useEffect(() => {
    const layers = gates.clouds ? buildCloudLayerUniforms(cloudLayers, CLOUD_THICKNESS_BY_TYPE_M) : []
    const visibSM = effectiveVisibilitySM({ metarSM, useInterpolation, interpolatedSM })
    refs.inputs.current = {
      layers: NO_INPUTS.layers.map((inactive, index) => {
        const layer = layers[index]
        return layer ? new Cesium.Cartesian4(layer.base, layer.thickness, layer.coverage, 1) : inactive
      }),
      layerCount: layers.length,
      visibilityMeters: gates.fog ? stageVisibilityMeters(visibSM, visibilityScale) : 0,
    }
    syncStageEnabled(refs)
  }, [gates.clouds, gates.fog, cloudLayers, metarSM, useInterpolation, interpolatedSM, visibilityScale, refs])

  useEffect(() => {
    if (!gates.missingLogDepth || warnedLogDepthRef.current) return
    warnedLogDepthRef.current = true
    console.warn(
      '[WeatherStage] This view has no logarithmic depth buffer, so the Babylon overlay draws clouds and fog ' +
        'instead of the Cesium stage.',
    )
  }, [gates.missingLogDepth])

  useWeatherStageFrame(viewer, anchor, gates.stage, refs)
  useWeatherStageComposite(viewer, gates.stage, refs)
}

/**
 * Dev-only drive aids for the stage: a fixed camera pose and a fixed test
 * aircraft from `weatherStageStore`, so occlusion cases can be framed without
 * live traffic or the app's camera modes. Set from `window.__tc3d.weatherStage`.
 *
 * Mount after `useCesiumCamera`, so the override's `preRender` listener runs
 * after the app's and its pose wins each frame.
 *
 * @param viewer - Main viewport's Cesium viewer, or null to do nothing
 */
export function useWeatherStageDriveAids(viewer: Cesium.Viewer | null): void {
  const cameraOverride = useWeatherStageStore((state) => state.cameraOverride)
  const testAircraft = useWeatherStageStore((state) => state.testAircraft)

  useEffect(() => {
    if (!import.meta.env.DEV || !viewer || viewer.isDestroyed() || !cameraOverride) return
    const { lat, lon, heightM, heading, pitch } = cameraOverride
    const destination = Cesium.Cartesian3.fromDegrees(lon, lat, heightM)
    const orientation = { heading: Cesium.Math.toRadians(heading), pitch: Cesium.Math.toRadians(pitch), roll: 0 }
    return viewer.scene.preRender.addEventListener(() => {
      viewer.camera.setView({ destination, orientation })
    })
  }, [viewer, cameraOverride])

  useEffect(() => {
    if (!import.meta.env.DEV || !viewer || viewer.isDestroyed() || !testAircraft) return
    let model: Cesium.Model | null = null
    let cancelled = false
    const position = Cesium.Cartesian3.fromDegrees(testAircraft.lon, testAircraft.lat, testAircraft.heightM)
    const hpr = new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(testAircraft.heading), 0, 0)
    Cesium.Model.fromGltfAsync({
      url: './b738.glb',
      modelMatrix: Cesium.Transforms.headingPitchRollToFixedFrame(position, hpr),
    })
      .then((loaded) => {
        if (cancelled || viewer.isDestroyed()) {
          loaded.destroy()
          return
        }
        model = viewer.scene.primitives.add(loaded) as Cesium.Model
      })
      .catch((error) => console.error('[WeatherStage] Test aircraft failed to load:', error))
    return () => {
      cancelled = true
      if (model && !viewer.isDestroyed()) {
        viewer.scene.primitives.remove(model)
      }
    }
  }, [viewer, testAircraft])
}
