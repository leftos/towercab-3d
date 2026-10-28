import * as Cesium from 'cesium'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUILDING_LOOKUP_BUILD_BUDGET_MS } from '@/constants'
import {
  attachBuildingLookup,
  BUILDING_LOOKUP_DEFINE,
  BUILDING_LOOKUP_SAMPLER,
  computeFeatureStats,
  emptyLookupTexels,
  type FeatureProperties,
  featureGroundOffset,
  featureHash,
  featureKey,
  fillTwins,
  getTileFeatureStats,
  glslBuildingLookupRead,
  installBuildingLookupStage,
  LOOKUP_ROW_GROUND,
  LOOKUP_ROW_TOP,
  lookupTexels,
  type PrimitiveGeometry,
  readTileGeometry,
} from '@/utils/buildingBaseLookup'
import { BOX_TRIANGLES, ENU, type FakeContext, fakeContext, fakeModel } from '@/utils/buildingLookupFakes.test-support'
import { PACK_HASH_STATES } from '@/utils/buildingStyle'

interface Box {
  id: number
  x: [number, number]
  y: [number, number]
  z: [number, number]
}

function geometry(boxes: readonly Box[]): PrimitiveGeometry {
  const positions: number[] = []
  const featureIds: number[] = []
  const indices: number[] = []
  for (const { id, x, y, z } of boxes) {
    const first = featureIds.length
    for (const zz of z) {
      positions.push(x[0], y[0], zz, x[1], y[0], zz, x[1], y[1], zz, x[0], y[1], zz)
    }
    featureIds.push(...Array<number>(8).fill(id))
    indices.push(...BOX_TRIANGLES.map((index) => index + first))
  }
  return {
    positions: new Float32Array(positions),
    featureIds: new Float32Array(featureIds),
    indices: new Uint16Array(indices),
    modelMatrix: ENU,
  }
}

const TERMINAL: Box = { id: 0, x: [0, 10], y: [0, 20], z: [5, 17] }
const TOWER: Box = { id: 1, x: [30, 40], y: [0, 5], z: [0, 30] }

function properties(values: Record<string, unknown>): FeatureProperties {
  return { getProperty: (name) => values[name] }
}

describe('computeFeatureStats', () => {
  it('takes base, roof and footprint area from a box', () => {
    const stats = computeFeatureStats([geometry([TERMINAL])], 1)

    expect(stats.base[0]).toBeCloseTo(5, 3)
    expect(stats.roof[0]).toBeCloseTo(17, 3)
    expect(stats.area[0]).toBeCloseTo(200, 2)
    expect(stats.hasGeometry[0]).toBe(1)
    expect(stats.baseMC[2]).toBeCloseTo(5, 6)
  })

  it('measures base and roof along the local up of a building about 70 km from the model origin', () => {
    // At the equator the geodetic and geocentric up agree. The model frame sits 0.63° of longitude
    // (about 70 km) west of the building, raised so the building's ground is at 0 along its own up.
    const radius = Cesium.Ellipsoid.WGS84.maximumRadius
    const theta = Cesium.Math.toRadians(0.63)
    const origin = Cesium.Cartesian3.fromDegrees(0, 0, radius / Math.cos(theta) - radius)
    const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(origin)
    const site = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(0.63, 0, 0))
    const siteToModel = Cesium.Matrix4.multiply(
      Cesium.Matrix4.inverse(modelMatrix, new Cesium.Matrix4()),
      site,
      new Cesium.Matrix4(),
    )
    const box = geometry([{ id: 0, x: [0, 10], y: [0, 20], z: [0, 30] }])
    const positions = new Float32Array(box.positions.length)
    const point = new Cesium.Cartesian3()
    for (let v = 0; v < positions.length; v += 3) {
      Cesium.Cartesian3.fromElements(box.positions[v], box.positions[v + 1], box.positions[v + 2], point)
      Cesium.Matrix4.multiplyByPoint(siteToModel, point, point)
      positions.set([point.x, point.y, point.z], v)
    }

    const stats = computeFeatureStats([{ ...box, positions, modelMatrix }], 1)

    expect(Math.abs(stats.base[0])).toBeLessThan(0.01)
    expect(Math.abs(stats.roof[0] - 30)).toBeLessThan(0.01)
    expect(stats.area[0]).toBeCloseTo(200, 0)
  })

  it('keeps the footprint and eave finite when one vertex is not a number', () => {
    const box = geometry([TERMINAL])
    const positions = box.positions.slice()
    // Vertex 1, a bottom corner: the feature's up comes from vertex 0, and the roof triangles skip it.
    positions[1 * 3 + 2] = Number.NaN

    const stats = computeFeatureStats([{ ...box, positions }], 1)

    expect(stats.area[0]).toBeCloseTo(200, 2)
    expect(stats.eave[0]).toBeCloseTo(17, 3)
  })

  it('keeps two features in one buffer apart', () => {
    const stats = computeFeatureStats([geometry([TERMINAL, TOWER])], 2)

    expect([stats.base[0], stats.roof[0], stats.area[0]].map((v) => Number(v.toFixed(2)))).toEqual([5, 17, 200])
    expect([stats.base[1], stats.roof[1], stats.area[1]].map((v) => Number(v.toFixed(2)))).toEqual([0, 30, 50])
    expect(stats.baseMC[3]).toBeGreaterThanOrEqual(30)
  })

  it('leaves a feature with no vertices at zero, and skips ids past the count', () => {
    const stats = computeFeatureStats([geometry([TERMINAL, { ...TOWER, id: 7 }])], 3)

    expect(stats.hasGeometry[2]).toBe(0)
    expect([stats.base[2], stats.roof[2], stats.area[2]]).toEqual([0, 0, 0])
    expect(stats.hasGeometry[1]).toBe(0)
    expect([...lookupTexels(stats).subarray(8, 12)]).toEqual([0, 0, 0, 0])
  })
})

