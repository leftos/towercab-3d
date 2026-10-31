import { describe, expect, it } from 'vitest'
import { FACADE_BASE_BAND_M, FACADE_PARAPET_M, FACADE_PIER_M, FACE_BUILD_CHUNK_TRIANGLES } from '@/constants'
import { computeFeatureStats, type TileFeatureStats } from '@/utils/buildingBaseLookup'
import { FACE_TEXELS, FaceBuilder, type FaceTable, faceTexels } from '@/utils/buildingFaces'
import {
  ARC,
  COURTYARD,
  JOG,
  KINK,
  L,
  NOTCH,
  type Prism,
  type PrismOptions,
  prismGeometry,
  prismRings,
  RECT,
  ROUND16,
  U,
  wallSamples,
} from '@/utils/buildingLookupFakes.test-support'
import { FacadeClass } from '@/utils/buildingStyle'
import { type FacadeFit, type FaceMatch, type FitGrammar, fitOpening, matchFace, windowHashes } from '@/utils/facadeFit'
import { FACADE_GRAMMARS } from '@/utils/facadeShader'

type Vec3 = readonly [number, number, number]

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

function vec(array: ArrayLike<number>, f: number): Vec3 {
  return [array[f * 3], array[f * 3 + 1], array[f * 3 + 2]]
}

interface Table {
  readonly stats: TileFeatureStats
  readonly table: FaceTable
}

/** Feature 0's face table, built as the tile build builds it. */
function tableOf(prisms: readonly Prism[], options: PrismOptions = {}): Table {
  const geometry = prismGeometry(prisms, options)
  const stats = computeFeatureStats([geometry], 1)
  const builder = new FaceBuilder([geometry], stats)
  while (!builder.done) builder.step(FACE_BUILD_CHUNK_TRIANGLES)
  return { stats, table: faceTexels(builder.runs, 4096) }
}

/** The point relative to feature 0's base, as the shader's `positionMC - ground.xyz`. */
function relative({ stats }: Table, point: Vec3): Vec3 {
  const base = vec(stats.baseMC, 0)
  return [point[0] - base[0], point[1] - base[1], point[2] - base[2]]
}

function matchAt(built: Table, point: Vec3, normal: Vec3, table = built.table): FaceMatch | undefined {
  return matchFace(
    table,
    built.table.first[0],
    built.table.count[0],
    relative(built, point),
    normal,
    vec(built.stats.up, 0),
  )
}

function heightAt(built: Table, point: Vec3): number {
  return dot(relative(built, point), vec(built.stats.up, 0))
}

function faceNormal(table: FaceTable, face: number): Vec3 {
  const o = face * FACE_TEXELS * 4
  return [table.texels[o], table.texels[o + 1], table.texels[o + 2]]
}

/** The point `along` metres from the start of ring edge `edge`, at height `z`, with the edge's outward normal. */
function onEdge(prism: Prism, ring: number, edge: number, along: number, z: number): { point: Vec3; normal: Vec3 } {
  const r = prismRings(prism)[ring]
  const [x0, y0] = r[edge]
  const [x1, y1] = r[(edge + 1) % r.length]
  const length = Math.hypot(x1 - x0, y1 - y0)
  return {
    point: [x0 + ((x1 - x0) * along) / length, y0 + ((y1 - y0) * along) / length, z],
    normal: [(y1 - y0) / length, -(x1 - x0) / length, 0],
  }
}

function edgeLength(prism: Prism, ring: number, edge: number): number {
  const r = prismRings(prism)[ring]
  const [x0, y0] = r[edge]
  const [x1, y1] = r[(edge + 1) % r.length]
  return Math.hypot(x1 - x0, y1 - y0)
}

/** The table with its faces stored in another order: face slot j holds face `order[j]`. */
function reordered(table: FaceTable, order: readonly number[]): FaceTable {
  const texels = new Float32Array(table.texels.length)
  const block = FACE_TEXELS * 4
  order.forEach((face, slot) => {
    texels.set(table.texels.subarray(face * block, face * block + block), slot * block)
  })
  return { ...table, texels }
}

const GENERIC = FACADE_GRAMMARS[FacadeClass.GENERIC]

