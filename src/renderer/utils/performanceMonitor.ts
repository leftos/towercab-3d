/**
 * Performance monitoring utility for tracking frame timing
 * Provides frame-by-frame timing data for performance optimization
 */

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
}

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

    // Calculate frame interval (start-to-start) - the true frame rate
    if (this.previousFrameStartTime > 0) {
      const frameInterval = now - this.previousFrameStartTime
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
    }

    this.previousFrameStartTime = now
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
  }

  /**
   * Get current performance metrics
   */
  getMetrics(): PerformanceMetrics {
    return { ...this.metrics }
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
    }
    this.frameTimes = []
    this.idleTimes = []
    this.timers.clear()
    this.cesiumPreUpdateTime = 0
    this.cesiumPreRenderTime = 0
    this.previousFrameStartTime = 0
  }
}

// Singleton instance
export const performanceMonitor = new PerformanceMonitor()