describe('fillTwins', () => {
  it("gives a vertex-less feature its twin's values, matched by the part's own element id", () => {
    const stats = computeFeatureStats([geometry([TERMINAL])], 3)
    const keys = [
      featureKey(properties({ elementId: 'w1', 'part#elementId': 'w9' })),
      featureKey(properties({ elementId: 'w1', 'part#elementId': 'w9' })),
      featureKey(properties({ elementId: 'w1' })),
    ]

    fillTwins(stats, keys)

    expect(keys).toEqual(['w9', 'w9', 'w1'])
    expect([stats.base[1], stats.roof[1], stats.area[1]]).toEqual([stats.base[0], stats.roof[0], stats.area[0]])
    expect(stats.hasGeometry[1]).toBe(0)
    expect(stats.area[2]).toBe(0)
  })

  it('never matches features without an element id', () => {
    const stats = computeFeatureStats([geometry([TERMINAL])], 2)

    fillTwins(stats, [featureKey(properties({})), featureKey(properties({}))])

    expect(stats.area[1]).toBe(0)
  })
})

describe('featureGroundOffset', () => {
  it("reads a raised part's own min_height, never its parent's", () => {
    expect(
      featureGroundOffset(properties({ 'part#elementId': 'w2', 'part#min_height': '6 m', min_height: '40' })),
    ).toBe(6)
    expect(featureGroundOffset(properties({ 'part#elementId': 'w2', min_height: '40' }))).toBe(0)
    expect(featureGroundOffset(properties({ elementId: 'w3', min_height: 4.5 }))).toBe(4.5)
    expect(featureGroundOffset(properties({ elementId: 'w3', min_height: '-2' }))).toBe(0)
    expect(featureGroundOffset(properties({ 'part#elementId': null, 'part#min_height': '6', min_height: '3' }))).toBe(3)
  })
})

