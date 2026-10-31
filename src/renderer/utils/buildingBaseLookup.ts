/**
 * Each OSM building's ground, measured from its own geometry, for the facade shader's floor lines.
 *
 * The OSM Buildings tileset carries no base height per building, and one tile's model origin sits
 * on the ellipsoid up to about 70 km away, so a height taken from that origin puts each building's
 * floor lines at a random offset. When a tile loads, its vertex and index buffers are read back
 * once (WebGL2 keeps no CPU copy of them), and each feature's lowest vertex, roof height and
 * footprint area are computed. A per-tile lookup texture keyed by feature id carries them to the
 * shader; a custom shader has no per-tile uniform, so the texture is bound by a patch on Cesium's
 * private `BatchTexturePipelineStage.process` (`Source/Scene/Model/BatchTexturePipelineStage.js`).
 *
 * The lookup texture is two rows of `featuresLength` RGBA float texels. Row 0 holds each
 * feature's lowest vertex in the tile's model coordinates and the metres from the building's
 * ground to that vertex (a raised part's `min_height`). Row 1 holds the metres from the building's
 * ground to the lowest vertex of the feature's upward faces (its wall top: the eave of a sloped
 * roof, the roof of a flat one; -1 when unknown), the feature's hash (`featureHash`), which picks
 * its wall colour variant, and the feature's first face and face count in the tile's face table.
 * A tile without a lookup (not built yet, or skipped) binds a single column whose ground offset is
 * -1, the sentinel on which the shader draws no floor lines, whose wall top is -1 (unknown), whose
 * hash is 0 and whose face count is 0. The base and roof heights and the footprint area stay on
 * the CPU (`getTileFeatureStats`).
 *
 * Beside the lookup each tile binds its face table (`buildingFaces.ts`): every wall face of every
 * feature, three RGBA float texels per face. Both are built over several frames, a step at a time
 * within the frame budget, and are bound, recorded and released together; a tile without them
 * binds a shared empty face table.
 */
import * as Cesium from 'cesium'
import { BUILDING_LOOKUP_BUILD_BUDGET_MS, FACADE_ROOF_COS, FACE_BUILD_CHUNK_TRIANGLES } from '@/constants'
import { capTileRuns, FACE_TEXELS, FaceBuilder, faceTexels, type Run } from '@/utils/buildingFaces'
import { isBuildingPart, tagValueNumber } from '@/utils/buildingTags'

/** The sampler the patched stage declares and the facade shader reads. */
export const BUILDING_LOOKUP_SAMPLER = 'tc3d_buildingLookup'

/** The face-table sampler the patched stage declares beside the lookup's. */
export const BUILDING_FACES_SAMPLER = 'tc3d_buildingFaces'

/** The define the patched stage adds to the fragment shader where it binds the lookup (WebGL2 only). */
export const BUILDING_LOOKUP_DEFINE = 'TC3D_BUILDING_LOOKUP'

/** The lookup row holding each feature's lowest vertex and ground offset. */
export const LOOKUP_ROW_GROUND = 0

/** The lookup row holding each feature's wall top and hash. */
export const LOOKUP_ROW_TOP = 1

/** Rows of the lookup texture. */
const LOOKUP_ROWS = 2

/**
 * GLSL reading one feature's lookup texel in a row, the id clamped into the texture on both sides.
 *
 * @param id - A GLSL `int` expression holding the feature id
 * @param row - The row, a GLSL `int` literal (`LOOKUP_ROW_GROUND` or `LOOKUP_ROW_TOP`)
 * @returns The `vec4` expression
 */
export function glslBuildingLookupRead(id: string, row: string): string {
  const size = `textureSize(${BUILDING_LOOKUP_SAMPLER}, 0).x`
  return `texelFetch(${BUILDING_LOOKUP_SAMPLER}, ivec2(clamp(${id}, 0, ${size} - 1), ${row}), 0)`
}

/**
 * The texels bound where a tile has no lookup, one per row: ground offset -1, the shader's
 * sentinel for no floor lines, then wall top -1 (unknown) and hash 0 (colour variant 0).
 */
export function emptyLookupTexels(): Float32Array {
  return Float32Array.of(0, 0, 0, -1, -1, 0, 0, 0)
}

/** The face table bound where a tile has none: one face of zeros, which no feature's range reaches. */
export function emptyFaceTexels(): Float32Array {
  return new Float32Array(FACE_TEXELS * 4)
}

/** One triangle-list primitive of a tile, read back from the GPU. */
export interface PrimitiveGeometry {
  /** xyz per vertex, in the primitive's model coordinates. */
  readonly positions: Float32Array
  /** The feature id of each vertex. */
  readonly featureIds: ArrayLike<number>
  /** Three vertex indices per triangle, counter-clockwise seen from the front. */
  readonly indices: ArrayLike<number>
  /** Model coordinates to Earth-fixed coordinates. */
  readonly modelMatrix: Cesium.Matrix4
}

