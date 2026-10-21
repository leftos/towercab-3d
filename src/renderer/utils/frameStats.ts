/**
 * Fixed-capacity windows of per-frame timing samples and the median/p95 summaries of them.
 *
 * The performance HUD reads smoothed means over the last 60 frames, which hides the
 * outliers a stutter report is about. These windows keep the raw values for 300
 * samples instead, so a caller can ask what a typical frame cost and what the worst
 * frames cost. Frame rows carry the CPU-side series; the GPU series are their own
 * numeric windows, because one poll can drain more than one GPU result.
 */

import type { FrameRowSummary, FrameSample, PercentileStat } from '@/types'

/** Samples kept for `__tc3d.perf()` — about 5 s at 60 fps. */
export const FRAME_WINDOW_CAPACITY = 300

/** Rank of the 95th percentile in nearest-rank form. */
const P95_RANK = 0.95

/**
 * Summarizes one series of millisecond samples.
 *
 * @param values - Samples
 * @returns Median (mean of the two middle values for an even count) and p95 by
 * nearest rank, or null when there are no samples
 */
export function summarizeSeries(values: readonly number[]): PercentileStat | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const half = sorted.length / 2
  const median = sorted.length % 2 === 1 ? sorted[Math.floor(half)] : (sorted[half - 1] + sorted[half]) / 2
  const rank = Math.max(0, Math.ceil(P95_RANK * sorted.length) - 1)
  return { median, p95: sorted[rank] }
}

/**
 * Ring buffer of per-frame samples that keeps only the newest ones.
 *
 * @example
 * const window = new FrameWindow()
 * window.push(sample)
 * window.summarize().frameInterval?.p95
 */
export class FrameWindow {
  private readonly capacity: number
  private readonly samples: FrameSample[] = []
  private next = 0
  private count = 0

  /**
   * @param capacity - Samples to keep; the oldest are overwritten past it
   */
  constructor(capacity: number = FRAME_WINDOW_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`FrameWindow capacity must be a positive integer, got ${String(capacity)}`)
    }
    this.capacity = capacity
  }

  /** Adds one frame's sample, dropping the oldest once the window is full. */
  push(sample: FrameSample): void {
    this.samples[this.next] = sample
    this.next = (this.next + 1) % this.capacity
    if (this.count < this.capacity) this.count++
  }

  /** Drops every sample. */
  clear(): void {
    this.samples.length = 0
    this.next = 0
    this.count = 0
  }

  /** Median and p95 of every CPU-side series over the samples currently held. */
  summarize(): FrameRowSummary {
    const samples = this.samples.slice(0, this.count)
    return {
      frames: samples.length,
      frameInterval: summarizeSeries(samples.map((s) => s.frameInterval)),
      totalFrame: summarizeSeries(samples.map((s) => s.totalFrame)),
      cesiumUpdate: summarizeSeries(samples.map((s) => s.cesiumUpdate)),
      cesiumDraw: summarizeSeries(samples.map((s) => s.cesiumDraw)),
      babylonRender: summarizeSeries(samples.map((s) => s.babylonRender)),
    }
  }
}

/**
 * Ring buffer of single numeric samples, used for the GPU series.
 *
 * A real 0 ms result is a sample like any other; "no sample" is the absence of
 * one, never a sentinel value.
 */
export class NumberWindow {
  private readonly capacity: number
  private readonly held: number[] = []
  private next = 0
  private count = 0

  /**
   * @param capacity - Samples to keep; the oldest are overwritten past it
   */
  constructor(capacity: number = FRAME_WINDOW_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`NumberWindow capacity must be a positive integer, got ${String(capacity)}`)
    }
    this.capacity = capacity
  }

  /** Adds one sample, dropping the oldest once the window is full. */
  push(value: number): void {
    this.held[this.next] = value
    this.next = (this.next + 1) % this.capacity
    if (this.count < this.capacity) this.count++
  }

  /** Drops every sample. */
  clear(): void {
    this.held.length = 0
    this.next = 0
    this.count = 0
  }

  /** Median and p95 of the samples currently held, or null when there are none. */
  summarize(): PercentileStat | null {
    return summarizeSeries(this.held.slice(0, this.count))
  }
}
