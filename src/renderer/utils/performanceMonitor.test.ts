import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { performanceMonitor } from './performanceMonitor'

/** Mocked clock, advanced by the frame phases below. */
let now = 0

/** Idle gap between the end of one frame and the start of the next (ms). */
const FRAME_IDLE_MS = 10

/**
 * Drives one frame of the monitor: 2 ms update, 3 ms draw, 1 ms of tail work,
 * then a 10 ms gap, so each frame interval is 16 ms.
 */
function runFrame(): void {
  performanceMonitor.startFrame()
  performanceMonitor.markCesiumPreUpdate()
  now += 2
  performanceMonitor.markCesiumPostUpdate()
  performanceMonitor.markCesiumPreRender()
  now += 3
  performanceMonitor.markCesiumPostRender(10, 1, 0)
  now += 1
  performanceMonitor.endFrame()
  now += FRAME_IDLE_MS
}

describe('performanceMonitor frame window', () => {
  beforeEach(() => {
    now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    performanceMonitor.reset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    performanceMonitor.reset()
  })

  it('holds one sample per frame with its phase and total times', () => {
    for (let frame = 0; frame < 5; frame++) {
      runFrame()
    }

    const summary = performanceMonitor.getFrameWindow()
    expect(summary.frames).toBe(5)
    expect(summary.frameInterval?.median).toBe(16)
    expect(summary.cesiumUpdate).toEqual({ median: 2, p95: 2 })
    expect(summary.cesiumDraw).toEqual({ median: 3, p95: 3 })
    expect(summary.totalFrame).toEqual({ median: 6, p95: 6 })
    expect(summary.gpuCesiumMs).toBeNull()
    expect(summary.gpuBabylonMs).toBeNull()
  })

  it('records a real 0 ms GPU result as a 0, not as no result', () => {
    for (let frame = 0; frame < 4; frame++) {
      performanceMonitor.pushGpuSamples([0], [0])
      runFrame()
    }

    const summary = performanceMonitor.getFrameWindow()
    expect(summary.gpuCesiumMs).toEqual({ median: 0, p95: 0 })
    expect(summary.gpuBabylonMs).toEqual({ median: 0, p95: 0 })
  })

  it('adds no GPU sample for a frame with no new result', () => {
    performanceMonitor.pushGpuSamples([4], [])
    runFrame()
    performanceMonitor.pushGpuSamples([], [])
    runFrame()

    const summary = performanceMonitor.getFrameWindow()
    expect(summary.frames).toBe(2)
    expect(summary.gpuCesiumMs).toEqual({ median: 4, p95: 4 })
    expect(summary.gpuBabylonMs).toBeNull()
  })

  it('keeps only real results in the GPU series once the timer breaks', () => {
    performanceMonitor.pushGpuSamples([6], [])
    runFrame()
    // A broken timer reports no results at all, not -1.
    performanceMonitor.pushGpuSamples([], [])
    runFrame()

    const summary = performanceMonitor.getFrameWindow()
    expect(summary.gpuCesiumMs).toEqual({ median: 6, p95: 6 })
  })

  it('leaves the HUD metrics exactly as the caller reports them', () => {
    performanceMonitor.setGpuTimings(-1, -1, false)
    expect(performanceMonitor.getMetrics().gpuCesiumMs).toBe(-1)

    performanceMonitor.setGpuTimings(2.5, 1.5, true)
    const metrics = performanceMonitor.getMetrics()
    expect(metrics.gpuCesiumMs).toBe(2.5)
    expect(metrics.gpuBabylonMs).toBe(1.5)
    expect(metrics.gpuSupported).toBe(true)
  })
})
