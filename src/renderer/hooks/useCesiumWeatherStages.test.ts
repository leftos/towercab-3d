import * as Cesium from 'cesium'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WeatherStagesOptions } from '@/hooks/useCesiumWeatherStages'

/**
 * Drives `useCesiumWeatherStages` without a DOM: react's hooks are replaced by a minimal
 * renderer that keeps refs, state and effect deps by call order, runs effects after each
 * render, and re-renders while the effects leave state changed.
 */
const hookState = vi.hoisted(() => {
  interface Slot {
    deps?: unknown[]
    cleanup?: (() => void) | undefined
    ref?: { current: unknown }
    value?: unknown
    hasValue?: boolean
    set?: (next: unknown) => void
  }
  const slots: Slot[] = []
  let effects: Array<() => void> = []
  let layoutEffects: Array<() => void> = []
  let index = 0
  let dirty = false
  const depsChanged = (a: unknown[] | undefined, b: unknown[] | undefined) =>
    !a || !b || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]))
  const slot = (): Slot => {
    if (!slots[index]) slots[index] = {}
    return slots[index++]
  }
  const register = (target: Slot, fn: () => (() => void) | undefined, deps: unknown[] | undefined) => {
    if (!depsChanged(target.deps, deps)) return
    target.deps = deps
    const run = () => {
      target.cleanup?.()
      target.cleanup = fn() ?? undefined
    }
    return run
  }
  return {
    begin() {
      index = 0
      effects = []
      layoutEffects = []
    },
    clear() {
      dirty = false
    },
    isDirty: () => dirty,
    runLayoutEffects() {
      const queued = layoutEffects.splice(0)
      for (const run of queued) run()
    },
    runEffects() {
      const queued = effects.splice(0)
      for (const run of queued) run()
    },
    reset() {
      slots.length = 0
      index = 0
      effects = []
      layoutEffects = []
      dirty = false
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
    useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void] {
      const target = slot()
      if (!target.hasValue) {
        target.hasValue = true
        target.value = typeof initial === 'function' ? (initial as () => T)() : initial
      }
      if (!target.set) {
        target.set = (next: unknown) => {
          const value = typeof next === 'function' ? (next as (previous: unknown) => unknown)(target.value) : next
          if (Object.is(value, target.value)) return
          target.value = value
          dirty = true
        }
      }
      return [target.value as T, target.set as (next: T | ((previous: T) => T)) => void]
    },
    useEffect(fn: () => (() => void) | undefined, deps?: unknown[]) {
      const run = register(slot(), fn, deps)
      if (run) effects.push(run)
    },
    useLayoutEffect(fn: () => (() => void) | undefined, deps?: unknown[]) {
      const run = register(slot(), fn, deps)
      if (run) layoutEffects.push(run)
    },
  }
})

vi.mock('react', () => {
  const api = {
    useRef: <T>(initial: T) => hookState.useRef(initial),
    useState: <T>(initial: T | (() => T)) => hookState.useState(initial),
    useEffect: (fn: () => (() => void) | undefined, deps?: unknown[]) => hookState.useEffect(fn, deps),
    useLayoutEffect: (fn: () => (() => void) | undefined, deps?: unknown[]) => hookState.useLayoutEffect(fn, deps),
  }
  return { ...api, default: api }
})

const settings = vi.hoisted(() => ({
  weather: {
    showWeatherEffects: true,
    showClouds: true,
    showBabylonFog: true,
    visibilityScale: 1,
    fogIntensity: 1,
    stageQuality: 'high' as string,
  },
}))
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: typeof settings) => unknown) => selector(settings),
}))

const weather = vi.hoisted(() => ({
  cloudLayers: [] as unknown[],
  currentMetar: undefined as { visib?: number } | undefined,
  useInterpolation: false,
  interpolatedWeather: undefined as { visibility?: number } | undefined,
}))
vi.mock('@/stores/weatherStore', () => ({
  useWeatherStore: (selector: (state: typeof weather) => unknown) => selector(weather),
}))

vi.mock('@/stores/weatherStageStore', () => ({
  useWeatherStageStore: (selector: (state: { cameraOverride: null; testAircraft: null }) => unknown) =>
    selector({ cameraOverride: null, testAircraft: null }),
}))

