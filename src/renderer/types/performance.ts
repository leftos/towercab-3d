/**
 * Types for the performance monitor's per-frame measurements.
 *
 * These live apart from `utils/performanceMonitor` so the harness types can name
 * them without importing the monitor (which imports the types barrel).
 */

/** Per-frame timings and derived rates for the main viewport, as the HUD reports them. */
export interface PerformanceMetrics {
  interpolation: number
  aircraftUpdate: number
  babylonSync: number
  babylonRender: number
  /** Total Cesium time (update + render) */
  cesiumRender: number
  /** Cesium scene update phase (animations, transforms, culling) */
  cesiumUpdate: number
  /** Cesium actual render phase (GPU draw calls) */
  cesiumDraw: number
  cesiumPrimitives: number
  cesiumTilesLoaded: number
  cesiumTilesLoading: number
  totalFrame: number
  fps: number
  frameInterval: number
  /** Time between our work ending and next frame starting (browser/GPU/VSync wait) */
  idleTime: number
  /** Time not accounted for by individual timers (overhead, unmeasured work) */
  unaccountedTime: number
  /** Real GPU execution time of the Cesium scene draw (ms), via timer query. -1 if unsupported. */
  gpuCesiumMs: number
  /** Real GPU execution time of the Babylon overlay render (ms), via timer query. -1 if unsupported. */
  gpuBabylonMs: number
  /** Whether GPU timer queries are available on this hardware/context. */
  gpuSupported: boolean
  /** Main-thread blocking (longtasks) observed in the gap between frames (ms). */
  blockedJsMs: number
  /** Unmasked GPU/driver string for the main Cesium context (empty until known). */
  gpuRenderer: string
}
