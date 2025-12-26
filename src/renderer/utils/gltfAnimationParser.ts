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

/** Single animation keyframe with time and value */
export interface AnimationKey {
  time: number
  value: number[]
}

/** Animation track for a single node (translation, rotation, scale) */
export interface AnimationTrack {
  translationKeys: AnimationKey[]
  rotationKeys: AnimationKey[]
  scaleKeys: AnimationKey[]
}

/** Single animation with name, duration, and tracks per node */
export interface Animation {
  name: string
  duration: number
  tracks: Map<string, AnimationTrack>
}

/** Node data from glTF including original transforms */
export interface NodeData {
  name: string
  translation: number[]
  rotation: number[]
  scale: number[]
  invRotation: Cesium.Quaternion
  invRotationMatrix: Cesium.Matrix3
}

/** Complete animation set for a model */
export interface AnimationSet {
  animations: Animation[]
  nodes: Map<string, NodeData>
}

/** Mesh bounding box from glTF POSITION accessor min/max */
export interface MeshBounds {
  min: [number, number, number]
  max: [number, number, number]
}

/** Extended node data including hierarchy and mesh bounds */
export interface ExtendedNodeData {
  index: number
  name: string
  parentIndex: number | null
  childIndices: number[]
  meshIndex: number | null
  localMatrix: number[]  // 4x4 matrix as 16 floats (column-major)
  meshBounds: MeshBounds | null  // Bounds of attached mesh in local space
}

/** Ground offset data computed from model geometry */
export interface ModelGroundData {
  /** Lowest Y coordinate when gear is retracted (0%), in model space */
  gearUpMinY: number
  /** Lowest Y coordinate when gear is extended (100%), in model space */
  gearDownMinY: number
}

/** Cache of parsed animation sets by model URL */
const animationSetCache = new Map<string, AnimationSet>()

/** Pending parse promises to avoid duplicate parsing */
const pendingParses = new Map<string, Promise<AnimationSet | null>>()

/** URLs that failed to fetch/parse (avoid repeated fetch attempts and log spam) */
const failedAnimationUrls = new Set<string>()

/** Cache of ground data by model URL */
const groundDataCache = new Map<string, ModelGroundData>()

/** Pending ground data parse promises */
const pendingGroundDataParses = new Map<string, Promise<ModelGroundData | null>>()

/** URLs that failed to fetch (avoid repeated fetch attempts) */
const failedGroundDataUrls = new Set<string>()

/**
 * Parse animation set from a GLB URL
 * Results are cached by URL to avoid re-parsing
 */
export async function parseAnimationSetFromUrl(glbUrl: string): Promise<AnimationSet | null> {
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      invRotationMatrix: invMatrix
    })
  }

  return nodes
}

/**
 * Parse animations from glTF JSON and binary data
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
          scaleKeys: []
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
      const outputData = new Float32Array(binData.slice(
        outputOffset,
        outputOffset + outputAccessor.count * componentCount * 4
      ))

      // Build keyframes
      for (let j = 0; j < inputAccessor.count; j++) {
        const time = inputData[j]
        if (time > duration) duration = time

        const value: number[] = []
        for (let k = 0; k < componentCount; k++) {
          value.push(outputData[j * componentCount + k])
        }

        const key: AnimationKey = { time, value }

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

/**
 * Get two keyframes surrounding a given time for interpolation
 */
function getKeysAtTime(keys: AnimationKey[], time: number): [AnimationKey, AnimationKey] | null {
  if (keys.length === 0) return null

  // Before first key - clamp to first
  if (keys[0].time > time) {
    return [keys[0], keys[0]]
  }

  // After last key - clamp to last
  if (time > keys[keys.length - 1].time) {
    return [keys[keys.length - 1], keys[keys.length - 1]]
  }

  // Find surrounding keys
  for (let i = 0; i < keys.length - 1; i++) {
    if (keys[i].time <= time && keys[i + 1].time >= time) {
      return [keys[i], keys[i + 1]]
    }
  }

  return null
}

