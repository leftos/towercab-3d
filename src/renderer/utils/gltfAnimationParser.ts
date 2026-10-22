/**
 * glTF Animation Parser
 *
 * Parses animation data directly from glTF/GLB files for manual control.
 * Based on Cesium-ModelAnimationPlayer by ProminentEdge.
 *
 * Unlike Cesium's built-in animation system, this allows direct control over
 * animation playback using setPercent() style API.
 *
 * @see https://github.com/ProminentEdge/Cesium-ModelAnimationPlayer
 */

import * as Cesium from 'cesium'

// Re-export types for external consumers
export type {
  Animation,
  AnimationKey,
  AnimationSet,
  AnimationTrack,
  ExtendedNodeData,
  MeshBounds,
  ModelGroundData,
  ModelWingData,
  NodeData,
} from './gltf'

import type {
  Animation,
  AnimationKey,
  AnimationSet,
  AnimationTrack,
  ModelGroundData,
  ModelWingData,
  NodeData,
} from './gltf'

import {
  computeMinYAtGearState,
  computeWingData,
  getKeysAtTime,
  parseExtendedNodes,
  parseGroundDataGltf1,
  parseWingDataGltf1,
} from './gltf'

// =============================================================================
// Caches
// =============================================================================

/** Cache of parsed animation sets by model URL */
const animationSetCache = new Map<string, AnimationSet>()

/** Pending parse promises to avoid duplicate parsing */
const pendingParses = new Map<string, Promise<AnimationSet | null>>()

/** URLs that failed to fetch/parse (avoid repeated fetch attempts and log spam) */
const failedAnimationUrls = new Set<string>()

// =============================================================================
// CLIP TRANSFORM CACHE (gear, spoilers, reversers)
// =============================================================================
// Cache computed node transforms at discrete progress intervals to avoid
// expensive quaternion slerp and matrix operations every frame.
// Since gear, spoilers and reversers move slowly, snapping to nearest 2% interval is imperceptible.
// Wheel spin is not cached: 2% of a revolution is a visible step at taxi speed.

/** Number of cached progress steps (50 = 2% intervals from 0.0 to 1.0) */
const GEAR_CACHE_STEPS = 50

/** Progress step size (0.02 = 2%) */
const GEAR_CACHE_STEP_SIZE = 1.0 / GEAR_CACHE_STEPS

/** One node's cached pose delta */
interface CachedNodeTransform {
  translation: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number; w: number }
  scale: { x: number; y: number; z: number }
}

/** Cached transforms: Map<modelUrl, Map<clipClass, Map<progressIndex, Map<nodeName, transform>>>> */
const clipTransformCache = new Map<string, Map<ProgressClipClass, Map<number, Map<string, CachedNodeTransform>>>>()

/**
 * Get the nearest cached progress index for a progress value
 */
function getProgressCacheIndex(progress: number): number {
  return Math.round(progress / GEAR_CACHE_STEP_SIZE)
}

/** Cache of ground data by model URL */
const groundDataCache = new Map<string, ModelGroundData>()

/** Pending ground data parse promises */
const pendingGroundDataParses = new Map<string, Promise<ModelGroundData | null>>()

/** URLs that failed to fetch (avoid repeated fetch attempts) */
const failedGroundDataUrls = new Set<string>()

/** Cache of wing data by model URL */
const wingDataCache = new Map<string, ModelWingData>()

/** Pending wing data parse promises */
const pendingWingDataParses = new Map<string, Promise<ModelWingData | null>>()

/** URLs that failed to fetch for wing data */
const failedWingDataUrls = new Set<string>()

// =============================================================================
// Animation Set Parsing
// =============================================================================

/**
 * Parse animation set from a GLB URL
 * Results are cached by URL to avoid re-parsing
 */
export async function parseAnimationSetFromUrl(glbUrl: string): Promise<AnimationSet | null> {
  // Skip empty URLs (pending conversions have no URL yet)
  if (!glbUrl || glbUrl === '') {
    return null
  }

  // Check cache first
  if (animationSetCache.has(glbUrl)) {
    return animationSetCache.get(glbUrl)!
  }

  // Skip URLs that have already failed (avoid log spam)
  if (failedAnimationUrls.has(glbUrl)) {
    return null
  }

  // Check if already parsing
  if (pendingParses.has(glbUrl)) {
    return pendingParses.get(glbUrl)!
  }

  // Start parsing
  const parsePromise = (async () => {
    try {
      const response = await fetch(glbUrl)
      if (!response.ok) {
        console.warn(`[AnimParser] Failed to fetch ${glbUrl}: ${response.statusText}`)
        failedAnimationUrls.add(glbUrl)
        return null
      }

      const arrayBuffer = await response.arrayBuffer()
      const animationSet = parseAnimationSetFromArrayBuffer(arrayBuffer)

      if (animationSet) {
        animationSetCache.set(glbUrl, animationSet)
      }

      return animationSet
    } catch (error) {
      console.error(`[AnimParser] Error parsing ${glbUrl}:`, error)
      failedAnimationUrls.add(glbUrl)
      return null
    } finally {
      pendingParses.delete(glbUrl)
    }
  })()

  pendingParses.set(glbUrl, parsePromise)
  return parsePromise
}