describe('featureHash', () => {
  const at = (latitude: unknown, longitude: unknown) =>
    properties({ 'cesium#latitude': latitude, 'cesium#longitude': longitude })

  it('featureHash is a stable fraction in [0, 1)', () => {
    expect(featureHash(at(37.61568, -122.38905))).toBe(featureHash(at(37.61568, -122.38905)))
    for (let i = 0; i < 20; i++) {
      const hash = featureHash(at(37.6 + i * 1e-3, -122.4 + i * 7e-4))
      expect(hash).toBeGreaterThanOrEqual(0)
      expect(hash).toBeLessThan(1)
    }
    expect(featureHash(at(undefined, -122.38905))).toBe(0)
    expect(featureHash(properties({}))).toBe(0)
  })

  it('floors to the palette state the packed colour carried before the hash moved to the lookup', () => {
    const state = (latitude: number, longitude: number) =>
      Math.floor(featureHash(at(latitude, longitude)) * PACK_HASH_STATES)

    expect(state(37.61568, -122.38905)).toBe(3)
    expect(state(37.72118, -122.22054)).toBe(2)
    expect(state(51.4775, -0.4614)).toBe(0)
  })
})

describe('lookupTexels', () => {
  it('holds row 0 first: the base vertex and the ground offset of each feature', () => {
    const stats = computeFeatureStats([geometry([TERMINAL, TOWER])], 2)
    stats.groundOffset[1] = 6

    const texels = lookupTexels(stats)

    expect(texels).toHaveLength(2 * 8)
    expect(texels[2]).toBeCloseTo(5, 4)
    expect(texels[3]).toBe(0)
    expect(texels[4]).toBeGreaterThanOrEqual(30)
    expect(texels[7]).toBe(6)
  })

  it("holds row 1 after it: each feature's wall top above its ground and its hash, a twin's from its owner", () => {
    const stats = computeFeatureStats([geometry([TERMINAL, TOWER])], 3)
    stats.groundOffset.set([2, 6, 2])
    stats.hash.set([0.25, 0.75, 0.25])
    fillTwins(stats, ['w1', 'w2', 'w1'])

    const texels = lookupTexels(stats)
    const row1 = [...texels.subarray(3 * 4)]

    expect(row1).toHaveLength(3 * 4)
    expect(row1[0]).toBeCloseTo(17 - 5 + 2, 3)
    expect(row1.slice(1, 4)).toEqual([0.25, 0, 0])
    expect(row1[4]).toBeCloseTo(30 - 0 + 6, 3)
    expect(row1.slice(5, 8)).toEqual([0.75, 0, 0])
    expect(row1[8]).toBeCloseTo(17 - 5 + 2, 3)
    expect(row1.slice(9, 12)).toEqual([0.25, 0, 0])
  })
})

describe('lookupTexels wall top', () => {
  /** A gabled house: walls from 0 to 6 m, two sloped roof faces meeting at a 9 m ridge. */
  function gabledHouse(): PrimitiveGeometry {
    const positions = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 8, 0],
      [0, 8, 0],
      [0, 0, 6],
      [10, 0, 6],
      [10, 8, 6],
      [0, 8, 6],
      [0, 4, 9],
      [10, 4, 9],
    ].flat()
    return {
      positions: new Float32Array(positions),
      featureIds: new Float32Array(10),
      indices: new Uint16Array([0, 1, 5, 0, 5, 4, 4, 5, 9, 4, 9, 8, 6, 7, 8, 6, 8, 9]),
      modelMatrix: ENU,
    }
  }

  const wallTop = (stats: ReturnType<typeof computeFeatureStats>, f: number) =>
    lookupTexels(stats)[stats.count * 4 + f * 4]

  it('puts the wall top of a flat box at its roof, above the ground offset', () => {
    const stats = computeFeatureStats([geometry([{ id: 0, x: [0, 10], y: [0, 20], z: [0, 10] }])], 1)
    stats.groundOffset[0] = 2

    expect(wallTop(stats, 0)).toBeCloseTo(12, 3)
  })

  it('puts the wall top of a gabled house at its eaves, not its ridge', () => {
    const stats = computeFeatureStats([gabledHouse()], 1)

    expect(stats.roof[0]).toBeCloseTo(9, 3)
    expect(wallTop(stats, 0)).toBeCloseTo(6, 3)
  })

  it("gives a twin its owner's wall top, and a feature with no vertices and no twin -1", () => {
    const stats = computeFeatureStats([gabledHouse()], 3)
    stats.groundOffset.set([1, 1, 4])
    fillTwins(stats, ['w1', 'w1', 'w2'])

    expect(wallTop(stats, 1)).toBeCloseTo(7, 3)
    expect(wallTop(stats, 2)).toBe(-1)
  })
})

