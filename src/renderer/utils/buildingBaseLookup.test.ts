import * as Cesium from 'cesium'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachBuildingLookup,
  BUILDING_LOOKUP_DEFINE,
  BUILDING_LOOKUP_SAMPLER,
  computeFeatureStats,
  emptyLookupTexel,
  type FeatureProperties,
  featureGroundOffset,
  featureKey,
  fillTwins,
  getTileFeatureStats,
  glslBuildingLookupRead,
  installBuildingLookupStage,
  lookupTexels,
  type PrimitiveGeometry,
} from '@/utils/buildingBaseLookup'

/** East-north-up at 0°N 0°E, where the geocentric and geodetic up agree: model z is up. */
const ENU = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(0, 0, 0))

interface Box {
  id: number
  x: [number, number]
  y: [number, number]
  z: [number, number]
}

/** A closed box, faces counter-clockwise seen from outside. */
const BOX_TRIANGLES = [
  [0, 2, 1, 0, 3, 2],
  [4, 5, 6, 4, 6, 7],
  [0, 1, 5, 0, 5, 4],
  [1, 2, 6, 1, 6, 5],
  [2, 3, 7, 2, 7, 6],
  [3, 0, 4, 3, 4, 7],
].flat()

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

describe('lookupTexels', () => {
  it('holds one row: the base vertex and the ground offset of each feature', () => {
    const stats = computeFeatureStats([geometry([TERMINAL, TOWER])], 2)
    stats.groundOffset[1] = 6

    const texels = lookupTexels(stats)

    expect(texels).toHaveLength(2 * 4)
    expect(texels[2]).toBeCloseTo(5, 4)
    expect(texels[3]).toBe(0)
    expect(texels[4]).toBeGreaterThanOrEqual(30)
    expect(texels[7]).toBe(6)
  })
})

describe('emptyLookupTexel', () => {
  it('carries the no-lookup sentinel, a negative ground offset', () => {
    expect([...emptyLookupTexel()]).toEqual([0, 0, 0, -1])
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

/** A WebGL2 context whose buffers are plain byte arrays, enough for the read-back. */
function fakeContext() {
  let bound: object | null = null
  const store = new Map<object, ArrayBuffer>()
  const gl = {
    MAX_TEXTURE_SIZE: 0x0d33,
    COPY_READ_BUFFER: 0x8f36,
    getParameter: () => 4096,
    bindBuffer: (_target: number, buffer: object | null) => {
      bound = buffer
    },
    getBufferSubData: (_target: number, _offset: number, destination: Uint8Array) => {
      destination.set(new Uint8Array(store.get(bound as object) as ArrayBuffer))
    },
  }
  const upload = (view: ArrayBufferView) => {
    const key = {}
    store.set(key, view.buffer as ArrayBuffer)
    return { _buffer: key, sizeInBytes: view.byteLength }
  }
  return { context: { webgl2: true, _gl: gl }, upload }
}

type FakeContext = ReturnType<typeof fakeContext>

function fakeModel({ upload }: FakeContext, nodes: 'dense' | 'sparse' = 'dense') {
  const { positions, featureIds, indices } = geometry([TERMINAL])
  const runtimePrimitive = {
    primitive: {
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      attributes: [
        {
          semantic: 'POSITION',
          buffer: upload(positions),
          count: 8,
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
        },
        {
          semantic: '_FEATURE_ID',
          setIndex: 0,
          buffer: upload(featureIds as Float32Array),
          count: 8,
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
        },
      ],
      indices: {
        buffer: upload(indices as Uint16Array),
        count: indices.length,
        indexDatatype: Cesium.IndexDatatype.UNSIGNED_SHORT,
      },
    },
    drawCommand: { modelMatrix: ENU },
  }
  const node = { runtimePrimitives: [runtimePrimitive] }
  return { ready: true, _sceneGraph: { _runtimeNodes: nodes === 'sparse' ? [undefined, node] : [node] } }
}

function fakeTile(model: object, url: string, getFeature = () => properties({ elementId: url })) {
  return { content: { _model: model, featuresLength: 1, url, getFeature } } as unknown as Cesium.Cesium3DTile
}

function attachFakes() {
  const fake = fakeContext()
  const tileset = { tileLoad: new Cesium.Event(), tileUnload: new Cesium.Event() }
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
  )
  const render = () => scene.postRender.raiseEvent()
  return { fake, tileset, render, createTexture, textures, detach }
}

describe('attachBuildingLookup', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("builds a loaded tile's one-row lookup at the next render, and releases it when the tile unloads", () => {
    const { fake, tileset, render, createTexture, textures } = attachFakes()
    const tile = fakeTile(fakeModel(fake), 'a.glb')

    tileset.tileLoad.raiseEvent(tile)
    expect(getTileFeatureStats(tile.content)).toBeUndefined()
    render()

    expect(createTexture).toHaveBeenCalledWith(fake.context, 1, 1, expect.any(Float32Array))
    expect(getTileFeatureStats(tile.content)?.base[0]).toBeCloseTo(5, 3)

    tileset.tileUnload.raiseEvent(tile)

    expect(textures[0].destroy).toHaveBeenCalledTimes(1)
    expect(getTileFeatureStats(tile.content)).toBeUndefined()
  })

  it('releases every lookup on detach and stops listening', () => {
    const { fake, tileset, render, createTexture, textures, detach } = attachFakes()
    tileset.tileLoad.raiseEvent(fakeTile(fakeModel(fake), 'a.glb'))
    render()

    detach()
    tileset.tileLoad.raiseEvent(fakeTile(fakeModel(fake), 'b.glb'))
    render()

    expect(textures[0].destroy).toHaveBeenCalledTimes(1)
    expect(createTexture).toHaveBeenCalledTimes(1)
  })

  it('keeps a tile whose model is not ready queued until it is', () => {
    const { fake, tileset, render, createTexture } = attachFakes()
    const model = { ...fakeModel(fake), ready: false }
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
    const broken = fakeTile(fakeModel(fake), 'broken.glb', () => {
      throw new Error('no feature')
    })

    tileset.tileLoad.raiseEvent(broken)
    tileset.tileLoad.raiseEvent(fakeTile(fakeModel(fake), 'good.glb'))
    render()
    render()

    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0][0])).toContain('broken.glb')
    expect(createTexture).toHaveBeenCalledTimes(1)
    expect(getTileFeatureStats(broken.content)).toBeUndefined()
  })

  it('skips the empty slots of a sparse runtime-node list', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { fake, tileset, render, createTexture } = attachFakes()

    tileset.tileLoad.raiseEvent(fakeTile(fakeModel(fake, 'sparse'), 'a.glb'))
    render()

    expect(error).not.toHaveBeenCalled()
    expect(createTexture).toHaveBeenCalledTimes(1)
  })
})

describe('glslBuildingLookupRead', () => {
  it('reads row 0 of the lookup at the clamped id', () => {
    expect(glslBuildingLookupRead('i')).toBe(
      `texelFetch(${BUILDING_LOOKUP_SAMPLER}, ivec2(clamp(i, 0, textureSize(${BUILDING_LOOKUP_SAMPLER}, 0).x - 1), 0), 0)`,
    )
  })
})
