import * as Cesium from 'cesium'
import { describe, expect, it } from 'vitest'
import { FACE_GATE_COS, FACE_PLANE_TOL_M, FACE_S_TOL_M, FACES_PER_FEATURE_MAX, FACES_PER_TILE_MAX } from '@/constants'
import { computeFeatureStats, type TileFeatureStats } from '@/utils/buildingBaseLookup'
import {
  capFeatureRuns,
  capTileRuns,
  extractFaces,
  type Face,
  faceRuns,
  faceTexels,
  featureFrame,
  type Run,
} from '@/utils/buildingFaces'
import {
  ARC,
  COMB,
  COURTYARD,
  farOrigin,
  GABLE,
  KINK,
  L,
  MANSARD,
  type Prism,
  type PrismOptions,
  prismGeometry,
  RECT,
  ROUND16,
  regularPolygon,
  THINWALL,
  U,
  wallSamples,
} from '@/utils/buildingLookupFakes.test-support'

type Vec3 = readonly [number, number, number]

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

function unitCross(a: Vec3, b: Vec3): Vec3 {
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] as const
  const length = Math.hypot(...c)
  return [c[0] / length, c[1] / length, c[2] / length]
}

function vec(array: ArrayLike<number>, f: number): Vec3 {
  return [array[f * 3], array[f * 3 + 1], array[f * 3 + 2]]
}

interface Built {
  readonly stats: TileFeatureStats
  readonly faces: Face[][]
  runs(f?: number): Run[]
}

function build(prisms: readonly Prism[], options: PrismOptions = {}): Built {
  const geometry = prismGeometry(prisms, options)
  const stats = computeFeatureStats([geometry], Math.max(...prisms.map((p) => p.id)) + 1)
  const faces = extractFaces([geometry], stats)
  return { stats, faces, runs: (f = 0) => faceRuns(faces[f], featureFrame(stats, f)) }
}

/** A face in the feature's model coordinates, no longer relative to its base vertex. */
interface AbsoluteFace {
  readonly n: Vec3
  readonly d: number
  readonly s0: number
  readonly s1: number
  readonly h0: number
  readonly h1: number
}

function absolute(face: Face, stats: TileFeatureStats, f = 0): AbsoluteFace {
  const base = vec(stats.baseMC, f)
  const up = vec(stats.up, f)
  const t = unitCross(up, face.normal)
  return {
    n: face.normal,
    d: face.d + dot(face.normal, base),
    s0: face.s0 + dot(t, base),
    s1: face.s1 + dot(t, base),
    h0: face.h0 + dot(up, base),
    h1: face.h1 + dot(up, base),
  }
}

/** A point of the face's horizontal line at walking position `s`, in model coordinates. */
function endPoint(face: Face, s: number, stats: TileFeatureStats, f = 0): Vec3 {
  const base = vec(stats.baseMC, f)
  const t = unitCross(vec(stats.up, f), face.normal)
  return [0, 1, 2].map((i) => base[i] + face.d * face.normal[i] + s * t[i]) as unknown as Vec3
}

function canonical(faces: readonly AbsoluteFace[]): AbsoluteFace[] {
  const angle = (face: AbsoluteFace) => Math.atan2(face.n[1], face.n[0])
  return [...faces].sort((a, b) => {
    if (Math.abs(angle(a) - angle(b)) > 1e-3) return angle(a) - angle(b)
    if (Math.abs(a.n[2] - b.n[2]) > 1e-3) return a.n[2] - b.n[2]
    if (Math.abs(a.d - b.d) > 0.05) return a.d - b.d
    return a.s0 - b.s0
  })
}

function expectSameFaces(actual: readonly AbsoluteFace[], expected: readonly AbsoluteFace[], tolerance = 0.01): void {
  expect(actual).toHaveLength(expected.length)
  const [a, e] = [canonical(actual), canonical(expected)]
  for (let i = 0; i < a.length; i++) {
    for (let k = 0; k < 3; k++) expect(Math.abs(a[i].n[k] - e[i].n[k])).toBeLessThan(1e-4)
    for (const key of ['d', 's0', 's1', 'h0', 'h1'] as const) {
      expect(Math.abs(a[i][key] - e[i][key])).toBeLessThan(tolerance)
    }
  }
}

