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

/** Cache of parsed animation sets by model URL */
const animationSetCache = new Map<string, AnimationSet>()

/** Pending parse promises to avoid duplicate parsing */
const pendingParses = new Map<string, Promise<AnimationSet | null>>()

/**
 * Parse animation set from a GLB URL
 * Results are cached by URL to avoid re-parsing
 */
export async function parseAnimationSetFromUrl(glbUrl: string): Promise<AnimationSet | null> {
  // Check cache first
  if (animationSetCache.has(glbUrl)) {
    return animationSetCache.get(glbUrl)!
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
  } else {
    animationSetCache.clear()
  }
}
