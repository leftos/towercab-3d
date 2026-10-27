import * as Cesium from 'cesium'
import { type RefObject, useEffect, useRef } from 'react'
import type { useBabylonOverlay } from '@/hooks/useBabylonOverlay'
import { useSettingsStore } from '@/stores/settingsStore'
import type { Airport } from '@/types'
import type { FollowMode } from '@/types/camera'
import { GpuFrameTimer, getRendererInfo, NO_GPU_RESULTS } from '@/utils/gpuTimer'
import { performanceMonitor } from '@/utils/performanceMonitor'
import { hasViewingContext, isOrbitWithoutAirport } from '@/utils/viewingContext'

/** The parts of the Babylon overlay the frame listeners drive. */
export type FrameOverlay = Pick<ReturnType<typeof useBabylonOverlay>, 'engine' | 'syncCamera' | 'render'>

interface GeoPosition {
  lat: number
  lon: number
}

/** Everything the frame listeners read from the viewer component. */
export interface FrameListenersOptions {
  babylonOverlay: FrameOverlay
  showWeatherEffects: boolean
  enableWeatherInterpolation: boolean
  enableAutoAirportSwitch: boolean
  followMode: FollowMode
  followingCallsign: string | null
  currentAirport: Airport | null
  updateCameraPosition: (lat: number, lon: number) => void
  setCameraGeoPosition: (position: GeoPosition) => void
  isInset: boolean
}

/**
 * GPU timer queries measure real GPU execution time, which the JS-side phase timers miss:
 * a GPU-bound frame submits its draw calls quickly (small "Draw" time) but the GPU spends
 * far longer executing them, and that cost otherwise hides inside "Idle/VSync". Main viewport
 * only — insets render on their own context and RAF loop.
 */
interface GpuTimers {
  cesium: GpuFrameTimer | null
  cesiumResults: readonly number[]
  babylon: GpuFrameTimer | null
  /** The context `babylon` was built on, so a new overlay engine gets a new timer. */
  babylonGl: WebGL2RenderingContext | null
  babylonResults: readonly number[]
  rendererLogged: boolean
}

/** Camera moves smaller than this (~100 m) are not sent to React state, which would re-render every frame. */
const POSITION_THRESHOLD_DEG = 0.001

function asWebGl2(gl: unknown): WebGL2RenderingContext | null {
  return gl instanceof WebGL2RenderingContext ? gl : null
}

function cesiumGl(viewer: Cesium.Viewer): WebGL2RenderingContext | null {
  return asWebGl2((viewer.scene as unknown as { context?: { _gl?: unknown } }).context?._gl)
}

function babylonGl(overlay: FrameOverlay): WebGL2RenderingContext | null {
  const engine = overlay.engine
  return asWebGl2(engine ? (engine as unknown as { _gl?: unknown })._gl : null)
}

/** Logs the Cesium renderer once per viewer, when its GPU timer is first built. */
function logRenderer(gl: WebGL2RenderingContext, timer: GpuFrameTimer): void {
  const info = getRendererInfo(gl)
  performanceMonitor.setRendererInfo(info.renderer)
  // Non-reactive read: this value is for the diagnostic log only and must not
  // re-initialize the render listeners when the user changes the setting.
  const cappedFps = useSettingsStore.getState().graphics.maxFramerate
  console.log(
    `[GPU] Cesium renderer="${info.renderer}" vendor="${info.vendor}" webgl2=${info.isWebgl2} timerQuery=${timer.isSupported} maxFramerate=${cappedFps}`,
  )
}

/** Builds the Cesium GPU timer once its context exists, reads back finished results and opens this frame's query. */
function beginCesiumGpuFrame(timers: GpuTimers, viewer: Cesium.Viewer): void {
  if (!timers.cesium) {
    const gl = cesiumGl(viewer)
    if (gl) {
      timers.cesium = new GpuFrameTimer(gl)
      if (!timers.rendererLogged) {
        logRenderer(gl, timers.cesium)
        timers.rendererLogged = true
      }
    }
  }
  timers.cesiumResults = timers.cesium?.poll() ?? NO_GPU_RESULTS
  timers.cesium?.begin()
}

/** Builds the Babylon GPU timer on the overlay's current context, replacing one built on an older context. */
function refreshBabylonGpuTimer(timers: GpuTimers, overlay: FrameOverlay): void {
  const gl = babylonGl(overlay)
  if (!gl || gl === timers.babylonGl) return
  timers.babylon?.dispose()
  timers.babylon = new GpuFrameTimer(gl)
  timers.babylonGl = gl
}

/** Publishes the latest GPU timings and this frame's read-back samples to the performance monitor. */
function publishGpuTimings(timers: GpuTimers): void {
  const cesiumMs = timers.cesium?.isSupported ? timers.cesium.gpuMs : -1
  const babylonMs = timers.babylon?.isSupported ? timers.babylon.gpuMs : -1
  performanceMonitor.setGpuTimings(cesiumMs, babylonMs, cesiumMs >= 0 || babylonMs >= 0)
  performanceMonitor.pushGpuSamples(timers.cesiumResults, timers.babylonResults)
}

/** Records Cesium's render time and scene statistics. */
function recordSceneStats(viewer: Cesium.Viewer): void {
  const primitiveCount = viewer.scene.primitives.length
  const globe = viewer.scene.globe
  // Access tile loading stats via internal surface (may not be available in all Cesium versions)
  const surface = (globe as unknown as { _surface?: { tileProvider?: { _tilesToRenderByTextureCount?: unknown[] } } })
    ._surface
  const tilesLoaded = surface?.tileProvider?._tilesToRenderByTextureCount?.length ?? 0
  const tilesLoading = (globe as unknown as { _tilesLoading?: number })._tilesLoading ?? 0
  performanceMonitor.markCesiumPostRender(primitiveCount, tilesLoaded, tilesLoading)
}