/** Whether the opening holding a point lies whole between the run's end piers and the face's bands. */
function expectWholeOpening(fit: FacadeFit, match: FaceMatch, grammar: FitGrammar, label: string): void {
  const closed = match.length < 0
  const length = Math.abs(match.length)
  const pier = closed ? 0 : FACADE_PIER_M
  const i = Math.floor(fit.cell[0])
  const j = Math.floor(fit.cell[1])
  const eps = 1e-6
  if (closed) {
    const bays = length / fit.bay
    expect(Math.abs(bays - Math.round(bays)), label).toBeLessThan(1e-6)
    expect(i, label).toBeGreaterThanOrEqual(0)
    expect(i, label).toBeLessThan(Math.round(bays))
  } else {
    expect(pier + (i + grammar.lo[0]) * fit.bay, label).toBeGreaterThanOrEqual(pier - eps)
    expect(pier + (i + grammar.hi[0]) * fit.bay, label).toBeLessThanOrEqual(length - pier + eps)
  }
  const bottom = match.h0 + FACADE_BASE_BAND_M
  expect(bottom + (j + grammar.lo[1]) * fit.pitch, label).toBeGreaterThanOrEqual(bottom - eps)
  expect(bottom + (j + grammar.hi[1]) * fit.pitch, label).toBeLessThanOrEqual(match.h1 - FACADE_PARAPET_M + eps)
}

describe('matchFace', () => {
  it('matches every sampled wall point of every fixture to its own face', () => {
    for (const prisms of [RECT, L, U, COURTYARD, NOTCH]) {
      const built = tableOf(prisms)
      for (const prism of prisms) {
        for (const sample of wallSamples(prism, 0.5)) {
          const label = `sample ${sample.point.join(', ')}`
          const match = matchAt(built, sample.point, sample.normal)
          const [x0, y0] = prismRings(prism)[sample.ring][sample.edge]
          const along = Math.hypot(sample.point[0] - x0, sample.point[1] - y0)

          expect(match, label).toBeDefined()
          const { u, length, face } = match as FaceMatch
          expect(dot(faceNormal(built.table, face), sample.normal), label).toBeGreaterThan(0.9999)
          expect(Math.abs(u - along), label).toBeLessThan(0.01)
          expect(Math.abs(length - edgeLength(prism, sample.ring, sample.edge)), label).toBeLessThan(0.01)
        }
      }
    }
  })

  it('matches nothing for a point off every plane or a flipped-winding face', () => {
    const built = tableOf(RECT)
    const flipped = tableOf(RECT, { flipWinding: true })
    const samples = wallSamples(RECT[0], 0.5)

    expect(flipped.table.count[0]).toBe(4)
    for (const { point, normal } of samples) {
      const off = (metres: number): Vec3 => [
        point[0] + normal[0] * metres,
        point[1] + normal[1] * metres,
        point[2] + normal[2] * metres,
      ]
      expect(matchAt(built, off(0.2), normal)).toBeUndefined()
      expect(matchAt(built, off(-0.2), normal)).toBeUndefined()
      expect(matchAt(flipped, point, normal)).toBeUndefined()
    }
  })

  it("gives the same coordinate whatever the faces' storage order, away from joints", () => {
    for (const prisms of [ROUND16, ARC, KINK, JOG]) {
      const built = tableOf(prisms)
      const count = built.table.count[0]
      const faces = Array.from({ length: count }, (_, i) => i)
      const orders = [[...faces].reverse(), faces.map((_, i) => (i * 7 + 3) % count)]
      for (const order of orders) {
        expect(new Set(order).size).toBe(count)
        const shuffled = reordered(built.table, order)
        for (const sample of wallSamples(prisms[0], 0.25)) {
          const along = Math.hypot(
            sample.point[0] - prismRings(prisms[0])[sample.ring][sample.edge][0],
            sample.point[1] - prismRings(prisms[0])[sample.ring][sample.edge][1],
          )
          const length = edgeLength(prisms[0], sample.ring, sample.edge)
          if (along < 0.11 || along > length - 0.11) continue
          const label = `sample ${sample.point.join(', ')}`
          const stored = matchAt(built, sample.point, sample.normal) as FaceMatch
          const moved = matchAt(built, sample.point, sample.normal, shuffled) as FaceMatch

          expect(stored, label).toBeDefined()
          expect(moved, label).toBeDefined()
          expect(Math.abs(moved.u - stored.u), label).toBeLessThan(1e-4)
          expect(moved.length, label).toBe(stored.length)
        }
      }
    }
  })

  it('keeps the coordinate continuous across every joint of a run', () => {
    const cases = [
      { prisms: ROUND16, joints: Array.from({ length: 16 }, (_, e) => e) },
      { prisms: ARC, joints: Array.from({ length: 13 }, (_, e) => e) },
    ]
    for (const { prisms, joints } of cases) {
      const built = tableOf(prisms)
      const edges = prismRings(prisms[0])[0].length
      for (const e of joints) {
        const next = (e + 1) % edges
        const before = onEdge(prisms[0], 0, e, edgeLength(prisms[0], 0, e) - 0.01, 5)
        const after = onEdge(prisms[0], 0, next, 0.01, 5)
        const a = matchAt(built, before.point, before.normal) as FaceMatch
        const b = matchAt(built, after.point, after.normal) as FaceMatch
        const label = `joint after edge ${e}`

        expect(a, label).toBeDefined()
        expect(b, label).toBeDefined()
        expect(b.length, label).toBe(a.length)
        const loop = Math.abs(a.length)
        const step = a.length < 0 ? (((b.u - a.u) % loop) + loop) % loop : b.u - a.u
        expect(Math.abs(step - 0.02), label).toBeLessThan(0.02)
      }
    }
  })
})

