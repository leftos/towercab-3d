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

/**
 * Moves a geometry drawn in east-north-up at 0.63°E 0°N (about 70 km east of the model origin) into
 * a model frame at 0°N 0°E raised so that the site's ground lies at 0 along its own up, as a tile's
 * far model origin does. At the equator the geodetic and geocentric up agree.
 *
 * @returns The geometry in the far model frame, and the site's east-north-up to that frame
 */
export function farOrigin<G extends { readonly positions: Float32Array }>(
  geometry: G,
): G & { readonly modelMatrix: Cesium.Matrix4; readonly siteToModel: Cesium.Matrix4 } {
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
  const positions = new Float32Array(geometry.positions.length)
  const point = new Cesium.Cartesian3()
  for (let v = 0; v < positions.length; v += 3) {
    Cesium.Cartesian3.fromElements(geometry.positions[v], geometry.positions[v + 1], geometry.positions[v + 2], point)
    Cesium.Matrix4.multiplyByPoint(siteToModel, point, point)
    positions.set([point.x, point.y, point.z], v)
  }
  return { ...geometry, positions, modelMatrix, siteToModel }
}

// ---- Prisms: buildings drawn from footprints ----------------------------------------------------

/** A closed ring of (x, y) points in metres, east and north. */
export type Ring = readonly (readonly [number, number])[]

/** How a prism is roofed: flat, gabled along its longer sides (four-cornered rings only), or open. */
export type Roof = 'flat' | 'gable' | 'none'

/** One extruded footprint of a feature. Rings may wind either way; they are oriented on use. */
export interface Prism {
  readonly id: number
  readonly outer: Ring
  readonly holes?: readonly Ring[]
  /** Bottom and top of the walls, metres. */
  readonly z: readonly [number, number]
  /** Metres the top ring is set in from the bottom one, which slopes the walls (a mansard). */
  readonly inset?: number
  /** Overrides the options' roof for this prism. */
  readonly roof?: Roof
}

/** How `prismGeometry` draws its prisms. */
export interface PrismOptions {
  /** Each wall segment as one quad, or a grid of `cols` x `rows` quads; two triangles per quad. */
  readonly walls?: 'quad' | { readonly cols: number; readonly rows: number }
  /** Extra footprint vertices on every edge, evenly or unevenly spaced. */
  readonly extraVertices?: { readonly count: number; readonly uneven?: boolean }
  /** Seeded uniform jitter of every vertex on every axis, in millimetres either way. */
  readonly jitterMm?: number
  /** Seed for the jitter and the near-duplicate corners. */
  readonly seed?: number
  /** A second vertex this many millimetres from every corner, in a seeded horizontal direction. */
  readonly nearDuplicateMm?: number
  /** Rotates every ring to start this many vertices later. */
  readonly rotateStart?: number
  /** Emits the triangles in reverse order. */
  readonly reverseTriangles?: boolean
  /** Winds every triangle clockwise seen from its front, so its normal points inward. */
  readonly flipWinding?: boolean
  /** The roof of every prism without its own (default flat). */
  readonly roof?: Roof
  /** Metres from the eave to the ridge of a gable roof (default 3). */
  readonly ridgeM?: number
  /** Draws a downward floor under each prism. */
  readonly floor?: boolean
  /** Metres the wall bottoms rise per metre east: a building on sloping ground. */
  readonly groundSlope?: number
}

/** The triangles a set of prisms draws, in east-north-up at 0°N 0°E. */
export interface PrismGeometry extends FakeGeometry {
  readonly modelMatrix: Cesium.Matrix4
}

/** A seeded uniform generator in [0, 1) (mulberry32). */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function signedArea(ring: Ring): number {
  let sum = 0
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i]
    const [x1, y1] = ring[(i + 1) % ring.length]
    sum += x0 * y1 - x1 * y0
  }
  return sum / 2
}

/** The ring wound counter-clockwise seen from above (`ccw`) or clockwise; a flat ring as given. */
function oriented(ring: Ring, ccw: boolean): Ring {
  const area = signedArea(ring)
  return area === 0 || area > 0 === ccw ? ring : [...ring].reverse()
}

