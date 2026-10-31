/**
 * The facade shader's per-face window fit, as TypeScript twins of its GLSL (`facadeShader.ts`), line
 * for line, so tests can check what the shader draws.
 *
 * `matchFace` finds the face of a feature's table range that a wall point lies on, in the table's
 * frame (relative to the feature's base, along its up); `fitOpening` fits whole bays along the
 * face's run, between a pier at each end of an open run and none on a closed loop, and whole rows
 * between the face's base band and its parapet, and says whether the point lies in an opening.
 */
import {
  FACADE_BASE_BAND_M,
  FACADE_PARAPET_M,
  FACADE_PIER_M,
  FACE_GATE_COS,
  FACE_PLANE_TOL_M,
  FACE_S_TOL_M,
  FACES_PER_FEATURE_MAX,
} from '@/constants'
import { FACE_TEXELS, type FaceTable } from '@/utils/buildingFaces'

type Vec2 = readonly [number, number]
type Vec3 = readonly [number, number, number]

/** Lowest row of windows the fit allows, metres; a wall lower than this keeps one row of its own height. */
export const STOREY_MIN_M = 2.4

/** Highest row of windows the fit allows, metres, and the storey height's cap against bad OSM tags. */
export const STOREY_MAX_M = 6.0

/** The face a wall point lies on, as the shader's match returns it. */
export interface FaceMatch {
  /** Position along the face's run, metres from the run's start. */
  readonly u: number
  /** The run's length, negative for a closed loop. */
  readonly length: number
  /** The face's bottom and top along up. */
  readonly h0: number
  readonly h1: number
  /** The face's index in the table. */
  readonly face: number
  /** The index of the run's first face: the run's identity. */
  readonly run: number
}

/** What the fit needs of a facade grammar (`FacadeGrammar`). */
export interface FitGrammar {
  readonly bayM: number
  readonly floorM: number
  readonly storeysFromLevels: boolean
  readonly opening: 'glass' | 'gap' | 'none'
  readonly lo: Vec2
  readonly hi: Vec2
}

/** Where a wall point lies in the window grid fitted to its face. */
export interface FacadeFit {
  /** Whether it lies in a cell of the grid: between the end piers and between the bands. */
  readonly inside: boolean
  /** Its position in bays from the run's first pier and rows from the base band. */
  readonly cell: Vec2
  /** The fitted bay width and row pitch, metres; 0 where the face draws no openings. */
  readonly bay: number
  readonly pitch: number
  /** Whether it lies in an opening (the grammar's rectangle in its cell). */
  readonly opening: boolean
}

const NO_FIT: FacadeFit = { inside: false, cell: [0, 0], bay: 0, pitch: 0, opening: false }

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** GLSL's `round` for the fit: half up, as `floor(x + 0.5)`, the same on every GPU. */
const roundHalfUp = (x: number) => Math.floor(x + 0.5)

/** GLSL's `mod`: the remainder with the sign of the divisor. */
const glslMod = (x: number, y: number) => x - y * Math.floor(x / y)

function texel(table: FaceTable, k: number): [number, number, number, number] {
  const column = k % table.width
  const row = Math.min(Math.floor(k / table.width), table.height - 1)
  const o = (row * table.width + column) * 4
  return [table.texels[o], table.texels[o + 1], table.texels[o + 2], table.texels[o + 3]]
}

/**
 * The first face of a feature's range that a wall point lies on, as the shader's `facadeFace`: the
 * fragment's normal gates each face, the point must lie within `FACE_PLANE_TOL_M` of its plane and
 * within `FACE_S_TOL_M` of its ends along `cross(up, the face's stored normal)`.
 *
 * @param table - The tile's face table
 * @param first - The feature's first face (lookup row 1, z)
 * @param count - The feature's face count (lookup row 1, w)
 * @param p - The point relative to the feature's base
 * @param n - The fragment's normal
 * @param up - The feature's up
 * @returns The match, or undefined where no face matches
 */