/**
 * Apply animation at a specific percent (0-1) to a Cesium Model
 *
 * @param model - Cesium Model primitive
 * @param animationSet - Parsed animation set
 * @param animationName - Name of animation to apply (or substring match)
 * @param percent - Animation progress (0 = start, 1 = end)
 */
export function applyAnimationPercent(
  model: Cesium.Model,
  animationSet: AnimationSet,
  animationName: string,
  percent: number
): boolean {
  // Find matching animation
  const animation = animationSet.animations.find(a =>
    a.name.toUpperCase().includes(animationName.toUpperCase())
  )

  if (!animation) {
    return false
  }

  // Clamp percent
  const clampedPercent = Math.max(0, Math.min(1, percent))
  const targetTime = animation.duration * clampedPercent

  // Apply transforms to each track
  for (const [nodeName, track] of animation.tracks) {
    const nodeData = animationSet.nodes.get(nodeName)
    if (!nodeData) continue

    // Get Cesium model node
    const node = model.getNode(nodeName)
    if (!node) continue

    // Store original matrix if not already stored
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodeWithOriginal = node as any
    if (!nodeWithOriginal._originalMatrix) {
      nodeWithOriginal._originalMatrix = node.matrix.clone()
    }
    const originalMatrix = nodeWithOriginal._originalMatrix as Cesium.Matrix4

    // Interpolate translation
    let translation = new Cesium.Cartesian3(0, 0, 0)
    const transKeys = getKeysAtTime(track.translationKeys, targetTime)
    if (transKeys) {
      const [k0, k1] = transKeys
      if (k0.time === k1.time) {
        translation = new Cesium.Cartesian3(
          k0.value[0] - nodeData.translation[0],
          k0.value[1] - nodeData.translation[1],
          k0.value[2] - nodeData.translation[2]
        )
      } else {
        const t = (targetTime - k0.time) / (k1.time - k0.time)
        const start = new Cesium.Cartesian3(k0.value[0], k0.value[1], k0.value[2])
        const end = new Cesium.Cartesian3(k1.value[0], k1.value[1], k1.value[2])
        const lerped = Cesium.Cartesian3.lerp(start, end, t, new Cesium.Cartesian3())
        translation = new Cesium.Cartesian3(
          lerped.x - nodeData.translation[0],
          lerped.y - nodeData.translation[1],
          lerped.z - nodeData.translation[2]
        )
      }
      // Transform to local node space
      Cesium.Matrix3.multiplyByVector(nodeData.invRotationMatrix, translation, translation)
    }

    // Interpolate rotation
    const rotation = new Cesium.Quaternion(0, 0, 0, 1)
    const rotKeys = getKeysAtTime(track.rotationKeys, targetTime)
    if (rotKeys) {
      const [k0, k1] = rotKeys
      let result: Cesium.Quaternion
      if (k0.time === k1.time) {
        result = new Cesium.Quaternion(k0.value[0], k0.value[1], k0.value[2], k0.value[3])
      } else {
        const t = (targetTime - k0.time) / (k1.time - k0.time)
        const start = new Cesium.Quaternion(k0.value[0], k0.value[1], k0.value[2], k0.value[3])
        const end = new Cesium.Quaternion(k1.value[0], k1.value[1], k1.value[2], k1.value[3])
        result = Cesium.Quaternion.slerp(start, end, t, new Cesium.Quaternion())
      }

      // Transform to local node space and compute delta from original
      const resultAxis = new Cesium.Cartesian3(1, 0, 0)
      const resultAngle = Cesium.Quaternion.computeAngle(result)
      if (Math.abs(resultAngle) > Cesium.Math.EPSILON5) {
        Cesium.Quaternion.computeAxis(result, resultAxis)
      }
      Cesium.Matrix3.multiplyByVector(nodeData.invRotationMatrix, resultAxis, resultAxis)
      Cesium.Quaternion.fromAxisAngle(resultAxis, resultAngle, result)
      Cesium.Quaternion.multiply(result, nodeData.invRotation, rotation)
    }

    // Interpolate scale
    let scale = new Cesium.Cartesian3(1, 1, 1)
    const scaleKeys = getKeysAtTime(track.scaleKeys, targetTime)
    if (scaleKeys) {
      const [k0, k1] = scaleKeys
      if (k0.time === k1.time) {
        scale = new Cesium.Cartesian3(
          k0.value[0] / nodeData.scale[0],
          k0.value[1] / nodeData.scale[1],
          k0.value[2] / nodeData.scale[2]
        )
      } else {
        const t = (targetTime - k0.time) / (k1.time - k0.time)
        const start = new Cesium.Cartesian3(k0.value[0], k0.value[1], k0.value[2])
        const end = new Cesium.Cartesian3(k1.value[0], k1.value[1], k1.value[2])
        const lerped = Cesium.Cartesian3.lerp(start, end, t, new Cesium.Cartesian3())
        scale = new Cesium.Cartesian3(
          lerped.x / nodeData.scale[0],
          lerped.y / nodeData.scale[1],
          lerped.z / nodeData.scale[2]
        )
      }
    }

    // Build transform matrix and apply to node
    const transformMatrix = Cesium.Matrix4.fromTranslationQuaternionRotationScale(
      translation,
      rotation,
      scale,
      new Cesium.Matrix4()
    )

    node.matrix = Cesium.Matrix4.multiply(originalMatrix, transformMatrix, new Cesium.Matrix4())
  }

  return true
}

