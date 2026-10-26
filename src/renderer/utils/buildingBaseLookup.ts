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
 * The lookup texture is one row of `featuresLength` RGBA float texels: each feature's lowest
 * vertex in the tile's model coordinates and the metres from the building's ground to that vertex
 * (a raised part's `min_height`). A tile without a lookup (not built yet, or skipped) binds a
 * single texel whose ground offset is -1, the sentinel on which the shader draws no floor lines.
 * The base and roof heights and the footprint area stay on the CPU (`getTileFeatureStats`).
 */
import * as Cesium from 'cesium'
import { BUILDING_LOOKUP_BUILD_BUDGET_MS } from '@/constants'
import { isBuildingPart, tagValueNumber } from '@/utils/buildingStyle'

/** The sampler the patched stage declares and the facade shader reads. */
export const BUILDING_LOOKUP_SAMPLER = 'tc3d_buildingLookup'

/** The define the patched stage adds to the fragment shader where it binds the lookup (WebGL2 only). */
export const BUILDING_LOOKUP_DEFINE = 'TC3D_BUILDING_LOOKUP'

/** The lookup texture's only row. */
const LOOKUP_ROW = 0

/**
 * GLSL reading one feature's lookup texel, the id clamped into the texture on both sides.
 *
 * @param id - A GLSL `int` expression holding the feature id
 * @returns The `vec4` expression
 */
export function glslBuildingLookupRead(id: string): string {
  const size = `textureSize(${BUILDING_LOOKUP_SAMPLER}, 0).x`
  return `texelFetch(${BUILDING_LOOKUP_SAMPLER}, ivec2(clamp(${id}, 0, ${size} - 1), ${LOOKUP_ROW}), 0)`
}

/** The texel bound where a tile has no lookup: ground offset -1, the shader's sentinel. */
export function emptyLookupTexel(): Float32Array {
  return Float32Array.of(0, 0, 0, -1)
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
  /** Footprint area in m²: the upward faces projected on the horizontal. */
  readonly area: Float64Array
  /** Metres from the building's ground to the feature's base: a raised part's `min_height`. */
  readonly groundOffset: Float64Array
  /** 1 where the feature owns vertices in the tile; a vertex-less twin keeps 0. */
  readonly hasGeometry: Uint8Array
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
    area: new Float64Array(count),
    groundOffset: new Float64Array(count),
    hasGeometry: new Uint8Array(count),
  }
}

/** The geocentric up at a model-space point, as a unit vector in model coordinates. */
function upAt(primitive: PrimitiveGeometry, inverse: Cesium.Matrix4, point: Cesium.Cartesian3): Cesium.Cartesian3 {
  const world = Cesium.Matrix4.multiplyByPoint(primitive.modelMatrix, point, new Cesium.Cartesian3())
  Cesium.Cartesian3.normalize(world, world)
  const up = Cesium.Matrix4.multiplyByPointAsVector(inverse, world, world)
  return Cesium.Cartesian3.normalize(up, up)
}

function scanVertices(primitive: PrimitiveGeometry, stats: TileFeatureStats, up: Float64Array): void {
  const inverse = Cesium.Matrix4.inverse(primitive.modelMatrix, new Cesium.Matrix4())
  const { positions, featureIds } = primitive
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
      stats.base[f] = Number.POSITIVE_INFINITY
      stats.roof[f] = Number.NEGATIVE_INFINITY
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

function sumFootprints(primitive: PrimitiveGeometry, stats: TileFeatureStats, up: Float64Array): void {
  const { positions, featureIds, indices } = primitive
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t]
    const f = featureIds[a]
    if (!(f >= 0 && f < stats.count)) continue
    const doubled = projectedDoubleArea(positions, a, indices[t + 1], indices[t + 2], up, f)
    if (doubled > 0) stats.area[f] += doubled / 2
  }
}

