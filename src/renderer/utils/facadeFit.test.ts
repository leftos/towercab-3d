import { describe, expect, it } from 'vitest'
import { FACADE_PIER_M, FACE_BUILD_CHUNK_TRIANGLES } from '@/constants'
import { computeFeatureStats, type TileFeatureStats } from '@/utils/buildingBaseLookup'
import { FACE_TEXELS, FaceBuilder, type FaceTable, faceTexels } from '@/utils/buildingFaces'
import {
  ARC,
  COURTYARD,
  GABLE,
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
import {
  type FacadeFit,
  type FaceMatch,
  type FitGrammar,
  fitOpening,
  fittedBands,
  litGlow,
  litMeanLinear,
  matchFace,
  tintFactor,
  windowHashes,
  windowLit,
} from '@/utils/facadeFit'
import { FACADE_GRAMMARS, FACADE_LIGHTS } from '@/utils/facadeShader'

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
  const bands = fittedBands(match.h1 - match.h0)
  const bottom = match.h0 + bands.base
  expect(bottom + (j + grammar.lo[1]) * fit.pitch, label).toBeGreaterThanOrEqual(bottom - eps)
  expect(bottom + (j + grammar.hi[1]) * fit.pitch, label).toBeLessThanOrEqual(match.h1 - bands.parapet + eps)
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

  /** The fitted row pitch of a wall `height` metres high. */
  function pitchOf(height: number): number {
    return fitOpening({ u: 10, length: 20, h0: 0, h1: height, face: 0, run: 0 }, height / 2, GENERIC, 0).pitch
  }

  it('keeps the full bands on a wall tall enough for a full row', () => {
    expect(fittedBands(3.6).base).toBeCloseTo(0.4, 10)
    expect(fittedBands(3.6).parapet).toBeCloseTo(0.8, 10)
    expect(fittedBands(30).base).toBeCloseTo(0.4, 10)
    expect(pitchOf(3.6)).toBeCloseTo(2.4, 10)
  })

  it('shrinks the base band and parapet in proportion before a row loses height', () => {
    expect(fittedBands(3).base).toBeCloseTo(0.2, 10)
    expect(fittedBands(3).parapet).toBeCloseTo(0.4, 10)
    expect(pitchOf(3)).toBeCloseTo(2.4, 10)
  })

  it('keeps one full row on a 2.5 m wall, with each band at its floor', () => {
    expect(fittedBands(2.5).base).toBeCloseTo(0.1, 10)
    expect(fittedBands(2.5).parapet).toBeCloseTo(0.1, 10)
    expect(rowsOf(0, 2.5)).toBe(1)
    expect(pitchOf(2.5)).toBeCloseTo(2.3, 10)
  })

  it('keeps one full row on a 1.5 m wall', () => {
    expect(rowsOf(0, 1.5)).toBe(1)
    expect(pitchOf(1.5)).toBeCloseTo(1.3, 10)
  })

  it('keeps a 1.0 m row on a 1.2 m wall and draws no openings on a lower one', () => {
    expect(rowsOf(0, 1.2)).toBe(1)
    expect(pitchOf(1.2)).toBeGreaterThanOrEqual(1 - 1e-9)
    expect(rowsOf(0, 1.19)).toBe(0)
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

  it('draws every opening of a gable end inside the wall below the gable triangle', () => {
    const built = tableOf(GABLE)
    const prism = GABLE[0]
    const eave = 6
    let openings = 0
    for (let edge = 0; edge < 4; edge++) {
      for (let along = 0.05; along < edgeLength(prism, 0, edge); along += 0.25) {
        for (let z = 0.05; z < 9; z += 0.05) {
          const { point, normal } = onEdge(prism, 0, edge, along, z)
          const match = matchAt(built, point, normal)
          if (match === undefined) continue
          expect(match.h1, `edge ${edge} at ${z}`).toBeCloseTo(eave, 3)
          const fit = fitOpening(match, heightAt(built, point), GENERIC, 0)
          if (!fit.opening) continue
          openings++
          expect(z, `edge ${edge} at ${along}`).toBeLessThan(eave - fittedBands(eave).parapet)
          expectWholeOpening(fit, match, GENERIC, `edge ${edge} at ${along}, ${z}`)
        }
      }
    }
    expect(openings).toBeGreaterThan(0)
  })

  it('draws no opening where no face matches', () => {
    for (let h = 0; h < 10; h += 0.1) {
      const fit = fitOpening(undefined, h, GENERIC, 3)
      expect(fit.opening).toBe(false)
      expect(fit.inside).toBe(false)
    }
  })
})

describe('windowLit', () => {
  const cells = (each: (cell: readonly [number, number], run: number) => void) => {
    for (let run = 0; run < 300; run++) {
      for (let i = 0; i < 16; i++) for (let j = 0; j < 6; j++) each([i + 0.5, j + 0.5], run * 7)
    }
  }

  it("keeps every class's lit share on average, clusters and all", () => {
    for (const light of Object.values(FACADE_LIGHTS)) {
      let lit = 0
      let all = 0
      cells((cell, run) => {
        all++
        if (windowLit(cell, run, light)) lit++
      })
      expect(Math.abs(lit / all - light.share), `share ${light.share}`).toBeLessThan(0.03)
    }
  })

  it('lights nothing for a dark class', () => {
    cells((cell, run) => expect(windowLit(cell, run, FACADE_LIGHTS[FacadeClass.WAREHOUSE])).toBe(false))
  })

  it('clusters lit windows by group: a group is mostly lit or mostly dark, never salt and pepper', () => {
    const light = FACADE_LIGHTS[FacadeClass.GENERIC]
    const mostly = [0, 0]
    for (let run = 0; run < 300; run++) {
      for (let row = 0; row < 6; row++) {
        for (let group = 0; group < 3; group++) {
          let lit = 0
          for (let i = 0; i < 4; i++) if (windowLit([group * 4 + i + 0.5, row + 0.5], run * 7, light)) lit++
          mostly[lit >= 3 ? 1 : 0]++
        }
      }
    }
    expect(mostly[1] / (mostly[0] + mostly[1])).toBeGreaterThan(0.15)
    expect(mostly[1] / (mostly[0] + mostly[1])).toBeLessThan(0.4)
  })

  it('lights whole floors on an office: every row is on or off together', () => {
    const light = FACADE_LIGHTS[FacadeClass.OFFICE]
    const shares: number[] = []
    for (let row = 0; row < 200; row++) {
      let lit = 0
      for (let i = 0; i < 40; i++) if (windowLit([i + 0.5, row + 0.5], 11, light)) lit++
      shares.push(lit / 40)
    }
    expect(shares.filter((share) => share > 0.5).length).toBeGreaterThan(0)
    expect(shares.every((share) => share > 0.6 || share < 0.3)).toBe(true)
  })
})

describe('litGlow', () => {
  it("averages to the far tint's lit colour for every lit class", () => {
    for (const light of Object.values(FACADE_LIGHTS).filter(({ share }) => share > 0)) {
      const sum = [0, 0, 0]
      const samples = 90000
      for (let n = 0; n < samples; n++) {
        const glow = litGlow([n % 300, Math.floor(n / 300)], 5, light)
        for (let k = 0; k < 3; k++) sum[k] += (glow[k] * (1 + 0.65)) / 2 / samples
      }
      const mean = litMeanLinear(light)
      for (let k = 0; k < 3; k++) expect(Math.abs(sum[k] / mean[k] - 1), `share ${light.share}`).toBeLessThan(0.05)
    }
  })

  it('mixes cool and neutral on offices, warm only on houses', () => {
    const colours = (code: keyof typeof FACADE_LIGHTS) => {
      const seen = new Set<string>()
      for (let n = 0; n < 2000; n++) {
        const glow = litGlow([n, 1], 3, { ...FACADE_LIGHTS[code], curtain: 0 })
        seen.add((glow[1] / glow[0]).toFixed(3))
      }
      return seen.size
    }

    expect(colours(FacadeClass.OFFICE)).toBe(3)
    expect(colours(FacadeClass.HOUSE)).toBe(1)
  })

  it('varies a lit window within the guide brightness range', () => {
    const light = { ...FACADE_LIGHTS[FacadeClass.GENERIC], curtain: 0 }
    const reds = Array.from({ length: 5000 }, (_, n) => litGlow([n, 2], 9, light)[0])

    expect(Math.min(...reds)).toBeGreaterThanOrEqual(1.3 * 0.5 * 0.8)
    expect(Math.max(...reds)).toBeLessThanOrEqual(1.3 * 1.3)
    expect(Math.max(...reds) - Math.min(...reds)).toBeGreaterThan(0.5)
  })
})

describe('tintFactor', () => {
  it('jitters a wall a little, by more than the palette states give, from the hash alone', () => {
    const factors = Array.from({ length: 2000 }, (_, n) => tintFactor((n + 0.5) / 2000))
    const greens = factors.map((factor) => factor[1])

    expect(new Set(greens.map((g) => g.toFixed(3))).size).toBeGreaterThan(50)
    expect(Math.min(...greens)).toBeGreaterThan(0.85)
    expect(Math.max(...greens)).toBeLessThan(1.15)
    expect(tintFactor(0.37)).toEqual(tintFactor(0.37))
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
