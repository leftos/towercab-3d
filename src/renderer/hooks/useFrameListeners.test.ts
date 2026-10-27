import * as Cesium from 'cesium'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import type { FrameListenersOptions, FrameOverlay } from '@/hooks/useFrameListeners'
import type { Airport } from '@/types'

/**
 * Drives `useFrameListeners` without a DOM: react's hooks are replaced by a minimal renderer
 * that keeps refs and effect deps by call order and runs the queued effects after each render.
 */
const hookState = vi.hoisted(() => {
  interface Slot {
    deps?: unknown[]
    cleanup?: (() => void) | undefined
    ref?: { current: unknown }
  }
  const slots: Slot[] = []
  let effects: Array<() => void> = []
  let index = 0
  const depsChanged = (a: unknown[] | undefined, b: unknown[] | undefined) =>
    !a || !b || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]))
  const slot = (): Slot => {
    if (!slots[index]) slots[index] = {}
    return slots[index++]
  }
  return {
    begin() {
      index = 0
      effects = []
    },
    runEffects() {
      const queued = effects.splice(0)
      for (const run of queued) run()
    },
    reset() {
      slots.length = 0
      index = 0
      effects = []
    },
    unmount() {
      for (const target of slots) {
        target.cleanup?.()
        target.cleanup = undefined
      }
    },
    useRef<T>(initial: T): { current: T } {
      const target = slot()
      if (!target.ref) target.ref = { current: initial }
      return target.ref as { current: T }
    },
    useEffect(fn: () => (() => void) | undefined, deps?: unknown[]) {
      const target = slot()
      if (!depsChanged(target.deps, deps)) return
      target.deps = deps
      effects.push(() => {
        target.cleanup?.()
        target.cleanup = fn() ?? undefined
      })
    },
  }
})

vi.mock('react', () => {
  const api = {
    useRef: <T>(initial: T) => hookState.useRef(initial),
    useEffect: (fn: () => (() => void) | undefined, deps?: unknown[]) => hookState.useEffect(fn, deps),
  }
  return { ...api, default: api }
})

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ graphics: { maxFramerate: 60 } }) },
}))

import { useFrameListeners } from '@/hooks/useFrameListeners'

/** A WebGL2 context that reports no extensions, so the GPU timers stay unsupported. */
class FakeWebGl2 {
  readonly RENDERER = 0x1f01
  readonly VENDOR = 0x1f00
  /** How many GPU timers asked this context for the timer-query extension. */
  timerRequests = 0
  getExtension(name: string): null {
    if (name === 'EXT_disjoint_timer_query_webgl2') this.timerRequests++
    return null
  }
  getParameter(): string {
    return 'fake'
  }
}

const AIRPORT_LAT = 37.7213
const AIRPORT_LON = -122.2208
/** About 200 m of latitude: twice the listeners' 100 m tracking threshold. */
const MOVE_DEG = 0.0018
/** About 60 m of latitude: under the threshold alone, past it after two steps. */
const SMALL_STEP_DEG = 0.0006
const KOAK = { icao: 'KOAK', lat: AIRPORT_LAT, lon: AIRPORT_LON } as Airport

function fakeViewer() {
  const scene = {
    preUpdate: new Cesium.Event(),
    postUpdate: new Cesium.Event(),
    preRender: new Cesium.Event(),
    postRender: new Cesium.Event(),
    primitives: { length: 0 },
    globe: {},
    context: { _gl: new FakeWebGl2() },
  }
  const camera = { positionCartographic: Cesium.Cartographic.fromDegrees(AIRPORT_LON, AIRPORT_LAT, 100) }
  return { isDestroyed: () => false, scene, camera }
}

type FakeViewer = ReturnType<typeof fakeViewer>

/** An overlay whose engine, when given, draws on the `gl` context. */
function fakeOverlay(gl?: FakeWebGl2): FrameOverlay {
  const engine = gl ? ({ _gl: gl } as unknown as FrameOverlay['engine']) : null
  return { engine, syncCamera: vi.fn(), render: vi.fn() }
}

/** Raises one Cesium frame's render events. */
function frame(viewer: FakeViewer): void {
  viewer.scene.preRender.raiseEvent()
  viewer.scene.postRender.raiseEvent()
}

