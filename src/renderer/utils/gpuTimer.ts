/**
 * Real GPU-time-per-frame measurement for WebGL2 contexts.
 *
 * The on-screen performance monitor only times the JavaScript work inside Cesium's
 * preUpdate→postRender window. When a frame is GPU-bound, that JS time stays small
 * (it only submits draw commands) while the GPU spends much longer actually executing
 * them — and that cost collapses into the monitor's single "Idle/VSync" bucket.
 *
 * EXT_disjoint_timer_query_webgl2 measures the wall-clock GPU time of the commands
 * issued between begin() and end(), so we can tell a GPU-bound frame (large gpuMs)
 * apart from a frame-scheduling/throttle problem (small gpuMs, large idle).
 */

interface DisjointTimerExt {
  TIME_ELAPSED_EXT: number
  GPU_DISJOINT_EXT: number
}

interface DebugRendererInfoExt {
  UNMASKED_RENDERER_WEBGL: number
  UNMASKED_VENDOR_WEBGL: number
}

export interface RendererInfo {
  /** Unmasked GPU/driver string (e.g. "NVIDIA GeForce RTX 4070" or "Microsoft Basic Render Driver"). */
  renderer: string
  /** Unmasked GPU vendor string. */
  vendor: string
  /** True when the context is WebGL2 (required for GPU timer queries). */
  isWebgl2: boolean
}

/**
 * Reads the unmasked renderer/vendor strings for a WebGL context.
 *
 * A renderer of "Microsoft Basic Render Driver", "SwiftShader", or "WARP" means the
 * context fell back to software rasterization — the classic cause of a fast-JS,
 * catastrophically-slow-present frame.
 */
export function getRendererInfo(gl: WebGLRenderingContext | WebGL2RenderingContext): RendererInfo {
  const isWebgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext
  const dbg = gl.getExtension('WEBGL_debug_renderer_info') as DebugRendererInfoExt | null
  const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER))
  const vendor = dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : String(gl.getParameter(gl.VENDOR))
  return { renderer, vendor, isWebgl2 }
}

/**
 * Issues one TIME_ELAPSED GPU timer query per frame and reads results back asynchronously.
 *
 * GPU timer results are not available on the same frame they are issued — the GPU is
 * typically 1-3 frames behind. This class keeps a small pool of query objects, queues
 * issued queries, and reads back completed ones on {@link poll}. {@link gpuMs} reports
 * the most recently completed measurement.
 *
 * Only one TIME_ELAPSED query may be active per context at a time, so begin()/end() must
 * be balanced and not nested.
 */
export class GpuFrameTimer {
  private readonly gl: WebGL2RenderingContext
  private readonly ext: DisjointTimerExt | null
  private readonly pool: WebGLQuery[] = []
  private readonly pending: WebGLQuery[] = []
  private activeQuery: WebGLQuery | null = null
  private lastGpuMs = 0
  private broken = false

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as DisjointTimerExt | null
  }

  /** True when the timer extension is present and no fatal GL error has occurred. */
  get isSupported(): boolean {
    return this.ext !== null && !this.broken
  }

  /** Most recently completed GPU frame time in milliseconds (lags real-time by a few frames). */
  get gpuMs(): number {
    return this.lastGpuMs
  }

  /** Begin timing the GPU commands that follow on this context. No-op if already active. */
  begin(): void {
    if (!this.ext || this.broken || this.activeQuery) {
      return
    }
    const query = this.pool.pop() ?? this.gl.createQuery()
    if (!query) {
      return
    }
    try {
      this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query)
      this.activeQuery = query
    } catch (err) {
      this.broken = true
      console.debug('[GpuFrameTimer] beginQuery failed, disabling GPU timing:', err)
    }
  }

  /** End the active timing query and queue it for later read-back. */
  end(): void {
    if (!this.ext || this.broken || !this.activeQuery) {
      return
    }
    try {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT)
      this.pending.push(this.activeQuery)
    } catch (err) {
      this.broken = true
      console.debug('[GpuFrameTimer] endQuery failed, disabling GPU timing:', err)
    } finally {
      this.activeQuery = null
    }
  }

  /** Read back any completed query results. Call once per frame before {@link begin}. */
  poll(): void {
    if (!this.ext || this.broken) {
      return
    }
    const gl = this.gl
    // A disjoint event (GPU mode switch, power event) invalidates all in-flight timings.
    if (gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
      for (const q of this.pending) {
        this.pool.push(q)
      }
      this.pending.length = 0
      return
    }
    while (this.pending.length > 0) {
      const query = this.pending[0]
      if (!query) {
        this.pending.shift()
        continue
      }
      const available = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) as boolean
      if (!available) {
        break
      }
      const nanoseconds = gl.getQueryParameter(query, gl.QUERY_RESULT) as number
      this.lastGpuMs = nanoseconds / 1e6
      this.pending.shift()
      this.pool.push(query)
    }
  }

  /** Delete all GL query objects. Call when the owning context is being destroyed. */
  dispose(): void {
    if (this.activeQuery && this.ext) {
      try {
        this.gl.endQuery(this.ext.TIME_ELAPSED_EXT)
      } catch (err) {
        // Context already lost during teardown — nothing to recover.
        console.debug('[GpuFrameTimer] endQuery during dispose failed:', err)
      }
      this.activeQuery = null
    }
    for (const query of this.pending) {
      this.gl.deleteQuery(query)
    }
    for (const query of this.pool) {
      this.gl.deleteQuery(query)
    }
    this.pending.length = 0
    this.pool.length = 0
  }
}