/**
 * Parse animation set from a GLB array buffer
 */
function parseAnimationSetFromArrayBuffer(arrayBuffer: ArrayBuffer): AnimationSet | null {
  try {
    // Parse glTF JSON from GLB
    const dv = new DataView(arrayBuffer, 12, 4)
    const jsonChunkLength = dv.getUint32(0, true)

    const jsonDataChunk = arrayBuffer.slice(20, 20 + jsonChunkLength)
    const decoder = new TextDecoder('UTF-8')
    const jsonText = decoder.decode(jsonDataChunk)
    const gltfJson = JSON.parse(jsonText)

    // Get binary data chunk
    const binOffset = 20 + jsonChunkLength
    const binDv = new DataView(arrayBuffer, binOffset, 4)
    const binChunkLength = binDv.getUint32(0, true)
    const binDataChunk = arrayBuffer.slice(binOffset + 8, binOffset + 8 + binChunkLength)

    // Parse nodes
    const nodes = parseNodes(gltfJson)

    // Parse animations
    const animations = parseAnimations(gltfJson, binDataChunk)

    return { animations, nodes }
  } catch (error) {
    console.error('[AnimParser] Failed to parse GLB:', error)
    return null
  }
}

/**
 * Parse node data from glTF JSON
 */
// biome-ignore lint/suspicious/noExplicitAny: glTF JSON parsing
function parseNodes(gltfJson: any): Map<string, NodeData> {
  const nodes = new Map<string, NodeData>()

  if (!gltfJson.nodes) return nodes

  for (let i = 0; i < gltfJson.nodes.length; i++) {
    const node = gltfJson.nodes[i]
    const name = node.name || `node_${i}`

    // Default transforms
    const translation = node.translation || [0, 0, 0]
    const rotation = node.rotation || [0, 0, 0, 1]
    const scale = node.scale || [1, 1, 1]

    // Compute inverse rotation for transform calculations
    const origQuat = new Cesium.Quaternion(rotation[0], rotation[1], rotation[2], rotation[3])
    const invQuat = Cesium.Quaternion.inverse(origQuat, new Cesium.Quaternion())
    const invMatrix = Cesium.Matrix3.fromQuaternion(invQuat, new Cesium.Matrix3())

    nodes.set(name, {
      name,
      translation,
      rotation,
      scale,
      invRotation: invQuat,
      invRotationMatrix: invMatrix,
    })
  }

  return nodes
}

/**
 * Parse animations from glTF JSON and binary data
 */
// biome-ignore lint/suspicious/noExplicitAny: glTF JSON parsing
function parseAnimations(gltfJson: any, binData: ArrayBuffer): Animation[] {
  const animations: Animation[] = []

  if (!gltfJson.animations) return animations

  for (let i = 0; i < gltfJson.animations.length; i++) {
    const animJson = gltfJson.animations[i]
    const name = animJson.name || `animation_${i}`
    const tracks = new Map<string, AnimationTrack>()
    let duration = 0

    for (const channel of animJson.channels) {
      const dofType = channel.target.path // 'translation', 'rotation', or 'scale'
      const nodeIndex = channel.target.node
      const node = gltfJson.nodes[nodeIndex]
      if (!node) continue

      const nodeName = node.name || `node_${nodeIndex}`

      // Get or create track for this node
      if (!tracks.has(nodeName)) {
        tracks.set(nodeName, {
          translationKeys: [],
          rotationKeys: [],
          scaleKeys: [],
        })
      }
      const track = tracks.get(nodeName)!

      const sampler = animJson.samplers[channel.sampler]

      // Parse input accessor (keyframe times)
      const inputAccessor = gltfJson.accessors[sampler.input]
      const inputBufferView = gltfJson.bufferViews[inputAccessor.bufferView]
      // Note: byteOffset can be undefined (means 0) - must handle to avoid NaN
      const inputOffset = (inputBufferView.byteOffset || 0) + (inputAccessor.byteOffset || 0)
      const inputData = new Float32Array(binData.slice(inputOffset, inputOffset + inputAccessor.count * 4))

      // Parse output accessor (keyframe values)
      const outputAccessor = gltfJson.accessors[sampler.output]
      const outputBufferView = gltfJson.bufferViews[outputAccessor.bufferView]
      const outputOffset = (outputBufferView.byteOffset || 0) + (outputAccessor.byteOffset || 0)
      const componentCount = outputAccessor.type === 'VEC3' ? 3 : 4
      const outputData = new Float32Array(
        binData.slice(outputOffset, outputOffset + outputAccessor.count * componentCount * 4),
      )

      // Build keyframes
      for (let j = 0; j < inputAccessor.count; j++) {
        const time = inputData[j]
        if (time > duration) duration = time

        const value: number[] = []
        for (let k = 0; k < componentCount; k++) {
          value.push(outputData[j * componentCount + k])
        }

        const key = { time, value }

        if (dofType === 'translation') {
          track.translationKeys.push(key)
        } else if (dofType === 'rotation') {
          track.rotationKeys.push(key)
        } else if (dofType === 'scale') {
          track.scaleKeys.push(key)
        }
      }
    }

    animations.push({ name, duration, tracks })
  }

  return animations
}