/** Per-feature geometry of one tile, indexed by feature id. */
export interface TileFeatureStats {
  readonly count: number
  /** The lowest vertex in the tile's model coordinates, xyz per feature. */
  readonly baseMC: Float64Array
  /** The lowest vertex's height along the feature's up, in model coordinates (metres). */
  readonly base: Float64Array
  /** The highest vertex's height along the feature's up, in model coordinates (metres). */
  readonly roof: Float64Array
  /**
   * The lowest vertex of the feature's upward faces, along its up in model coordinates (metres):
   * the eave of a sloped roof, the roof of a flat one, `roof` when no face points up; NaN for a
   * feature without vertices until `fillTwins` gives it its twin's.
   */
  readonly eave: Float64Array
  /** Footprint area in m²: the upward faces projected on the horizontal. */
  readonly area: Float64Array
  /** Metres from the building's ground to the feature's base: a raised part's `min_height`. */
  readonly groundOffset: Float64Array
  /** 1 where the feature owns vertices in the tile; a vertex-less twin keeps 0. */
  readonly hasGeometry: Uint8Array
  /** The feature's `featureHash`, in [0, 1). */
  readonly hash: Float64Array
  /** The feature's up: the geocentric up at its first vertex, a unit vector in model coordinates, xyz per feature. */
  readonly up: Float64Array
  /** The feature's north: the Earth's axis made level at its first vertex, a unit vector in model coordinates, xyz per feature. */
  readonly north: Float64Array
  /** The feature's first face in the tile's face table; a twin's is its owner's. */
  readonly faceFirst: Uint32Array
  /** The feature's faces in the table; 0 without faces, and for a vertex-less feature without a twin. */
  readonly faceCount: Uint32Array
}

/** The property reader a tile feature offers. */
export interface FeatureProperties {
  getProperty(name: string): unknown
}

function emptyStats(count: number): TileFeatureStats {
  return {
    count,
    baseMC: new Float64Array(count * 3),
    base: new Float64Array(count),
    roof: new Float64Array(count),
    eave: new Float64Array(count).fill(Number.NaN),
    area: new Float64Array(count),
    groundOffset: new Float64Array(count),
    hasGeometry: new Uint8Array(count),
    hash: new Float64Array(count),
    up: new Float64Array(count * 3),
    north: new Float64Array(count * 3),
    faceFirst: new Uint32Array(count),
    faceCount: new Uint32Array(count),
  }
}

/** The Earth's axis at a model-space point with up `up`, made level and unit, in model coordinates. */
function northAt(inverse: Cesium.Matrix4, up: Cesium.Cartesian3): Cesium.Cartesian3 {
  const axis = Cesium.Matrix4.multiplyByPointAsVector(inverse, Cesium.Cartesian3.UNIT_Z, new Cesium.Cartesian3())
  const level = Cesium.Cartesian3.subtract(
    axis,
    Cesium.Cartesian3.multiplyByScalar(up, Cesium.Cartesian3.dot(axis, up), new Cesium.Cartesian3()),
    axis,
  )
  return Cesium.Cartesian3.normalize(level, level)
}

/** The geocentric up at a model-space point, as a unit vector in model coordinates. */
function upAt(primitive: PrimitiveGeometry, inverse: Cesium.Matrix4, point: Cesium.Cartesian3): Cesium.Cartesian3 {
  const world = Cesium.Matrix4.multiplyByPoint(primitive.modelMatrix, point, new Cesium.Cartesian3())
  Cesium.Cartesian3.normalize(world, world)
  const up = Cesium.Matrix4.multiplyByPointAsVector(inverse, world, world)
  return Cesium.Cartesian3.normalize(up, up)
}

function scanVertices(primitive: PrimitiveGeometry, stats: TileFeatureStats): void {
  const inverse = Cesium.Matrix4.inverse(primitive.modelMatrix, new Cesium.Matrix4())
  const { positions, featureIds } = primitive
  const { up } = stats
  const point = new Cesium.Cartesian3()
  for (let v = 0; v < featureIds.length; v++) {
    const f = featureIds[v]
    if (!(f >= 0 && f < stats.count)) continue
    point.x = positions[v * 3]
    point.y = positions[v * 3 + 1]
    point.z = positions[v * 3 + 2]
    if (stats.hasGeometry[f] === 0) {
      const u = upAt(primitive, inverse, point)
      up.set([u.x, u.y, u.z], f * 3)
      const north = northAt(inverse, u)
      stats.north.set([north.x, north.y, north.z], f * 3)
      stats.base[f] = Number.POSITIVE_INFINITY
      stats.roof[f] = Number.NEGATIVE_INFINITY
      stats.eave[f] = Number.POSITIVE_INFINITY
      stats.hasGeometry[f] = 1
    }
    const h = point.x * up[f * 3] + point.y * up[f * 3 + 1] + point.z * up[f * 3 + 2]
    if (h < stats.base[f]) {
      stats.base[f] = h
      stats.baseMC.set([point.x, point.y, point.z], f * 3)
    }
    stats.roof[f] = Math.max(stats.roof[f], h)
  }
}

/** Twice the triangle's area projected on the plane normal to `up`, signed by its facing. */
function projectedDoubleArea(
  positions: Float32Array,
  a: number,
  b: number,
  c: number,
  up: Float64Array,
  f: number,
): number {
  const ax = positions[a * 3]
  const ay = positions[a * 3 + 1]
  const az = positions[a * 3 + 2]
  const e1x = positions[b * 3] - ax
  const e1y = positions[b * 3 + 1] - ay
  const e1z = positions[b * 3 + 2] - az
  const e2x = positions[c * 3] - ax
  const e2y = positions[c * 3 + 1] - ay
  const e2z = positions[c * 3 + 2] - az
  const nx = e1y * e2z - e1z * e2y
  const ny = e1z * e2x - e1x * e2z
  const nz = e1x * e2y - e1y * e2x
  return nx * up[f * 3] + ny * up[f * 3 + 1] + nz * up[f * 3 + 2]
}

