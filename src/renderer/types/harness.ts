/**
 * Types for the dev-only agent test harness exposed on `window.__tc3d`.
 *
 * The harness gives agent-driven tests a handle on the running app's Cesium
 * viewer, Babylon overlay and a few Zustand stores, so a test can read camera
 * state, aim the camera, project a coordinate to a screen point, read back
 * rendered pixels and read frame timings. It is installed by `useAgentHarness`
 * and only exists in dev builds; production bundles drop it.
 *
 * @see useAgentHarness - Hook that installs the global
 */

import type * as BABYLON from '@babylonjs/core'
import type * as Cesium from 'cesium'
import type { useSettingsStore } from '../stores/settingsStore'
import type { useViewportStore } from '../stores/viewportStore'
import type { useWeatherStore } from '../stores/weatherStore'
import type { FollowMode } from './camera'
import type { PerformanceMetrics } from './performance'

/** Median and p95 of one per-frame series, in milliseconds. */
export interface PercentileStat {
  median: number
  p95: number
}

/** One frame's CPU-side timing sample, as held by the frame window. */
export interface FrameSample {
  /** Start-to-start interval of this frame (true frame period) */
  frameInterval: number
  /** Time the monitor's work took inside this frame */
  totalFrame: number
  /** Cesium scene update phase */
  cesiumUpdate: number
  /** Cesium render phase */
  cesiumDraw: number
  /** Babylon overlay render */
  babylonRender: number
}

/** Median and p95 of the CPU-side series of the frames held. */
export interface FrameTimingSummary {
  frameInterval: PercentileStat | null
  totalFrame: PercentileStat | null
  cesiumUpdate: PercentileStat | null
  cesiumDraw: PercentileStat | null
  babylonRender: PercentileStat | null
}

/** The frame window's summary: every CPU-side series, plus how many rows it holds. */
export interface FrameRowSummary extends FrameTimingSummary {
  /** Rows held, at most the window's capacity */
  frames: number
}

/**
 * Everything `perf().window` reports: the frame rows plus the GPU series.
 *
 * A series with no samples is null. The GPU series hold one sample per GPU timer
 * result, so they are null until the first result arrives, and never carry a
 * sentinel for an unsupported or broken timer.
 */
export interface FrameWindowSummary extends FrameRowSummary {
  gpuCesiumMs: PercentileStat | null
  gpuBabylonMs: PercentileStat | null
}

/**
 * Dev-only handle on the running app, assigned to `window.__tc3d` in dev builds.
 *
 * @example
 * // Read the current camera, then aim it from the DevTools console
 * const tc3d = window.__tc3d
 * console.log(tc3d.camera.get())
 * tc3d.camera.set({ heading: 90, fov: 45 })
 */
export interface AgentHarness {
  /** Cesium viewer of the main viewport */
  viewer: Cesium.Viewer

  /** Babylon overlay engine and scene (either may be null before the scene exists) */
  babylon: {
    engine: BABYLON.Engine | null
    scene: BABYLON.Scene | null
  }

  /** The Zustand store hooks themselves, for `.getState()` / `.setState()` */
  stores: {
    viewport: typeof useViewportStore
    weather: typeof useWeatherStore
    settings: typeof useSettingsStore
  }

  /** Camera control for the active viewport */
  camera: {
    /** Camera fields of the active viewport */
    get: () => {
      heading: number
      pitch: number
      fov: number
      followMode: FollowMode
      followingCallsign: string | null
    }
    /** Sets the given camera fields on the active viewport; omitted fields are left alone */
    set: (update: { heading?: number; pitch?: number; fov?: number }) => void
  }

  /** Aims the active viewport's camera at a geographic position */
  lookAt: (lat: number, lon: number, altitudeFt: number) => void

  /**
   * Projects a geographic position to a page CSS-pixel point.
   *
   * @returns The point, or null when the position is not visible (near the
   * ellipsoid center)
   */
  project: (lat: number, lon: number, heightM: number) => { x: number; y: number } | null

  /**
   * Reads back RGBA pixels from the Babylon canvas.
   *
   * @param x - Left edge of the page CSS-pixel rectangle
   * @param y - Top edge of the page CSS-pixel rectangle
   * @param width - Rectangle width in CSS pixels
   * @param height - Rectangle height in CSS pixels
   * @returns RGBA bytes in Babylon's bottom-left origin order
   */
  readPixels: (x: number, y: number, width: number, height: number) => Promise<Uint8Array>

  /**
   * Frame timings of the main viewport's Cesium loop.
   *
   * @returns `current`, the last completed frame's metrics, and `window`, the
   * median and p95 of the last 300 frames' timing series
   */
  perf: () => { current: PerformanceMetrics; window: FrameWindowSummary }
}

declare global {
  interface Window {
    /** Dev-only agent test harness, present only in dev builds */
    __tc3d?: AgentHarness
  }
}
