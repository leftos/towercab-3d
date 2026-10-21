import * as Cesium from 'cesium'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Drives useTowerModel without a DOM: react's hooks are replaced by a minimal renderer that keeps
 * refs and effect deps by call order, runs effects after each render and cleans them up when their
 * deps change.
 */
const hookState = vi.hoisted(() => {
  type Slot = { deps?: unknown[]; cleanup?: (() => void) | undefined; ref?: { current: unknown } }
  const slots: Slot[] = []
  const pending: Array<() => void> = []
  let index = 0
  const depsChanged = (a: unknown[] | undefined, b: unknown[] | undefined) =>
    !a || !b || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]))
  return {
    slots,
    pending,
    begin() {
      index = 0
    },
    next(): Slot {
      if (!slots[index]) slots[index] = {}
      return slots[index++]
    },
    depsChanged,
    unmount() {
      for (const slot of slots) {
        slot.cleanup?.()
        slot.cleanup = undefined
      }
    },
    reset() {
      slots.length = 0
      pending.length = 0
      index = 0
    },
  }
})

vi.mock('react', () => {
  const api = {
    useRef: <T>(initial: T) => {
      const slot = hookState.next()
      if (!slot.ref) slot.ref = { current: initial }
      return slot.ref
    },
    useEffect: (fn: () => (() => void) | undefined, deps?: unknown[]) => {
      const slot = hookState.next()
      if (!hookState.depsChanged(slot.deps, deps)) return
      slot.deps = deps
      hookState.pending.push(() => {
        slot.cleanup?.()
        slot.cleanup = fn() ?? undefined
      })
    },
    useCallback: <T>(fn: T) => fn,
  }
  return { ...api, default: api }
})

const airportState = vi.hoisted(() => ({
  currentAirport: null as null | { icao: string; lat: number; lon: number; elevation: number },
}))
vi.mock('@/stores/airportStore', () => ({
  useAirportStore: (selector: (state: typeof airportState) => unknown) => selector(airportState),
}))