/**
 * Apply gear animations to a model at a specific percent
 * Finds all animations with "GEAR" in the name and applies them
 *
 * @param model - Cesium Model primitive
 * @param animationSet - Parsed animation set
 * @param percent - Gear progress (0 = retracted, 1 = extended)
 * @returns Number of gear animations applied
 */
export function applyGearAnimationsPercent(
  model: Cesium.Model,
  animationSet: AnimationSet,
  percent: number
): number {
  let appliedCount = 0

  for (const animation of animationSet.animations) {
    // Match gear-related animations
    if (animation.name.toUpperCase().includes('GEAR')) {
      const success = applyAnimationPercent(model, animationSet, animation.name, percent)
      if (success) appliedCount++
    }
  }

  return appliedCount
}

/**
 * Clear cached animation set for a URL
 */
export function clearAnimationCache(url?: string): void {
  if (url) {
    animationSetCache.delete(url)
    groundDataCache.delete(url)
    failedGroundDataUrls.delete(url)
    failedAnimationUrls.delete(url)
  } else {
    animationSetCache.clear()
    groundDataCache.clear()
    failedGroundDataUrls.clear()
    failedAnimationUrls.clear()
  }
}

// ============================================================================
// Ground Data Computation
// ============================================================================

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
      // These use Z-up coordinate system and object-based collections
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
    const gearAnimations = animations.filter(a => a.name.toUpperCase().includes('GEAR'))

    // Compute ground data at both gear states
    const gearUpMinY = computeMinYAtGearState(extendedNodes, gearAnimations, 0.0, gltfJson)
    const gearDownMinY = computeMinYAtGearState(extendedNodes, gearAnimations, 1.0, gltfJson)

    return { gearUpMinY, gearDownMinY }
  } catch (error) {
    console.error('[GroundData] Failed to parse GLB:', error)
    return null
  }
}