// =============================================================================
// Animation Application (Cesium-specific)
// =============================================================================

/** A node's pose relative to its rest pose, as a clip's keys give it at one time */
interface NodePoseDelta {
  translation: Cesium.Cartesian3
  rotation: Cesium.Quaternion
  scale: Cesium.Cartesian3
}

/** A model node with the matrix it had before any clip was applied */
type PosedNode = Cesium.ModelNode & { _originalMatrix?: Cesium.Matrix4 }

/** Linear interpolation of Vec3 keys at a time, or null for a track without keys */
function vec3AtTime(keys: AnimationKey[], time: number): Cesium.Cartesian3 | null {
  const pair = getKeysAtTime(keys, time)
  if (!pair) return null
  const [k0, k1] = pair
  const start = new Cesium.Cartesian3(k0.value[0], k0.value[1], k0.value[2])
  if (k0.time === k1.time) return start
  const end = new Cesium.Cartesian3(k1.value[0], k1.value[1], k1.value[2])
  return Cesium.Cartesian3.lerp(start, end, (time - k0.time) / (k1.time - k0.time), new Cesium.Cartesian3())
}

/** Translation from the node's rest translation, in the node's local space */
function translationDelta(track: AnimationTrack, nodeData: NodeData, time: number): Cesium.Cartesian3 {
  const value = vec3AtTime(track.translationKeys, time)
  if (!value) return new Cesium.Cartesian3(0, 0, 0)
  const delta = new Cesium.Cartesian3(
    value.x - nodeData.translation[0],
    value.y - nodeData.translation[1],
    value.z - nodeData.translation[2],
  )
  return Cesium.Matrix3.multiplyByVector(nodeData.invRotationMatrix, delta, delta)
}

/** Scale relative to the node's rest scale */
function scaleDelta(track: AnimationTrack, nodeData: NodeData, time: number): Cesium.Cartesian3 {
  const value = vec3AtTime(track.scaleKeys, time)
  if (!value) return new Cesium.Cartesian3(1, 1, 1)
  return new Cesium.Cartesian3(value.x / nodeData.scale[0], value.y / nodeData.scale[1], value.z / nodeData.scale[2])
}

/** Rotation from the node's rest rotation, in the node's local space */
function rotationDelta(track: AnimationTrack, nodeData: NodeData, time: number): Cesium.Quaternion {
  const pair = getKeysAtTime(track.rotationKeys, time)
  if (!pair) return new Cesium.Quaternion(0, 0, 0, 1)
  const [k0, k1] = pair
  let result = new Cesium.Quaternion(k0.value[0], k0.value[1], k0.value[2], k0.value[3])
  if (k0.time !== k1.time) {
    const end = new Cesium.Quaternion(k1.value[0], k1.value[1], k1.value[2], k1.value[3])
    result = Cesium.Quaternion.slerp(result, end, (time - k0.time) / (k1.time - k0.time), new Cesium.Quaternion())
  }

  const resultAxis = new Cesium.Cartesian3(1, 0, 0)
  const resultAngle = Cesium.Quaternion.computeAngle(result)
  if (Math.abs(resultAngle) > Cesium.Math.EPSILON5) {
    Cesium.Quaternion.computeAxis(result, resultAxis)
  }
  Cesium.Matrix3.multiplyByVector(nodeData.invRotationMatrix, resultAxis, resultAxis)
  Cesium.Quaternion.fromAxisAngle(resultAxis, resultAngle, result)
  return Cesium.Quaternion.multiply(result, nodeData.invRotation, new Cesium.Quaternion())
}

/** Set a node's matrix to its original matrix times a pose delta */
function setNodePose(node: PosedNode, pose: NodePoseDelta): void {
  if (!node._originalMatrix) {
    node._originalMatrix = node.matrix.clone()
  }
  const transformMatrix = Cesium.Matrix4.fromTranslationQuaternionRotationScale(
    pose.translation,
    pose.rotation,
    pose.scale,
    new Cesium.Matrix4(),
  )
  node.matrix = Cesium.Matrix4.multiply(node._originalMatrix, transformMatrix, new Cesium.Matrix4())
}

/** The motion that drives an animation clip */
export type AnimationClipClass = 'gear' | 'spoiler' | 'reverser' | 'wheelSpin'

/** A clip-name suffix of per-model numbers, as FSLTL `custom_anim_*` names carry (`_09`, `_1_08`) */
const NUMBERED = '(?:_\\d+)+'

