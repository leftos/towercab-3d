/**
 * The wall faces of each building feature in a tile, chained into runs, for the facade shader's
 * per-face wall table.
 *
 * A face is a flat piece of one feature's wall, found from the tile's read-back triangles: wall
 * triangles are taken strong first, then largest first, and each joins the first face whose plane holds all three of
 * its vertices, or starts a face of its own when it is large enough. A face keeps its plane, its
 * extent along the wall and its bottom and top. A run is a chain of vertical faces meeting end to
 * end through turns of at most `RUN_TURN_DEG`, so windows can fit along a whole curved or kinked
 * wall; a run that closes on itself is a closed loop. Every coordinate is relative to the feature's
 * lowest vertex (`baseMC`), along the feature's up, in the tile's model coordinates. A run's faces
 * stop at the feature's eave, so the triangle of a gable end holds no rows.
 *
 * The table lays three RGBA float texels per face (`faceTexels`): (normal, plane offset),
 * (start, end, position along the run, run length, negative for a closed loop), (its run's highest
 * bottom, its run's lowest top, the tile-wide index of its run's first face, 0).
 */
import {
  FACADE_ROOF_COS,
  FACE_BUILD_CHUNK_PLANE_TESTS,
  FACE_BUILD_CHUNK_TRIANGLES,
  FACE_GATE_COS,
  FACE_JOIN_GAP_M,
  FACE_LINK_CHUNK_PAIRS,
  FACE_PLANE_MERGE_M,
  FACE_STRONG_ALTITUDE_M,
  FACE_VERTICAL_COS,
  FACES_PER_FEATURE_MAX,
  FACES_PER_TILE_MAX,
  RUN_LINK_M,
  RUN_TURN_DEG,
} from '@/constants'

export type Vec3 = readonly [number, number, number]

/** A flat piece of one feature's wall, relative to the feature's lowest vertex. */
export interface Face {
  /** Outward unit normal, in model coordinates. */
  readonly normal: Vec3
  /** The plane's offset: `normal · (p - base)` for every point p on it. */
  readonly d: number
  /** Start and end along `cross(up, normal)`, start below end. */
  readonly s0: number
  readonly s1: number
  /** Bottom and top along the feature's up. */
  readonly h0: number
  readonly h1: number
  /** Whether the normal is within `FACE_VERTICAL_COS` of horizontal; only vertical faces join runs. */
  readonly vertical: boolean
}

/** Faces chained end to end, in walking order (along each face's `cross(up, normal)`). */
export interface Run {
  readonly faces: readonly Face[]
  /** The position along the run of each face's start. */
  readonly u0: readonly number[]
  /** The run's length: the sum of its faces' lengths. */
  readonly length: number
  /** Whether the run closes on itself; it then starts at its joint farthest north. */
  readonly closed: boolean
  /** The run's smallest (x, y) end point on the horizontal, relative to the feature's base: a tie-break. */
  readonly end: readonly [number, number]
}

/** A feature's up and north, unit vectors in model coordinates. */
export interface FeatureFrame {
  readonly up: Vec3
  readonly north: Vec3
}

/** The triangles of one tile primitive, as far as the faces read them. */
export interface FaceGeometry {
  readonly positions: ArrayLike<number>
  readonly featureIds: ArrayLike<number>
  readonly indices: ArrayLike<number>
}

/** The per-feature stats the faces read (`TileFeatureStats`). */
export interface FaceStats {
  readonly count: number
  readonly baseMC: Float64Array
  /** The lowest vertex's height along the feature's up. */
  readonly base: Float64Array
  /** The feature's wall top along its up (`TileFeatureStats.eave`). */
  readonly eave: Float64Array
  readonly up: Float64Array
  readonly north: Float64Array
  readonly hasGeometry: Uint8Array
}

/** The face table of a tile: its texels and each feature's face range. */
export interface FaceTable {
  readonly texels: Float32Array
  readonly width: number
  readonly height: number
  readonly first: Uint32Array
  readonly count: Uint32Array
}

/** Texels per face in the table. */
export const FACE_TEXELS = 3

