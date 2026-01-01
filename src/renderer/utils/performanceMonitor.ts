/**
 * Performance monitoring utility for tracking frame timing
 * Provides frame-by-frame timing data for performance optimization
 */

export interface PerformanceMetrics {
  interpolation: number
  aircraftUpdate: number
  babylonSync: number
  babylonRender: number
  cesiumRender: number
  cesiumPrimitives: number
  cesiumTilesLoaded: number
  cesiumTilesLoading: number
  totalFrame: number
  fps: number
  frameInterval: number
}

class PerformanceMonitor {
  private timers: Map<string, number> = new Map()
  private metrics: PerformanceMetrics = {
    interpolation: 0,
    aircraftUpdate: 0,
    babylonSync: 0,
    babylonRender: 0,
    cesiumRender: 0,
    cesiumPrimitives: 0,
    cesiumTilesLoaded: 0,
    cesiumTilesLoading: 0,
    totalFrame: 0,
    fps: 0,
    frameInterval: 0
  }

  // Cesium preRender timestamp for accurate render timing
  private cesiumPreRenderTime = 0

  private frameStartTime = 0
  private lastFrameTime = 0
  private frameTimes: number[] = []
  private readonly MAX_FRAME_SAMPLES = 60
  private logInterval: ReturnType<typeof setInterval> | null = null
  private previousFrameEndTime = 0

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
   * Called at Cesium scene.preRender to start timing Cesium's render phase
   */
  markCesiumPreRender(): void {
    this.cesiumPreRenderTime = performance.now()
  }

  /**
   * Called at Cesium scene.postRender to end timing Cesium's render phase
   * Also updates Cesium scene statistics
   */
  markCesiumPostRender(primitiveCount?: number, tilesLoaded?: number, tilesLoading?: number): void {
    if (this.cesiumPreRenderTime > 0) {
      this.metrics.cesiumRender = performance.now() - this.cesiumPreRenderTime
    }
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
    this.frameStartTime = performance.now()

    // Calculate actual frame-to-frame time (time since last frame ended)
    if (this.previousFrameEndTime > 0) {
      const frameToFrameTime = this.frameStartTime - this.previousFrameEndTime
      this.frameTimes.push(frameToFrameTime)
      if (this.frameTimes.length > this.MAX_FRAME_SAMPLES) {
        this.frameTimes.shift()
      }

      // Calculate FPS from frame-to-frame timing
      const avgFrameTime = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length
      this.metrics.fps = avgFrameTime > 0 ? 1000 / avgFrameTime : 0
      this.metrics.frameInterval = avgFrameTime
      // Note: cesiumRender is now measured directly via markCesiumPreRender/markCesiumPostRender
    }
  }

  /**
   * Mark the end of a frame and record total operations time
   */
  endFrame(): void {
    const now = performance.now()
    const operationsTime = now - this.frameStartTime
    this.metrics.totalFrame = operationsTime

    this.previousFrameEndTime = now
    this.lastFrameTime = now
  }

  /**
   * Get current performance metrics
   */
  getMetrics(): PerformanceMetrics {
    return { ...this.metrics }
  }

  /**
   * Log current performance metrics to console (DEV only)
   */
  logMetrics(): void {
    // Only log in development mode
    if (!import.meta.env.DEV) return

    const m = this.metrics
    const opsTotal = m.totalFrame || 1
    const frameTotal = m.frameInterval || 1

    // Suppress verbose performance logging - only log when FPS drops below 30
    if (m.fps < 30) {
      // Format as multi-line string for auto-expanded readability
      const output = [
        `[Performance Monitor] ${Math.round(m.fps)} FPS | ${m.frameInterval.toFixed(2)}ms interval`,
        `  Cesium Render:  ${m.cesiumRender.toFixed(2)}ms (${((m.cesiumRender / frameTotal) * 100).toFixed(1)}% of frame)`,
        `    • Primitives: ${m.cesiumPrimitives} | Tiles: ${m.cesiumTilesLoaded} loaded, ${m.cesiumTilesLoading} loading`,
        `  Our Operations: ${m.totalFrame.toFixed(2)}ms (${((m.totalFrame / frameTotal) * 100).toFixed(1)}% of frame)`,
        `    • Interpolation:   ${m.interpolation.toFixed(2)}ms (${((m.interpolation / opsTotal) * 100).toFixed(1)}% of ops)`,
        `    • Aircraft Update: ${m.aircraftUpdate.toFixed(2)}ms (${((m.aircraftUpdate / opsTotal) * 100).toFixed(1)}% of ops)`,
        `    • Babylon Sync:    ${m.babylonSync.toFixed(2)}ms (${((m.babylonSync / opsTotal) * 100).toFixed(1)}% of ops)`,
        `    • Babylon Render:  ${m.babylonRender.toFixed(2)}ms (${((m.babylonRender / opsTotal) * 100).toFixed(1)}% of ops)`
      ].join('\n')

      console.warn(output)
    }
  }

  /**
   * Start logging metrics to console every 5 seconds
   */
  startLogging(): void {
    if (this.logInterval) return // Already logging

    this.logInterval = setInterval(() => {
      this.logMetrics()
    }, 5000)
  }

  /**
   * Stop logging metrics to console
   */
  stopLogging(): void {
    if (this.logInterval) {
      clearInterval(this.logInterval)
      this.logInterval = null
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
      cesiumPrimitives: 0,
      cesiumTilesLoaded: 0,
      cesiumTilesLoading: 0,
      totalFrame: 0,
      fps: 0,
      frameInterval: 0
    }
    this.frameTimes = []
    this.timers.clear()
    this.cesiumPreRenderTime = 0
  }
}

// Singleton instance
export const performanceMonitor = new PerformanceMonitor()
