import type * as BABYLON from '@babylonjs/core'
import * as Cesium from 'cesium'
import { useEffect } from 'react'
import { WEATHER_STAGE_NAME } from '@/hooks/useCesiumWeatherStages'
import { useWeatherStageStore } from '@/stores/weatherStageStore'
import type { AgentHarness, TowerModelHandle } from '@/types'
import { performanceMonitor } from '@/utils/performanceMonitor'
import { useSettingsStore } from '../stores/settingsStore'
import { useViewportStore } from '../stores/viewportStore'
import { useWeatherStore } from '../stores/weatherStore'

/**
 * Installs the dev-only `window.__tc3d` agent test harness.
 *
 * The global exposes the Cesium viewer, the Babylon overlay engine and scene,
 * and the viewport/weather/settings store hooks, plus `camera`, `lookAt`,
 * `project`, `readPixels` and `perf` helpers and the `weatherStage` and `towerModel` handles. Agent-driven tests use it to
 * inspect and drive the running app through the `tauri-app` and `playwright`
 * MCP servers.
 *
 * The whole body sits behind `import.meta.env.DEV`, so Vite drops it from
 * production bundles.
 *
 * @param viewer - Cesium viewer of the main viewport, or null before it exists
 * @param babylon - Babylon overlay engine and scene (either may be null)
 * @param getTowerModel - Getter for the tower cab's state, from `useTowerModel`
 */
export function useAgentHarness(
  viewer: Cesium.Viewer | null,
  babylon: { engine: BABYLON.Engine | null; scene: BABYLON.Scene | null },
  getTowerModel: () => TowerModelHandle,
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
        perf: () => ({
          current: performanceMonitor.getMetrics(),
          window: performanceMonitor.getFrameWindow(),
        }),
        weatherStage: {
          set: ({ camera, testAircraft }) => {
            const state = useWeatherStageStore.getState()
            useWeatherStageStore.setState({
              cameraOverride: camera === undefined ? state.cameraOverride : camera,
              testAircraft: testAircraft === undefined ? state.testAircraft : testAircraft,
            })
          },
          info: () => {
            const stages = viewer.scene.postProcessStages
            const stageNames: string[] = []
            let stage: { enabled: boolean } | null = null
            for (let i = 0; i < stages.length; i++) {
              const current = stages.get(i)
              stageNames.push(current.name)
              if (current.name === WEATHER_STAGE_NAME) stage = current
            }
            return {
              stageInScene: stage !== null,
              stageEnabled: stage?.enabled ?? false,
              stageNames,
              // Scene.numberOfFrustums is a getter Cesium leaves out of its type declarations.
              numberOfFrustums: (viewer.scene as unknown as { numberOfFrustums: number }).numberOfFrustums,
              logDepth: viewer.scene.logarithmicDepthBuffer,
            }
          },
        },
        get towerModel() {
          return getTowerModel()
        },
      }

      window.__tc3d = harness

      return () => {
        if (window.__tc3d === harness) delete window.__tc3d
      }
    }
  }, [viewer, engine, scene, getTowerModel])
}