/**
 * Whether the camera position is needed: for camera-based weather interpolation, for the
 * nearest-METAR mode while orbiting without an airport, or for auto-airport switching.
 */
function shouldTrackCamera(options: FrameListenersOptions): boolean {
  const { showWeatherEffects, currentAirport, followMode, followingCallsign } = options
  return (
    (showWeatherEffects && options.enableWeatherInterpolation) ||
    (showWeatherEffects && isOrbitWithoutAirport(currentAirport, followMode, followingCallsign)) ||
    options.enableAutoAirportSwitch
  )
}

function movedPastThreshold(lastSent: GeoPosition | null, lat: number, lon: number): boolean {
  return (
    !lastSent ||
    Math.abs(lat - lastSent.lat) > POSITION_THRESHOLD_DEG ||
    Math.abs(lon - lastSent.lon) > POSITION_THRESHOLD_DEG
  )
}

/**
 * Sends the camera position to the auto-airport switch (once it has moved ~100 m from the last
 * position sent) and to the weather store (every frame, which throttles on its own).
 */
function trackCameraPosition(
  viewer: Cesium.Viewer,
  options: FrameListenersOptions,
  lastSentPositionRef: RefObject<GeoPosition | null>,
): void {
  if (!shouldTrackCamera(options)) return
  const cameraCartographic = viewer.camera.positionCartographic
  if (!cameraCartographic) return

  const lat = Cesium.Math.toDegrees(cameraCartographic.latitude)
  const lon = Cesium.Math.toDegrees(cameraCartographic.longitude)
  if (movedPastThreshold(lastSentPositionRef.current, lat, lon)) {
    lastSentPositionRef.current = { lat, lon }
    options.setCameraGeoPosition({ lat, lon })
  }

  // Only fetch weather when viewing a specific location (not globe from space)
  const { currentAirport, followMode, followingCallsign } = options
  if (options.showWeatherEffects && hasViewingContext(currentAirport, followMode, followingCallsign)) {
    options.updateCameraPosition(lat, lon)
  }
}

/**
 * Attaches the per-frame Cesium scene listeners: performance phase marks, GPU timers, the Babylon
 * overlay's camera sync and render, and camera-position tracking for weather and auto-switching.
 *
 * The listeners attach once per viewer and read every other option through a ref refreshed on each
 * render, so a re-render (a new overlay object, a camera-position write) never re-attaches them.
 *
 * @param viewer - The Cesium viewer, or null before it exists.
 * @param options - The overlay, settings and view state the listeners read.
 */
export function useFrameListeners(viewer: Cesium.Viewer | null, options: FrameListenersOptions): void {
  const { isInset } = options
  const latestRef = useRef(options)
  latestRef.current = options
  // The last position handed to setCameraGeoPosition, which the ~100 m threshold compares against.
  const lastSentPositionRef = useRef<GeoPosition | null>(null)

  // Sync Babylon overlay and update aircraft on each render frame
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return

    const timers: GpuTimers = {
      cesium: null,
      cesiumResults: NO_GPU_RESULTS,
      babylon: null,
      babylonGl: null,
      babylonResults: NO_GPU_RESULTS,
      rendererLogged: false,
    }

    // Track Cesium update phase (scene graph updates, culling, animations)
    const removePreUpdate = viewer.scene.preUpdate.addEventListener(() => {
      performanceMonitor.startFrame()
      performanceMonitor.markCesiumPreUpdate()
    })

    const removePostUpdate = viewer.scene.postUpdate.addEventListener(() => {
      performanceMonitor.markCesiumPostUpdate()
    })

    // Track Cesium render/draw phase (actual GPU drawing)
    const removePreRender = viewer.scene.preRender.addEventListener(() => {
      performanceMonitor.markCesiumPreRender()
      if (!isInset) beginCesiumGpuFrame(timers, viewer)
    })

    // Update aircraft and sync Babylon overlay AFTER render when camera position is finalized
    // This runs every frame (~60fps) to ensure smooth interpolated aircraft movement
    const removePostRender = viewer.scene.postRender.addEventListener(() => {
      recordSceneStats(viewer)
      // Close the Cesium GPU timer query opened in preRender.
      timers.cesium?.end()

      const latest = latestRef.current
      performanceMonitor.startTimer('babylonSync')
      latest.babylonOverlay.syncCamera()
      performanceMonitor.endTimer('babylonSync')

      if (!isInset) refreshBabylonGpuTimer(timers, latest.babylonOverlay)
      performanceMonitor.startTimer('babylonRender')
      timers.babylonResults = timers.babylon?.poll() ?? NO_GPU_RESULTS
      timers.babylon?.begin()
      latest.babylonOverlay.render()
      timers.babylon?.end()
      performanceMonitor.endTimer('babylonRender')

      if (!isInset) publishGpuTimings(timers)
      trackCameraPosition(viewer, latest, lastSentPositionRef)
      performanceMonitor.endFrame()
    })

    return () => {
      removePreUpdate()
      removePostUpdate()
      removePreRender()
      removePostRender()
      timers.cesium?.dispose()
      timers.babylon?.dispose()
    }
  }, [viewer, isInset])
}