export function matchFace(
  table: FaceTable,
  first: number,
  count: number,
  p: Vec3,
  n: Vec3,
  up: Vec3,
): FaceMatch | undefined {
  for (let i = 0; i < FACES_PER_FEATURE_MAX; i++) {
    if (i >= count) break
    const k = FACE_TEXELS * (first + i)
    const plane = texel(table, k)
    const normal: Vec3 = [plane[0], plane[1], plane[2]]
    if (dot(n, normal) < FACE_GATE_COS || Math.abs(dot(p, normal) - plane[3]) > FACE_PLANE_TOL_M) continue
    const ends = texel(table, k + 1)
    const across: Vec3 = [
      up[1] * normal[2] - up[2] * normal[1],
      up[2] * normal[0] - up[0] * normal[2],
      up[0] * normal[1] - up[1] * normal[0],
    ]
    const s = dot(p, across) / Math.hypot(...across)
    if (s < ends[0] - FACE_S_TOL_M || s > ends[1] + FACE_S_TOL_M) continue
    const span = texel(table, k + 2)
    const u = ends[2] + Math.min(Math.max(s, ends[0]), ends[1]) - ends[0]
    return { u, length: ends[3], h0: span[0], h1: span[1], face: first + i, run: span[2] }
  }
  return undefined
}

const fract = (x: number) => x - Math.floor(x)

/** The shader's `facadeHash12`: a hash of a 2D point into [0, 1). */
export function facadeHash12(p: Vec2): number {
  let x = fract(p[0] * 0.1031)
  let y = fract(p[1] * 0.1031)
  let z = fract(p[0] * 0.1031)
  const d = x * (y + 33.33) + y * (z + 33.33) + z * (x + 33.33)
  x += d
  y += d
  z += d
  return fract((x + y) * z)
}

/**
 * The hashes that pick a window's glass shade and whether it is lit, as the shader takes them from
 * the window's cell and its run's identity.
 *
 * @param cell - The point's place in the fitted grid (`FacadeFit.cell`)
 * @param run - The index of the run's first face (`FaceMatch.run`)
 */
export function windowHashes(cell: Vec2, run: number): { glass: number; lit: number } {
  const id: Vec2 = [Math.floor(cell[0]), Math.floor(cell[1])]
  return {
    glass: facadeHash12([facadeHash12(id), run]),
    lit: facadeHash12([facadeHash12([id[0] * 1.37, id[1] * 1.37]), run]),
  }
}

/**
 * Rows of windows on a face whose band between base band and parapet is `usable` metres high: the
 * packed level count where the grammar takes it, raised until no row is higher than `STOREY_MAX_M`,
 * else the grammar's storeys; then fewer while a row would be lower than `STOREY_MIN_M`, and at
 * least one.
 */
function fittedRows(usable: number, grammar: FitGrammar, levels: number): number {
  const fromLevels = grammar.storeysFromLevels && levels >= 1
  const wanted = fromLevels
    ? Math.max(levels, Math.ceil(usable / STOREY_MAX_M))
    : Math.max(1, roundHalfUp(usable / grammar.floorM))
  return Math.max(1, Math.min(wanted, Math.floor(usable / STOREY_MIN_M)))
}

/**
 * Fits whole bays along a matched face's run and whole rows between its bands, as the shader's
 * `facadeFit`, and places a point in that grid.
 *
 * @param match - The face the point lies on (`matchFace`), or undefined: no openings
 * @param h - The point's height along up, relative to the feature's base (the table's frame)
 * @param grammar - The building class's facade grammar
 * @param levels - The packed storey count, 0 when unknown
 * @returns The point's place in the fitted grid
 */
export function fitOpening(match: FaceMatch | undefined, h: number, grammar: FitGrammar, levels: number): FacadeFit {
  if (match === undefined) return NO_FIT
  const closed = match.length < 0
  const length = Math.abs(match.length)
  const pier = closed ? 0 : FACADE_PIER_M
  const span = length - 2 * pier
  const bottom = match.h0 + FACADE_BASE_BAND_M
  const usable = match.h1 - FACADE_PARAPET_M - bottom
  if (span <= 0 || usable <= 0) return NO_FIT
  const bays = Math.max(1, roundHalfUp(span / grammar.bayM))
  const bay = span / bays
  const rows = fittedRows(usable, grammar, levels)
  const pitch = usable / rows
  const along = closed ? glslMod(match.u, length) : match.u - pier
  const cell: Vec2 = [along / bay, (h - bottom) / pitch]
  const i = Math.floor(cell[0])
  const j = Math.floor(cell[1])
  const inside = i >= 0 && i < bays && j >= 0 && j < rows
  const fx = cell[0] - i
  const fy = cell[1] - j
  const inRect = fx >= grammar.lo[0] && fx <= grammar.hi[0] && fy >= grammar.lo[1] && fy <= grammar.hi[1]
  return { inside, cell, bay, pitch, opening: inside && grammar.opening !== 'none' && inRect }
}