/** Largest texture width the table uses, whatever the context allows. */
const FACE_TABLE_WIDTH_MAX = 4096

/** A triangle more than this narrow (twice its area, m²) is degenerate and dropped. */
const DEGENERATE_DOUBLE_AREA = 1e-4

/** y within this many metres counts as level when choosing a closed loop's seam. */
const SEAM_LEVEL_M = 0.01

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function unit(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2])
  return [v[0] / length, v[1] / length, v[2] / length]
}

function vec3(array: ArrayLike<number>, i: number): Vec3 {
  return [array[i * 3], array[i * 3 + 1], array[i * 3 + 2]]
}

/** Feature `f`'s up and north from its stats. */
export function featureFrame(stats: FaceStats, f: number): FeatureFrame {
  return { up: vec3(stats.up, f), north: vec3(stats.north, f) }
}

// ---- Wall triangles ---------------------------------------------------------------------------

/** Floats per wall triangle: its three vertices relative to the feature's base, then its unit normal. */
const STRIDE = 12

/**
 * A tile's wall triangles in flat arrays, in the order they were collected, each feature's chained
 * from its first to its last so a feature's triangles can be taken without a sort of the whole tile.
 */
class WallTriangles {
  count = 0
  readonly feature: Int32Array
  readonly strong: Uint8Array
  readonly doubleArea: Float64Array
  readonly data: Float64Array
  /** The next wall triangle of the same feature, or -1. */
  private readonly nextInFeature: Int32Array
  /** Each feature's first and last wall triangle, or -1. */
  private readonly head: Int32Array
  private readonly tail: Int32Array

  constructor(
    capacity: number,
    private readonly stats: FaceStats,
  ) {
    this.feature = new Int32Array(capacity)
    this.strong = new Uint8Array(capacity)
    this.doubleArea = new Float64Array(capacity)
    this.data = new Float64Array(capacity * STRIDE)
    this.nextInFeature = new Int32Array(capacity)
    this.head = new Int32Array(stats.count).fill(-1)
    this.tail = new Int32Array(stats.count).fill(-1)
  }

  /** Adds triangle `t` (the indices at t, t + 1, t + 2) of feature `f` when it is a wall and not degenerate. */
  add(positions: ArrayLike<number>, indices: ArrayLike<number>, t: number, f: number): void {
    const o = this.count * STRIDE
    const data = this.data
    for (let v = 0; v < 3; v++) {
      const p = indices[t + v] * 3
      for (let k = 0; k < 3; k++) data[o + v * 3 + k] = positions[p + k] - this.stats.baseMC[f * 3 + k]
    }
    const e1x = data[o + 3] - data[o]
    const e1y = data[o + 4] - data[o + 1]
    const e1z = data[o + 5] - data[o + 2]
    const e2x = data[o + 6] - data[o]
    const e2y = data[o + 7] - data[o + 1]
    const e2z = data[o + 8] - data[o + 2]
    const nx = e1y * e2z - e1z * e2y
    const ny = e1z * e2x - e1x * e2z
    const nz = e1x * e2y - e1y * e2x
    const doubleArea = Math.hypot(nx, ny, nz)
    if (!(doubleArea >= DEGENERATE_DOUBLE_AREA)) return
    const up = this.stats.up
    if (Math.abs(nx * up[f * 3] + ny * up[f * 3 + 1] + nz * up[f * 3 + 2]) / doubleArea > FACADE_ROOF_COS) return
    data[o + 9] = nx / doubleArea
    data[o + 10] = ny / doubleArea
    data[o + 11] = nz / doubleArea
    const longest = Math.max(
      Math.hypot(e1x, e1y, e1z),
      Math.hypot(e2x, e2y, e2z),
      Math.hypot(e2x - e1x, e2y - e1y, e2z - e1z),
    )
    this.append(f, doubleArea, doubleArea / longest >= FACE_STRONG_ALTITUDE_M)
  }