/** The prism's rings oriented so the solid lies left of every edge: outer counter-clockwise, holes clockwise. */
export function prismRings(prism: Prism): Ring[] {
  return [oriented(prism.outer, true), ...(prism.holes ?? []).map((hole) => oriented(hole, false))]
}

function withExtraVertices(
  ring: Ring,
  extra: PrismOptions['extraVertices'],
): { p: [number, number]; corner: boolean }[] {
  const out: { p: [number, number]; corner: boolean }[] = []
  const count = extra?.count ?? 0
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i]
    const [x1, y1] = ring[(i + 1) % ring.length]
    out.push({ p: [x0, y0], corner: true })
    for (let k = 1; k <= count; k++) {
      const even = k / (count + 1)
      const t = extra?.uneven ? even ** 1.5 : even
      out.push({ p: [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t], corner: false })
    }
  }
  return out
}

/** The ring's points after rotation, extra vertices and near-duplicate corners. */
function drawnRing(ring: Ring, options: PrismOptions, random: () => number): [number, number][] {
  const shift = (((options.rotateStart ?? 0) % ring.length) + ring.length) % ring.length
  const rotated = [...ring.slice(shift), ...ring.slice(0, shift)]
  const points: [number, number][] = []
  for (const { p, corner } of withExtraVertices(rotated, options.extraVertices)) {
    points.push(p)
    if (!corner || options.nearDuplicateMm === undefined) continue
    const angle = random() * 2 * Math.PI
    const offset = options.nearDuplicateMm / 1000
    points.push([p[0] + offset * Math.cos(angle), p[1] + offset * Math.sin(angle)])
  }
  return points
}

/** The ring set in by `inset` metres toward the solid, each corner mitred. */
function insetRing(ring: readonly (readonly [number, number])[], inset: number): [number, number][] {
  if (inset === 0) return ring.map(([x, y]) => [x, y])
  const n = ring.length
  const leftNormal = (i: number): [number, number] => {
    const [x0, y0] = ring[i]
    const [x1, y1] = ring[(i + 1) % n]
    const length = Math.hypot(x1 - x0, y1 - y0)
    return [-(y1 - y0) / length, (x1 - x0) / length]
  }
  return ring.map(([x, y], i) => {
    const a = leftNormal((i + n - 1) % n)
    const b = leftNormal(i)
    const scale = inset / (1 + a[0] * b[0] + a[1] * b[1])
    return [x + (a[0] + b[0]) * scale, y + (a[1] + b[1]) * scale]
  })
}

class TriangleSink {
  readonly positions: number[] = []
  readonly triangles: [number, number, number][] = []

  vertex(x: number, y: number, z: number): number {
    this.positions.push(x, y, z)
    return this.positions.length / 3 - 1
  }

  /** Adds a triangle, wound so its normal's z has the sign of `facing` when `facing` is not 0. */
  triangle(a: number, b: number, c: number, facing = 0): void {
    if (facing !== 0) {
      const p = this.positions
      const cross =
        (p[b * 3] - p[a * 3]) * (p[c * 3 + 1] - p[a * 3 + 1]) - (p[b * 3 + 1] - p[a * 3 + 1]) * (p[c * 3] - p[a * 3])
      if (cross * facing < 0) {
        this.triangles.push([a, c, b])
        return
      }
    }
    this.triangles.push([a, b, c])
  }
}

interface WallRing {
  readonly bottom: [number, number][]
  readonly top: [number, number][]
}