function allAbsolute(built: Built, f = 0): AbsoluteFace[] {
  return built.faces[f].map((face) => absolute(face, built.stats, f))
}

/** Run lengths, closed loops negative, sorted. */
function runLengths(runs: readonly Run[]): number[] {
  return runs.map((run) => (run.closed ? -run.length : run.length)).sort((a, b) => a - b)
}

function expectSameRuns(actual: readonly Run[], expected: readonly Run[], tolerance = 0.01): void {
  const [a, e] = [runLengths(actual), runLengths(expected)]
  expect(a).toHaveLength(e.length)
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - e[i])).toBeLessThan(tolerance)
}

/** The faces a wall sample lies on, by the shader's tolerances, with the sample's own normal. */
function facesUnder(point: Vec3, normal: Vec3, built: Built, f = 0): number[] {
  const base = vec(built.stats.baseMC, f)
  const up = vec(built.stats.up, f)
  const p: Vec3 = [point[0] - base[0], point[1] - base[1], point[2] - base[2]]
  return built.faces[f].flatMap((face, i) => {
    if (dot(normal, face.normal) < FACE_GATE_COS) return []
    if (Math.abs(dot(p, face.normal) - face.d) > FACE_PLANE_TOL_M) return []
    const s = dot(p, unitCross(up, face.normal))
    return s < face.s0 - FACE_S_TOL_M || s > face.s1 + FACE_S_TOL_M ? [] : [i]
  })
}

function expectEverySampleOnOneFace(prisms: readonly Prism[], built: Built): void {
  for (const prism of prisms) {
    for (const sample of wallSamples(prism, 0.5)) {
      const under = facesUnder(sample.point, sample.normal, built)
      expect(under, `sample ${sample.point.join(', ')}`).toHaveLength(1)
      expect(dot(built.faces[0][under[0]].normal, sample.normal)).toBeGreaterThan(0.9999)
    }
  }
}