/**
 * Parse ground data from glTF 1.0 format (FR24/FlightGear models)
 *
 * glTF 1.0 uses:
 * - Object-based collections (meshes/accessors are objects with named keys)
 * - No landing gear animations (static models)
 *
 * Note: FR24 models are inconsistent in their coordinate systems.
 * We detect the vertical axis by counting which axis has the most primitives
 * with "reasonable" vertical bounds (min between -10 and 0, range < 20m).
 * This works because most aircraft parts (fuselage, tail, gear) have small
 * vertical extent, while only wings have large lateral extent.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseGroundDataGltf1(gltfJson: any): ModelGroundData | null {
  const meshes = gltfJson.meshes || {}
  const accessors = gltfJson.accessors || {}

  // Count primitives with "reasonable" vertical bounds per axis
  // Landing gear is typically 2-6m below origin, fuselage height ~6-18m
  const axisCounts = [0, 0, 0]  // X, Y, Z
  const axisMinValues: [number[], number[], number[]] = [[], [], []]

  // Iterate over all meshes (object with named keys)
  for (const meshName of Object.keys(meshes)) {
    const mesh = meshes[meshName]
    if (!mesh.primitives) continue

    for (const primitive of mesh.primitives) {
      const posAccessorName = primitive.attributes?.POSITION
      if (!posAccessorName) continue

      const posAccessor = accessors[posAccessorName]
      if (!posAccessor?.min || !posAccessor?.max) continue

      // Check each axis for reasonable vertical bounds
      for (let axis = 0; axis < 3; axis++) {
        const min = posAccessor.min[axis]
        const max = posAccessor.max[axis]
        const range = max - min

        // Reasonable vertical bounds: min between -5 and 0, range < 15m
        // Tighter threshold (-5m) excludes fuselage belly and focuses on
        // landing gear-like geometry. FR24 models often don't have explicit
        // landing gear, so we use the lower parts of wings/nacelles.
        if (min >= -5 && min < 0 && range < 15) {
          axisCounts[axis]++
          axisMinValues[axis].push(min)
        }
      }
    }
  }

  // Pick the axis with most primitives having reasonable bounds
  let bestAxis = 0
  let bestCount = axisCounts[0]
  for (let i = 1; i < 3; i++) {
    if (axisCounts[i] > bestCount) {
      bestCount = axisCounts[i]
      bestAxis = i
    }
  }

  // Get the minimum value across all reasonable primitives for the best axis
  const minValues = axisMinValues[bestAxis]
  if (minValues.length === 0) {
    // Fallback: no reasonable bounds found, use global minimum of smallest range axis
    let globalMinX = Infinity, globalMaxX = -Infinity
    let globalMinY = Infinity, globalMaxY = -Infinity
    let globalMinZ = Infinity, globalMaxZ = -Infinity

    for (const meshName of Object.keys(meshes)) {
      const mesh = meshes[meshName]
      if (!mesh.primitives) continue
      for (const primitive of mesh.primitives) {
        const posAccessorName = primitive.attributes?.POSITION
        if (!posAccessorName) continue
        const posAccessor = accessors[posAccessorName]
        if (!posAccessor?.min || !posAccessor?.max) continue
        globalMinX = Math.min(globalMinX, posAccessor.min[0])
        globalMaxX = Math.max(globalMaxX, posAccessor.max[0])
        globalMinY = Math.min(globalMinY, posAccessor.min[1])
        globalMaxY = Math.max(globalMaxY, posAccessor.max[1])
        globalMinZ = Math.min(globalMinZ, posAccessor.min[2])
        globalMaxZ = Math.max(globalMaxZ, posAccessor.max[2])
      }
    }

    const ranges = [globalMaxX - globalMinX, globalMaxY - globalMinY, globalMaxZ - globalMinZ]
    const mins = [globalMinX, globalMinY, globalMinZ]
    let smallestRangeAxis = 0
    for (let i = 1; i < 3; i++) {
      if (ranges[i] < ranges[smallestRangeAxis]) smallestRangeAxis = i
    }
    // Cap to -4m max for FR24 models
    const MAX_FR24_GROUND_OFFSET = -4
    const cappedMin = Math.max(mins[smallestRangeAxis], MAX_FR24_GROUND_OFFSET)
    return { gearUpMinY: cappedMin, gearDownMinY: cappedMin }
  }

  const minVertical = Math.min(...minValues)

  // FR24 models have no gear animations, so both states are the same
  // Cap the offset to -4m max - FR24 models don't have detailed landing gear,
  // so large offsets (like -6m from fuselage belly) are incorrect.
  // Typical landing gear extends 2-4m below fuselage.
  const MAX_FR24_GROUND_OFFSET = -4
  const cappedMinVertical = Math.max(minVertical, MAX_FR24_GROUND_OFFSET)

  return {
    gearUpMinY: cappedMinVertical,
    gearDownMinY: cappedMinVertical
  }
}

/**
 * Parse extended node data including hierarchy and mesh bounds
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseExtendedNodes(gltfJson: any): Map<number, ExtendedNodeData> {
  const nodes = new Map<number, ExtendedNodeData>()

  if (!gltfJson.nodes) return nodes

  // First pass: create nodes with basic data
  for (let i = 0; i < gltfJson.nodes.length; i++) {
    const node = gltfJson.nodes[i]
    const name = node.name || `node_${i}`

    // Compute local matrix from TRS or use provided matrix
    let localMatrix: number[]
    if (node.matrix) {
      localMatrix = node.matrix
    } else {
      // Build matrix from TRS
      const t = node.translation || [0, 0, 0]
      const r = node.rotation || [0, 0, 0, 1]
      const s = node.scale || [1, 1, 1]
      localMatrix = matrixFromTRS(t, r, s)
    }

    // Get mesh bounds if this node has a mesh
    let meshBounds: MeshBounds | null = null
    if (node.mesh !== undefined && gltfJson.meshes && gltfJson.meshes[node.mesh]) {
      meshBounds = getMeshBounds(gltfJson, node.mesh)
    }

    nodes.set(i, {
      index: i,
      name,
      parentIndex: null,  // Will be set in second pass
      childIndices: node.children || [],
      meshIndex: node.mesh ?? null,
      localMatrix,
      meshBounds
    })
  }

  // Second pass: set parent indices
  for (const [idx, node] of nodes) {
    for (const childIdx of node.childIndices) {
      const childNode = nodes.get(childIdx)
      if (childNode) {
        childNode.parentIndex = idx
      }
    }
  }

  return nodes
}

/**
 * Get combined mesh bounds from all primitives of a mesh
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getMeshBounds(gltfJson: any, meshIndex: number): MeshBounds | null {
  const mesh = gltfJson.meshes[meshIndex]
  if (!mesh || !mesh.primitives) return null

  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity

  for (const primitive of mesh.primitives) {
    if (primitive.attributes?.POSITION === undefined) continue

    const posAccessor = gltfJson.accessors[primitive.attributes.POSITION]
    if (!posAccessor || !posAccessor.min || !posAccessor.max) continue

    // glTF POSITION accessors must have min/max per spec
    minX = Math.min(minX, posAccessor.min[0])
    minY = Math.min(minY, posAccessor.min[1])
    minZ = Math.min(minZ, posAccessor.min[2])
    maxX = Math.max(maxX, posAccessor.max[0])
    maxY = Math.max(maxY, posAccessor.max[1])
    maxZ = Math.max(maxZ, posAccessor.max[2])
  }

  if (!isFinite(minX)) return null

  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ]
  }
}

/**
 * Compute the minimum Y coordinate across all meshes at a specific gear state
 */