/** Twice the triangle's area. */
function doubleArea(positions: Float32Array, a: number, b: number, c: number): number {
  const ax = positions[a * 3]
  const ay = positions[a * 3 + 1]
  const az = positions[a * 3 + 2]
  const e1x = positions[b * 3] - ax
  const e1y = positions[b * 3 + 1] - ay
  const e1z = positions[b * 3 + 2] - az
  const e2x = positions[c * 3] - ax
  const e2y = positions[c * 3 + 1] - ay
  const e2z = positions[c * 3 + 2] - az
  return Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x)
}

/** Lowers feature `f`'s eave to vertex `v`'s height along its up. */
function lowerEave(stats: TileFeatureStats, positions: Float32Array, v: number, up: Float64Array, f: number): void {
  const h = positions[v * 3] * up[f * 3] + positions[v * 3 + 1] * up[f * 3 + 1] + positions[v * 3 + 2] * up[f * 3 + 2]
  stats.eave[f] = Math.min(stats.eave[f], h)
}

function sumFootprints(primitive: PrimitiveGeometry, stats: TileFeatureStats, up: Float64Array): void {
  const { positions, featureIds, indices } = primitive
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t]
    const f = featureIds[a]
    if (!(f >= 0 && f < stats.count)) continue
    const b = indices[t + 1]
    const c = indices[t + 2]
    const doubled = projectedDoubleArea(positions, a, b, c, up, f)
    if (!(doubled > 0)) continue
    stats.area[f] += doubled / 2
    // A roof by the facade shader's test; walls tilted a little toward up by the Earth's curvature
    // across a tile stay walls.
    if (doubled <= FACADE_ROOF_COS * doubleArea(positions, a, b, c)) continue
    lowerEave(stats, positions, a, up, f)
    lowerEave(stats, positions, b, up, f)
    lowerEave(stats, positions, c, up, f)
  }
}

/**
 * Base, roof, eave and footprint area of every feature in a tile's primitives.
 *
 * A feature's up is the geocentric up at its first vertex, as the shader's is at each fragment.
 * The footprint is the sum of its upward faces projected on the horizontal, which covers the
 * outline once for a flat, pitched or stepped roof.
 *
 * @param primitives - The tile's triangle-list primitives
 * @param count - The tile's feature count; vertices with ids outside 0..count-1 are skipped
 * @returns Per-feature stats; a feature without vertices keeps zeros and `hasGeometry` 0
 */
export function computeFeatureStats(primitives: readonly PrimitiveGeometry[], count: number): TileFeatureStats {
  const stats = emptyStats(count)
  for (const primitive of primitives) scanVertices(primitive, stats)
  for (const primitive of primitives) sumFootprints(primitive, stats, stats.up)
  for (let f = 0; f < count; f++) {
    if (stats.eave[f] === Number.POSITIVE_INFINITY) stats.eave[f] = stats.roof[f]
  }
  return stats
}

/** The OSM element a feature draws: a part's own `part#elementId`, else `elementId`; '' when neither. */
export function featureKey(feature: FeatureProperties): string {
  const part = feature.getProperty('part#elementId')
  if (part !== undefined && part !== null) return String(part)
  const element = feature.getProperty('elementId')
  return element === undefined || element === null ? '' : String(element)
}

/**
 * Metres from the building's ground to a feature's base: `part#min_height` for a part (a part's
 * unprefixed tags are its parent's), `min_height` for a whole building, 0 when absent or negative.
 */
export function featureGroundOffset(feature: FeatureProperties): number {
  const offset = tagValueNumber(feature.getProperty(isBuildingPart(feature) ? 'part#min_height' : 'min_height'))
  return Number.isNaN(offset) ? 0 : Math.max(offset, 0)
}

/**
 * A stable hash of a feature's position, which picks its wall colour variant. Every part of one
 * building carries the building's own `cesium#latitude` and `cesium#longitude`, so they share it.
 *
 * @param feature - The tile feature
 * @returns A fraction in [0, 1); 0 when the latitude or longitude is absent
 */
export function featureHash(feature: FeatureProperties): number {
  const latitude = tagValueNumber(feature.getProperty('cesium#latitude'))
  const longitude = tagValueNumber(feature.getProperty('cesium#longitude'))
  const sine = Math.abs(Math.sin(latitude * 12.9898 + longitude * 78.233)) * 43758.5453
  const fraction = sine - Math.floor(sine)
  return Number.isNaN(fraction) ? 0 : fraction
}

/**
 * Gives each vertex-less feature its twin's base, roof, eave and footprint. Every element appears twice
 * in a tile, with identical properties, and one of the two owns no vertices.
 *
 * @param stats - The tile's stats, filled in place
 * @param keys - `featureKey` of each feature; '' never matches
 */
