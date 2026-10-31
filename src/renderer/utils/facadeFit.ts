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

/** Lowest row of windows the fit gives a wall with room for it; a lower wall keeps one row of what it has. */
export const STOREY_MIN_M = 2.4

/** Highest row of windows the fit allows, metres, and the storey height's cap against bad OSM tags. */
export const STOREY_MAX_M = 6.0

/** Thinnest base band or parapet, metres, when a short wall shrinks them to keep its row. */
export const BAND_MIN_M = 0.1

/** Lowest row of windows on the shortest wall that keeps one, metres. */
const ROW_MIN_M = 1.0

/** Wall height, metres, under which a face draws no openings: one lowest row between two thinnest bands. */
export const WALL_MIN_M = ROW_MIN_M + 2 * BAND_MIN_M

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

/** Share of a lit group's windows that glow, and of a dark group's. */
export const LIT_GROUP_RATE = 0.8
export const LIT_DARK_RATE = 0.08

/** Scales a group's id before its hash, so the group's pick differs from its first window's. */
export const LIT_GROUP_SCALE = 2.11

/** Lit-window colours in linear light: 2700 K, 3500 K, 4500 K, and a warm curtain. */
export const LIT_WARM: Vec3 = [1.0, 0.7, 0.4]
export const LIT_NEUTRAL: Vec3 = [1.0, 0.84, 0.64]
export const LIT_COOL: Vec3 = [0.82, 0.88, 1.0]
export const LIT_CURTAIN: Vec3 = [1.0, 0.6, 0.3]

/** A lit window's intensity: the base times a class level times a pick between dim and bright. */
export const LIT_BASE = 1.3
export const LIT_DIM = 0.5
export const LIT_BRIGHT = 1.3

/** A curtained window's intensity, as a share of an open one's. */
export const LIT_CURTAIN_DIM = 0.3

/** Glow at a pane's sill as a share of its head, for ceiling light. */
export const LIT_SILL_SHADE = 0.65

/** The scales that turn a window's glass and lit hashes into its colour, intensity and curtain picks. */
export const LIT_PICKS = [7.31, 5.77, 3.17] as const

/** The scales of the two tint hashes, drawn from the lookup's hash by `fract`, and how far each tints a wall. */
export const TINT_JITTER_HASH: Vec2 = [251, 419]
export const TINT_JITTER_L = 0.12
export const TINT_JITTER_B: Vec3 = [0.015, 0.005, -0.045]

/** A class's night lights. */
export interface FacadeLight {
  /** Share of its windows lit. */
  readonly share: number
  /** Share of lit windows in warm and in neutral colour; the rest are cool. */
  readonly warm: number
  readonly neutral: number
  /** Share of lit windows curtained. */
  readonly curtain: number
  /** Bays a lit group spans along a row. */
  readonly groupBays: number
  /** The class's intensity, as a share of `LIT_BASE`. */
  readonly level: number
}

/**
 * Whether a window is lit, as the shader's `facadeWindowLit`: a group of bays in a row is picked
 * lit or dark, then `LIT_GROUP_RATE` of a lit group's windows glow and `LIT_DARK_RATE` of a dark
 * group's, with the groups' share set so the class's share holds on average.
 *
 * @param cell - The point's place in the fitted grid (`FacadeFit.cell`)
 * @param run - The index of the run's first face (`FaceMatch.run`)
 * @param light - The class's night lights
 */
export function windowLit(cell: Vec2, run: number, light: FacadeLight): boolean {
  const rate = Math.max(LIT_GROUP_RATE, light.share)
  const dark = Math.min(LIT_DARK_RATE, light.share)
  const groups = (light.share - dark) / (rate - dark)
  const groupId: Vec2 = [
    Math.floor(Math.floor(cell[0]) / light.groupBays) * LIT_GROUP_SCALE,
    Math.floor(cell[1]) * LIT_GROUP_SCALE,
  ]
  const group = facadeHash12([facadeHash12(groupId), run])
  return windowHashes(cell, run).lit < (group < groups ? rate : dark)
}