function computeMinYAtGearState(
  nodes: Map<number, ExtendedNodeData>,
  gearAnimations: Animation[],
  gearProgress: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gltfJson: any
): number {
  // Get gear animation transforms at the specified progress
  const animatedTransforms = computeGearAnimationTransforms(gearAnimations, gearProgress, gltfJson)

  let globalMinY = Infinity

  // For each node with a mesh, compute world-space bounds
  for (const [nodeIdx, node] of nodes) {
    if (!node.meshBounds) continue

    // Get world matrix for this node (walking up the hierarchy)
    const worldMatrix = getWorldMatrix(nodeIdx, nodes, animatedTransforms)

    // Transform the 8 corners of the bounding box
    const corners = getBoundingBoxCorners(node.meshBounds)
    for (const corner of corners) {
      const worldCorner = transformPoint(corner, worldMatrix)
      globalMinY = Math.min(globalMinY, worldCorner[1])  // Y is up in glTF
    }
  }

  return isFinite(globalMinY) ? globalMinY : 0
}

/**
 * Compute animation transforms for gear-related nodes at a specific progress
 */
function computeGearAnimationTransforms(
  gearAnimations: Animation[],
  progress: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gltfJson: any
): Map<string, number[]> {
  const transforms = new Map<string, number[]>()

  for (const animation of gearAnimations) {
    const targetTime = animation.duration * progress

    for (const [nodeName, track] of animation.tracks) {
      // Find node index by name
      let nodeIndex = -1
      for (let i = 0; i < gltfJson.nodes.length; i++) {
        const node = gltfJson.nodes[i]
        const name = node.name || `node_${i}`
        if (name === nodeName) {
          nodeIndex = i
          break
        }
      }
      if (nodeIndex === -1) continue

      const node = gltfJson.nodes[nodeIndex]

      // Get base TRS from node
      const baseT = node.translation || [0, 0, 0]
      const baseR = node.rotation || [0, 0, 0, 1]
      const baseS = node.scale || [1, 1, 1]

      // Interpolate animation values
      const t = interpolateVec3(track.translationKeys, targetTime) || baseT
      const r = interpolateQuat(track.rotationKeys, targetTime) || baseR
      const s = interpolateVec3(track.scaleKeys, targetTime) || baseS

      // Build animated matrix
      const animatedMatrix = matrixFromTRS(t, r, s)
      transforms.set(nodeName, animatedMatrix)
    }
  }

  return transforms
}

