import type * as BABYLON from '@babylonjs/core'
import * as Cesium from 'cesium'
import { useEffect } from 'react'
import type { AgentHarness } from '@/types'
import { useSettingsStore } from '../stores/settingsStore'
import { useViewportStore } from '../stores/viewportStore'
import { useWeatherStore } from '../stores/weatherStore'

/**
 * Installs the dev-only `window.__tc3d` agent test harness.
 *
 * The global exposes the Cesium viewer, the Babylon overlay engine and scene,
 * and the viewport/weather/settings store hooks, plus `camera`, `lookAt`,
 * `project` and `readPixels` helpers. Agent-driven tests use it to inspect and
 * drive the running app through the `tauri-app` and `playwright` MCP servers.
 *
 * The whole body sits behind `import.meta.env.DEV`, so Vite drops it from
 * production bundles.
 *
 * @param viewer - Cesium viewer of the main viewport, or null before it exists
 * @param babylon - Babylon overlay engine and scene (either may be null)
 */
export function useAgentHarness(
  viewer: Cesium.Viewer | null,
  babylon: { engine: BABYLON.Engine | null; scene: BABYLON.Scene | null },
): void {
  const { engine, scene } = babylon

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return

    if (import.meta.env.DEV) {
      const harness: AgentHarness = {
        viewer,
        babylon: { engine, scene },
        stores: {
          viewport: useViewportStore,
          weather: useWeatherStore,
          settings: useSettingsStore,
        },
        camera: {
          get: () => {
            const { heading, pitch, fov, followMode, followingCallsign } = useViewportStore
              .getState()
              .getActiveCameraState()
            return { heading, pitch, fov, followMode, followingCallsign }
          },
          set: ({ heading, pitch, fov }) => {
            const { setHeading, setPitch, setFov } = useViewportStore.getState()
            if (heading !== undefined) setHeading(heading)
            if (pitch !== undefined) setPitch(pitch)
            if (fov !== undefined) setFov(fov)
          },
        },
        lookAt: (lat, lon, altitudeFt) => {
          useViewportStore.getState().lookAtPosition(lat, lon, altitudeFt)
        },
        project: (lat, lon, heightM) => {
          const position = Cesium.Cartesian3.fromDegrees(lon, lat, heightM)
          // Returns CSS pixels relative to the top-left of the Cesium canvas.
          const windowPosition = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, position)
          if (!windowPosition) return null
          const rect = viewer.canvas.getBoundingClientRect()
          return { x: windowPosition.x + rect.left, y: windowPosition.y + rect.top }
        },
        readPixels: async (x, y, width, height) => {
          const canvas = engine?.getRenderingCanvas() ?? null
          if (!engine || !canvas) {
            throw new Error('TowerCab agent harness: Babylon engine or canvas is not available')
          }
          // Backing-store ratio: the engine sizes the canvas, so this may differ
          // from window.devicePixelRatio.
          const rect = canvas.getBoundingClientRect()
          const ratio = canvas.width / canvas.clientWidth
          const px = Math.round((x - rect.left) * ratio)
          const py = Math.round(canvas.height - (y - rect.top + height) * ratio)
          const w = Math.round(width * ratio)
          const h = Math.round(height * ratio)
          const data = await engine.readPixels(px, py, w, h, true, false)
          return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        },
      }

      window.__tc3d = harness

      return () => {
        if (window.__tc3d === harness) delete window.__tc3d
      }
    }
  }, [viewer, engine, scene])
}