describe('extractFaces', () => {
  it('finds the same faces for a wall drawn as 2, 8 or 32 triangles', () => {
    const quad = build(RECT)
    for (const walls of [
      { cols: 2, rows: 2 },
      { cols: 4, rows: 4 },
    ]) {
      const grid = build(RECT, { walls })
      expectSameFaces(allAbsolute(grid), allAbsolute(quad))
      expectSameRuns(grid.runs(), quad.runs())
    }
    expect(quad.faces[0]).toHaveLength(4)
  })

  it('keeps one face per wall whatever the extra footprint vertices on it, evenly or unevenly spaced', () => {
    const plain = build(RECT)
    for (const extraVertices of [{ count: 3 }, { count: 4, uneven: true }]) {
      const extra = build(RECT, { extraVertices })
      expectSameFaces(allAbsolute(extra), allAbsolute(plain))
      expectSameRuns(extra.runs(), plain.runs())
    }
  })

  it('ignores near-duplicate vertices and ±3 mm jitter on every vertex', () => {
    // Each joint of a run can overlap its neighbour by a near-duplicate's few millimetres, so the
    // 2 cm bound on a run's length holds on runs of few joints; the 16-sided loop keeps its shape.
    for (const prisms of [RECT, KINK, ROUND16]) {
      const plain = build(prisms)
      for (const nearDuplicateMm of [1, 3, 5]) {
        const noisy = build(prisms, { nearDuplicateMm, jitterMm: 3, seed: nearDuplicateMm })
        const wide = noisy.faces[0].filter((face) => face.s1 - face.s0 > 0.05)
        expect(wide).toHaveLength(plain.faces[0].length)
        expect(noisy.runs().map((run) => [run.faces.length, run.closed])).toEqual(
          expect.arrayContaining(plain.runs().map((run) => [run.faces.length, run.closed])),
        )
        if (prisms === ROUND16) {
          expect(Math.abs(noisy.runs()[0].length / plain.runs()[0].length - 1)).toBeLessThan(0.01)
        } else {
          expectSameRuns(noisy.runs(), plain.runs(), 0.02)
        }
      }
    }
  })

  it("finds the same faces whatever the footprint's start vertex and the triangle order", () => {
    for (const prisms of [RECT, L, ROUND16]) {
      const plain = build(prisms)
      for (const rotateStart of [1, 2, 3]) {
        const rotated = build(prisms, { rotateStart, reverseTriangles: rotateStart === 2 })
        expectSameFaces(allAbsolute(rotated), allAbsolute(plain))
        expectSameRuns(rotated.runs(), plain.runs())
      }
    }
  })

  it('merges a wall the mesher split into collinear pieces, T-junction included', () => {
    // A 20 m south wall: one quad over x 0-10, two stacked quads over x 10-20 whose middle vertex
    // sits on the first quad's edge (a T-junction), and a sliver piece along the top.
    const corners = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 0, 9.9],
      [0, 0, 9.9],
      [20, 0, 0],
      [20, 0, 5],
      [10, 0, 5],
      [20, 0, 9.9],
      [0, 0, 10],
      [20, 0, 10],
    ].flat()
    const geometry = {
      positions: new Float32Array(corners),
      featureIds: new Float32Array(10),
      indices: new Uint16Array([0, 1, 2, 0, 2, 3, 1, 4, 5, 1, 5, 6, 6, 5, 7, 6, 7, 2, 3, 7, 9, 3, 9, 8]),
      modelMatrix: prismGeometry(RECT).modelMatrix,
    }
    const stats = computeFeatureStats([geometry], 1)

    const faces = extractFaces([geometry], stats)[0]

    expect(faces).toHaveLength(1)
    expect([faces[0].s0, faces[0].s1, faces[0].h0, faces[0].h1].map((v) => Number(v.toFixed(3)))).toEqual([
      0, 20, 0, 10,
    ])
  })

  it('gives a rectangle four faces ending at its corners', () => {
    const built = build(RECT)
    const ends = built.faces[0].map((face) => [face.s0, face.s1].map((s) => endPoint(face, s, built.stats)))
    const corners = RECT[0].outer.map(([x, y]) => `${x},${y}`)

    expect(built.faces[0]).toHaveLength(4)
    for (const pair of ends) {
      for (const [x, y] of pair) expect(corners).toContain(`${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`)
    }
    expect(runLengths(built.runs()).map((v) => Number(v.toFixed(2)))).toEqual([10, 10, 20, 20])
    expectEverySampleOnOneFace(RECT, built)
  })

  it("ends both faces at an L-shape's inner corner", () => {
    const built = build(L)
    const atCorner = built.faces[0].flatMap((face) =>
      [face.s0, face.s1].filter((s) => {
        const [x, y] = endPoint(face, s, built.stats)
        return Math.hypot(x - 10, y - 10) < 0.01
      }),
    )

    expect(built.faces[0]).toHaveLength(6)
    expect(atCorner).toHaveLength(2)
    expect(built.runs()).toHaveLength(6)
    expectEverySampleOnOneFace(L, built)
  })

  it('keeps a courtyard wall and coplanar disjoint pieces apart from the walls they parallel', () => {
    const courtyard = build(COURTYARD)
    const u = build(U)
    const armEnds = u.faces[0].filter(
      (face) => face.normal[1] > 0.99 && Math.abs(absolute(face, u.stats).d - 20) < 0.01,
    )

    expect(courtyard.faces[0]).toHaveLength(8)
    expectEverySampleOnOneFace(COURTYARD, courtyard)
    expect(u.faces[0]).toHaveLength(8)
    expect(armEnds).toHaveLength(2)
    expectEverySampleOnOneFace(U, u)
  })

  it('keeps the two sides of a zero-thickness wall apart', () => {
    const built = build(THINWALL)

    expect(built.faces[0]).toHaveLength(2)
    expect(dot(built.faces[0][0].normal, built.faces[0][1].normal)).toBeLessThan(-0.9999)
    expectEverySampleOnOneFace(THINWALL, built)
  })

  it("makes no face from roof or floor triangles, by the shader's roof cosine", () => {
    // Battered 4 m walls set in so their normals sit just under and just over 0.6 of up.
    const batter = (cos: number) => 4 * (cos / Math.sqrt(1 - cos * cos))
    const under = build([{ ...RECT[0], z: [0, 4], inset: batter(0.58) }], { floor: true })
    const over = build([{ ...RECT[0], z: [0, 4], inset: batter(0.62) }], { floor: true })
    const box = build(RECT, { floor: true })

    expect(box.faces[0]).toHaveLength(4)
    expect(box.faces[0].every((face) => Math.abs(face.normal[2]) < 1e-6)).toBe(true)
    expect(under.faces[0]).toHaveLength(4)
    expect(over.faces[0]).toHaveLength(0)
  })

  it('gives a sloped facade face a run of its own', () => {
    const built = build(MANSARD)
    const sloped = built.faces[0].filter((face) => !face.vertical)
    const runs = built.runs()

    expect(built.faces[0]).toHaveLength(8)
    expect(sloped).toHaveLength(4)
    for (const face of sloped) expect(face.normal[2]).toBeCloseTo(Math.cos((70 * Math.PI) / 180), 3)
    expect(runs).toHaveLength(8)
    for (const run of runs) expect(run.faces).toHaveLength(1)
  })

  it('measures a building 70 km from the model origin as at the origin', () => {
    const near = build(L)
    const geometry = farOrigin(prismGeometry(L))
    const stats = computeFeatureStats([geometry], 1)
    const faces = extractFaces([geometry], stats)[0]
    const key = (v: number) => Math.round(v * 10)
    const modelToSite = Cesium.Matrix4.inverse(geometry.siteToModel, new Cesium.Matrix4())
    const corners = (facesOf: readonly Face[], of: TileFeatureStats, toSite?: Cesium.Matrix4) =>
      facesOf
        .flatMap((face) => {
          const base = vec(of.baseMC, 0)
          const up = vec(of.up, 0)
          const t = unitCross(up, face.normal)
          return [face.s0, face.s1].flatMap((s) =>
            [face.h0, face.h1].map((h) => {
              const p = [0, 1, 2].map((i) => base[i] + face.d * face.normal[i] + s * t[i] + h * up[i])
              const point = new Cesium.Cartesian3(p[0], p[1], p[2])
              if (toSite !== undefined) Cesium.Matrix4.multiplyByPoint(toSite, point, point)
              return [point.x, point.y, point.z]
            }),
          )
        })
        .sort((a, b) => key(a[0]) - key(b[0]) || key(a[1]) - key(b[1]) || key(a[2]) - key(b[2]))

    const far = corners(faces, stats, modelToSite)
    const expected = corners(near.faces[0], near.stats)

    expect(faces).toHaveLength(near.faces[0].length)
    for (let i = 0; i < far.length; i++) {
      for (let k = 0; k < 3; k++) expect(Math.abs(far[i][k] - expected[i][k])).toBeLessThan(0.01)
    }
    expectSameRuns(faceRuns(faces, featureFrame(stats, 0)), near.runs())
  })

  it('starts a face from its strong triangles before a larger sliver, which then joins it', () => {
    // A 40 m wall's top edge is one 0.09 m sliver, larger than each 1 m strong triangle of the
    // wall below it, which covers only x 10-30.
    const grid = Array.from({ length: 21 }, (_, i) => [10 + i, 0, 0])
    const corners = [...grid, ...grid.map(([x]) => [x, 0, 1]), [0, 0, 1], [40, 0, 1], [20, 0, 1.09]]
    const quads = Array.from({ length: 20 }, (_, i) => [i, i + 1, 22 + i, i, 22 + i, 21 + i]).flat()
    const geometry = {
      positions: new Float32Array(corners.flat()),
      featureIds: new Float32Array(corners.length),
      indices: new Uint16Array([...quads, 42, 43, 44]),
      modelMatrix: prismGeometry(RECT).modelMatrix,
    }
    const stats = computeFeatureStats([geometry], 1)

    const faces = extractFaces([geometry], stats)[0]

    expect(faces).toHaveLength(1)
    expect(Math.abs(faces[0].s1 - faces[0].s0 - 40)).toBeLessThan(0.01)
    expect(Math.abs(faces[0].h1 - faces[0].h0 - 1.09)).toBeLessThan(0.01)
  })

  it("stores each face's bottom and top heights", () => {
    const gable = build(GABLE)
    const tops = gable.faces[0].map((face) => [Math.abs(face.normal[0]) > 0.99, face.h1] as const)
    const sloping = build(RECT, { groundSlope: 0.1 })
    const bottom = (nx: number) => sloping.faces[0].find((face) => face.normal[0] * nx > 0.99)?.h0

    expect(gable.faces[0]).toHaveLength(4)
    for (const [gableEnd, top] of tops) expect(top).toBeCloseTo(gableEnd ? 9 : 6, 3)
    for (const face of gable.faces[0]) expect(face.h0).toBeCloseTo(0, 3)
    expect(bottom(-1)).toBeCloseTo(0, 3)
    expect(bottom(1)).toBeCloseTo(2, 3)
    for (const face of sloping.faces[0]) expect(face.h1).toBeCloseTo(10, 3)
  })
})