/**
 * Get the world matrix for a node by walking up the hierarchy
 */
function getWorldMatrix(
  nodeIndex: number,
  nodes: Map<number, ExtendedNodeData>,
  animatedTransforms: Map<string, number[]>
): number[] {
  const node = nodes.get(nodeIndex)
  if (!node) return identityMatrix()

  // Check if this node has an animated transform
  const localMatrix = animatedTransforms.get(node.name) || node.localMatrix

  if (node.parentIndex === null) {
    return localMatrix
  }

  // Recursively get parent's world matrix
  const parentWorld = getWorldMatrix(node.parentIndex, nodes, animatedTransforms)

  // Multiply: parent * local = world
  return multiplyMatrices(parentWorld, localMatrix)
}

/**
 * Get the 8 corners of a bounding box
 */
function getBoundingBoxCorners(bounds: MeshBounds): [number, number, number][] {
  const [minX, minY, minZ] = bounds.min
  const [maxX, maxY, maxZ] = bounds.max

  return [
    [minX, minY, minZ],
    [maxX, minY, minZ],
    [minX, maxY, minZ],
    [maxX, maxY, minZ],
    [minX, minY, maxZ],
    [maxX, minY, maxZ],
    [minX, maxY, maxZ],
    [maxX, maxY, maxZ]
  ]
}

/**
 * Transform a point by a 4x4 matrix (column-major)
 */