const positioning = vi.hoisted(() => {
  const listeners = new Set<(state: unknown) => void>()
  const inactive = { isActive: false, step: 'model', targetIcao: null, getAbsoluteModelPosition: () => null }
  return {
    listeners,
    inactive,
    state: inactive as unknown,
    getState() {
      return this.state
    },
    subscribe(listener: (state: unknown) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
})
vi.mock('@/stores/towerPositioningStore', () => ({
  useTowerPositioningStore: {
    subscribe: positioning.subscribe,
    getState: () => positioning.getState(),
  },
}))

const mods = vi.hoisted(() => ({
  getTowerModel: vi.fn(),
  getTowerPlacement: vi.fn(),
}))
vi.mock('@/services/ModService', () => ({ modService: mods }))

// Field elevation becomes ellipsoidal height by a fixed 30 m undulation.
const GEOID_UNDULATION = 30
vi.mock('@/services/GeoidService', () => ({
  geoidService: { mslToEllipsoidal: (_lat: number, _lon: number, msl: number) => msl + GEOID_UNDULATION },
}))
vi.mock('@/utils/tauriApi', () => ({ convertToAssetUrlSync: (url: string) => url }))

const cesiumFakes = vi.hoisted(() => ({ fromGltfAsync: vi.fn(), sampleTerrainMostDetailed: vi.fn() }))
vi.mock('cesium', async (importOriginal) => {
  const actual = await importOriginal<typeof import('cesium')>()
  return {
    ...actual,
    Model: { fromGltfAsync: cesiumFakes.fromGltfAsync },
    sampleTerrainMostDetailed: cesiumFakes.sampleTerrainMostDetailed,
  }
})

import { useTowerModel } from '@/hooks/useTowerModel'
import { towerModelMatrix } from '@/utils/modelOrientation'
import { cabNightFactor } from '@/utils/nightBrightness'

interface FakeModel {
  modelMatrix: Cesium.Matrix4
  lightColor: Cesium.Cartesian3 | undefined
  imageBasedLighting: { imageBasedLightingFactor: Cesium.Cartesian2 }
  destroy: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
}

const KOAK = { icao: 'KOAK', lat: 37.7213, lon: -122.2208, elevation: 9 }
const KSFO = { icao: 'KSFO', lat: 37.619, lon: -122.375, elevation: 13 }
const FIELD_KOAK = KOAK.elevation * 0.3048 + GEOID_UNDULATION
const MANIFEST_HEIGHT = 2.5

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function fakeModel(options: { modelMatrix: Cesium.Matrix4 }): FakeModel {
  return {
    modelMatrix: options.modelMatrix,
    lightColor: undefined,
    imageBasedLighting: { imageBasedLightingFactor: new Cesium.Cartesian2(1, 1) },
    destroy: vi.fn(),
    isDestroyed: () => false,
  }
}

function fakeViewer(terrainProvider: unknown) {
  return {
    terrainProvider,
    isDestroyed: () => false,
    scene: {
      primitives: { add: vi.fn(), remove: vi.fn() },
      globe: { getHeight: vi.fn(() => undefined), terrainProviderChanged: new Cesium.Event() },
      light: { color: new Cesium.Color(0.9, 0.8, 0.7, 1), intensity: 2 },
    },
  }
}

type FakeViewer = ReturnType<typeof fakeViewer>

const NIGHT_OFF = { sunElevation: 30, nightDarkeningEnabled: false, nightDarkeningIntensity: 0.7 }

function render(viewer: FakeViewer, options: typeof NIGHT_OFF = NIGHT_OFF) {
  hookState.begin()
  const getState = useTowerModel(viewer as unknown as Cesium.Viewer, options)
  const effects = hookState.pending.splice(0)
  for (const run of effects) run()
  return getState
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function heightOf(modelMatrix: Cesium.Matrix4): number {
  return Cesium.Cartographic.fromCartesian(Cesium.Matrix4.getTranslation(modelMatrix, new Cesium.Cartesian3())).height
}

function towerMod(icao: string) {
  return { manifest: { scale: 1 }, modelUrl: `mods/towers/${icao}/model.glb`, basePath: `mods/towers/${icao}` }
}

function placement(airport: typeof KOAK) {
  return { lat: airport.lat, lon: airport.lon, height: MANIFEST_HEIGHT, rotation: 0, source: 'manifest' }
}

const loadSpy = cesiumFakes.fromGltfAsync
const sampleSpy = cesiumFakes.sampleTerrainMostDetailed

beforeEach(() => {
  hookState.reset()
  positioning.listeners.clear()
  positioning.state = positioning.inactive
  airportState.currentAirport = KOAK
  mods.getTowerModel.mockReset()
  mods.getTowerPlacement.mockReset()
  mods.getTowerModel.mockImplementation((icao: string) => towerMod(icao))
  mods.getTowerPlacement.mockImplementation((icao: string) => placement(icao === 'KSFO' ? KSFO : KOAK))
  loadSpy.mockReset()
  loadSpy.mockImplementation(async (options: { modelMatrix: Cesium.Matrix4 }) => fakeModel(options))
  sampleSpy.mockReset()
})

describe('useTowerModel', () => {
  it('loads nothing when the airport has no tower mod', async () => {
    mods.getTowerModel.mockReturnValue(undefined)
    render(fakeViewer(undefined))
    await flush()
    expect(loadSpy).not.toHaveBeenCalled()
  })

  it('loads nothing when ModService finds no placement for the mod', async () => {
    mods.getTowerPlacement.mockReturnValue(null)
    render(fakeViewer(undefined))
    await flush()
    expect(mods.getTowerPlacement).toHaveBeenCalledWith('KOAK')
    expect(loadSpy).not.toHaveBeenCalled()
  })

  it('drops a model that finishes loading after the airport changed', async () => {
    const provider = {}
    const viewer = fakeViewer(provider)
    sampleSpy.mockImplementation(async (_p: unknown, positions: Cesium.Cartographic[]) =>
      positions.map((p) => new Cesium.Cartographic(p.longitude, p.latitude, 5)),
    )
    const koakLoad = deferred<FakeModel>()
    loadSpy.mockImplementationOnce(() => koakLoad.promise)

    render(viewer)
    await flush()
    expect(loadSpy).toHaveBeenCalledTimes(1)

    airportState.currentAirport = KSFO
    render(viewer)
    await flush()

    const stale = fakeModel({ modelMatrix: Cesium.Matrix4.IDENTITY })
    koakLoad.resolve(stale)
    await flush()

    expect(stale.destroy).toHaveBeenCalled()
    expect(viewer.scene.primitives.add).not.toHaveBeenCalledWith(stale)
    expect(viewer.scene.primitives.add).toHaveBeenCalledTimes(1)
    expect(mods.getTowerPlacement).toHaveBeenLastCalledWith('KSFO')
  })

  it('places the cab at the field elevation until terrain arrives, then on the sampled terrain', async () => {
    const viewer = fakeViewer(undefined)
    const getState = render(viewer)
    await flush()

    expect(sampleSpy).not.toHaveBeenCalled()
    expect(loadSpy).toHaveBeenCalledTimes(1)
    const model = viewer.scene.primitives.add.mock.calls[0][0] as FakeModel
    expect(heightOf(model.modelMatrix)).toBeCloseTo(FIELD_KOAK + MANIFEST_HEIGHT, 3)
    expect(getState().loaded).toBe(true)

    const TERRAIN = 12
    sampleSpy.mockImplementation(async (_p: unknown, positions: Cesium.Cartographic[]) =>
      positions.map((p) => new Cesium.Cartographic(p.longitude, p.latitude, TERRAIN)),
    )
    viewer.terrainProvider = {}
    viewer.scene.globe.terrainProviderChanged.raiseEvent(viewer.terrainProvider)
    await flush()

    expect(sampleSpy).toHaveBeenCalledTimes(1)
    expect(loadSpy).toHaveBeenCalledTimes(1)
    expect(heightOf(model.modelMatrix)).toBeCloseTo(TERRAIN + MANIFEST_HEIGHT, 3)
  })

  it('falls back to the field elevation when the terrain sample has no height', async () => {
    const viewer = fakeViewer({})
    // Cesium leaves the height undefined where the terrain has no data.
    sampleSpy.mockImplementation(async (_p: unknown, positions: Cesium.Cartographic[]) =>
      positions.map((p) => ({ longitude: p.longitude, latitude: p.latitude, height: undefined })),
    )
    render(viewer)
    await flush()
    const model = viewer.scene.primitives.add.mock.calls[0][0] as FakeModel
    expect(heightOf(model.modelMatrix)).toBeCloseTo(FIELD_KOAK + MANIFEST_HEIGHT, 3)
  })

  it('falls back to the field elevation when the terrain sample fails', async () => {
    const viewer = fakeViewer({})
    sampleSpy.mockRejectedValue(new Error('tile request failed'))
    render(viewer)
    await flush()
    const model = viewer.scene.primitives.add.mock.calls[0][0] as FakeModel
    expect(heightOf(model.modelMatrix)).toBeCloseTo(FIELD_KOAK + MANIFEST_HEIGHT, 3)
  })

  it('moves the loaded cab when the positioning wizard edits it', async () => {
    const TERRAIN = 7
    const viewer = fakeViewer({})
    sampleSpy.mockImplementation(async (_p: unknown, positions: Cesium.Cartographic[]) =>
      positions.map((p) => new Cesium.Cartographic(p.longitude, p.latitude, TERRAIN)),
    )
    const getState = render(viewer)
    await flush()
    const model = viewer.scene.primitives.add.mock.calls[0][0] as FakeModel

    const moved = { lat: KOAK.lat + 0.0001, lon: KOAK.lon - 0.0001, height: 4, rotation: 45 }
    const wizardState = {
      isActive: true,
      step: 'model',
      targetIcao: 'koak',
      modelOffset: { north: 11, east: -9, up: 1.5 },
      modelRotation: 45,
      getAbsoluteModelPosition: () => moved,
    }
    for (const listener of positioning.listeners) listener(wizardState)

    const expected = towerModelMatrix(moved.lon, moved.lat, TERRAIN + moved.height, moved.rotation, 1)
    for (let i = 0; i < 16; i++) {
      expect(model.modelMatrix[i]).toBeCloseTo(expected[i], 6)
    }
    expect(getState().modelMatrix).toEqual(Cesium.Matrix4.toArray(model.modelMatrix))
  })

  it('treats the startup ellipsoid provider as no terrain and re-places on world terrain', async () => {
    const viewer = fakeViewer(new Cesium.EllipsoidTerrainProvider())
    render(viewer)
    await flush()

    expect(sampleSpy).not.toHaveBeenCalled()
    const model = viewer.scene.primitives.add.mock.calls[0][0] as FakeModel
    expect(heightOf(model.modelMatrix)).toBeCloseTo(FIELD_KOAK + MANIFEST_HEIGHT, 3)

    const TERRAIN = 9
    sampleSpy.mockImplementation(async (_p: unknown, positions: Cesium.Cartographic[]) =>
      positions.map((p) => new Cesium.Cartographic(p.longitude, p.latitude, TERRAIN)),
    )
    viewer.terrainProvider = {}
    viewer.scene.globe.terrainProviderChanged.raiseEvent(viewer.terrainProvider)
    await flush()

    expect(sampleSpy).toHaveBeenCalledTimes(1)
    expect(heightOf(model.modelMatrix)).toBeCloseTo(TERRAIN + MANIFEST_HEIGHT, 3)
  })

  it('keeps a wizard edit in progress when terrain arrives late', async () => {
    const viewer = fakeViewer(undefined)
    render(viewer)
    await flush()
    const model = viewer.scene.primitives.add.mock.calls[0][0] as FakeModel

    const moved = { lat: KOAK.lat + 0.0002, lon: KOAK.lon + 0.0001, height: 3, rotation: 30 }
    positioning.state = {
      isActive: true,
      step: 'model',
      targetIcao: 'KOAK',
      modelOffset: { north: 22, east: 9, up: 0.5 },
      modelRotation: 30,
      getAbsoluteModelPosition: () => moved,
    }

    const TERRAIN = 11
    sampleSpy.mockImplementation(async (_p: unknown, positions: Cesium.Cartographic[]) =>
      positions.map((p) => new Cesium.Cartographic(p.longitude, p.latitude, TERRAIN)),
    )
    viewer.terrainProvider = {}
    viewer.scene.globe.terrainProviderChanged.raiseEvent(viewer.terrainProvider)
    await flush()

    const expected = towerModelMatrix(moved.lon, moved.lat, TERRAIN + moved.height, moved.rotation, 1)
    for (let i = 0; i < 16; i++) {
      expect(model.modelMatrix[i]).toBeCloseTo(expected[i], 6)
    }
  })

  it('lights the cab at the night factor times the scene light, and back to the scene light by day', async () => {
    const viewer = fakeViewer({})
    sampleSpy.mockImplementation(async (_p: unknown, positions: Cesium.Cartographic[]) =>
      positions.map((p) => new Cesium.Cartographic(p.longitude, p.latitude, 4)),
    )
    const night = { sunElevation: -40, nightDarkeningEnabled: true, nightDarkeningIntensity: 0.7 }
    const getState = render(viewer, night)
    await flush()
    const model = viewer.scene.primitives.add.mock.calls[0][0] as FakeModel

    const f = cabNightFactor(night.sunElevation, night.nightDarkeningIntensity, true)
    expect(f).toBeLessThan(1)
    expect(getState().nightFactor).toBe(f)
    const { color, intensity } = viewer.scene.light
    expect(model.lightColor?.x).toBeCloseTo(color.red * intensity * f, 9)
    expect(model.lightColor?.y).toBeCloseTo(color.green * intensity * f, 9)
    expect(model.lightColor?.z).toBeCloseTo(color.blue * intensity * f, 9)
    expect(model.imageBasedLighting.imageBasedLightingFactor.x).toBeCloseTo(f, 9)
    expect(model.imageBasedLighting.imageBasedLightingFactor.y).toBeCloseTo(f, 9)

    render(viewer, NIGHT_OFF)
    expect(model.lightColor).toBeUndefined()
    expect(model.imageBasedLighting.imageBasedLightingFactor.x).toBe(1)
    expect(model.imageBasedLighting.imageBasedLightingFactor.y).toBe(1)

    const dusk = { ...night, sunElevation: -9 }
    render(viewer, dusk)
    const g = cabNightFactor(dusk.sunElevation, dusk.nightDarkeningIntensity, true)
    expect(g).toBeLessThan(1)
    expect(g).not.toBe(f)
    expect(model.lightColor?.x).toBeCloseTo(color.red * intensity * g, 9)
    expect(model.imageBasedLighting.imageBasedLightingFactor.x).toBeCloseTo(g, 9)
  })

  it('removes and destroys the cab on unmount', async () => {
    const viewer = fakeViewer({})
    sampleSpy.mockImplementation(async (_p: unknown, positions: Cesium.Cartographic[]) =>
      positions.map((p) => new Cesium.Cartographic(p.longitude, p.latitude, 4)),
    )
    render(viewer)
    await flush()
    const model = viewer.scene.primitives.add.mock.calls[0][0] as FakeModel

    hookState.unmount()

    expect(viewer.scene.primitives.remove).toHaveBeenCalledWith(model)
    expect(model.destroy).toHaveBeenCalled()
  })

  it('stops listening for terrain changes on cleanup', async () => {
    const viewer = fakeViewer(undefined)
    render(viewer)
    await flush()
    expect(viewer.scene.globe.terrainProviderChanged.numberOfListeners).toBe(1)

    hookState.unmount()

    expect(viewer.scene.globe.terrainProviderChanged.numberOfListeners).toBe(0)
  })
})