describe('faceRuns', () => {
  it('links the facets of a 16-sided round building into one closed run of its perimeter', () => {
    const runs = build(ROUND16).runs()
    const perimeter = 16 * 2 * 12 * Math.sin(Math.PI / 16)

    expect(runs).toHaveLength(1)
    expect(runs[0].closed).toBe(true)
    expect(runs[0].faces).toHaveLength(16)
    expect(Math.abs(runs[0].length - perimeter) / perimeter).toBeLessThan(0.01)
  })

  it("links a curved front's facets into one open run ending at its corners", () => {
    const built = build(ARC)
    const runs = built.runs()
    const front = runs.find((run) => run.faces.length > 1)
    const first = front?.faces[0] as Face
    const last = front?.faces[front.faces.length - 1] as Face

    expect(runs).toHaveLength(3)
    expect(front?.closed).toBe(false)
    expect(front?.faces).toHaveLength(14)
    const start = endPoint(first, first.s0, built.stats)
    const end = endPoint(last, last.s1, built.stats)
    expect(Math.hypot(start[0], start[1])).toBeLessThan(0.01)
    expect(Math.hypot(end[0] - 32, end[1] - 30)).toBeLessThan(0.01)
    for (let i = 1; i < (front?.faces.length ?? 0); i++) {
      const before = front?.faces[i - 1] as Face
      expect(front?.u0[i]).toBeCloseTo((front?.u0[i - 1] ?? 0) + before.s1 - before.s0, 6)
    }
  })

  it('links two faces across a 0.5° mapping kink into one run', () => {
    const built = build(KINK)
    const runs = built.runs()
    const south = runs.find((run) => run.faces.length === 2)

    expect(built.faces[0]).toHaveLength(5)
    expect(runs).toHaveLength(4)
    expect(south?.length).toBeCloseTo(2 * Math.hypot(10, 0.087), 2)
  })

  it('never links across a corner sharper than the run angle', () => {
    const turned = (degrees: number) => {
      const r = (degrees * Math.PI) / 180
      const corner = [20 + 20 * Math.cos(r), 20 * Math.sin(r)] as const
      return build([{ id: 0, outer: [[0, 0], [20, 0], corner, [corner[0], 40], [0, 40]], z: [0, 10] }]).runs()
    }

    expect(build(RECT).runs()).toHaveLength(4)
    expect(turned(24)).toHaveLength(4)
    expect(turned(26)).toHaveLength(5)
  })

  it("puts a closed run's seam at the same joint for any start vertex", () => {
    for (const rotateStart of [0, 1, 5, 11]) {
      const built = build(ROUND16, { rotateStart, reverseTriangles: rotateStart === 5 })
      const loop = built.runs()[0]
      const start = endPoint(loop.faces[0], loop.faces[0].s0, built.stats)

      expect(loop.u0[0]).toBe(0)
      expect(Math.hypot(start[0], start[1] - 12)).toBeLessThan(0.01)
    }
  })

  it('breaks a seam tie between joints level within 1 cm by the westmost, for any start vertex', () => {
    // A 16-sided loop with a flat north edge, its east corner (the last) 5 mm north of its west one.
    const outer = Array.from({ length: 16 }, (_, i) => {
      const angle = Math.PI / 2 + Math.PI / 16 + (2 * Math.PI * i) / 16
      return [12 * Math.cos(angle), 12 * Math.sin(angle) + (i === 15 ? 0.005 : 0)] as const
    })
    const west = outer[0]
    for (const rotateStart of [0, 1, 5, 11]) {
      const built = build([{ id: 0, outer, z: [0, 10] }], { rotateStart, reverseTriangles: rotateStart === 5 })
      const loop = built.runs()[0]
      const start = endPoint(loop.faces[0], loop.faces[0].s0, built.stats)

      expect(loop.closed).toBe(true)
      expect(Math.hypot(start[0] - west[0], start[1] - west[1])).toBeLessThan(0.01)
    }
  })
})