  private append(f: number, doubleArea: number, strong: boolean): void {
    const i = this.count++
    this.feature[i] = f
    this.doubleArea[i] = doubleArea
    this.strong[i] = strong ? 1 : 0
    this.nextInFeature[i] = -1
    if (this.head[f] === -1) this.head[f] = i
    else this.nextInFeature[this.tail[f]] = i
    this.tail[f] = i
  }

  /** Feature `f`'s wall triangles in grouping order (`compare`). */
  sortedOf(f: number): Uint32Array {
    let length = 0
    for (let i = this.head[f]; i !== -1; i = this.nextInFeature[i]) length++
    const order = new Uint32Array(length)
    let at = 0
    for (let i = this.head[f]; i !== -1; i = this.nextInFeature[i]) order[at++] = i
    return order.sort((a, b) => this.compare(a, b))
  }

  /**
   * Strong first, so a large sliver never comes before the strong triangle that starts its plane;
   * then larger first; then by centroid, so equal triangles take one order whatever the buffer's.
   */
  private compare(a: number, b: number): number {
    if (this.strong[a] !== this.strong[b]) return this.strong[b] - this.strong[a]
    if (this.doubleArea[a] !== this.doubleArea[b]) return this.doubleArea[b] - this.doubleArea[a]
    const data = this.data
    for (let k = 0; k < 3; k++) {
      const oa = a * STRIDE + k
      const ob = b * STRIDE + k
      const difference = data[oa] + data[oa + 3] + data[oa + 6] - (data[ob] + data[ob + 3] + data[ob + 6])
      if (difference !== 0) return difference
    }
    return 0
  }
}

// ---- Faces --------------------------------------------------------------------------------------

interface Plane {
  readonly normal: Vec3
  readonly d: number
  readonly members: number[]
}

/** Groups one feature's wall triangles, in grouping order, into planes. */
class PlaneGrouper {
  readonly planes: Plane[] = []

  constructor(
    readonly feature: number,
    private readonly walls: WallTriangles,
  ) {}

  /**
   * Adds wall triangle `i` to the first plane that holds it, or starts a plane with it when it is strong.
   *
   * @returns The planes it was tested against
   */
  add(i: number): number {
    const data = this.walls.data
    const o = i * STRIDE
    const strong = this.walls.strong[i] === 1
    let tests = 0
    for (const plane of this.planes) {
      tests++
      const n = plane.normal
      if (strong && data[o + 9] * n[0] + data[o + 10] * n[1] + data[o + 11] * n[2] < FACE_GATE_COS) continue
      if (this.onPlane(o, plane)) {
        plane.members.push(i)
        return tests
      }
    }
    if (strong) {
      const normal: Vec3 = [data[o + 9], data[o + 10], data[o + 11]]
      this.planes.push({
        normal,
        d: normal[0] * data[o] + normal[1] * data[o + 1] + normal[2] * data[o + 2],
        members: [i],
      })
    }
    return tests
  }

  private onPlane(o: number, plane: Plane): boolean {
    const data = this.walls.data
    const n = plane.normal
    for (let v = o; v < o + 9; v += 3) {
      if (Math.abs(data[v] * n[0] + data[v + 1] * n[1] + data[v + 2] * n[2] - plane.d) > FACE_PLANE_MERGE_M)
        return false
    }
    return true
  }
}

interface Piece {
  s0: number
  s1: number
  h0: number
  h1: number
}

/** A member triangle's extent along `t` and `up`. */
function pieceOf(data: Float64Array, i: number, t: Vec3, up: Vec3): Piece {
  const piece = { s0: Infinity, s1: -Infinity, h0: Infinity, h1: -Infinity }
  for (let v = 0; v < 3; v++) {
    const p: Vec3 = [data[i * STRIDE + v * 3], data[i * STRIDE + v * 3 + 1], data[i * STRIDE + v * 3 + 2]]
    const s = dot(p, t)
    const h = dot(p, up)
    piece.s0 = Math.min(piece.s0, s)
    piece.s1 = Math.max(piece.s1, s)
    piece.h0 = Math.min(piece.h0, h)
    piece.h1 = Math.max(piece.h1, h)
  }
  return piece
}