/** Clip names that look like a class but are not driven: steering, wheel RPM, tyre contact points, flap swings */
const EXCLUDED_CLIP_PATTERNS: RegExp[] = [
  /STEER/i,
  /^custom_anim_C_WHEEL_LR$/i,
  /^c_wheel(?:_key)?$/i,
  new RegExp(`^custom_anim_ROTATION_VELOCITY_BODY_Y${NUMBERED}$`, 'i'),
  new RegExp(`^custom_anim_(?:LEFT|RIGHT|CENTER)_WHEEL_RPM${NUMBERED}$`, 'i'),
  /^fx_tire_contactPoint_/i,
  new RegExp(`^custom_anim_GROUND_VELOCITY${NUMBERED}$`, 'i'),
  /^spoiler_UTT787_aileron$/i,
]

/** Ground spoilers and speedbrakes */
const SPOILER_CLIP_PATTERNS: RegExp[] = [
  new RegExp(`^custom_anim_SPOILERS_(?:LEFT|RIGHT)_POSITION${NUMBERED}$`, 'i'),
  /^[lr]_spoiler_key$/i,
  /^SPO(?:IL|LI)ERS(?:_(?:left|right))?$/i,
  /^HANDLING_Spoilers_(?:Ground|l|r)$/i,
  /^[\w-]+_Spoiler_(?:L|R|LR)\d*$/i,
  /^Spoiler_[LR]\d+(?:[LR]\d+)?$/i,
  /^spoiler_Q_new$/i,
  /^TFS_777_Spoiler_(?:Inner_[LR]|Out_(?:L|R|LR)[\d-]+)$/i,
  /^TFS_A380_spoiler_(?:inner|[LR]_outer)$/i,
  /^UTT_787_spoiler_[lr]_(?:in|out\d)$/i,
  /^AIA_Fokker_TailSpeedBrake$/i,
]

/** Thrust reverser sleeves and buckets */
const REVERSER_CLIP_PATTERNS: RegExp[] = [
  /^custom_anim_REV_THRUST$/i,
  /^reverse_thrust$/i,
  /^REVERSERS?$/i,
  /^thrust_rev_\d+$/i,
  /^engine_rev$/i,
  new RegExp(`^custom_anim_TURB_ENG_REVERSE_NOZZLE_PERCENT${NUMBERED}$`, 'i'),
]

/** Wheel rotation about the axle */
const WHEEL_SPIN_CLIP_PATTERNS: RegExp[] = [
  new RegExp(`^custom_anim_(?:CENTER|LEFT|RIGHT)_WHEEL_ROTATION_ANGLE${NUMBERED}$`, 'i'),
  /^WHEEL_ROLL_(?:center|left|right)$/i,
  /^[clr]_tire(?:_anim|_blurred_key|_still_key|_roll|_key)?$/i,
  /^center_tire_roll$/i,
  /^tire_anim$/i,
  /^GEAR_(?:Center|Left|Right)_Tire$/i,
]

const matchesAny = (patterns: RegExp[], name: string): boolean => patterns.some((p) => p.test(name))

/**
 * The motion that drives an animation clip, from its name. Spoiler, reverser and wheel-spin clips come from a checked
 * allowlist of the names in the converted FSLTL and AIG models; every other clip with GEAR in its name is gear.
 * Steering clips (GEAR_STEER, custom_anim_C_WHEEL_LR and the like) and the near misses in EXCLUDED_CLIP_PATTERNS are
 * driven by nothing.
 *
 * @param name - The glTF animation name
 * @returns The clip's class, or null for a clip nothing drives
 */
export function classifyAnimationClip(name: string): AnimationClipClass | null {
  if (matchesAny(EXCLUDED_CLIP_PATTERNS, name)) return null
  if (matchesAny(WHEEL_SPIN_CLIP_PATTERNS, name)) return 'wheelSpin'
  if (matchesAny(SPOILER_CLIP_PATTERNS, name)) return 'spoiler'
  if (matchesAny(REVERSER_CLIP_PATTERNS, name)) return 'reverser'
  return /GEAR/i.test(name) ? 'gear' : null
}

/**
 * Whether gear progress drives this animation clip.
 * MSFS models name nose-wheel steering clips with GEAR too (GEAR_STEER and the like), and some name wheel spins
 * GEAR_*_Tire; neither is driven by gear progress.
 *
 * @param name - The glTF animation name
 * @returns True for gear extension/retraction clips
 */
export function isGearClip(name: string): boolean {
  return classifyAnimationClip(name) === 'gear'
}

/** A clip class driven by a progress from 0 to 1, through the progress cache */
export type ProgressClipClass = Exclude<AnimationClipClass, 'wheelSpin'>

/** Degrees a wheel clip may miss one revolution by, step off its axis by, or come within of a half-turn step */
const WHEEL_REVOLUTION_TOLERANCE_DEG = 4