/**
 * A lit window's glow in linear light at the pane's head, as the shader's `facadeLitGlow`, from the
 * picks it takes off the window's hashes.
 *
 * @param cell - The point's place in the fitted grid (`FacadeFit.cell`)
 * @param run - The index of the run's first face (`FaceMatch.run`)
 * @param light - The class's night lights
 */
export function litGlow(cell: Vec2, run: number, light: FacadeLight): Vec3 {
  const { glass, lit } = windowHashes(cell, run)
  const colourPick = fract(glass * LIT_PICKS[0])
  const levelPick = fract(lit * LIT_PICKS[1])
  const curtainPick = fract((glass + lit) * LIT_PICKS[2])
  const open = colourPick < light.warm ? LIT_WARM : colourPick < light.warm + light.neutral ? LIT_NEUTRAL : LIT_COOL
  const curtained = curtainPick < light.curtain
  const scale = LIT_BASE * light.level * (LIT_DIM + (LIT_BRIGHT - LIT_DIM) * levelPick)
  const colour = curtained ? LIT_CURTAIN : open
  return [0, 1, 2].map((i) => colour[i] * scale * (curtained ? LIT_CURTAIN_DIM : 1)) as unknown as Vec3
}

/**
 * The mean a lit pane glows over its height and over a class's picks, in linear light: what the far
 * tint glows by, so a tier change keeps the mean.
 *
 * @param light - The class's night lights
 */
export function litMeanLinear(light: FacadeLight): [number, number, number] {
  const cool = 1 - light.warm - light.neutral
  const open = 1 - light.curtain
  const gradient = (1 + LIT_SILL_SHADE) / 2
  const level = (LIT_BASE * light.level * (LIT_DIM + LIT_BRIGHT)) / 2
  const channel = (i: number) =>
    level *
    gradient *
    (open * (light.warm * LIT_WARM[i] + light.neutral * LIT_NEUTRAL[i] + cool * LIT_COOL[i]) +
      light.curtain * LIT_CURTAIN_DIM * LIT_CURTAIN[i])
  return [channel(0), channel(1), channel(2)]
}

/**
 * A building's wall tint jitter, as the shader's: a second hash of its lookup hash, so it holds across
 * tile levels, shifts its lightness and warmth.
 *
 * @param hash - The building's lookup hash
 * @returns The factor per channel on the wall colour
 */
export function tintFactor(hash: number): Vec3 {
  const light = fract(hash * TINT_JITTER_HASH[0]) * 2 - 1
  const warm = fract(hash * TINT_JITTER_HASH[1]) * 2 - 1
  return [0, 1, 2].map((i) => (1 + TINT_JITTER_L * light) * (1 + TINT_JITTER_B[i] * warm)) as unknown as Vec3
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
 * The base band and parapet of a wall, as the shader's `facadeBands`: their full heights, shrunk in
 * proportion on a wall too short for those and a `STOREY_MIN_M` row, each at least `BAND_MIN_M`.
 *
 * @param wall - The wall's height, metres
 * @returns The two bands' heights, metres
 */
export function fittedBands(wall: number): { base: number; parapet: number } {
  const scale = Math.min(Math.max((wall - STOREY_MIN_M) / (FACADE_BASE_BAND_M + FACADE_PARAPET_M), 0), 1)
  return {
    base: Math.max(FACADE_BASE_BAND_M * scale, BAND_MIN_M),
    parapet: Math.max(FACADE_PARAPET_M * scale, BAND_MIN_M),
  }
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
  const wall = match.h1 - match.h0
  const bands = fittedBands(wall)
  const bottom = match.h0 + bands.base
  const usable = match.h1 - bands.parapet - bottom
  if (span <= 0 || wall < WALL_MIN_M) return NO_FIT
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