/** A plane's faces: its member triangles' extents along the wall, merged across gaps of `FACE_JOIN_GAP_M`. */
function planeFaces(plane: Plane, triangles: WallTriangles, up: Vec3): Face[] {
  const t = unit(cross(up, plane.normal))
  const vertical = Math.abs(dot(plane.normal, up)) <= FACE_VERTICAL_COS
  const pieces = plane.members.map((i) => pieceOf(triangles.data, i, t, up)).sort((a, b) => a.s0 - b.s0)
  const merged: Piece[] = []
  for (const piece of pieces) {
    const last = merged[merged.length - 1]
    if (last !== undefined && piece.s0 <= last.s1 + FACE_JOIN_GAP_M) {
      last.s1 = Math.max(last.s1, piece.s1)
      last.h0 = Math.min(last.h0, piece.h0)
      last.h1 = Math.max(last.h1, piece.h1)
    } else {
      merged.push({ ...piece })
    }
  }
  return merged.map((piece) => ({ normal: plane.normal, d: plane.d, ...piece, vertical }))
}

// ---- Runs ---------------------------------------------------------------------------------------

/** Each face's two ends on the horizontal plane through the base: [start, end]. */
function faceEnds(faces: readonly Face[], up: Vec3): [Vec3, Vec3][] {
  return faces.map((face) => {
    const t = unit(cross(up, face.normal))
    const at = (s: number): Vec3 => {
      const p: Vec3 = [
        face.d * face.normal[0] + s * t[0],
        face.d * face.normal[1] + s * t[1],
        face.d * face.normal[2] + s * t[2],
      ]
      const h = dot(p, up)
      return [p[0] - h * up[0], p[1] - h * up[1], p[2] - h * up[2]]
    }
    return [at(face.s0), at(face.s1)]
  })
}

const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

interface Link {
  readonly from: number
  readonly to: number
  readonly turn: number
  readonly gap: number
}

/** Links each vertical face's end to the next one's start, smallest turn first, each end once. */
function linkFaces(faces: readonly Face[], ends: readonly [Vec3, Vec3][]): Int32Array {
  const links: Link[] = []
  const maxTurn = (RUN_TURN_DEG * Math.PI) / 180
  for (let from = 0; from < faces.length; from++) {
    if (!faces[from].vertical) continue
    for (let to = 0; to < faces.length; to++) {
      if (to === from || !faces[to].vertical) continue
      const gap = distance(ends[from][1], ends[to][0])
      if (gap > RUN_LINK_M) continue
      const turn = Math.acos(Math.min(1, dot(faces[from].normal, faces[to].normal)))
      if (turn <= maxTurn) links.push({ from, to, turn, gap })
    }
  }
  links.sort((a, b) => a.turn - b.turn || a.gap - b.gap)
  const next = new Int32Array(faces.length).fill(-1)
  const taken = new Uint8Array(faces.length)
  for (const { from, to } of links) {
    if (next[from] !== -1 || taken[to] === 1) continue
    next[from] = to
    taken[to] = 1
  }
  return next
}

function makeRun(
  faces: readonly Face[],
  ends: readonly [Vec3, Vec3][],
  order: readonly number[],
  closed: boolean,
): Run {
  const u0: number[] = []
  let length = 0
  let end: [number, number] = [Infinity, Infinity]
  for (const i of order) {
    u0.push(length)
    length += faces[i].s1 - faces[i].s0
    for (const p of ends[i]) {
      if (p[0] < end[0] || (p[0] === end[0] && p[1] < end[1])) end = [p[0], p[1]]
    }
  }
  return { faces: order.map((i) => faces[i]), u0, length, closed, end }
}

/** The loop rotated to start at its joint farthest north (smallest east on a level tie). */
function seamFirst(loop: readonly number[], ends: readonly [Vec3, Vec3][], frame: FeatureFrame): number[] {
  const east = cross(frame.north, frame.up)
  const joints = loop.map((face, m) => {
    const before = ends[loop[(m + loop.length - 1) % loop.length]][1]
    const start = ends[face][0]
    const joint: Vec3 = [(before[0] + start[0]) / 2, (before[1] + start[1]) / 2, (before[2] + start[2]) / 2]
    return { north: dot(joint, frame.north), east: dot(joint, east) }
  })
  const northmost = Math.max(...joints.map((joint) => joint.north))
  let seam = -1
  joints.forEach((joint, m) => {
    if (joint.north < northmost - SEAM_LEVEL_M) return
    if (seam === -1 || joint.east < joints[seam].east) seam = m
  })
  return [...loop.slice(seam), ...loop.slice(0, seam)]
}

