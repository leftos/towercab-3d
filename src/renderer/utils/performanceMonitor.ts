/**
 * Performance monitoring utility for tracking frame timing
 * Provides frame-by-frame timing data for performance optimization
 */

import type { FrameWindowSummary, PerformanceMetrics } from '@/types'
import { FrameWindow, NumberWindow } from '@/utils/frameStats'

class PerformanceMonitor {
  private timers: Map<string, number> = new Map()
  private metrics: PerformanceMetrics = {
    interpolation: 0,
    aircraftUpdate: 0,
    babylonSync: 0,
    babylonRender: 0,
    cesiumRender: 0,
    cesiumUpdate: 0,
    cesiumDraw: 0,
    cesiumPrimitives: 0,
    cesiumTilesLoaded: 0,
    cesiumTilesLoading: 0,
    totalFrame: 0,
    fps: 0,
    frameInterval: 0,
    idleTime: 0,
    unaccountedTime: 0,
    gpuCesiumMs: -1,
    gpuBabylonMs: -1,
    gpuSupported: false,
    blockedJsMs: 0,
    gpuRenderer: '',
  }

  // Cesium phase timestamps for detailed timing
  private cesiumPreUpdateTime = 0
  private cesiumPreRenderTime = 0

  private frameStartTime = 0
  private previousFrameStartTime = 0
  private frameTimes: number[] = []
  private idleTimes: number[] = []
  private readonly MAX_FRAME_SAMPLES = 60
  private previousFrameEndTime = 0

  // Per-frame (not averaged) values behind `getFrameWindow()`. Separate from the 60-sample
  // means above, whose fields keep their meaning for the HUD.
  private readonly frameWindow = new FrameWindow()
  private readonly gpuCesiumWindow = new NumberWindow()
  private readonly gpuBabylonWindow = new NumberWindow()
  private lastFrameInterval = 0

  // Longtask attribution: a PerformanceObserver records main-thread tasks >50ms so we can
  // tell how much of the inter-frame "idle" gap is actually JS blocking vs GPU/present wait.
  private longTaskStamps: Array<{ start: number; duration: number }> = []
  private blockedJsTimes: number[] = []

  constructor() {
    this.initLongTaskObserver()
  }

  private initLongTaskObserver(): void {
    if (typeof PerformanceObserver === 'undefined') {
      return
    }
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.longTaskStamps.push({ start: entry.startTime, duration: entry.duration })
        }
        // Cap buffer growth; only the most recent inter-frame window is ever consumed.
        if (this.longTaskStamps.length > 256) {
          this.longTaskStamps.splice(0, this.longTaskStamps.length - 256)
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch (err) {
      // longtask is unsupported in some embedded webviews — degrade silently (blockedJsMs stays 0).
      console.debug('[performanceMonitor] longtask observer unavailable:', err)
    }
  }

  /**
   * Start timing a specific operation
   */
  startTimer(name: string): void {
    this.timers.set(name, performance.now())
  }

  /**
   * End timing and record the duration
   */
  endTimer(name: string): number {
    const start = this.timers.get(name)
    if (start === undefined) return 0

    const duration = performance.now() - start
    this.timers.delete(name)

    // Update metrics
    switch (name) {
      case 'interpolation':
        this.metrics.interpolation = duration
        break
      case 'aircraftUpdate':
        this.metrics.aircraftUpdate = duration
        break
      case 'babylonSync':
        this.metrics.babylonSync = duration
        break
      case 'babylonRender':
        this.metrics.babylonRender = duration
        break
      case 'cesiumRender':
        this.metrics.cesiumRender = duration
        break
    }

    return duration
  }

  /**
   * Called at Cesium scene.preUpdate to start timing Cesium's update phase
   */
  markCesiumPreUpdate(): void {
    this.cesiumPreUpdateTime = performance.now()
  }

  /**
   * Called at Cesium scene.postUpdate to end timing Cesium's update phase
   */
  markCesiumPostUpdate(): void {
    if (this.cesiumPreUpdateTime > 0) {
      this.metrics.cesiumUpdate = performance.now() - this.cesiumPreUpdateTime
    }
  }

  /**
   * Called at Cesium scene.preRender to start timing Cesium's render/draw phase
   */
  markCesiumPreRender(): void {
    this.cesiumPreRenderTime = performance.now()
  }

  /**
   * Called at Cesium scene.postRender to end timing Cesium's render/draw phase
   * Also updates Cesium scene statistics
   */
  markCesiumPostRender(primitiveCount?: number, tilesLoaded?: number, tilesLoading?: number): void {
    const now = performance.now()
    if (this.cesiumPreRenderTime > 0) {
      this.metrics.cesiumDraw = now - this.cesiumPreRenderTime
    }
    // Total Cesium time = update + draw
    this.metrics.cesiumRender = this.metrics.cesiumUpdate + this.metrics.cesiumDraw
    if (primitiveCount !== undefined) {
      this.metrics.cesiumPrimitives = primitiveCount
    }
    if (tilesLoaded !== undefined) {
      this.metrics.cesiumTilesLoaded = tilesLoaded
    }
    if (tilesLoading !== undefined) {
      this.metrics.cesiumTilesLoading = tilesLoading
    }
  }