function transformPoint(point: [number, number, number], matrix: number[]): [number, number, number] {
  const [x, y, z] = point
  // Column-major: m[col*4 + row]
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15]
  // Guard against division by zero (degenerate matrix)
  const safeW = Math.abs(w) < 1e-10 ? 1 : w
  return [
    (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / safeW,
    (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / safeW,
    (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / safeW
  ]
}

/**
 * Create a 4x4 matrix from translation, rotation (quaternion), and scale
 */
function matrixFromTRS(t: number[], r: number[], s: number[]): number[] {
  // Quaternion to rotation matrix
  const [qx, qy, qz, qw] = r
  const xx = qx * qx, yy = qy * qy, zz = qz * qz
  const xy = qx * qy, xz = qx * qz, yz = qy * qz
  const wx = qw * qx, wy = qw * qy, wz = qw * qz

  const r00 = 1 - 2 * (yy + zz)
  const r01 = 2 * (xy - wz)
  const r02 = 2 * (xz + wy)
  const r10 = 2 * (xy + wz)
  const r11 = 1 - 2 * (xx + zz)
  const r12 = 2 * (yz - wx)
  const r20 = 2 * (xz - wy)
  const r21 = 2 * (yz + wx)
  const r22 = 1 - 2 * (xx + yy)

  // Apply scale to rotation matrix, then add translation
  // Column-major order
  return [
    r00 * s[0], r10 * s[0], r20 * s[0], 0,
    r01 * s[1], r11 * s[1], r21 * s[1], 0,
    r02 * s[2], r12 * s[2], r22 * s[2], 0,
    t[0], t[1], t[2], 1
  ]
}

/**
 * Multiply two 4x4 matrices (column-major)
 */
function multiplyMatrices(a: number[], b: number[]): number[] {
  const result = new Array(16).fill(0)
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + row] * b[col * 4 + k]
      }
      result[col * 4 + row] = sum
    }
  }
  return result
}

/**
 * Create an identity 4x4 matrix
 */
function identityMatrix(): number[] {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
  ]
}

/**
 * Interpolate Vec3 keyframes at a specific time
 */
function interpolateVec3(keys: AnimationKey[], time: number): number[] | null {
  if (keys.length === 0) return null

  // Before first key
  if (time <= keys[0].time) {
    return keys[0].value
  }

  // After last key
  if (time >= keys[keys.length - 1].time) {
    return keys[keys.length - 1].value
  }

  // Find surrounding keys
  for (let i = 0; i < keys.length - 1; i++) {
    if (keys[i].time <= time && keys[i + 1].time >= time) {
      const t = (time - keys[i].time) / (keys[i + 1].time - keys[i].time)
      const a = keys[i].value
      const b = keys[i + 1].value
      return [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t
      ]
    }
  }

  return null
}

/**
 * Interpolate quaternion keyframes at a specific time (spherical linear interpolation)
 */
function interpolateQuat(keys: AnimationKey[], time: number): number[] | null {
  if (keys.length === 0) return null

  // Before first key
  if (time <= keys[0].time) {
    return keys[0].value
  }

  // After last key
  if (time >= keys[keys.length - 1].time) {
    return keys[keys.length - 1].value
  }

  // Find surrounding keys
  for (let i = 0; i < keys.length - 1; i++) {
    if (keys[i].time <= time && keys[i + 1].time >= time) {
      const t = (time - keys[i].time) / (keys[i + 1].time - keys[i].time)
      return slerpQuat(keys[i].value, keys[i + 1].value, t)
    }
  }

  return null
}

/**
 * Spherical linear interpolation between two quaternions
 */
function slerpQuat(a: number[], b: number[], t: number): number[] {
  // Compute dot product
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]

  // If negative dot, negate one quaternion to take shorter path
  const bSign = dot < 0 ? -1 : 1
  dot = Math.abs(dot)

  // If quaternions are very close, use linear interpolation
  if (dot > 0.9995) {
    return [
      a[0] + t * (bSign * b[0] - a[0]),
      a[1] + t * (bSign * b[1] - a[1]),
      a[2] + t * (bSign * b[2] - a[2]),
      a[3] + t * (bSign * b[3] - a[3])
    ]
  }

  // Spherical interpolation
  const theta = Math.acos(dot)
  const sinTheta = Math.sin(theta)
  const wa = Math.sin((1 - t) * theta) / sinTheta
  const wb = Math.sin(t * theta) / sinTheta * bSign

  return [
    wa * a[0] + wb * b[0],
    wa * a[1] + wb * b[1],
    wa * a[2] + wb * b[2],
    wa * a[3] + wb * b[3]
  ]
}