/**
 * A face stopped at the feature's eave, relative to the feature's base. A face that starts at or
 * above the eave, the wall of a higher part of a stepped roof, keeps its top.
 */
function capAtEave(face: Face, eave: number): Face {
  return face.h0 < eave && face.h1 > eave ? { ...face, h1: eave } : face
}

/**
 * Chains a feature's faces into runs: open runs from each unlinked start, then closed loops of
 * what is left. A face that is not vertical is a run of its own.
 *
 * @param faces - The feature's faces (`extractFaces`)
 * @param frame - The feature's up and north (`featureFrame`)
 */
export function faceRuns(faces: readonly Face[], frame: FeatureFrame): Run[] {
  const ends = faceEnds(faces, frame.up)
  const next = linkFaces(faces, ends)
  const hasPrevious = new Uint8Array(faces.length)
  for (const to of next) if (to !== -1) hasPrevious[to] = 1
  const visited = new Uint8Array(faces.length)
  const walk = (start: number) => {
    const order: number[] = []
    for (let i = start; i !== -1 && visited[i] === 0; i = next[i]) {
      visited[i] = 1
      order.push(i)
    }
    return order
  }
  const runs: Run[] = []
  for (let i = 0; i < faces.length; i++) {
    if (hasPrevious[i] === 0) runs.push(makeRun(faces, ends, walk(i), false))
  }
  for (let i = 0; i < faces.length; i++) {
    if (visited[i] === 0) runs.push(makeRun(faces, ends, seamFirst(walk(i), ends, frame), true))
  }
  return runs
}

// ---- Caps and the table -------------------------------------------------------------------------

/** Longer first; on a tie, the run with the smaller (x, y) end point. */
function compareRuns(a: Run, b: Run): number {
  return b.length - a.length || a.end[0] - b.end[0] || a.end[1] - b.end[1]
}

/**
 * A feature's runs in table order, longest first, keeping whole runs while their faces fit in
 * `FACES_PER_FEATURE_MAX`; a run that does not fit is dropped whole and shorter ones still tried.
 */
export function capFeatureRuns(runs: readonly Run[]): Run[] {
  const kept: Run[] = []
  let faces = 0
  for (const run of [...runs].sort(compareRuns)) {
    if (faces + run.faces.length > FACES_PER_FEATURE_MAX) continue
    kept.push(run)
    faces += run.faces.length
  }
  return kept
}

const facesIn = (runs: readonly Run[]) => runs.reduce((sum, run) => sum + run.faces.length, 0)

/**
 * Keeps features' runs in feature order until the next feature would pass `FACES_PER_TILE_MAX`;
 * that feature and every later one keep none.
 *
 * @returns The kept runs per feature, and how many features with faces were cut
 */
export function capTileRuns(runs: readonly (readonly Run[])[]): { runs: (readonly Run[])[]; cut: number } {
  const kept: (readonly Run[])[] = []
  let faces = 0
  let cut = 0
  for (const featureRuns of runs) {
    const count = facesIn(featureRuns)
    if (cut > 0 || faces + count > FACES_PER_TILE_MAX) {
      kept.push([])
      if (count > 0) cut++
      continue
    }
    kept.push(featureRuns)
    faces += count
  }
  return { runs: kept, cut }
}

/** The table's width: the largest multiple of three within the texture limit and the faces, at least 3. */
function tableWidth(faces: number, maxTextureSize: number): number {
  const limit = Math.floor(Math.min(maxTextureSize, FACE_TABLE_WIDTH_MAX) / FACE_TEXELS) * FACE_TEXELS
  return Math.max(FACE_TEXELS, Math.min(limit, FACE_TEXELS * faces))
}