/** A rotation step smaller than this, in radians, is a held key (float32 noise on a repeated key is far below it) */
const HELD_KEY_RADIANS = 1e-5

/** Clips per class for each parsed animation set; wheel-spin clips only when they make one revolution */
const clipsByClass = new WeakMap<AnimationSet, Map<AnimationClipClass, Animation[]>>()

/**
 * The clips of one class in an animation set, classified once per set. Wheel-spin clips that do not make one
 * revolution (isOneRevolutionClip) are left out.
 */
function clipsOfClass(animationSet: AnimationSet, clipClass: AnimationClipClass): Animation[] {
  let byClass = clipsByClass.get(animationSet)
  if (!byClass) {
    byClass = new Map()
    for (const animation of animationSet.animations) {
      const found = classifyAnimationClip(animation.name)
      if (found === null || (found === 'wheelSpin' && !isOneRevolutionClip(animation))) continue
      byClass.set(found, [...(byClass.get(found) ?? []), animation])
    }
    dropWheelClipsOnGearNodes(byClass)
    clipsByClass.set(animationSet, byClass)
  }
  return byClass.get(clipClass) ?? []
}

/**
 * Leave out wheel-spin clips that target a node a gear clip of the same model moves: the two would overwrite each
 * other's pose. The converted FSLTL and AIG models have none; a model that does is logged once.
 */
function dropWheelClipsOnGearNodes(byClass: Map<AnimationClipClass, Animation[]>): void {
  const gearNodes = new Set((byClass.get('gear') ?? []).flatMap((a) => [...a.tracks.keys()]))
  const wheels = byClass.get('wheelSpin') ?? []
  const shared = wheels.filter((a) => [...a.tracks.keys()].some((node) => gearNodes.has(node)))
  if (shared.length === 0) return
  byClass.set(
    'wheelSpin',
    wheels.filter((a) => !shared.includes(a)),
  )
  console.warn(`[AnimParser] Not spinning wheel clips that move a gear node: ${shared.map((a) => a.name).join(', ')}`)
}

/** First and last key time over every track of a clip; [0, duration] for a clip without keys */
function clipKeyRange(animation: Animation): { start: number; end: number } {
  let range = keyRanges.get(animation)
  if (!range) {
    range = computeClipKeyRange(animation)
    keyRanges.set(animation, range)
  }
  return range
}

/** Key ranges per clip, computed once */
const keyRanges = new WeakMap<Animation, { start: number; end: number }>()

function computeClipKeyRange(animation: Animation): { start: number; end: number } {
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (const track of animation.tracks.values()) {
    for (const keys of [track.translationKeys, track.rotationKeys, track.scaleKeys]) {
      if (keys.length === 0) continue
      start = Math.min(start, keys[0].time)
      end = Math.max(end, keys[keys.length - 1].time)
    }
  }
  return start <= end ? { start, end } : { start: 0, end: animation.duration }
}

/**
 * The clip time for a progress, over the clip's own key range: some clips start mid-timeline (E170/E190 at 4.17 s,
 * ATR 72 wheels at 100 s), so progress 0 is the first key, not time 0.
 *
 * @param animation - The clip
 * @param percent - Progress, clamped to 0..1
 * @returns Clip time in seconds
 */
export function clipTimeAtPercent(animation: Animation, percent: number): number {
  const { start, end } = clipKeyRange(animation)
  return start + (end - start) * Math.max(0, Math.min(1, percent))
}

/** The rotation from quaternion a to quaternion b, as an angle in radians (0..π, the shortest way) and a unit axis */
function rotationStep(a: number[], b: number[]): { angle: number; axis: [number, number, number] } {
  const [ax, ay, az, aw] = [-a[0], -a[1], -a[2], a[3]]
  const [bx, by, bz, bw] = b
  let w = aw * bw - ax * bx - ay * by - az * bz
  let x = aw * bx + ax * bw + ay * bz - az * by
  let y = aw * by - ax * bz + ay * bw + az * bx
  let z = aw * bz + ax * by - ay * bx + az * bw
  if (w < 0) [w, x, y, z] = [-w, -x, -y, -z]
  const sinHalf = Math.hypot(x, y, z)
  const angle = 2 * Math.atan2(sinHalf, w)
  return { angle, axis: sinHalf > 0 ? [x / sinHalf, y / sinHalf, z / sinHalf] : [1, 0, 0] }
}

/** Whether rotation keys turn one revolution, every step the same way about one axis and short of a half-turn */
function turnsOnceAboutOneAxis(keys: AnimationKey[]): boolean {
  const tolerance = Cesium.Math.toRadians(WHEEL_REVOLUTION_TOLERANCE_DEG)
  let axis: [number, number, number] | null = null
  let total = 0
  for (let i = 1; i < keys.length; i++) {
    const step = rotationStep(keys[i - 1].value, keys[i].value)
    if (step.angle < HELD_KEY_RADIANS) continue
    if (step.angle > Math.PI - tolerance) return false
    axis ??= step.axis
    const alignment = step.axis[0] * axis[0] + step.axis[1] * axis[1] + step.axis[2] * axis[2]
    if (alignment < Math.cos(tolerance)) return false
    total += step.angle
  }
  return Math.abs(total - 2 * Math.PI) <= tolerance
}