function addWalls(sink: TriangleSink, ring: WallRing, z: readonly [number, number], options: PrismOptions): void {
  const { cols, rows } = options.walls === undefined || options.walls === 'quad' ? { cols: 1, rows: 1 } : options.walls
  const slope = options.groundSlope ?? 0
  const n = ring.bottom.length
  for (let e = 0; e < n; e++) {
    const [b0, b1, t0, t1] = [ring.bottom[e], ring.bottom[(e + 1) % n], ring.top[e], ring.top[(e + 1) % n]]
    const grid: number[] = []
    for (let i = 0; i <= cols; i++) {
      const f = i / cols
      const bx = b0[0] + (b1[0] - b0[0]) * f
      const by = b0[1] + (b1[1] - b0[1]) * f
      const tx = t0[0] + (t1[0] - t0[0]) * f
      const ty = t0[1] + (t1[1] - t0[1]) * f
      const bz = z[0] + slope * bx
      for (let j = 0; j <= rows; j++) {
        const g = j / rows
        grid.push(sink.vertex(bx + (tx - bx) * g, by + (ty - by) * g, bz + (z[1] - bz) * g))
      }
    }
    const at = (i: number, j: number) => grid[i * (rows + 1) + j]
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        sink.triangle(at(i, j), at(i + 1, j), at(i + 1, j + 1))
        sink.triangle(at(i, j), at(i + 1, j + 1), at(i, j + 1))
      }
    }
  }
}

/** Fills the rings at height `z` (or on the sloping ground), facing up (`facing` 1) or down (-1). */
function addCap(sink: TriangleSink, rings: [number, number][][], z: number, slope: number, facing: number): void {
  const flat = rings.flat()
  const holes: number[] = []
  let start = rings[0].length
  for (const ring of rings.slice(1)) {
    holes.push(start)
    start += ring.length
  }
  const indices = Cesium.PolygonPipeline.triangulate(
    flat.map(([x, y]) => new Cesium.Cartesian2(x, y)),
    holes,
  )
  const vertices = flat.map(([x, y]) => sink.vertex(x, y, z + slope * x))
  for (let t = 0; t + 2 < indices.length; t += 3) {
    sink.triangle(vertices[indices[t]], vertices[indices[t + 1]], vertices[indices[t + 2]], facing)
  }
}