/** A run of `faces` copies of one 2 m face. */
function syntheticRun(faces: number): Run {
  const face: Face = { normal: [1, 0, 0], d: 1, s0: 0, s1: 2, h0: 0, h1: 5, vertical: true }
  return {
    faces: Array<Face>(faces).fill(face),
    u0: Array.from({ length: faces }, (_, i) => 2 * i),
    length: 2 * faces,
    closed: false,
    end: [0, 0],
  }
}

describe('face caps', () => {
  it('keeps the longest whole runs of a feature past the per-feature cap', () => {
    // A 300-sided loop is one run past the cap on its own, so it is dropped whole. Its radius keeps
    // each facet's neighbour more than the plane tolerance off its plane, so every facet is a face.
    const loop: Prism = { id: 0, outer: regularPolygon(300, 150, [70, 300]), z: [0, 10] }
    const built = build([...COMB, loop])
    const runs = built.runs()
    const kept = capFeatureRuns(runs)
    const keptFaces = kept.reduce((sum, run) => sum + run.faces.length, 0)
    const dropped = runs.filter((run) => !kept.includes(run))
    const shortestKept = Math.min(...kept.map((run) => run.length))

    expect(built.faces[0].length).toBeGreaterThan(FACES_PER_FEATURE_MAX + 300)
    expect(keptFaces).toBe(FACES_PER_FEATURE_MAX)
    expect(kept.some((run) => run.closed)).toBe(false)
    for (let i = 1; i < kept.length; i++) expect(kept[i].length).toBeLessThanOrEqual(kept[i - 1].length)
    for (const run of dropped.filter((r) => !r.closed)) expect(run.length).toBeLessThanOrEqual(shortestKept)
  })

  it('stops at the per-tile cap in feature order and warns once', () => {
    const perFeature = 255
    const features = Array.from({ length: 300 }, (_, f) => (f === 299 ? [syntheticRun(1)] : [syntheticRun(perFeature)]))
    const fit = Math.floor(FACES_PER_TILE_MAX / perFeature)

    const { runs, cut } = capTileRuns(features)

    expect(runs.slice(0, fit).every((kept, f) => kept === features[f])).toBe(true)
    expect(runs.slice(fit).every((kept) => kept.length === 0)).toBe(true)
    expect(cut).toBe(300 - fit)
    expect(capTileRuns(features.slice(0, fit)).cut).toBe(0)
  })
})