describe('fitOpening', () => {
  it('fits rows over the whole run, at the same heights on both sides of every joint, on sloping ground', () => {
    const cases = [
      { prisms: ROUND16, joints: Array.from({ length: 16 }, (_, e) => e) },
      { prisms: ARC, joints: Array.from({ length: 13 }, (_, e) => e) },
    ]
    for (const { prisms, joints } of cases) {
      const built = tableOf(prisms, { groundSlope: 0.1 })
      const edges = prismRings(prisms[0])[0].length
      let openings = 0
      for (const e of joints) {
        const before = onEdge(prisms[0], 0, e, edgeLength(prisms[0], 0, e) - 0.01, 0)
        const after = onEdge(prisms[0], 0, (e + 1) % edges, 0.01, 0)
        for (let z = 0; z <= 10; z += 0.05) {
          const label = `joint after edge ${e} at ${z.toFixed(2)}`
          const sides = [before, after].map(({ point, normal }) => {
            const at: Vec3 = [point[0], point[1], z]
            const match = matchAt(built, at, normal) as FaceMatch
            expect(match, label).toBeDefined()
            const fit = fitOpening(match, heightAt(built, at), GENERIC, 0)
            if (fit.opening) expectWholeOpening(fit, match, GENERIC, label)
            return { opening: fit.opening, row: Math.floor(fit.cell[1]) }
          })
          expect(sides[1].opening, label).toBe(sides[0].opening)
          if (!sides[0].opening) continue
          openings++
          expect(sides[1].row, label).toBe(sides[0].row)
        }
      }
      expect(openings).toBeGreaterThan(0)
    }
  })

  it('draws only whole openings between the end piers of every run of every fixture', () => {
    const grammars = [FacadeClass.GENERIC, FacadeClass.OFFICE, FacadeClass.HOUSE, FacadeClass.GARAGE].map(
      (code) => FACADE_GRAMMARS[code],
    )
    for (const prisms of [RECT, L, U, COURTYARD, NOTCH, KINK, JOG, ROUND16, ARC]) {
      const built = tableOf(prisms)
      const openings = grammars.map(() => 0)
      prismRings(prisms[0]).forEach((ring, r) => {
        for (let e = 0; e < ring.length; e++) {
          const length = edgeLength(prisms[0], r, e)
          for (let along = 0.01; along < length; along += 0.1) {
            for (let z = 0.05; z < 10; z += 0.25) {
              const { point, normal } = onEdge(prisms[0], r, e, along, z)
              const match = matchAt(built, point, normal)
              if (match === undefined) continue
              grammars.forEach((grammar, g) => {
                const fit = fitOpening(match, heightAt(built, point), grammar, 0)
                if (!fit.opening) return
                openings[g]++
                expectWholeOpening(fit, match, grammar, `edge ${e} at ${along.toFixed(2)}, ${z}`)
              })
            }
          }
        }
      })
      for (const count of openings) expect(count).toBeGreaterThan(0)
    }
  })

  /** The rows of a wall `height` metres high that hold an opening, swept every centimetre. */
  function rowsOf(h0: number, h1: number, levels = 0, length = 20): number {
    const match: FaceMatch = { u: length / 2, length, h0, h1, face: 0, run: 0 }
    const rows = new Set<number>()
    for (let h = h0; h <= h1; h += 0.01) {
      const fit = fitOpening(match, h, GENERIC, levels)
      if (!fit.opening) continue
      expectWholeOpening(fit, match, GENERIC, `height ${h.toFixed(2)} of ${h1 - h0}`)
      rows.add(Math.floor(fit.cell[1]))
    }
    return rows.size
  }

  it('fits whole rows between the base band and the parapet at any wall height', () => {
    const expected: [number, number][] = [
      [3, 1],
      [5.9, 1],
      [6, 2],
      [8.9, 3],
      [9, 3],
      [11.9, 4],
      [30, 10],
      [120, 40],
    ]
    for (const [height, rows] of expected) expect(rowsOf(0, height), `${height} m`).toBe(rows)
  })

  it('keeps one row on a 2.5 m wall and none on a 1.0 m wall', () => {
    expect(rowsOf(0, 2.5)).toBe(1)
    expect(rowsOf(0, 1)).toBe(0)
  })

  it('takes the row count from the packed levels, fewer where a row would be lower than a storey can be', () => {
    expect(rowsOf(0, 9, 2)).toBe(2)
    expect(rowsOf(0, 9, 4)).toBe(3)
    expect(rowsOf(0, 9, 1)).toBe(2)
  })

  it('keeps a row at most 6 m high on a building whose level count is too low for its height', () => {
    expect(rowsOf(0, 40, 1)).toBe(Math.ceil(38.8 / 6))
    expect(rowsOf(0, 40, 1)).toBe(7)
  })

  it('fits each face of a building on sloping ground between its own bottom and top', () => {
    const built = tableOf(RECT, { groundSlope: 0.1 })
    const rows = (x: number, nx: number) => {
      const seen = new Set<number>()
      for (let z = 0; z <= 10; z += 0.01) {
        const point: Vec3 = [x, 5, z]
        const normal: Vec3 = [nx, 0, 0]
        const match = matchAt(built, point, normal)
        if (match === undefined) continue
        const fit = fitOpening(match, heightAt(built, point), GENERIC, 0)
        if (!fit.opening) continue
        expectWholeOpening(fit, match, GENERIC, `x ${x} at ${z.toFixed(2)}`)
        seen.add(Math.floor(fit.cell[1]))
      }
      return seen.size
    }

    expect(rows(0, -1)).toBe(3)
    expect(rows(20, 1)).toBe(2)
  })

  it('fits one whole bay to a wall shorter than a bay, and none where the end piers meet', () => {
    const bays = (length: number) => {
      const seen = new Set<number>()
      for (let u = 0; u <= length; u += 0.01) {
        const match: FaceMatch = { u, length, h0: 0, h1: 6, face: 0, run: 0 }
        const fit = fitOpening(match, 2, GENERIC, 0)
        if (!fit.opening) continue
        expectWholeOpening(fit, match, GENERIC, `u ${u.toFixed(2)} of ${length}`)
        seen.add(Math.floor(fit.cell[0]))
      }
      return seen.size
    }

    expect(bays(2)).toBe(1)
    expect(bays(1)).toBe(0)
    expect(bays(20)).toBe(Math.round((20 - 2 * FACADE_PIER_M) / GENERIC.bayM))
  })

  it('draws no opening where no face matches', () => {
    for (let h = 0; h < 10; h += 0.1) {
      const fit = fitOpening(undefined, h, GENERIC, 3)
      expect(fit.opening).toBe(false)
      expect(fit.inside).toBe(false)
    }
  })
})