/** A gable roof over a four-cornered ring: gable-end triangles on its shorter sides, two slopes between. */
function addGable(sink: TriangleSink, ring: [number, number][], top: number, ridge: number): void {
  if (ring.length !== 4) throw new Error('a gable roof needs a ring of exactly four corners')
  const lengths = ring.map(([x, y], i) => Math.hypot(ring[(i + 1) % 4][0] - x, ring[(i + 1) % 4][1] - y))
  const end = lengths[0] < lengths[1] ? 0 : 1
  const apex = (e: number) => {
    const [p, q] = [ring[e], ring[(e + 1) % 4]]
    return sink.vertex((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, top + ridge)
  }
  const corner = (i: number) => sink.vertex(ring[i % 4][0], ring[i % 4][1], top)
  const apexes = [apex(end), apex(end + 2)]
  sink.triangle(corner(end), corner(end + 1), apexes[0])
  sink.triangle(corner(end + 2), corner(end + 3), apexes[1])
  sink.triangle(corner(end + 1), corner(end + 2), apexes[1], 1)
  sink.triangle(corner(end + 1), apexes[1], apexes[0], 1)
  sink.triangle(corner(end + 3), corner(end + 4), apexes[0], 1)
  sink.triangle(corner(end + 3), apexes[0], apexes[1], 1)
}

function addPrism(sink: TriangleSink, prism: Prism, options: PrismOptions, random: () => number): void {
  const rings = prismRings(prism).map((ring) => drawnRing(ring, options, random))
  const tops = rings.map((ring) => insetRing(ring, prism.inset ?? 0))
  for (let r = 0; r < rings.length; r++) addWalls(sink, { bottom: rings[r], top: tops[r] }, prism.z, options)
  const roof = prism.roof ?? options.roof ?? 'flat'
  if (roof === 'flat') addCap(sink, tops, prism.z[1], 0, 1)
  if (roof === 'gable') addGable(sink, tops[0], prism.z[1], options.ridgeM ?? 3)
  if (options.floor) addCap(sink, rings, prism.z[0], options.groundSlope ?? 0, -1)
}

/**
 * The triangles of a set of prisms, each wall counter-clockwise seen from outside, in east-north-up
 * at 0°N 0°E (model z is up). Every wall and cap has its own vertices, as the tiles split them at corners.
 *
 * @param prisms - The prisms; several may share a feature id
 * @param options - How the walls, roofs and vertices are drawn
 */
export function prismGeometry(prisms: readonly Prism[], options: PrismOptions = {}): PrismGeometry {
  const random = seeded(options.seed ?? 1)
  const featureIds: number[] = []
  const sink = new TriangleSink()
  for (const prism of prisms) {
    const first = sink.positions.length / 3
    addPrism(sink, prism, options, random)
    for (let v = first; v < sink.positions.length / 3; v++) featureIds.push(prism.id)
  }
  const jitter = (options.jitterMm ?? 0) / 1000
  const positions = sink.positions.map((value) => value + (jitter === 0 ? 0 : (random() * 2 - 1) * jitter))
  const triangles = options.reverseTriangles ? [...sink.triangles].reverse() : sink.triangles
  const indices = triangles.flatMap(([a, b, c]) => (options.flipWinding ? [a, c, b] : [a, b, c]))
  if (featureIds.length > 0xffff)
    throw new Error(`a prism geometry of ${featureIds.length} vertices needs 32-bit indices`)
  return {
    positions: new Float32Array(positions),
    featureIds: new Float32Array(featureIds),
    indices: new Uint16Array(indices),
    modelMatrix: ENU,
  }
}

/** A point on a prism's wall, with the wall's true outward normal and the ring edge it lies on. */
export interface WallSample {
  readonly point: readonly [number, number, number]
  readonly normal: readonly [number, number, number]
  readonly ring: number
  readonly edge: number
}

/**
 * Points on every vertical wall of a prism, every `step` metres along each footprint edge and 1 cm
 * inside its ends, at 1 cm above the bottom, mid-height and 1 cm below the top.
 */
export function wallSamples(prism: Prism, step: number): WallSample[] {
  const samples: WallSample[] = []
  const heights = [prism.z[0] + 0.01, (prism.z[0] + prism.z[1]) / 2, prism.z[1] - 0.01]
  prismRings(prism).forEach((ring, r) => {
    for (let e = 0; e < ring.length; e++) {
      const [x0, y0] = ring[e]
      const [x1, y1] = ring[(e + 1) % ring.length]
      const length = Math.hypot(x1 - x0, y1 - y0)
      const normal = [(y1 - y0) / length, -(x1 - x0) / length, 0] as const
      const along: number[] = []
      for (let s = 0.01; s < length - 0.01; s += step) along.push(s)
      along.push(length - 0.01)
      for (const s of along) {
        for (const z of heights) {
          const point = [x0 + ((x1 - x0) * s) / length, y0 + ((y1 - y0) * s) / length, z] as const
          samples.push({ point, normal, ring: r, edge: e })
        }
      }
    }
  })
  return samples
}

/** A regular polygon of `sides` corners on a circle of `radius` metres, one corner due north. */
export function regularPolygon(sides: number, radius: number, centre: readonly [number, number] = [0, 0]): Ring {
  return Array.from({ length: sides }, (_, i) => {
    const angle = Math.PI / 2 + (2 * Math.PI * i) / sides
    return [centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle)] as const
  })
}

/** A 20 x 10 m box. */
export const RECT: readonly Prism[] = [
  {
    id: 0,
    outer: [
      [0, 0],
      [20, 0],
      [20, 10],
      [0, 10],
    ],
    z: [0, 10],
  },
]

/** An L of two 10 m arms, its inner corner at (10, 10). */
export const L: readonly Prism[] = [
  {
    id: 0,
    outer: [
      [0, 0],
      [20, 0],
      [20, 10],
      [10, 10],
      [10, 20],
      [0, 20],
    ],
    z: [0, 10],
  },
]

/** A U whose two arm ends are coplanar pieces of one line, 10 m apart. */
export const U: readonly Prism[] = [
  {
    id: 0,
    outer: [
      [0, 0],
      [30, 0],
      [30, 20],
      [20, 20],
      [20, 8],
      [10, 8],
      [10, 20],
      [0, 20],
    ],
    z: [0, 10],
  },
]