export function fillTwins(stats: TileFeatureStats, keys: readonly string[]): void {
  const owner = new Map<string, number>()
  for (let f = 0; f < stats.count; f++) {
    if (stats.hasGeometry[f] === 1 && keys[f] !== '' && !owner.has(keys[f])) owner.set(keys[f], f)
  }
  for (let f = 0; f < stats.count; f++) {
    const twin = stats.hasGeometry[f] === 0 ? owner.get(keys[f]) : undefined
    if (twin === undefined) continue
    stats.base[f] = stats.base[twin]
    stats.roof[f] = stats.roof[twin]
    stats.eave[f] = stats.eave[twin]
    stats.area[f] = stats.area[twin]
    stats.faceFirst[f] = stats.faceFirst[twin]
    stats.faceCount[f] = stats.faceCount[twin]
    stats.baseMC.set(stats.baseMC.subarray(twin * 3, twin * 3 + 3), f * 3)
  }
}

/**
 * The lookup texture's texels, two rows of `count` RGBA floats (see the module comment). The wall
 * top is the eave above the building's ground, `eave - base + groundOffset`, and -1 (unknown) for
 * a feature without vertices or a twin.
 */
export function lookupTexels(stats: TileFeatureStats): Float32Array {
  const { count } = stats
  const texels = new Float32Array(count * 4 * LOOKUP_ROWS)
  const ground = LOOKUP_ROW_GROUND * count * 4
  const top = LOOKUP_ROW_TOP * count * 4
  for (let f = 0; f < count; f++) {
    const offset = stats.groundOffset[f]
    texels.set([stats.baseMC[f * 3], stats.baseMC[f * 3 + 1], stats.baseMC[f * 3 + 2], offset], ground + f * 4)
    const eave = stats.eave[f]
    const wallTop = Number.isNaN(eave) ? -1 : eave - stats.base[f] + offset
    texels.set([wallTop, stats.hash[f], stats.faceFirst[f], stats.faceCount[f]], top + f * 4)
  }
  return texels
}

// ---- Cesium private surface -------------------------------------------------------------------

interface PrivateBuffer {
  readonly _buffer: WebGLBuffer
  readonly sizeInBytes: number
}

interface PrivateAttribute {
  readonly semantic: string
  readonly setIndex?: number
  readonly buffer?: PrivateBuffer
  readonly count: number
  readonly byteOffset?: number
  readonly byteStride?: number
  readonly componentDatatype: number
  readonly quantization?: unknown
}

interface PrivatePrimitive {
  readonly attributes: readonly PrivateAttribute[]
  readonly indices?: { readonly buffer?: PrivateBuffer; readonly count: number; readonly indexDatatype: number }
  readonly primitiveType: number
}

interface PrivateRuntimeNode {
  readonly runtimePrimitives: readonly {
    readonly primitive: PrivatePrimitive
    readonly drawCommand?: { readonly modelMatrix: Cesium.Matrix4 }
  }[]
}

interface PrivateModel {
  readonly ready: boolean
  /** Cesium leaves a slot empty for a node it skips, so the list can be sparse. */
  readonly _sceneGraph?: { readonly _runtimeNodes: readonly (PrivateRuntimeNode | undefined)[] }
}

/** A Cesium texture, as far as the lookup uses it. */
export interface LookupTexture {
  destroy(): void
}

/** The scene's private rendering context, as far as the lookup uses it. */
export interface LookupContext {
  readonly _gl: WebGL2RenderingContext
  readonly webgl2: boolean
}

/** Creates a lookup texture of `width` x `height` RGBA float texels. */
export type LookupTextureFactory = (
  context: LookupContext,
  width: number,
  height: number,
  texels: Float32Array,
) => LookupTexture

interface RenderResources {
  readonly model: object
  readonly shaderBuilder: {
    addUniform(type: string, name: string, destination: number): void
    addDefine(name: string, value: undefined, destination: number): void
  }
  uniformMap: Record<string, () => unknown>
}

type StageProcess = (
  this: unknown,
  renderResources: RenderResources,
  primitive: unknown,
  frameState: { context: LookupContext },
) => void

/** Marks the wrapper on `BatchTexturePipelineStage.process` and holds the function it wraps. */
const WRAPPED = Symbol.for('tc3d.buildingLookup')

type MarkedProcess = StageProcess & { [WRAPPED]?: StageProcess }

interface CesiumPrivate {
  readonly VERSION?: string
  readonly BatchTexturePipelineStage?: { process: MarkedProcess }
  readonly ShaderDestination?: { readonly FRAGMENT: number }
  readonly Texture?: new (options: object) => LookupTexture
  readonly Sampler?: new (options: object) => object
}

const PRIVATE = Cesium as unknown as CesiumPrivate

/**
 * Each built lookup and face table, by model: other code reads the stats through
 * `getTileFeatureStats`. A tile with no faces has no face table of its own.
 */
const lookups = new WeakMap<object, { stats: TileFeatureStats; texture: LookupTexture; faces?: LookupTexture }>()
const emptyTextures = new WeakMap<LookupContext, LookupTexture>()
const emptyFaceTextures = new WeakMap<LookupContext, LookupTexture>()
/**
 * The texture factory `attachBuildingLookup` was given, by context, so the empty texture is made
 * the same way as each tile's. A model of a tileset without an attached lookup (any other tileset
 * with feature ids) binds an empty texture made by `createLookupTexture`.
 */
const factories = new WeakMap<LookupContext, LookupTextureFactory>()

