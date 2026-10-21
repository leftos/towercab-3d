import { describe, expect, it } from 'vitest'
import type { FrameSample } from '@/types'
import { FrameWindow, NumberWindow, summarizeSeries } from './frameStats'

function sample(frameInterval: number): FrameSample {
  return {
    frameInterval,
    totalFrame: frameInterval * 0.5,
    cesiumUpdate: 1,
    cesiumDraw: 2,
    babylonRender: 3,
  }
}

describe('summarizeSeries', () => {
  it('returns null for an empty series', () => {
    expect(summarizeSeries([])).toBeNull()
  })

  it('takes the middle value as the median for an odd count', () => {
    expect(summarizeSeries([30, 10, 20])?.median).toBe(20)
  })

  it('takes the mean of the two middle values as the median for an even count', () => {
    expect(summarizeSeries([40, 10, 30, 20])?.median).toBe(25)
  })

  it('takes p95 by nearest rank', () => {
    const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(summarizeSeries(oneToHundred)?.p95).toBe(95)
  })
})

describe('FrameWindow', () => {
  it('reports an empty window as no frames and every statistic null', () => {
    expect(new FrameWindow().summarize()).toEqual({
      frames: 0,
      frameInterval: null,
      totalFrame: null,
      cesiumUpdate: null,
      cesiumDraw: null,
      babylonRender: null,
    })
  })

  it('summarizes per-frame series including p95 on a full 300-frame window', () => {
    const window = new FrameWindow()
    for (let i = 1; i <= 300; i++) {
      window.push(sample(i))
    }
    const summary = window.summarize()
    expect(summary.frames).toBe(300)
    expect(summary.frameInterval).toEqual({ median: 150.5, p95: 285 })
    expect(summary.totalFrame).toEqual({ median: 75.25, p95: 142.5 })
  })

  it('drops the oldest samples once it is past capacity', () => {
    const window = new FrameWindow(3)
    for (const value of [10, 20, 30, 40, 50]) {
      window.push(sample(value))
    }
    const summary = window.summarize()
    expect(summary.frames).toBe(3)
    expect(summary.frameInterval).toEqual({ median: 40, p95: 50 })
  })
})

describe('NumberWindow', () => {
  it('summarizes to null with no samples', () => {
    expect(new NumberWindow().summarize()).toBeNull()
  })

  it('keeps only the newest samples past capacity', () => {
    const window = new NumberWindow(3)
    for (const value of [10, 20, 30, 40, 50]) {
      window.push(value)
    }
    expect(window.summarize()).toEqual({ median: 40, p95: 50 })
  })

  it('keeps a real 0 as 0 rather than treating it as empty', () => {
    const window = new NumberWindow()
    window.push(0)
    expect(window.summarize()).toEqual({ median: 0, p95: 0 })
  })
})