describe('emptyLookupTexels', () => {
  it('carries the no-lookup sentinels: a negative ground offset, an unknown wall top and hash 0', () => {
    expect([...emptyLookupTexels()]).toEqual([0, 0, 0, -1, -1, 0, 0, 0])
  })
})

interface FakeStage {
  process(renderResources: object, primitive: object, frameState: object): void
}

const PRIVATE = Cesium as unknown as {
  BatchTexturePipelineStage: FakeStage
  ShaderDestination: { FRAGMENT: number }
}

function fakeRenderResources() {
  const model = {
    featureTableId: 0,
    featureTables: [
      {
        featuresLength: 2,
        batchTexture: { textureDimensions: { y: 1 }, textureStep: {}, batchTexture: {}, defaultTexture: {} },
      },
    ],
  }
  return {
    model,
    shaderBuilder: { addUniform: vi.fn(), addDefine: vi.fn() },
    uniformMap: { u_existing: () => 1 } as Record<string, () => unknown>,
  }
}

function processWith(webgl2: boolean) {
  const resources = fakeRenderResources()
  PRIVATE.BatchTexturePipelineStage.process(resources, {}, { context: { webgl2 } })
  return resources
}

describe('installBuildingLookupStage', () => {
  it('wraps BatchTexturePipelineStage.process once, even when a reloaded module installs it again', async () => {
    const original = PRIVATE.BatchTexturePipelineStage.process
    installBuildingLookupStage()
    installBuildingLookupStage()
    vi.resetModules()
    const reloaded = await import('@/utils/buildingBaseLookup')
    const reloadedCesium = (await import('cesium')) as unknown as typeof PRIVATE
    reloaded.installBuildingLookupStage()

    expect(reloadedCesium.BatchTexturePipelineStage).toBe(PRIVATE.BatchTexturePipelineStage)
    const lookupUniforms = processWith(true).shaderBuilder.addUniform.mock.calls.filter(
      (call) => call[1] === BUILDING_LOOKUP_SAMPLER,
    )
    expect(lookupUniforms).toHaveLength(1)
    expect(PRIVATE.BatchTexturePipelineStage.process).not.toBe(original)
  })

  it('binds the lookup to the fragment shader, with its define, keeping the stage’s own uniforms', () => {
    installBuildingLookupStage()
    const fragment = PRIVATE.ShaderDestination.FRAGMENT

    const { shaderBuilder, uniformMap } = processWith(true)

    expect(shaderBuilder.addUniform).toHaveBeenCalledWith('highp sampler2D', BUILDING_LOOKUP_SAMPLER, fragment)
    expect(shaderBuilder.addDefine).toHaveBeenCalledWith(BUILDING_LOOKUP_DEFINE, undefined, fragment)
    expect(Object.keys(uniformMap)).toEqual(
      expect.arrayContaining([BUILDING_LOOKUP_SAMPLER, 'u_existing', 'model_batchTexture']),
    )
  })

  it('binds nothing on WebGL1, where the shader keeps the no-lookup sentinel', () => {
    installBuildingLookupStage()

    const { shaderBuilder, uniformMap } = processWith(false)

    expect(shaderBuilder.addUniform.mock.calls.map((call) => call[1])).not.toContain(BUILDING_LOOKUP_SAMPLER)
    expect(shaderBuilder.addDefine.mock.calls.map((call) => call[0])).not.toContain(BUILDING_LOOKUP_DEFINE)
    expect(uniformMap[BUILDING_LOOKUP_SAMPLER]).toBeUndefined()
  })
})