/**
 * Lays each feature's faces, run by run in the given order, three texels per face, in rows of a
 * width divisible by three so a face's texels share a row: face i's texels are k = 3i, 3i+1, 3i+2
 * at (k mod width, k div width). Every face of a run carries the index of the run's first face,
 * the run's identity, and the run's band: the highest of its faces' bottoms and the lowest of
 * their tops, so rows fit whole across every joint of the run.
 *
 * @param runs - Each feature's runs, in feature order (capped)
 * @param maxTextureSize - The context's texture limit
 */
export function faceTexels(runs: readonly (readonly Run[])[], maxTextureSize: number): FaceTable {
  const total = runs.reduce((sum, featureRuns) => sum + facesIn(featureRuns), 0)
  const width = tableWidth(total, maxTextureSize)
  const height = Math.max(1, Math.ceil((FACE_TEXELS * total) / width))
  const texels = new Float32Array(width * height * 4)
  const first = new Uint32Array(runs.length)
  const count = new Uint32Array(runs.length)
  let face = 0
  runs.forEach((featureRuns, f) => {
    first[f] = face
    for (const run of featureRuns) {
      const signedLength = run.closed ? -run.length : run.length
      const runFirst = face
      const bottom = Math.max(...run.faces.map((entry) => entry.h0))
      const top = Math.min(...run.faces.map((entry) => entry.h1))
      run.faces.forEach((entry, i) => {
        const o = face * FACE_TEXELS * 4
        const plane = [...entry.normal, entry.d]
        texels.set([...plane, entry.s0, entry.s1, run.u0[i], signedLength, bottom, top, runFirst, 0], o)
        face++
      })
    }
    count[f] = face - first[f]
  })
  return { texels, width, height, first, count }
}

// ---- The stepped build --------------------------------------------------------------------------

/** The work one `FaceBuilder.step` did, so tests can bound it. */
export interface FaceStepWork {
  /** Source triangles read while collecting wall triangles. */
  sourceTriangles: number
  /** Wall triangles grouped into planes. */
  wallTriangles: number
  /** Tests of a wall triangle against a plane while grouping. */
  planeTests: number
  /** Face pairs the run linking can examine: the square of each linked feature's faces. */
  facePairs: number
  /** The face pairs of the step's last linked feature, the one that may take it past `FACE_LINK_CHUNK_PAIRS`. */
  lastFeaturePairs: number
}

type Phase = 'collect' | 'group' | 'link' | 'done'

/**
 * Builds a tile's faces and runs a bounded piece at a time, so the work can spread over frames.
 * Each `step` does one of: collect the wall triangles of the next `limit` source triangles; group
 * the next `limit` wall triangles into planes, ending early before `FACE_BUILD_CHUNK_PLANE_TESTS`
 * plane tests; or link and cap the runs of the next features, ending after the feature that passes
 * `FACE_LINK_CHUNK_PAIRS` face pairs.
 */
export class FaceBuilder {
  /** Each feature's faces, filled as features are linked. */
  readonly faces: Face[][]
  /** Each feature's runs in table order, capped per feature, filled as features are linked. */
  readonly runs: Run[][]
  private readonly walls: WallTriangles
  /** Each feature's planes, kept from grouping until its runs are linked. */
  private readonly planes: Plane[][]
  private phase: Phase = 'collect'
  private primitive = 0
  private triangle = 0
  /** The next feature to group, then the next to link. */
  private feature = 0
  private grouper: PlaneGrouper | undefined
  private order: Uint32Array = new Uint32Array(0)
  private position = 0

  constructor(
    private readonly primitives: readonly FaceGeometry[],
    private readonly stats: FaceStats,
  ) {
    const capacity = primitives.reduce((sum, primitive) => sum + Math.floor(primitive.indices.length / 3), 0)
    this.walls = new WallTriangles(capacity, stats)
    this.faces = Array.from({ length: stats.count }, () => [])
    this.runs = Array.from({ length: stats.count }, () => [])
    this.planes = Array.from({ length: stats.count }, () => [])
  }