/**
 * Restyles one tile through `Cesium3DTileContent.applyStyle`, which Cesium marks `@private`
 * (Cesium3DTileContent.js:268-270); a model's content sets its model's style, restyled on its next update.
 * A throw is logged and the tile keeps its old style, so the pass goes on to the other tiles.
 */
function restyleTile(tile: Cesium.Cesium3DTile, style: Cesium.Cesium3DTileStyle): void {
  try {
    ;(tile.content as unknown as { applyStyle(style: Cesium.Cesium3DTileStyle): void }).applyStyle(style)
  } catch (error) {
    console.error(
      '[buildingBaseLookup] restyling a built building tile failed; its shape types wait for the next restyle',
      error,
    )
  }
}

function modelOf(content: Cesium.Cesium3DTileContent | undefined): (PrivateModel & object) | undefined {
  return (content as unknown as { _model?: PrivateModel } | undefined)?._model
}

/**
 * The per-feature base, roof, eave and footprint area of a loaded tile, once its lookup is built.
 *
 * @param content - A tile's content
 * @returns The stats, or undefined before the tile's lookup is built or for a tile without one
 */
export function getTileFeatureStats(content: Cesium.Cesium3DTileContent): TileFeatureStats | undefined {
  const model = modelOf(content)
  return model === undefined ? undefined : lookups.get(model)?.stats
}

/** Creates a NEAREST-sampled RGBA float lookup texture through Cesium's private `Texture`. */
export const createLookupTexture: LookupTextureFactory = (context, width, height, texels) => {
  const { Texture, Sampler } = PRIVATE as Required<CesiumPrivate>
  return new Texture({
    context,
    width,
    height,
    pixelFormat: Cesium.PixelFormat.RGBA,
    pixelDatatype: Cesium.PixelDatatype.FLOAT,
    flipY: false,
    source: { width, height, arrayBufferView: texels },
    sampler: new Sampler({
      minificationFilter: Cesium.TextureMinificationFilter.NEAREST,
      magnificationFilter: Cesium.TextureMagnificationFilter.NEAREST,
    }),
  })
}

function emptyTexture(context: LookupContext, createTexture: LookupTextureFactory): LookupTexture {
  let texture = emptyTextures.get(context)
  if (texture === undefined) {
    texture = createTexture(context, 1, LOOKUP_ROWS, emptyLookupTexels())
    emptyTextures.set(context, texture)
  }
  return texture
}

function emptyFaceTexture(context: LookupContext, createTexture: LookupTextureFactory): LookupTexture {
  let texture = emptyFaceTextures.get(context)
  if (texture === undefined) {
    texture = createTexture(context, FACE_TEXELS, 1, emptyFaceTexels())
    emptyFaceTextures.set(context, texture)
  }
  return texture
}

/**
 * Binds each tile's lookup texture to the facade shader by wrapping Cesium's private
 * `BatchTexturePipelineStage.process` (`Source/Scene/Model/BatchTexturePipelineStage.js`), which
 * runs for every model primitive with a property table, the case `HAS_SELECTED_FEATURE_ID` marks.
 * On WebGL2 the wrapper adds the fragment sampler and `TC3D_BUILDING_LOOKUP`; on WebGL1 it adds
 * nothing, and the shader keeps the no-lookup sentinel. Installing again (a reloaded module)
 * replaces the wrapper rather than wrapping it, since the wrapper carries the original.
 *
 * @throws Error naming the Cesium version when a private name the lookup uses is missing
 */
export function installBuildingLookupStage(): void {
  const missing = (['BatchTexturePipelineStage', 'ShaderDestination', 'Texture', 'Sampler'] as const).filter(
    (name) => PRIVATE[name] === undefined,
  )
  if (typeof PRIVATE.BatchTexturePipelineStage?.process !== 'function') missing.push('BatchTexturePipelineStage')
  if (missing.length > 0) {
    throw new Error(
      `Cesium ${PRIVATE.VERSION ?? '(unknown version)'} lacks ${[...new Set(missing)].join(', ')}, which the building ` +
        'floor-line lookup patches (Source/Scene/Model/BatchTexturePipelineStage.js, process). ' +
        'Update src/renderer/utils/buildingBaseLookup.ts for this Cesium version.',
    )
  }
  const stage = PRIVATE.BatchTexturePipelineStage as { process: MarkedProcess }
  const fragment = (PRIVATE.ShaderDestination as { FRAGMENT: number }).FRAGMENT
  const original = stage.process[WRAPPED] ?? stage.process
  const wrapper: MarkedProcess = function (renderResources, primitive, frameState) {
    original.call(this, renderResources, primitive, frameState)
    const { model, shaderBuilder } = renderResources
    const { context } = frameState
    if (!context.webgl2) return
    shaderBuilder.addDefine(BUILDING_LOOKUP_DEFINE, undefined, fragment)
    shaderBuilder.addUniform('highp sampler2D', BUILDING_LOOKUP_SAMPLER, fragment)
    shaderBuilder.addUniform('highp sampler2D', BUILDING_FACES_SAMPLER, fragment)
    const factory = () => factories.get(context) ?? createLookupTexture
    renderResources.uniformMap = {
      ...renderResources.uniformMap,
      [BUILDING_LOOKUP_SAMPLER]: () => lookups.get(model)?.texture ?? emptyTexture(context, factory()),
      [BUILDING_FACES_SAMPLER]: () => lookups.get(model)?.faces ?? emptyFaceTexture(context, factory()),
    }
  }
  wrapper[WRAPPED] = original
  stage.process = wrapper
}