/** The view state a CesiumViewer would hold, the same callbacks on every render. */
function viewState(overrides: Partial<FrameListenersOptions>) {
  const setCameraGeoPosition = vi.fn()
  const updateCameraPosition = vi.fn()
  const options = (babylonOverlay: FrameOverlay): FrameListenersOptions => ({
    babylonOverlay,
    showWeatherEffects: false,
    enableWeatherInterpolation: false,
    enableAutoAirportSwitch: false,
    followMode: 'tower',
    followingCallsign: null,
    currentAirport: KOAK,
    updateCameraPosition,
    isInset: false,
    ...overrides,
    setCameraGeoPosition,
  })
  return { options, setCameraGeoPosition }
}

function render(viewer: FakeViewer, options: FrameListenersOptions): void {
  hookState.begin()
  // biome-ignore lint/correctness/useHookAtTopLevel: driven by the minimal renderer above, one render per call
  useFrameListeners(viewer as unknown as Cesium.Viewer, options)
  hookState.runEffects()
}

function gpuLines(log: MockInstance<typeof console.log>): number {
  return log.mock.calls.filter(([line]) => String(line).startsWith('[GPU] Cesium renderer')).length
}

let log: MockInstance<typeof console.log>

beforeEach(() => {
  hookState.unmount()
  hookState.reset()
  vi.stubGlobal('WebGL2RenderingContext', FakeWebGl2)
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterEach(() => {
  hookState.unmount()
  log.mockRestore()
  vi.unstubAllGlobals()
})

describe('useFrameListeners', () => {
  it('attaches its frame listeners once while weather tracking re-renders the view every frame', () => {
    const viewer = fakeViewer()
    const attach = vi.spyOn(viewer.scene.postRender, 'addEventListener')
    const view = viewState({ showWeatherEffects: true, enableWeatherInterpolation: true })
    const overlays: FrameOverlay[] = []

    for (let i = 0; i < 10; i++) {
      const overlay = fakeOverlay()
      overlays.push(overlay)
      render(viewer, view.options(overlay))
      frame(viewer)
    }

    expect(attach).toHaveBeenCalledTimes(1)
    expect(gpuLines(log)).toBe(1)
    expect(overlays[9].render).toHaveBeenCalledTimes(1)
  })

  it('keeps its frame listeners across camera moves', () => {
    const viewer = fakeViewer()
    const attach = vi.spyOn(viewer.scene.postRender, 'addEventListener')
    const view = viewState({ enableAutoAirportSwitch: true })
    const overlay = fakeOverlay()
    render(viewer, view.options(overlay))

    for (let move = 1; move <= 5; move++) {
      viewer.camera.positionCartographic = Cesium.Cartographic.fromDegrees(
        AIRPORT_LON,
        AIRPORT_LAT + move * MOVE_DEG,
        100,
      )
      frame(viewer)
      render(viewer, view.options(overlay))
      frame(viewer)
      render(viewer, view.options(overlay))
    }

    expect(attach).toHaveBeenCalledTimes(1)
    expect(view.setCameraGeoPosition).toHaveBeenCalledTimes(5)

    // 60 m steps: each is under the threshold, but every second one is past it from the last send.
    const lastLat = AIRPORT_LAT + 5 * MOVE_DEG
    for (let step = 1; step <= 10; step++) {
      viewer.camera.positionCartographic = Cesium.Cartographic.fromDegrees(
        AIRPORT_LON,
        lastLat + step * SMALL_STEP_DEG,
        100,
      )
      frame(viewer)
      render(viewer, view.options(overlay))
    }

    expect(view.setCameraGeoPosition).toHaveBeenCalledTimes(10)
  })

  it("rebuilds the Babylon GPU timer when the overlay's GL context changes", () => {
    const viewer = fakeViewer()
    const view = viewState({})
    const first = new FakeWebGl2()
    const second = new FakeWebGl2()
    render(viewer, view.options(fakeOverlay(first)))
    frame(viewer)

    render(viewer, view.options(fakeOverlay(second)))
    frame(viewer)
    frame(viewer)

    expect(first.timerRequests).toBe(1)
    expect(second.timerRequests).toBe(1)
  })

  it('picks up the Babylon engine when it arrives after mount', () => {
    const viewer = fakeViewer()
    const view = viewState({})
    render(viewer, view.options(fakeOverlay()))
    frame(viewer)

    const gl = new FakeWebGl2()
    const ready = fakeOverlay(gl)
    render(viewer, view.options(ready))
    frame(viewer)

    expect(gl.timerRequests).toBe(1)
    expect(ready.render).toHaveBeenCalledTimes(1)
  })
})