/**
 * Whether a wheel clip can be driven by a spin phase: every rotation track turns one revolution, monotonic about one
 * axis, within WHEEL_REVOLUTION_TOLERANCE_DEG (4°) of 360°, with no step of a half-turn or more. Clips that reverse
 * partway, stop short of a turn or step 180° (where the direction between keys is undefined) fail.
 *
 * @param animation - A wheel-spin clip
 * @returns True when the clip makes one revolution
 */
export function isOneRevolutionClip(animation: Animation): boolean {
  const rotating = [...animation.tracks.values()].filter((t) => t.rotationKeys.length >= 2)
  return rotating.length > 0 && rotating.every((t) => turnsOnceAboutOneAxis(t.rotationKeys))
}

/** The progress cache of one model URL and clip class */
function progressCacheFor(
  modelUrl: string,
  clipClass: ProgressClipClass,
): Map<number, Map<string, CachedNodeTransform>> {
  let urlCache = clipTransformCache.get(modelUrl)
  if (!urlCache) {
    urlCache = new Map()
    clipTransformCache.set(modelUrl, urlCache)
  }
  let classCache = urlCache.get(clipClass)
  if (!classCache) {
    classCache = new Map()
    urlCache.set(clipClass, classCache)
  }
  return classCache
}

/**
 * Apply every clip of one class (gear, spoiler or reverser) to a model at a progress.
 *
 * Uses transforms cached per model URL and class at discrete 2% intervals, to avoid quaternion slerp and matrix
 * operations every frame.
 *
 * @param model - Cesium Model primitive
 * @param animationSet - Parsed animation set
 * @param clipClass - The class of clips to apply
 * @param percent - Progress (0 = stowed or retracted, 1 = deployed or extended)
 * @param modelUrl - Model URL, the cache key
 * @returns Number of nodes the pose covers (written now, or already in place from the last frame at the same 2% step);
 *   0 when the model has no node of this class
 */
export function applyClipAnimationsPercent(
  model: Cesium.Model,
  animationSet: AnimationSet,
  clipClass: ProgressClipClass,
  percent: number,
  modelUrl: string,
): number {
  const cacheIndex = getProgressCacheIndex(Math.max(0, Math.min(1, percent)))
  const classCache = progressCacheFor(modelUrl, clipClass)
  const cached = classCache.get(cacheIndex)
  const lastByClass = lastAppliedIndex.get(model) ?? new Map<ProgressClipClass, number>()
  lastAppliedIndex.set(model, lastByClass)
  if (cached && lastByClass.get(clipClass) === cacheIndex) {
    return cached.size
  }
  lastByClass.set(clipClass, cacheIndex)
  if (cached) {
    return applyCachedTransforms(model, animationSet, cached)
  }

  const progressCache = new Map<string, CachedNodeTransform>()
  for (const animation of clipsOfClass(animationSet, clipClass)) {
    const time = clipTimeAtPercent(animation, cacheIndex * GEAR_CACHE_STEP_SIZE)
    applyClipAtTime(model, animationSet, animation, time, progressCache)
  }
  classCache.set(cacheIndex, progressCache)
  return progressCache.size
}

/** The cache index last applied per model and clip class, so a pose held between frames is not rewritten */
const lastAppliedIndex = new WeakMap<Cesium.Model, Map<ProgressClipClass, number>>()

/** The wheel phase last applied per model, so parked or held wheels are not rewritten */
const lastWheelTurn = new WeakMap<Cesium.Model, number>()

/**
 * Turn every one-revolution wheel clip of a model to a spin phase, uncached so the wheel turns smoothly at taxi speed.
 *
 * @param model - Cesium Model primitive
 * @param animationSet - Parsed animation set
 * @param phase - Wheel phase in revolutions; only the fraction counts
 * @returns Number of wheel clips applied
 */
export function applyWheelSpin(model: Cesium.Model, animationSet: AnimationSet, phase: number): number {
  const turn = phase - Math.floor(phase)
  const clips = clipsOfClass(animationSet, 'wheelSpin')
  if (lastWheelTurn.get(model) === turn) {
    return clips.length
  }
  lastWheelTurn.set(model, turn)
  for (const animation of clips) {
    applyClipAtTime(model, animationSet, animation, clipTimeAtPercent(animation, turn), null)
  }
  return clips.length
}

/**
 * Apply cached transforms directly to model nodes - O(nodes) with minimal computation
 */