describe('faceTexels', () => {
  it('lays three texels per face in rows of a width divisible by three within the texture limit', () => {
    const features = [[syntheticRun(1500)], [], [syntheticRun(500)]]

    const small = faceTexels(features, 1000)
    const large = faceTexels(features, 16384)
    const empty = faceTexels([[], []], 16384)
    const two = faceTexels([[syntheticRun(2)]], 16384)

    expect([small.width, small.height]).toEqual([999, Math.ceil((3 * 2000) / 999)])
    expect([large.width, large.height]).toEqual([4095, 2])
    expect([empty.width, empty.height, empty.texels.length]).toEqual([3, 1, 12])
    expect([two.width, two.height]).toEqual([6, 1])
    expect([...two.texels.subarray(0, 12)]).toEqual([1, 0, 0, 1, 0, 2, 0, 4, 0, 5, 0, 0])
    expect([...two.texels.subarray(12, 16)]).toEqual([1, 0, 0, 1])
    expect(two.texels[12 + 6]).toBe(2)
    expect([...two.texels.subarray(20, 24)]).toEqual([0, 5, 0, 0])
    for (const table of [small, large]) {
      expect(table.width % 3).toBe(0)
      expect(table.texels).toHaveLength(table.width * table.height * 4)
    }
  })

  it("keeps every feature's face range inside the table", () => {
    const loop = { ...syntheticRun(3), closed: true }
    const features = [[syntheticRun(4)], [], [syntheticRun(FACES_PER_FEATURE_MAX - 3), loop], [syntheticRun(7)]]

    const table = faceTexels(features, 64)
    const faces = 4 + FACES_PER_FEATURE_MAX + 7

    expect([...table.first]).toEqual([0, 4, 4, 4 + FACES_PER_FEATURE_MAX])
    expect([...table.count]).toEqual([4, 0, FACES_PER_FEATURE_MAX, 7])
    for (let f = 0; f < features.length; f++) expect(table.first[f] + table.count[f]).toBeLessThanOrEqual(faces)
    expect(table.width).toBeLessThanOrEqual(64)
    expect(table.height).toBeLessThanOrEqual(64)
    expect(table.width * table.height).toBeGreaterThanOrEqual(3 * faces)
    const closedFace = 4 + FACES_PER_FEATURE_MAX - 3
    const k = 3 * closedFace + 1
    const row = Math.floor(k / table.width)
    expect(table.texels[(row * table.width + (k % table.width)) * 4 + 3]).toBe(-6)
  })

  it("stores on every face of a run the run's highest bottom and lowest top, and a lone face its own", () => {
    const face = (h0: number, h1: number): Face => ({ normal: [1, 0, 0], d: 1, s0: 0, s1: 2, h0, h1, vertical: true })
    const run = (faces: Face[]): Run => ({
      faces,
      u0: faces.map((_, i) => 2 * i),
      length: 2 * faces.length,
      closed: false,
      end: [0, 0],
    })
    const table = faceTexels([[run([face(0, 10), face(1, 9), face(0.5, 12)]), run([face(0.3, 7)])]], 64)
    const heights = (i: number) => {
      const o = (3 * i + 2) * 4
      return [table.texels[o], table.texels[o + 1]]
    }

    expect([0, 1, 2].map(heights)).toEqual([
      [1, 9],
      [1, 9],
      [1, 9],
    ])
    expect(heights(3)[0]).toBeCloseTo(0.3, 6)
    expect(heights(3)[1]).toBe(7)
  })

  it("stores on every face of a run the index of the run's first face", () => {
    const loop = { ...syntheticRun(3), closed: true }
    const features = [[syntheticRun(4)], [], [syntheticRun(5), loop]]

    const table = faceTexels(features, 64)
    const runFirst = (face: number) => {
      const k = 3 * face + 2
      return table.texels[(Math.floor(k / table.width) * table.width + (k % table.width)) * 4 + 2]
    }

    expect(Array.from({ length: 12 }, (_, face) => runFirst(face))).toEqual([0, 0, 0, 0, 4, 4, 4, 4, 4, 9, 9, 9])
  })
})