  /**
   * Mark the start of a new frame
   */
  startFrame(): void {
    const now = performance.now()
    this.frameStartTime = now
    this.lastFrameInterval = 0

    // Calculate frame interval (start-to-start) - the true frame rate
    if (this.previousFrameStartTime > 0) {
      const frameInterval = now - this.previousFrameStartTime
      this.lastFrameInterval = frameInterval
      this.frameTimes.push(frameInterval)
      if (this.frameTimes.length > this.MAX_FRAME_SAMPLES) {
        this.frameTimes.shift()
      }

      // Calculate FPS from frame interval
      const avgFrameTime = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length
      this.metrics.fps = avgFrameTime > 0 ? 1000 / avgFrameTime : 0
      this.metrics.frameInterval = avgFrameTime
    }

    // Calculate idle time (end of last frame to start of this frame)
    // This is time spent waiting for VSync, GPU, or browser processing
    if (this.previousFrameEndTime > 0) {
      const idleTime = now - this.previousFrameEndTime
      this.idleTimes.push(idleTime)
      if (this.idleTimes.length > this.MAX_FRAME_SAMPLES) {
        this.idleTimes.shift()
      }

      const avgIdleTime = this.idleTimes.reduce((a, b) => a + b, 0) / this.idleTimes.length
      this.metrics.idleTime = avgIdleTime

      // Attribute longtasks that ran during the just-ended idle window to "blocked JS".
      let blockedThisFrame = 0
      for (const stamp of this.longTaskStamps) {
        if (stamp.start >= this.previousFrameEndTime) {
          blockedThisFrame += stamp.duration
        }
      }
      this.longTaskStamps.length = 0
      this.blockedJsTimes.push(blockedThisFrame)
      if (this.blockedJsTimes.length > this.MAX_FRAME_SAMPLES) {
        this.blockedJsTimes.shift()
      }
      this.metrics.blockedJsMs = this.blockedJsTimes.reduce((a, b) => a + b, 0) / this.blockedJsTimes.length
    }

    this.previousFrameStartTime = now
  }

  /**
   * Record real GPU frame times measured via timer queries, for the HUD.
   * Pass -1 for a context whose timing is unavailable.
   */
  setGpuTimings(cesiumMs: number, babylonMs: number, supported: boolean): void {
    this.metrics.gpuCesiumMs = cesiumMs
    this.metrics.gpuBabylonMs = babylonMs
    this.metrics.gpuSupported = supported
  }

  /**
   * Record the GPU timer results read since the last poll, one window sample each.
   *
   * A frame that drains several results keeps every one of them, and a frame with
   * no new result adds none, so the series never repeats a stale value.
   *
   * @param cesium - Results from the Cesium context, in milliseconds
   * @param babylon - Results from the Babylon context, in milliseconds
   */
  pushGpuSamples(cesium: readonly number[], babylon: readonly number[]): void {
    if (!import.meta.env.DEV) return
    for (const milliseconds of cesium) this.gpuCesiumWindow.push(milliseconds)
    for (const milliseconds of babylon) this.gpuBabylonWindow.push(milliseconds)
  }

  /** Record the unmasked GPU/driver string for the main rendering context. */
  setRendererInfo(renderer: string): void {
    this.metrics.gpuRenderer = renderer
  }

  /**
   * Mark the end of a frame and record total operations time
   */
  endFrame(): void {
    const now = performance.now()
    const operationsTime = now - this.frameStartTime
    this.metrics.totalFrame = operationsTime

    // Calculate unaccounted time (total operations minus measured components)
    // This helps identify unmeasured work or measurement overhead
    const measuredTime =
      this.metrics.interpolation +
      this.metrics.aircraftUpdate +
      this.metrics.babylonSync +
      this.metrics.babylonRender +
      this.metrics.cesiumRender
    this.metrics.unaccountedTime = Math.max(0, operationsTime - measuredTime)

    this.previousFrameEndTime = now

    // Dev-only: production builds keep no frame history for the agent harness.
    if (import.meta.env.DEV) {
      this.frameWindow.push({
        frameInterval: this.lastFrameInterval,
        totalFrame: this.metrics.totalFrame,
        cesiumUpdate: this.metrics.cesiumUpdate,
        cesiumDraw: this.metrics.cesiumDraw,
        babylonRender: this.metrics.babylonRender,
      })
    }
  }

  /**
   * Get current performance metrics
   */
  getMetrics(): PerformanceMetrics {
    return { ...this.metrics }
  }

  /** Median and p95 of the last 300 frames' CPU series and the last 300 GPU results. */
  getFrameWindow(): FrameWindowSummary {
    return {
      ...this.frameWindow.summarize(),
      gpuCesiumMs: this.gpuCesiumWindow.summarize(),
      gpuBabylonMs: this.gpuBabylonWindow.summarize(),
    }
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.metrics = {
      interpolation: 0,
      aircraftUpdate: 0,
      babylonSync: 0,
      babylonRender: 0,
      cesiumRender: 0,
      cesiumUpdate: 0,
      cesiumDraw: 0,
      cesiumPrimitives: 0,
      cesiumTilesLoaded: 0,
      cesiumTilesLoading: 0,
      totalFrame: 0,
      fps: 0,
      frameInterval: 0,
      idleTime: 0,
      unaccountedTime: 0,
      gpuCesiumMs: -1,
      gpuBabylonMs: -1,
      gpuSupported: false,
      blockedJsMs: 0,
      gpuRenderer: '',
    }
    this.frameWindow.clear()
    this.gpuCesiumWindow.clear()
    this.gpuBabylonWindow.clear()
    this.lastFrameInterval = 0
    this.frameTimes = []
    this.idleTimes = []
    this.blockedJsTimes = []
    this.longTaskStamps = []
    this.timers.clear()
    this.cesiumPreUpdateTime = 0
    this.cesiumPreRenderTime = 0
    this.previousFrameStartTime = 0
  }
}

// Singleton instance
export const performanceMonitor = new PerformanceMonitor()