function applyCachedTransforms(
  model: Cesium.Model,
  animationSet: AnimationSet,
  cache: Map<string, CachedNodeTransform>,
): number {
  let appliedCount = 0
  for (const [nodeName, transform] of cache) {
    if (!animationSet.nodes.has(nodeName)) continue
    const node = model.getNode(nodeName)
    if (!node) continue
    const { translation: t, rotation: r, scale: s } = transform
    setNodePose(node, {
      translation: new Cesium.Cartesian3(t.x, t.y, t.z),
      rotation: new Cesium.Quaternion(r.x, r.y, r.z, r.w),
      scale: new Cesium.Cartesian3(s.x, s.y, s.z),
    })
    appliedCount++
  }
  return appliedCount
}

/**
 * Pose every node a clip animates at a clip time, recording each pose in the cache when one is given
 */
function applyClipAtTime(
  model: Cesium.Model,
  animationSet: AnimationSet,
  animation: Animation,
  time: number,
  cache: Map<string, CachedNodeTransform> | null,
): void {
  for (const [nodeName, track] of animation.tracks) {
    const nodeData = animationSet.nodes.get(nodeName)
    if (!nodeData) continue
    const node = model.getNode(nodeName)
    if (!node) continue
    const pose: NodePoseDelta = {
      translation: translationDelta(track, nodeData, time),
      rotation: rotationDelta(track, nodeData, time),
      scale: scaleDelta(track, nodeData, time),
    }
    const { translation: t, rotation: r, scale: s } = pose
    cache?.set(nodeName, {
      translation: { x: t.x, y: t.y, z: t.z },
      rotation: { x: r.x, y: r.y, z: r.z, w: r.w },
      scale: { x: s.x, y: s.y, z: s.z },
    })
    setNodePose(node, pose)
  }
}

// =============================================================================
// Cache Management
// =============================================================================

/**
 * Clear cached animation set for a URL
 */
export function clearAnimationCache(url?: string): void {
  if (url) {
    animationSetCache.delete(url)
    groundDataCache.delete(url)
    wingDataCache.delete(url)
    clipTransformCache.delete(url)
    failedGroundDataUrls.delete(url)
    failedWingDataUrls.delete(url)
    failedAnimationUrls.delete(url)
  } else {
    animationSetCache.clear()
    groundDataCache.clear()
    wingDataCache.clear()
    clipTransformCache.clear()
    failedGroundDataUrls.clear()
    failedWingDataUrls.clear()
    failedAnimationUrls.clear()
  }
}

// =============================================================================
// Ground Data Computation
// =============================================================================

/**
 * Get cached ground data for a model URL, or null if not yet computed
 */
export function getModelGroundData(modelUrl: string): ModelGroundData | null {
  return groundDataCache.get(modelUrl) ?? null
}

/**
 * Parse ground data from a GLB URL
 * Results are cached by URL to avoid re-parsing
 */
export async function parseGroundDataFromUrl(glbUrl: string): Promise<ModelGroundData | null> {
  // Skip empty URLs (pending conversions have no URL yet)
  if (!glbUrl || glbUrl === '') {
    return null
  }

  // Check cache first
  if (groundDataCache.has(glbUrl)) {
    return groundDataCache.get(glbUrl)!
  }

  // Skip URLs that have already failed (avoid console spam)
  if (failedGroundDataUrls.has(glbUrl)) {
    return null
  }

  // Check if already parsing
  if (pendingGroundDataParses.has(glbUrl)) {
    return pendingGroundDataParses.get(glbUrl)!
  }

  // Start parsing
  const parsePromise = (async () => {
    try {
      const response = await fetch(glbUrl)
      if (!response.ok) {
        // Don't log warning for Tauri asset failures (common during dev)
        if (!glbUrl.includes('asset.localhost')) {
          console.warn(`[GroundData] Failed to fetch ${glbUrl}: ${response.statusText}`)
        }
        failedGroundDataUrls.add(glbUrl)
        return null
      }

      const arrayBuffer = await response.arrayBuffer()
      const groundData = parseGroundDataFromArrayBuffer(arrayBuffer)

      if (groundData) {
        groundDataCache.set(glbUrl, groundData)
      }

      return groundData
    } catch (error) {
      console.error(`[GroundData] Error parsing ${glbUrl}:`, error)
      failedGroundDataUrls.add(glbUrl)
      return null
    } finally {
      pendingGroundDataParses.delete(glbUrl)
    }
  })()

  pendingGroundDataParses.set(glbUrl, parsePromise)
  return parsePromise
}

/**
 * Parse ground data from a GLB array buffer
 *
 * Handles both glTF 2.0 (arrays, Y-up) and glTF 1.0 (objects, Z-up) formats.
 * FR24/FlightGear models use glTF 1.0 with Z as vertical axis.
 * FSLTL models use glTF 2.0 with Y as vertical axis.
 */