function readBack(gl: WebGL2RenderingContext, buffer: PrivateBuffer): ArrayBuffer {
  const bytes = new Uint8Array(buffer.sizeInBytes)
  gl.bindBuffer(gl.COPY_READ_BUFFER, buffer._buffer)
  gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, bytes)
  gl.bindBuffer(gl.COPY_READ_BUFFER, null)
  return bytes.buffer
}

/** Why an attribute cannot be read as tightly packed floats, or undefined when it can. */
function attributeProblem(
  attribute: PrivateAttribute | undefined,
  name: string,
  components: number,
): string | undefined {
  if (attribute === undefined) return `${name} missing`
  if (attribute.buffer === undefined) return `${name} has no GPU buffer`
  if (attribute.quantization !== undefined) return `${name} quantized`
  if (attribute.componentDatatype !== Cesium.ComponentDatatype.FLOAT) return `${name} not float`
  const stride = attribute.byteStride
  if (stride !== undefined && stride !== components * 4) return `${name} interleaved`
  return undefined
}

function readIndices(gl: WebGL2RenderingContext, indices: NonNullable<PrivatePrimitive['indices']>): ArrayLike<number> {
  const bytes = readBack(gl, indices.buffer as PrivateBuffer)
  if (indices.indexDatatype === Cesium.IndexDatatype.UNSIGNED_INT) return new Uint32Array(bytes, 0, indices.count)
  if (indices.indexDatatype === Cesium.IndexDatatype.UNSIGNED_BYTE) return new Uint8Array(bytes, 0, indices.count)
  return new Uint16Array(bytes, 0, indices.count)
}

/** The primitive's geometry, or why it cannot be read. */
function readPrimitive(
  gl: WebGL2RenderingContext,
  primitive: PrivatePrimitive,
  modelMatrix: Cesium.Matrix4,
): PrimitiveGeometry | string {
  const position = primitive.attributes.find((a) => a.semantic === 'POSITION')
  const featureId = primitive.attributes.find((a) => a.semantic === '_FEATURE_ID' && a.setIndex === 0)
  const indices = primitive.indices
  if (primitive.primitiveType !== Cesium.PrimitiveType.TRIANGLES) return 'not a triangle list'
  if (indices?.buffer === undefined) return 'no index buffer'
  const problem = attributeProblem(position, 'POSITION', 3) ?? attributeProblem(featureId, '_FEATURE_ID_0', 1)
  if (problem !== undefined) return problem
  return readVertices(gl, position as PrivateAttribute, featureId as PrivateAttribute, indices, modelMatrix)
}

/**
 * Reads the indices, then every vertex they or the attributes' counts reach. A Draco-decoded
 * attribute keeps its glTF accessor's count while its buffer holds every decoded vertex, so the
 * largest index can pass `count`; the buffer's size is not the count either, since attributes can
 * share one buffer at different offsets.
 */
function readVertices(
  gl: WebGL2RenderingContext,
  position: PrivateAttribute,
  featureId: PrivateAttribute,
  indexBuffer: NonNullable<PrivatePrimitive['indices']>,
  modelMatrix: Cesium.Matrix4,
): PrimitiveGeometry | string {
  const indices = readIndices(gl, indexBuffer)
  let largest = -1
  for (let i = 0; i < indices.length; i++) largest = Math.max(largest, indices[i])
  const vertices = Math.max(position.count, featureId.count, largest + 1)
  const overrun = bufferOverrun(position, 3, vertices) ?? bufferOverrun(featureId, 1, vertices)
  if (overrun !== undefined) return overrun
  return {
    positions: readFloats(gl, position, 3, vertices),
    featureIds: readFloats(gl, featureId, 1, vertices),
    indices,
    modelMatrix,
  }
}

/** Why `vertices` vertices of an attribute do not fit in its buffer, or undefined when they do. */
function bufferOverrun(attribute: PrivateAttribute, components: number, vertices: number): string | undefined {
  const needed = (attribute.byteOffset ?? 0) + vertices * components * 4
  const has = (attribute.buffer as PrivateBuffer).sizeInBytes
  return needed > has ? `attribute past its buffer (needs ${needed} bytes, has ${has})` : undefined
}

/** `vertices` vertices of an attribute `attributeProblem` and `bufferOverrun` passed, as `components` floats each. */
function readFloats(
  gl: WebGL2RenderingContext,
  attribute: PrivateAttribute,
  components: number,
  vertices: number,
): Float32Array {
  const bytes = readBack(gl, attribute.buffer as PrivateBuffer)
  return new Float32Array(bytes, attribute.byteOffset ?? 0, vertices * components)
}

/** A model's readable triangle primitives, and why each other one could not be read. */
export interface TileGeometry {
  readonly primitives: PrimitiveGeometry[]
  readonly unreadable: string[]
}

/**
 * Reads a ready model's triangle primitives back from the GPU.
 *
 * @returns The geometry, or undefined while the model has no draw commands yet
 */