/** A ready model drawing the terminal box. */
function terminalModel(fake: FakeContext, nodes: 'dense' | 'sparse' = 'dense') {
  const { positions, featureIds, indices } = geometry([TERMINAL])
  return fakeModel(fake, { positions, featureIds: featureIds as Float32Array, indices: indices as Uint16Array }, nodes)
}

/** The terminal box's buffers, typed as a fake model uploads them. */
function terminalBuffers() {
  const { positions, featureIds, indices } = geometry([TERMINAL])
  return { positions, featureIds: featureIds as Float32Array, indices: indices as Uint16Array }
}

describe('readTileGeometry', () => {
  it('reads every vertex a decoded attribute buffer holds, past its glTF accessor count', () => {
    const fake = fakeContext()
    const { positions, featureIds, indices } = terminalBuffers()
    const model = fakeModel(fake, { positions, featureIds, indices })
    // A Draco-decoded attribute keeps its accessor's count while its buffer holds every decoded vertex.
    for (const attribute of model._sceneGraph._runtimeNodes[0]!.runtimePrimitives[0].primitive.attributes) {
      attribute.count = 6
    }
    const read = readTileGeometry(model, fake.context._gl as unknown as WebGL2RenderingContext)
    expect(read?.primitives[0].positions).toHaveLength(8 * 3)
    expect(computeFeatureStats(read?.primitives ?? [], 1).area[0]).toBeCloseTo(10 * 20)
  })

  it('reads attributes sharing one buffer, each at its own offset', () => {
    const fake = fakeContext()
    const { positions, featureIds, indices } = terminalBuffers()
    const model = fakeModel(fake, { positions, featureIds, indices })
    const shared = fake.upload(Float32Array.of(...positions, ...featureIds))
    const [position, featureId] = model._sceneGraph._runtimeNodes[0]!.runtimePrimitives[0].primitive.attributes
    Object.assign(position, { buffer: shared, byteOffset: 0, count: 8 })
    Object.assign(featureId, { buffer: shared, byteOffset: 96, count: 8 })
    const read = readTileGeometry(model, fake.context._gl as unknown as WebGL2RenderingContext)
    expect(read?.unreadable).toEqual([])
    expect(read?.primitives[0].positions).toEqual(positions)
    expect(read?.primitives[0].featureIds).toEqual(featureIds)
    expect(computeFeatureStats(read?.primitives ?? [], 1).area[0]).toBeCloseTo(10 * 20)
  })

  it('refuses a primitive whose attribute reaches past its buffer', () => {
    const fake = fakeContext()
    const model = fakeModel(fake, terminalBuffers())
    const featureId = model._sceneGraph._runtimeNodes[0]!.runtimePrimitives[0].primitive.attributes[1]
    Object.assign(featureId, { byteOffset: 4 })
    const read = readTileGeometry(model, fake.context._gl as unknown as WebGL2RenderingContext)
    expect(read).toEqual({ primitives: [], unreadable: ['attribute past its buffer (needs 36 bytes, has 32)'] })
  })
})

function fakeTile(model: object, url: string, getFeature = () => properties({ elementId: url })) {
  const content = { _model: model, featuresLength: 1, url, getFeature, applyStyle: vi.fn() }
  return { content } as unknown as Cesium.Cesium3DTile
}

/** The `applyStyle` spy on a fake tile's content. */
function applyStyleOf(tile: Cesium.Cesium3DTile) {
  return (tile.content as unknown as { applyStyle: ReturnType<typeof vi.fn> }).applyStyle
}

/** Attaches the lookup to fakes; `restyleWhen` is the lookup's restyle predicate. */
function attachFakes(restyleWhen: () => boolean = () => true) {
  const fake = fakeContext()
  const tileset = {
    tileLoad: new Cesium.Event(),
    tileUnload: new Cesium.Event(),
    makeStyleDirty: vi.fn(),
    style: { name: 'building style' },
  }
  const scene = { postRender: new Cesium.Event(), context: fake.context }
  const textures: { destroy: ReturnType<typeof vi.fn> }[] = []
  const createTexture = vi.fn(() => {
    const texture = { destroy: vi.fn() }
    textures.push(texture)
    return texture
  })
  const detach = attachBuildingLookup(
    tileset as unknown as Cesium.Cesium3DTileset,
    scene as unknown as Cesium.Scene,
    createTexture,
    restyleWhen,
  )
  const render = () => scene.postRender.raiseEvent()
  return { fake, tileset, render, createTexture, textures, detach }
}