  /** Whether every feature's runs are linked and capped. */
  get done(): boolean {
    return this.phase === 'done'
  }

  /**
   * Takes the next step of the build.
   *
   * @param limit - Source triangles to collect, or wall triangles to group, in this step
   * @returns The work the step did
   */
  step(limit: number): FaceStepWork {
    const work: FaceStepWork = {
      sourceTriangles: 0,
      wallTriangles: 0,
      planeTests: 0,
      facePairs: 0,
      lastFeaturePairs: 0,
    }
    if (this.phase === 'collect') this.collect(limit, work)
    else if (this.phase === 'group') this.group(limit, work)
    else if (this.phase === 'link') this.link(work)
    return work
  }

  private collect(limit: number, work: FaceStepWork): void {
    while (work.sourceTriangles < limit && this.primitive < this.primitives.length) {
      const { positions, featureIds, indices } = this.primitives[this.primitive]
      if (this.triangle + 2 < indices.length) {
        const f = featureIds[indices[this.triangle]]
        if (this.hasWalls(f)) this.walls.add(positions, indices, this.triangle, f)
        this.triangle += 3
        work.sourceTriangles++
      }
      if (this.triangle + 2 >= indices.length) {
        this.primitive++
        this.triangle = 0
      }
    }
    if (this.primitive >= this.primitives.length) this.phase = 'group'
  }

  /** Whether `f` is a feature id of the tile with vertices of its own. */
  private hasWalls(f: number): boolean {
    return f >= 0 && f < this.stats.count && this.stats.hasGeometry[f] !== 0
  }

  private group(limit: number, work: FaceStepWork): void {
    while (work.wallTriangles < limit && this.nextTriangle()) {
      const grouper = this.grouper as PlaneGrouper
      if (work.planeTests > 0 && work.planeTests + grouper.planes.length > FACE_BUILD_CHUNK_PLANE_TESTS) return
      work.planeTests += grouper.add(this.order[this.position++])
      work.wallTriangles++
    }
  }

  /**
   * Whether a wall triangle is left to group: keeps the planes of a feature whose triangles are all
   * grouped and starts the next feature with any, and moves on to linking when none is left.
   */
  private nextTriangle(): boolean {
    for (;;) {
      if (this.grouper !== undefined && this.position < this.order.length) return true
      if (this.grouper !== undefined) this.planes[this.grouper.feature] = this.grouper.planes
      this.grouper = undefined
      if (this.feature >= this.stats.count) {
        this.phase = 'link'
        this.feature = 0
        return false
      }
      const f = this.feature++
      this.order = this.walls.sortedOf(f)
      this.position = 0
      if (this.order.length > 0) this.grouper = new PlaneGrouper(f, this.walls)
    }
  }

  private link(work: FaceStepWork): void {
    while (this.feature < this.stats.count && work.facePairs <= FACE_LINK_CHUNK_PAIRS) {
      const f = this.feature++
      if (this.planes[f].length === 0) continue
      const up = vec3(this.stats.up, f)
      this.faces[f] = this.planes[f].flatMap((plane) => planeFaces(plane, this.walls, up))
      const eave = this.stats.eave[f] - this.stats.base[f]
      const walls = this.faces[f].map((face) => capAtEave(face, eave))
      this.runs[f] = capFeatureRuns(faceRuns(walls, featureFrame(this.stats, f)))
      this.planes[f] = []
      work.lastFeaturePairs = this.faces[f].length ** 2
      work.facePairs += work.lastFeaturePairs
    }
    if (this.feature >= this.stats.count) this.phase = 'done'
  }
}

/**
 * Every feature's wall faces in a tile, in one go.
 *
 * @param primitives - The tile's triangle-list primitives
 * @param stats - The tile's stats (`computeFeatureStats`): base, up and north per feature
 * @returns Faces per feature id; a feature without wall triangles has none
 */
export function extractFaces(primitives: readonly FaceGeometry[], stats: FaceStats): Face[][] {
  const builder = new FaceBuilder(primitives, stats)
  while (!builder.done) builder.step(FACE_BUILD_CHUNK_TRIANGLES)
  return builder.faces
}