export function readTileGeometry(model: PrivateModel, gl: WebGL2RenderingContext): TileGeometry | undefined {
  const nodes = model._sceneGraph?._runtimeNodes
  if (nodes === undefined) return undefined
  const geometry: TileGeometry = { primitives: [], unreadable: [] }
  for (const node of nodes) {
    for (const runtime of node?.runtimePrimitives ?? []) {
      if (runtime.drawCommand === undefined) return undefined
      const read = readPrimitive(gl, runtime.primitive, runtime.drawCommand.modelMatrix)
      if (typeof read === 'string') geometry.unreadable.push(read)
      else geometry.primitives.push(read)
    }
  }
  return geometry
}

/** The stats of a tile's features, their properties and twins included, and each feature's `featureKey`. */
export function tileFeatureStats(
  content: Cesium.Cesium3DTileContent,
  primitives: readonly PrimitiveGeometry[],
): { stats: TileFeatureStats; keys: string[] } {
  const count = content.featuresLength
  const stats = computeFeatureStats(primitives, count)
  const keys: string[] = new Array<string>(count)
  for (let f = 0; f < count; f++) {
    const feature = content.getFeature(f)
    keys[f] = featureKey(feature)
    stats.groundOffset[f] = featureGroundOffset(feature)
    stats.hash[f] = featureHash(feature)
  }
  fillTwins(stats, keys)
  return { stats, keys }
}

/** What one build step did: started or advanced a tile's build, finished it, gave up on it, or found it not ready. */
type StepOutcome = 'progress' | 'built' | 'skipped' | 'waiting'

/** A tile's lookup and face table in the making, kept across frames until its last step publishes both. */
interface BuildJob {
  readonly model: object
  readonly stats: TileFeatureStats
  readonly keys: readonly string[]
  readonly faces: FaceBuilder
}

interface Attachment {
  readonly context: LookupContext
  readonly maxTextureSize: number
  readonly built: Set<object>
  /** Each tile whose build has started and not yet published. */
  readonly jobs: Map<Cesium.Cesium3DTile, BuildJob>
  readonly createTexture: LookupTextureFactory
  /** The clock each frame's build budget is measured on. */
  readonly now: () => number
  /** Set once a tile of this tileset had no readable primitive, so that is logged once. */
  unreadableLogged: boolean
  /** Set once a tile of this tileset passed the per-tile face cap, so that is logged once. */
  faceCapLogged: boolean
}

/** The model's readable primitives; undefined while it is not ready, empty when none can be read. */
function readableGeometry(model: PrivateModel, attachment: Attachment): PrimitiveGeometry[] | undefined {
  if (!model.ready) return undefined
  const geometry = readTileGeometry(model, attachment.context._gl)
  if (geometry === undefined) return undefined
  if (geometry.primitives.length === 0 && !attachment.unreadableLogged) {
    attachment.unreadableLogged = true
    console.warn(
      `[buildingBaseLookup] a building tile has no readable triangle primitive (${geometry.unreadable.join('; ') || 'none'}); ` +
        'such tiles show no floor lines',
    )
  }
  return geometry.primitives
}

/** Logs, once per tileset, that a tile's features past the per-tile face cap draw walls without openings. */
function warnFaceCap(cut: number, attachment: Attachment): void {
  if (cut === 0 || attachment.faceCapLogged) return
  attachment.faceCapLogged = true
  console.warn(
    `[buildingBaseLookup] a building tile has more wall faces than the face table holds; ${cut} of its ` +
      'features keep none, and their walls show no windows',
  )
}

/**
 * Lays the tile's capped runs into its face table, gives each feature (and each twin) its face
 * range, and creates the lookup and the face table together.
 */
function publishTables(
  model: object,
  stats: TileFeatureStats,
  keys: readonly string[],
  runs: readonly (readonly Run[])[],
  attachment: Attachment,
): void {
  const capped = capTileRuns(runs)
  warnFaceCap(capped.cut, attachment)
  const table = faceTexels(capped.runs, attachment.maxTextureSize)
  stats.faceFirst.set(table.first)
  stats.faceCount.set(table.count)
  fillTwins(stats, keys)
  const { context, createTexture } = attachment
  const texture = createTexture(context, stats.count, LOOKUP_ROWS, lookupTexels(stats))
  let faces: LookupTexture | undefined
  try {
    faces = table.count.some((count) => count > 0)
      ? createTexture(context, table.width, table.height, table.texels)
      : undefined
  } catch (error) {
    texture.destroy()
    throw error
  }
  lookups.set(model, { stats, texture, faces })
  attachment.built.add(model)
}

/** The first step of a tile's build: read-back, stats, tags, twins, and the face builder that steps through the rest. */
function startBuild(tile: Cesium.Cesium3DTile, attachment: Attachment): BuildJob | 'skipped' | 'waiting' {
  const model = modelOf(tile.content)
  const count = tile.content?.featuresLength ?? 0
  if (model === undefined || count === 0 || lookups.has(model)) return 'skipped'
  if (count > attachment.maxTextureSize) {
    console.warn(
      `[buildingBaseLookup] a tile has ${count} features, more than the texture limit; its facades show no floor lines`,
    )
    return 'skipped'
  }
  const primitives = readableGeometry(model, attachment)
  if (primitives === undefined) return 'waiting'
  if (primitives.length === 0) return 'skipped'
  const { stats, keys } = tileFeatureStats(tile.content, primitives)
  return { model, stats, keys, faces: new FaceBuilder(primitives, stats) }
}

