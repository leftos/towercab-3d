import { describe, expect, it } from 'vitest'
import { GpuFrameTimer } from './gpuTimer'

interface FakeQuery {
  available: boolean
  nanoseconds: number
}

const TIME_ELAPSED_EXT = 0x88bf
const GPU_DISJOINT_EXT = 0x8fbb
const QUERY_RESULT_AVAILABLE = 0x8867

/** Minimal WebGL2 stand-in covering the calls GpuFrameTimer makes. */
function fakeGl(): {
  gl: WebGL2RenderingContext
  queries: FakeQuery[]
  state: { throwOnBegin: boolean; disjoint: boolean }
} {
  const queries: FakeQuery[] = []
  const state = { throwOnBegin: false, disjoint: false }
  const gl = {
    getExtension: () => ({ TIME_ELAPSED_EXT, GPU_DISJOINT_EXT }),
    createQuery: () => {
      const query: FakeQuery = { available: false, nanoseconds: 0 }
      queries.push(query)
      return query
    },
    beginQuery: (_target: number, query: FakeQuery) => {
      if (state.throwOnBegin) throw new Error('context lost')
      // A freshly issued query has no result yet, even when it reuses a pooled one.
      query.available = false
      query.nanoseconds = 0
    },
    endQuery: () => {},
    deleteQuery: () => {},
    getParameter: (pname: number) => pname === GPU_DISJOINT_EXT && state.disjoint,
    getQueryParameter: (query: FakeQuery, pname: number) =>
      pname === QUERY_RESULT_AVAILABLE ? query.available : query.nanoseconds,
  }
  return { gl: gl as unknown as WebGL2RenderingContext, queries, state }
}

describe('GpuFrameTimer.poll', () => {
  it('returns every result read since the previous poll', () => {
    const { gl, queries } = fakeGl()
    const timer = new GpuFrameTimer(gl)

    timer.begin()
    timer.end()
    timer.begin()
    timer.end()
    queries[0].available = true
    queries[0].nanoseconds = 4e6
    queries[1].available = true
    queries[1].nanoseconds = 9e6

    expect(timer.poll()).toEqual([4, 9])
    expect(timer.gpuMs).toBe(9)
  })

  it('returns nothing on a frame with no completed result', () => {
    const { gl, queries } = fakeGl()
    const timer = new GpuFrameTimer(gl)

    timer.begin()
    timer.end()
    queries[0].available = true
    queries[0].nanoseconds = 6e6
    expect(timer.poll()).toEqual([6])

    timer.begin()
    timer.end()
    expect(timer.poll()).toEqual([])
    expect(timer.gpuMs).toBe(6)
  })

  it('returns nothing once the timer has broken after a first result', () => {
    const { gl, queries, state } = fakeGl()
    const timer = new GpuFrameTimer(gl)

    timer.begin()
    timer.end()
    queries[0].available = true
    queries[0].nanoseconds = 4e6
    expect(timer.poll()).toEqual([4])

    state.throwOnBegin = true
    timer.begin()
    timer.end()

    expect(timer.isSupported).toBe(false)
    expect(timer.poll()).toEqual([])
  })

  it('returns the same empty array on every poll with no completed query', () => {
    const { gl } = fakeGl()
    const timer = new GpuFrameTimer(gl)

    timer.begin()
    timer.end()

    expect(timer.poll()).toBe(timer.poll())
  })

  it('drops in-flight results on a disjoint event and reads nothing afterwards', () => {
    const { gl, queries, state } = fakeGl()
    const timer = new GpuFrameTimer(gl)

    timer.begin()
    timer.end()
    queries[0].available = true
    queries[0].nanoseconds = 4e6

    state.disjoint = true
    expect(timer.poll()).toEqual([])

    state.disjoint = false
    expect(timer.poll()).toEqual([])
    expect(timer.gpuMs).toBe(0)
  })
})