/**
 * Base, roof and footprint area of every feature in a tile's primitives.
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
  const up = new Float64Array(count * 3)
  for (const primitive of primitives) scanVertices(primitive, stats, up)
  for (const primitive of primitives) sumFootprints(primitive, stats, up)
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
 * Gives each vertex-less feature its twin's base, roof and footprint. Every element appears twice
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
    stats.area[f] = stats.area[twin]
    stats.baseMC.set(stats.baseMC.subarray(twin * 3, twin * 3 + 3), f * 3)
  }
}

/** The lookup texture's texels, one row of `count` RGBA floats (see the module comment). */
export function lookupTexels(stats: TileFeatureStats): Float32Array {
  const texels = new Float32Array(stats.count * 4)
  for (let f = 0; f < stats.count; f++) {
    texels.set([stats.baseMC[f * 3], stats.baseMC[f * 3 + 1], stats.baseMC[f * 3 + 2], stats.groundOffset[f]], f * 4)
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

/** Each built lookup, by model: other code reads the stats through `getTileFeatureStats`. */
const lookups = new WeakMap<object, { stats: TileFeatureStats; texture: LookupTexture }>()
const emptyTextures = new WeakMap<LookupContext, LookupTexture>()

function modelOf(content: Cesium.Cesium3DTileContent | undefined): (PrivateModel & object) | undefined {
  return (content as unknown as { _model?: PrivateModel } | undefined)?._model
}

/**
 * The per-feature base, roof and footprint area of a loaded tile, once its lookup is built.
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

function emptyTexture(context: LookupContext): LookupTexture {
  let texture = emptyTextures.get(context)
  if (texture === undefined) {
    texture = createLookupTexture(context, 1, 1, emptyLookupTexel())
    emptyTextures.set(context, texture)
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
    renderResources.uniformMap = {
      ...renderResources.uniformMap,
      [BUILDING_LOOKUP_SAMPLER]: () => lookups.get(model)?.texture ?? emptyTexture(context),
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
  return {
    positions: readFloats(gl, position as PrivateAttribute, 3),
    featureIds: readFloats(gl, featureId as PrivateAttribute, 1),
    indices: readIndices(gl, indices),
    modelMatrix,
  }
}

/** An attribute `attributeProblem` passed, read back as `components` floats per vertex. */
function readFloats(gl: WebGL2RenderingContext, attribute: PrivateAttribute, components: number): Float32Array {
  const bytes = readBack(gl, attribute.buffer as PrivateBuffer)
  return new Float32Array(bytes, attribute.byteOffset ?? 0, attribute.count * components)
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

/** The stats of a tile's features, their properties included. */
export function tileFeatureStats(
  content: Cesium.Cesium3DTileContent,
  primitives: readonly PrimitiveGeometry[],
): TileFeatureStats {
  const count = content.featuresLength
  const stats = computeFeatureStats(primitives, count)
  const keys: string[] = new Array<string>(count)
  for (let f = 0; f < count; f++) {
    const feature = content.getFeature(f)
    keys[f] = featureKey(feature)
    stats.groundOffset[f] = featureGroundOffset(feature)
  }
  fillTwins(stats, keys)
  return stats
}

type BuildOutcome = 'built' | 'skipped' | 'waiting'

interface Attachment {
  readonly context: LookupContext
  readonly maxTextureSize: number
  readonly built: Set<object>
  readonly createTexture: LookupTextureFactory
  /** Set once a tile of this tileset had no readable primitive, so that is logged once. */
  unreadableLogged: boolean
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

function buildLookup(tile: Cesium.Cesium3DTile, attachment: Attachment): BuildOutcome {
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
  const stats = tileFeatureStats(tile.content, primitives)
  const texture = attachment.createTexture(attachment.context, count, 1, lookupTexels(stats))
  lookups.set(model, { stats, texture })
  attachment.built.add(model)
  return 'built'
}

/** Builds the tile's lookup; a throw is logged naming the tile, which then stays without one. */
function tryBuildLookup(tile: Cesium.Cesium3DTile, attachment: Attachment): BuildOutcome {
  try {
    return buildLookup(tile, attachment)
  } catch (error) {
    console.error(
      `[buildingBaseLookup] building the floor-line lookup of tile ${tile.content?.url ?? '(no content)'} failed; ` +
        'its facades show no floor lines',
      error,
    )
    return 'skipped'
  }
}

function release(model: object, attachment: Attachment): void {
  lookups.get(model)?.texture.destroy()
  lookups.delete(model)
  attachment.built.delete(model)
}

/**
 * Builds a lookup for each tile of the tileset as it loads, and releases it as the tile unloads.
 * `installBuildingLookupStage` must have run for the facade shader to see them. A tile shows no
 * floor lines until its lookup is built, and none at all on WebGL1.
 *
 * @param tileset - The OSM Buildings tileset
 * @param scene - The scene drawing it
 * @param createTexture - Makes each tile's lookup texture (`createLookupTexture`)
 * @returns A function that stops listening and releases every lookup it built
 */
export function attachBuildingLookup(
  tileset: Cesium.Cesium3DTileset,
  scene: Cesium.Scene,
  createTexture: LookupTextureFactory,
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
    createTexture,
    unreadableLogged: false,
  }
  const pending = new Set<Cesium.Cesium3DTile>()
  const drain = () => {
    const start = performance.now()
    for (const tile of pending) {
      if (performance.now() - start > BUILDING_LOOKUP_BUILD_BUDGET_MS) return
      if (tryBuildLookup(tile, attachment) !== 'waiting') pending.delete(tile)
    }
  }
  const removers = [
    tileset.tileLoad.addEventListener((tile: Cesium.Cesium3DTile) => pending.add(tile)),
    tileset.tileUnload.addEventListener((tile: Cesium.Cesium3DTile) => {
      pending.delete(tile)
      const model = modelOf(tile.content)
      if (model !== undefined) release(model, attachment)
    }),
    scene.postRender.addEventListener(drain),
  ]
  return () => {
    for (const remove of removers) remove()
    for (const model of [...attachment.built]) release(model, attachment)
    pending.clear()
  }
}