/**
 * One step of a tile's build: the start (`startBuild`), then the face builder's steps over chunks
 * of `FACE_BUILD_CHUNK_TRIANGLES` triangles (`FaceBuilder.step`) until its runs are done, then the
 * publish, which lays the face table and creates, records and binds both textures together.
 */
function buildStep(tile: Cesium.Cesium3DTile, attachment: Attachment): StepOutcome {
  const job = attachment.jobs.get(tile)
  if (job === undefined) {
    const started = startBuild(tile, attachment)
    if (typeof started === 'string') return started
    attachment.jobs.set(tile, started)
    return 'progress'
  }
  if (!job.faces.done) {
    job.faces.step(FACE_BUILD_CHUNK_TRIANGLES)
    return 'progress'
  }
  attachment.jobs.delete(tile)
  publishTables(job.model, job.stats, job.keys, job.faces.runs, attachment)
  return 'built'
}

/** One step of the tile's build; a throw is logged naming the tile, which then stays without a lookup. */
function tryBuildStep(tile: Cesium.Cesium3DTile, attachment: Attachment): StepOutcome {
  try {
    return buildStep(tile, attachment)
  } catch (error) {
    attachment.jobs.delete(tile)
    console.error(
      `[buildingBaseLookup] the building lookup or face table build failed for tile ${tile.content?.url ?? '(no content)'}; ` +
        'its facades show no floor lines',
      error,
    )
    return 'skipped'
  }
}

function release(model: object, attachment: Attachment): void {
  const built = lookups.get(model)
  built?.texture.destroy()
  built?.faces?.destroy()
  lookups.delete(model)
  attachment.built.delete(model)
}

/**
 * Steps a tile's build until it ends or the pass's budget, counted from `start` on the attachment's
 * clock, runs out first.
 *
 * @returns The last step's outcome, or 'out of budget' with the build still pending
 */
function buildWithin(tile: Cesium.Cesium3DTile, attachment: Attachment, start: number): StepOutcome | 'out of budget' {
  for (;;) {
    if (attachment.now() - start > BUILDING_LOOKUP_BUILD_BUDGET_MS) return 'out of budget'
    const outcome = tryBuildStep(tile, attachment)
    if (outcome !== 'progress') return outcome
  }
}

/**
 * Builds a lookup and a face table for each tile of the tileset as it loads, a step at a time
 * within each frame's budget, and releases both as the tile unloads. `installBuildingLookupStage`
 * must have run for the facade shader to see them. A tile shows no floor lines until both are
 * built, and none at all on WebGL1.
 *
 * @param tileset - The OSM Buildings tileset
 * @param scene - The scene drawing it
 * @param createTexture - Makes each tile's lookup texture (`createLookupTexture`)
 * @param restyleWhen - Whether new stats can change the style (`isShapeFallbackOn`); when it
 *   holds, each tile whose lookup a render pass built is restyled
 * @param now - The clock, in milliseconds, each frame's build budget is measured on
 *   (`performance.now`); the build reads no other
 * @returns A function that stops listening and releases every lookup it built
 */
export function attachBuildingLookup(
  tileset: Cesium.Cesium3DTileset,
  scene: Cesium.Scene,
  createTexture: LookupTextureFactory,
  restyleWhen: () => boolean,
  now: () => number,
): () => void {
  const context = (scene as unknown as { context: LookupContext }).context
  if (!context.webgl2) {
    console.warn('[buildingBaseLookup] WebGL1 cannot read buffers back; building facades show no floor lines')
    return () => {}
  }
  const attachment: Attachment = {
    context,
    maxTextureSize: context._gl.getParameter(context._gl.MAX_TEXTURE_SIZE),
    built: new Set(),
    jobs: new Map(),
    createTexture,
    now,
    unreadableLogged: false,
    faceCapLogged: false,
  }
  factories.set(context, createTexture)
  const pending = new Set<Cesium.Cesium3DTile>()
  // Restyles only the tiles a pass built, while `restyleWhen` holds, so the style's shape fallback
  // sees their new stats without re-evaluating every visible feature.
  const drain = () => {
    const start = now()
    const built: Cesium.Cesium3DTile[] = []
    for (const tile of pending) {
      const outcome = buildWithin(tile, attachment, start)
      if (outcome === 'out of budget') break
      if (outcome !== 'waiting') pending.delete(tile)
      if (outcome === 'built') built.push(tile)
    }
    const style = tileset.style
    if (built.length === 0 || style === undefined || !restyleWhen()) return
    for (const tile of built) restyleTile(tile, style)
  }
  const removers = [
    tileset.tileLoad.addEventListener((tile: Cesium.Cesium3DTile) => pending.add(tile)),
    tileset.tileUnload.addEventListener((tile: Cesium.Cesium3DTile) => {
      pending.delete(tile)
      attachment.jobs.delete(tile)
      const model = modelOf(tile.content)
      if (model !== undefined) release(model, attachment)
    }),
    scene.postRender.addEventListener(drain),
  ]
  return () => {
    for (const remove of removers) remove()
    for (const model of [...attachment.built]) release(model, attachment)
    pending.clear()
    attachment.jobs.clear()
    if (factories.get(context) === createTexture) factories.delete(context)
  }
}
