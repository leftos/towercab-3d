/**
 * Fakes for the building lookup's tests: a WebGL2 context whose buffers are plain byte arrays and
 * a ready tile model drawing given triangles, enough for `attachBuildingLookup` to read back.
 */

import * as Cesium from 'cesium'

/** East-north-up at 0°N 0°E, where the geocentric and geodetic up agree: model z is up. */
export const ENU = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(0, 0, 0))

/** A closed box, faces counter-clockwise seen from outside. */
export const BOX_TRIANGLES = [
  [0, 2, 1, 0, 3, 2],
  [4, 5, 6, 4, 6, 7],
  [0, 1, 5, 0, 5, 4],
  [1, 2, 6, 1, 6, 5],
  [2, 3, 7, 2, 7, 6],
  [3, 0, 4, 3, 4, 7],
].flat()

/** A WebGL2 context whose buffers are plain byte arrays, enough for the read-back. */
export function fakeContext() {
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

export type FakeContext = ReturnType<typeof fakeContext>

/** The triangles a fake model draws, in model coordinates, with each vertex's feature id. */
export interface FakeGeometry {
  readonly positions: Float32Array
  readonly featureIds: Float32Array
  readonly indices: Uint16Array
}

/**
 * A ready model drawing `geometry` in east-north-up at 0°N 0°E.
 *
 * @param nodes - 'sparse' puts an empty slot before the one runtime node, as Cesium can
 */
export function fakeModel({ upload }: FakeContext, geometry: FakeGeometry, nodes: 'dense' | 'sparse' = 'dense') {
  const { positions, featureIds, indices } = geometry
  const count = featureIds.length
  const runtimePrimitive = {
    primitive: {
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      attributes: [
        {
          semantic: 'POSITION',
          buffer: upload(positions),
          count,
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
        },
        {
          semantic: '_FEATURE_ID',
          setIndex: 0,
          buffer: upload(featureIds),
          count,
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
        },
      ],
      indices: {
        buffer: upload(indices),
        count: indices.length,
        indexDatatype: Cesium.IndexDatatype.UNSIGNED_SHORT,
      },
    },
    drawCommand: { modelMatrix: ENU },
  }
  const node = { runtimePrimitives: [runtimePrimitive] }
  return { ready: true, _sceneGraph: { _runtimeNodes: nodes === 'sparse' ? [undefined, node] : [node] } }
}