/** A 30 x 30 m block around a 10 x 10 m courtyard. */
export const COURTYARD: readonly Prism[] = [
  {
    id: 0,
    outer: [
      [0, 0],
      [30, 0],
      [30, 30],
      [0, 30],
    ],
    holes: [
      [
        [10, 10],
        [20, 10],
        [20, 20],
        [10, 20],
      ],
    ],
    z: [0, 10],
  },
]

/** A box with a 4 m wide, 2 m deep notch in its north side, which splits that side into two coplanar pieces. */
export const NOTCH: readonly Prism[] = [
  {
    id: 0,
    outer: [
      [0, 0],
      [20, 0],
      [20, 10],
      [12, 10],
      [12, 8],
      [8, 8],
      [8, 10],
      [0, 10],
    ],
    z: [0, 10],
  },
]

/** A box whose 20 m south side bends 0.5° at a middle vertex 8.7 cm off the line: a mapping kink. */
export const KINK: readonly Prism[] = [
  {
    id: 0,
    outer: [
      [0, 0],
      [10, -0.087],
      [20, 0],
      [20, 10],
      [0, 10],
    ],
    z: [0, 10],
  },
]

/** A box whose south side steps back 0.3 m halfway along. */
export const JOG: readonly Prism[] = [
  {
    id: 0,
    outer: [
      [0, 0],
      [10, 0],
      [10, 0.3],
      [20, 0.3],
      [20, 10],
      [0, 10],
    ],
    z: [0, 10],
  },
]

/** A 16-sided round building of radius 12 m. */
export const ROUND16: readonly Prism[] = [{ id: 0, outer: regularPolygon(16, 12), z: [0, 10] }]

/** A front of 12 facets on a quarter circle of radius 12 m, between a straight south wall and a straight east wall. */
export const ARC: readonly Prism[] = [
  {
    id: 0,
    outer: [
      [0, 0],
      [20, 0],
      ...Array.from({ length: 11 }, (_, i) => {
        const angle = ((i + 1) * Math.PI) / 24
        return [20 + 12 * Math.sin(angle), 12 - 12 * Math.cos(angle)] as const
      }),
      [32, 12],
      [32, 30],
      [0, 30],
    ],
    z: [0, 10],
  },
]

/** A 96-sided round building of radius 40 m. */
export const ROUND96: readonly Prism[] = [{ id: 0, outer: regularPolygon(96, 40), z: [0, 10] }]

/** A comb of 70 teeth, 1 m wide, 1 m apart and 2 m deep: about 280 faces, past the per-feature cap. */
export const COMB: readonly Prism[] = [
  {
    id: 0,
    outer: [
      [0, 0],
      [140, 0],
      [140, 5],
      ...Array.from({ length: 70 }, (_, i) => {
        const x = 139 - 2 * i
        return [
          [x, 5],
          [x, 7],
          [x - 1, 7],
          [x - 1, 5],
        ] as const
      }).flat(),
    ],
    z: [0, 10],
  },
]

/** A free-standing wall of no thickness, 20 m long: two coplanar sides facing apart, no roof. */
export const THINWALL: readonly Prism[] = [
  {
    id: 0,
    outer: [
      [0, 0],
      [20, 0],
    ],
    z: [0, 4],
    roof: 'none',
  },
]

/** A 10 x 8 m house with 6 m walls and a gable roof whose ridge runs east-west. */
export const GABLE: readonly Prism[] = [
  {
    id: 0,
    outer: [
      [0, 0],
      [10, 0],
      [10, 8],
      [0, 8],
    ],
    z: [0, 6],
    roof: 'gable',
  },
]

/** A 20 x 10 m box with 10 m walls under a 4 m mansard storey whose faces slope at 70°. */
export const MANSARD: readonly Prism[] = [
  {
    id: 0,
    outer: [
      [0, 0],
      [20, 0],
      [20, 10],
      [0, 10],
    ],
    z: [0, 10],
    roof: 'none',
  },
  {
    id: 0,
    outer: [
      [0, 0],
      [20, 0],
      [20, 10],
      [0, 10],
    ],
    z: [10, 14],
    inset: 4 / Math.tan((70 * Math.PI) / 180),
  },
]