const cesiumFakes = vi.hoisted(() => ({
  created: [] as Array<{ name: string; textureScale?: number }>,
  sampleTerrainMostDetailed: vi.fn(async () => [{ height: 0 }]),
}))

vi.mock('cesium', async (importOriginal) => {
  const actual = await importOriginal<typeof import('cesium')>()
  class FakeStage {
    name: string
    textureScale: number | undefined
    enabled = true
    constructor(options: { name: string; textureScale?: number }) {
      this.name = options.name
      this.textureScale = options.textureScale
      cesiumFakes.created.push(this)
    }
  }
  class FakeComposite {
    name: string
    enabled = true
    constructor(options: { name: string }) {
      this.name = options.name
      cesiumFakes.created.push(this)
    }
  }
  return {
    ...actual,
    PostProcessStage: FakeStage,
    PostProcessStageComposite: FakeComposite,
    sampleTerrainMostDetailed: cesiumFakes.sampleTerrainMostDetailed,
  }
})

import { useCesiumWeatherStages } from '@/hooks/useCesiumWeatherStages'

function fakeViewer() {
  const stages = {
    list: [] as unknown[],
    add(stage: unknown) {
      this.list.push(stage)
      return stage
    },
    remove(stage: unknown) {
      const index = this.list.indexOf(stage)
      if (index >= 0) this.list.splice(index, 1)
    },
    get(index: number) {
      return this.list[index]
    },
    get length() {
      return this.list.length
    },
  }
  return {
    isDestroyed: () => false,
    terrainProvider: {},
    scene: {
      postProcessStages: stages,
      preRender: new Cesium.Event(),
      terrainProviderChanged: new Cesium.Event(),
      logarithmicDepthBuffer: true,
      globe: { getHeight: () => undefined },
    },
  }
}

const OPTIONS: WeatherStagesOptions = {
  airportIcao: 'KOAK',
  refLat: 37.7213,
  refLon: -122.2208,
  airportElevationM: 9,
  followedCallsign: null,
  interpolatedAircraft: new Map(),
  viewMode: '3d',
  isInset: false,
}

type FakeViewer = ReturnType<typeof fakeViewer>

/** One render of the hook, with the effects it queued, and whether they left state changed. */
function renderOnce(viewer: FakeViewer): { result: boolean; dirty: boolean } {
  hookState.begin()
  hookState.clear()
  // biome-ignore lint/correctness/useHookAtTopLevel: driven by the minimal renderer above, one render per call
  const result = useCesiumWeatherStages(viewer as unknown as Cesium.Viewer, OPTIONS)
  hookState.runLayoutEffects()
  hookState.runEffects()
  return { result, dirty: hookState.isDirty() }
}

/** Re-renders while the effects leave state changed. */
function settle(viewer: FakeViewer): boolean {
  let rendered = renderOnce(viewer)
  for (let pass = 0; rendered.dirty && pass < 10; pass++) rendered = renderOnce(viewer)
  if (rendered.dirty) throw new Error('the weather stage hook did not settle')
  return rendered.result
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** Settles the effects that only run once the terrain sample resolves. */
async function renderSettled(viewer: FakeViewer): Promise<boolean> {
  let result = settle(viewer)
  await flush()
  result = settle(viewer)
  await flush()
  return result
}

/** The cloud pass is the only stage created with a texture scale */
function cloudTextures(): number[] {
  return cesiumFakes.created.flatMap((stage) => (stage.textureScale === undefined ? [] : [stage.textureScale]))
}

beforeEach(() => {
  hookState.unmount()
  hookState.reset()
  cesiumFakes.created.length = 0
  settings.weather.stageQuality = 'high'
})

describe('useCesiumWeatherStages', () => {
  it('gives the main view the cloud pass resolution of its quality preset', async () => {
    const viewer = fakeViewer()
    await renderSettled(viewer)
    expect(cloudTextures()).toEqual([0.5])

    settings.weather.stageQuality = 'low'
    await renderSettled(viewer)
    expect(cloudTextures()).toEqual([0.5, 0.25])
  })
})