describe('windowHashes', () => {
  it("gives every run its own window pattern, never a shifted copy of another run's", () => {
    const shifted = { ...RECT[0], id: 1, outer: RECT[0].outer.map(([x, y]) => [x + 40, y] as const) }
    const geometry = prismGeometry([RECT[0], shifted])
    const stats = computeFeatureStats([geometry], 2)
    const builder = new FaceBuilder([geometry], stats)
    while (!builder.done) builder.step(FACE_BUILD_CHUNK_TRIANGLES)
    const table = faceTexels(builder.runs, 4096)
    const faces = table.count[0] + table.count[1]
    const runs = [...new Set(Array.from({ length: faces }, (_, i) => table.texels[(i * FACE_TEXELS + 2) * 4 + 2]))]
    const bays = 8
    const rows = 4
    const pattern = (run: number, pick: 'glass' | 'lit') =>
      Array.from({ length: bays }, (_, i) =>
        Array.from({ length: rows }, (_, j) => windowHashes([i + 0.5, j + 0.5], run)[pick]),
      )

    expect(runs).toHaveLength(8)
    for (const pick of ['glass', 'lit'] as const) {
      for (const a of runs) {
        for (const b of runs) {
          if (a === b) continue
          const [pa, pb] = [pattern(a, pick), pattern(b, pick)]
          for (let shift = 1 - bays; shift < bays; shift++) {
            let same = true
            for (let i = Math.max(0, -shift); i < Math.min(bays, bays - shift); i++) {
              for (let j = 0; j < rows; j++) same &&= pa[i + shift][j] === pb[i][j]
            }
            expect(same, `${pick}: run ${b} as run ${a} shifted by ${shift} bays`).toBe(false)
          }
        }
      }
    }
  })
})
