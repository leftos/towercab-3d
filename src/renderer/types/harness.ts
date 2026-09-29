/**
 * Types for the dev-only agent test harness exposed on `window.__tc3d`.
 *
 * The harness gives agent-driven tests a handle on the running app's Cesium
 * viewer, Babylon overlay and a few Zustand stores, so a test can read camera
 * state, aim the camera, project a coordinate to a screen point and read back
 * rendered pixels. It is installed by `useAgentHarness` and only exists in dev
 * builds; production bundles drop it.
 *
 * @see useAgentHarness - Hook that installs the global
 */

import type * as BABYLON from '@babylonjs/core'
import type * as Cesium from 'cesium'
import type { useSettingsStore } from '../stores/settingsStore'
import type { useViewportStore } from '../stores/viewportStore'
import type { useWeatherStore } from '../stores/weatherStore'
import type { FollowMode } from './camera'

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
}

declare global {
  interface Window {
    /** Dev-only agent test harness, present only in dev builds */
    __tc3d?: AgentHarness
  }
}