function parseGroundDataFromArrayBuffer(arrayBuffer: ArrayBuffer): ModelGroundData | null {
  try {
    // Parse glTF JSON from GLB
    const dv = new DataView(arrayBuffer, 12, 4)
    const jsonChunkLength = dv.getUint32(0, true)

    const jsonDataChunk = arrayBuffer.slice(20, 20 + jsonChunkLength)
    const decoder = new TextDecoder('UTF-8')
    const jsonText = decoder.decode(jsonDataChunk)
    const gltfJson = JSON.parse(jsonText)

    // Detect glTF version: 1.0 uses object-based collections, 2.0 uses arrays
    const isGltf1 = gltfJson.meshes && !Array.isArray(gltfJson.meshes)

    if (isGltf1) {
      // glTF 1.0 format (FR24/FlightGear models)
      return parseGroundDataGltf1(gltfJson)
    }

    // glTF 2.0 format (FSLTL models)
    // Get binary data chunk for animation parsing
    const binOffset = 20 + jsonChunkLength
    const binDv = new DataView(arrayBuffer, binOffset, 4)
    const binChunkLength = binDv.getUint32(0, true)
    const binDataChunk = arrayBuffer.slice(binOffset + 8, binOffset + 8 + binChunkLength)

    // Parse extended node data with hierarchy and mesh bounds
    const extendedNodes = parseExtendedNodes(gltfJson)

    // Parse animations to identify gear-related nodes
    const animations = parseAnimations(gltfJson, binDataChunk)
    const gearAnimations = animations.filter((a) => isGearClip(a.name))

    // Compute ground data at both gear states
    const gearUpMinY = computeMinYAtGearState(extendedNodes, gearAnimations, 0.0, gltfJson)
    const gearDownMinY = computeMinYAtGearState(extendedNodes, gearAnimations, 1.0, gltfJson)

    return { gearUpMinY, gearDownMinY }
  } catch (error) {
    console.error('[GroundData] Failed to parse GLB:', error)
    return null
  }
}

// =============================================================================
// Wing Data Computation
// =============================================================================

/**
 * Get cached wing data for a model URL, or null if not yet computed
 */
export function getModelWingData(modelUrl: string): ModelWingData | null {
  return wingDataCache.get(modelUrl) ?? null
}

/**
 * Parse wing data from a GLB URL
 * Results are cached by URL to avoid re-parsing
 */
export async function parseWingDataFromUrl(glbUrl: string): Promise<ModelWingData | null> {
  // Skip empty URLs (pending conversions have no URL yet)
  if (!glbUrl || glbUrl === '') {
    return null
  }

  // Check cache first
  if (wingDataCache.has(glbUrl)) {
    return wingDataCache.get(glbUrl)!
  }

  // Skip URLs that have already failed
  if (failedWingDataUrls.has(glbUrl)) {
    return null
  }

  // Check if already parsing
  if (pendingWingDataParses.has(glbUrl)) {
    return pendingWingDataParses.get(glbUrl)!
  }

  // Start parsing
  const parsePromise = (async () => {
    try {
      const response = await fetch(glbUrl)
      if (!response.ok) {
        if (!glbUrl.includes('asset.localhost')) {
          console.warn(`[WingData] Failed to fetch ${glbUrl}: ${response.statusText}`)
        }
        failedWingDataUrls.add(glbUrl)
        return null
      }

      const arrayBuffer = await response.arrayBuffer()
      const wingData = parseWingDataFromArrayBuffer(arrayBuffer)

      if (wingData) {
        wingDataCache.set(glbUrl, wingData)
      }

      return wingData
    } catch (error) {
      console.error(`[WingData] Error parsing ${glbUrl}:`, error)
      failedWingDataUrls.add(glbUrl)
      return null
    } finally {
      pendingWingDataParses.delete(glbUrl)
    }
  })()

  pendingWingDataParses.set(glbUrl, parsePromise)
  return parsePromise
}

/**
 * Parse wing data from a GLB array buffer
 */
function parseWingDataFromArrayBuffer(arrayBuffer: ArrayBuffer): ModelWingData | null {
  try {
    // Parse glTF JSON from GLB
    const dv = new DataView(arrayBuffer, 12, 4)
    const jsonChunkLength = dv.getUint32(0, true)

    const jsonDataChunk = arrayBuffer.slice(20, 20 + jsonChunkLength)
    const decoder = new TextDecoder('UTF-8')
    const jsonText = decoder.decode(jsonDataChunk)
    const gltfJson = JSON.parse(jsonText)

    // Detect glTF version: 1.0 uses object-based collections, 2.0 uses arrays
    const isGltf1 = gltfJson.meshes && !Array.isArray(gltfJson.meshes)

    if (isGltf1) {
      // glTF 1.0 format (FR24/FlightGear models)
      return parseWingDataGltf1(gltfJson)
    }

    // glTF 2.0 format (FSLTL models)
    // Parse extended node data with hierarchy and mesh bounds
    const extendedNodes = parseExtendedNodes(gltfJson)

    // Compute wing positions from model geometry
    return computeWingData(extendedNodes)
  } catch (error) {
    console.error('[WingData] Failed to parse GLB:', error)
    return null
  }
}