describe('attachBuildingLookup', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("builds a loaded tile's two-row lookup at the next render, and releases it when the tile unloads", () => {
    const { fake, tileset, render, createTexture, textures } = attachFakes()
    const tile = fakeTile(terminalModel(fake), 'a.glb')

    tileset.tileLoad.raiseEvent(tile)
    expect(getTileFeatureStats(tile.content)).toBeUndefined()
    render()

    expect(createTexture).toHaveBeenCalledWith(fake.context, 1, 2, expect.any(Float32Array))
    expect((createTexture.mock.calls[0] as unknown[])[3]).toHaveLength(1 * 2 * 4)
    expect(getTileFeatureStats(tile.content)?.base[0]).toBeCloseTo(5, 3)

    tileset.tileUnload.raiseEvent(tile)

    expect(textures[0].destroy).toHaveBeenCalledTimes(1)
    expect(getTileFeatureStats(tile.content)).toBeUndefined()
  })

  it("fills each feature's hash from its position and carries it in row 1 of the texture", () => {
    const { fake, tileset, render, createTexture } = attachFakes()
    const feature = properties({ elementId: 'w1', 'cesium#latitude': 37.61568, 'cesium#longitude': -122.38905 })
    const tile = fakeTile(terminalModel(fake), 'a.glb', () => feature)

    tileset.tileLoad.raiseEvent(tile)
    render()

    const hash = featureHash(feature)
    expect(hash).toBeGreaterThan(0)
    expect(getTileFeatureStats(tile.content)?.hash[0]).toBe(hash)
    const texels = (createTexture.mock.calls[0] as unknown[])[3] as Float32Array
    expect(texels[1 * 4 + 1]).toBeCloseTo(hash, 6)
  })

  it('builds the empty texture of a tile without a lookup through the same factory, 1 wide and 2 high', () => {
    const { fake, createTexture } = attachFakes()
    installBuildingLookupStage()
    const resources = fakeRenderResources()
    PRIVATE.BatchTexturePipelineStage.process(resources, {}, { context: fake.context })

    resources.uniformMap[BUILDING_LOOKUP_SAMPLER]()

    expect(createTexture).toHaveBeenCalledTimes(1)
    expect(createTexture).toHaveBeenCalledWith(fake.context, 1, 2, emptyLookupTexels())
  })

  it('releases every lookup on detach and stops listening', () => {
    const { fake, tileset, render, createTexture, textures, detach } = attachFakes()
    tileset.tileLoad.raiseEvent(fakeTile(terminalModel(fake), 'a.glb'))
    render()

    detach()
    tileset.tileLoad.raiseEvent(fakeTile(terminalModel(fake), 'b.glb'))
    render()

    expect(textures[0].destroy).toHaveBeenCalledTimes(1)
    expect(createTexture).toHaveBeenCalledTimes(1)
  })

  it('keeps a tile whose model is not ready queued until it is', () => {
    const { fake, tileset, render, createTexture } = attachFakes()
    const model = { ...terminalModel(fake), ready: false }
    const tile = fakeTile(model, 'a.glb')

    tileset.tileLoad.raiseEvent(tile)
    render()
    expect(createTexture).not.toHaveBeenCalled()

    model.ready = true
    render()
    expect(createTexture).toHaveBeenCalledTimes(1)
  })

  it('drops a tile whose build throws, logs it once naming the tile, and builds the rest', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { fake, tileset, render, createTexture } = attachFakes()
    const broken = fakeTile(terminalModel(fake), 'broken.glb', () => {
      throw new Error('no feature')
    })

    tileset.tileLoad.raiseEvent(broken)
    tileset.tileLoad.raiseEvent(fakeTile(terminalModel(fake), 'good.glb'))
    render()
    render()

    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0][0])).toContain('broken.glb')
    expect(createTexture).toHaveBeenCalledTimes(1)
    expect(getTileFeatureStats(broken.content)).toBeUndefined()
  })

  it('restyles each tile a pass built, and only those', () => {
    const { fake, tileset, render, createTexture } = attachFakes(() => true)
    const a = fakeTile(terminalModel(fake), 'a.glb')
    const b = fakeTile(terminalModel(fake), 'b.glb')
    const waiting = fakeTile({ ...terminalModel(fake), ready: false }, 'waiting.glb')
    for (const tile of [a, b, waiting]) tileset.tileLoad.raiseEvent(tile)

    render()

    expect(createTexture).toHaveBeenCalledTimes(2)
    for (const built of [a, b]) {
      expect(applyStyleOf(built)).toHaveBeenCalledTimes(1)
      expect(applyStyleOf(built)).toHaveBeenCalledWith(tileset.style)
    }
    expect(applyStyleOf(waiting)).not.toHaveBeenCalled()
    expect(tileset.makeStyleDirty).not.toHaveBeenCalled()
  })

  it("keeps restyling the other built tiles when one tile's applyStyle throws", () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { fake, tileset, render } = attachFakes(() => true)
    const first = fakeTile(terminalModel(fake), 'a.glb')
    const second = fakeTile(terminalModel(fake), 'b.glb')
    applyStyleOf(first).mockImplementation(() => {
      throw new Error('no model')
    })
    tileset.tileLoad.raiseEvent(first)
    tileset.tileLoad.raiseEvent(second)

    expect(() => render()).not.toThrow()

    expect(applyStyleOf(second)).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('restyles nothing while the shape fallback is off', () => {
    const { fake, tileset, render, createTexture } = attachFakes(() => false)
    const tile = fakeTile(terminalModel(fake), 'a.glb')
    tileset.tileLoad.raiseEvent(tile)

    render()

    expect(createTexture).toHaveBeenCalledTimes(1)
    expect(applyStyleOf(tile)).not.toHaveBeenCalled()
    expect(tileset.makeStyleDirty).not.toHaveBeenCalled()
  })

  it('restyles the tile it built when a pass runs out of budget', () => {
    const { fake, tileset, render, createTexture } = attachFakes(() => true)
    const first = fakeTile(terminalModel(fake), 'a.glb')
    const second = fakeTile(terminalModel(fake), 'b.glb')
    tileset.tileLoad.raiseEvent(first)
    tileset.tileLoad.raiseEvent(second)
    // The pass starts at 0 and checks the budget at 0 before the first tile, then past it.
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(BUILDING_LOOKUP_BUILD_BUDGET_MS + 1)

    render()

    expect(createTexture).toHaveBeenCalledTimes(1)
    expect(applyStyleOf(first)).toHaveBeenCalledTimes(1)
    expect(applyStyleOf(second)).not.toHaveBeenCalled()
  })

  it('skips the empty slots of a sparse runtime-node list', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { fake, tileset, render, createTexture } = attachFakes()

    tileset.tileLoad.raiseEvent(fakeTile(terminalModel(fake, 'sparse'), 'a.glb'))
    render()

    expect(error).not.toHaveBeenCalled()
    expect(createTexture).toHaveBeenCalledTimes(1)
  })
})

describe('glslBuildingLookupRead', () => {
  it('reads the given row of the lookup at the clamped id', () => {
    expect(glslBuildingLookupRead('i', '0')).toBe(
      `texelFetch(${BUILDING_LOOKUP_SAMPLER}, ivec2(clamp(i, 0, textureSize(${BUILDING_LOOKUP_SAMPLER}, 0).x - 1), 0), 0)`,
    )
    expect(glslBuildingLookupRead('id', '1')).toContain(', 1), 0)')
    expect(glslBuildingLookupRead('id', '0')).toContain(', 0), 0)')
  })

  it('names row 0 the ground row and row 1 the wall-top row', () => {
    expect([LOOKUP_ROW_GROUND, LOOKUP_ROW_TOP]).toEqual([0, 1])
  })
})
