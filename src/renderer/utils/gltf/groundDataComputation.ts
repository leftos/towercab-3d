/**
 * Ground Data Computation
 *
 * Computes ground offset data from glTF model geometry.
 * Handles both glTF 1.0 (FR24/FlightGear) and glTF 2.0 (FSLTL) formats.
 */

import type { Animation, ExtendedNodeData, MeshBounds, ModelGroundData, ModelWingData } from './types'
import { interpolateVec3, interpolateQuat } from './animationInterpolation'
import {
  matrixFromTRS,
  multiplyMatrices,
  identityMatrix,
  transformPoint,
  getBoundingBoxCorners
} from './matrixMath'

/**
 * Parse extended node data including hierarchy and mesh bounds
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseExtendedNodes(gltfJson: any): Map<number, ExtendedNodeData> {
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
export function getMeshBounds(gltfJson: any, meshIndex: number): MeshBounds | null {
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
export function computeMinYAtGearState(
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
export function computeGearAnimationTransforms(
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
export function getWorldMatrix(
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
 * Parse ground data from glTF 1.0 format (FR24/FlightGear models)
 *
 * glTF 1.0 uses:
 * - Object-based collections (meshes/accessors are objects with named keys)
 * - No landing gear animations (static models)
 *
 * Note: FR24 models are inconsistent in their coordinate systems.
 * We detect the vertical axis by counting which axis has the most primitives
 * with "reasonable" vertical bounds (min between -10 and 0, range < 20m).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseGroundDataGltf1(gltfJson: any): ModelGroundData | null {
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
  // Cap the offset to -4m max
  const MAX_FR24_GROUND_OFFSET = -4
  const cappedMinVertical = Math.max(minVertical, MAX_FR24_GROUND_OFFSET)

  return {
    gearUpMinY: cappedMinVertical,
    gearDownMinY: cappedMinVertical
  }
}

/**
 * Compute wing tip positions from model geometry
 *
 * Finds the extreme X positions (left/right wingtips) and records their Y coordinates.
 * This is used to position navigation lights at the correct height on the wings.
 *
 * For glTF 2.0 models (FSLTL), we transform mesh bounds to world space.
 * For glTF 1.0 models (FR24), we use local bounds directly.
 *
 * Nav lights are on top of the wings, so we track the MAXIMUM Y at each wingtip X.
 */
export function computeWingData(
  nodes: Map<number, ExtendedNodeData>
): ModelWingData | null {
  // Track extreme X positions and the maximum Y at those positions
  // We use a tolerance to find corners "near" the wingtip X
  let leftMostX = Infinity
  let rightMostX = -Infinity
  let leftWingMaxY = -Infinity
  let rightWingMaxY = -Infinity

  // No animations needed for wing computation - wings don't animate
  const noAnimations = new Map<string, number[]>()

  // First pass: find extreme X positions
  for (const [nodeIdx, node] of nodes) {
    if (!node.meshBounds) continue

    const worldMatrix = getWorldMatrix(nodeIdx, nodes, noAnimations)
    const corners = getBoundingBoxCorners(node.meshBounds)

    for (const corner of corners) {
      const worldCorner = transformPoint(corner, worldMatrix)
      const x = worldCorner[0]

      if (x < leftMostX) leftMostX = x
      if (x > rightMostX) rightMostX = x
    }
  }

  if (!isFinite(leftMostX) || !isFinite(rightMostX)) {
    return null
  }

  // Tolerance for finding corners "at" the wingtip (within 0.5m of extreme)
  const tolerance = 0.5

  // Second pass: find maximum Y at each wingtip
  for (const [nodeIdx, node] of nodes) {
    if (!node.meshBounds) continue

    const worldMatrix = getWorldMatrix(nodeIdx, nodes, noAnimations)
    const corners = getBoundingBoxCorners(node.meshBounds)

    for (const corner of corners) {
      const worldCorner = transformPoint(corner, worldMatrix)
      const x = worldCorner[0]
      const y = worldCorner[1]

      // Check if this corner is at the left wingtip
      if (x <= leftMostX + tolerance) {
        leftWingMaxY = Math.max(leftWingMaxY, y)
      }

      // Check if this corner is at the right wingtip
      if (x >= rightMostX - tolerance) {
        rightWingMaxY = Math.max(rightWingMaxY, y)
      }
    }
  }

  // Validate we found reasonable wing data
  if (!isFinite(leftWingMaxY) || !isFinite(rightWingMaxY)) {
    return null
  }

  // Wings should be reasonably symmetric - sanity check
  const wingspan = rightMostX - leftMostX
  if (wingspan < 5 || wingspan > 100) {
    // Wingspan less than 5m or more than 100m is suspicious
    return null
  }

  return {
    leftWingX: leftMostX,
    rightWingX: rightMostX,
    leftWingY: leftWingMaxY,
    rightWingY: rightWingMaxY
  }
}

/**
 * Parse wing data from glTF 1.0 format (FR24/FlightGear models)
 *
 * Similar to parseGroundDataGltf1, handles the object-based format.
 * Uses two-pass approach: first find extreme X positions, then find max Y at those positions.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseWingDataGltf1(gltfJson: any): ModelWingData | null {
  const meshes = gltfJson.meshes || {}
  const accessors = gltfJson.accessors || {}

  let leftMostX = Infinity
  let rightMostX = -Infinity
  let leftWingMaxY = -Infinity
  let rightWingMaxY = -Infinity

  // First pass: find extreme X positions
  for (const meshName of Object.keys(meshes)) {
    const mesh = meshes[meshName]
    if (!mesh.primitives) continue

    for (const primitive of mesh.primitives) {
      const posAccessorName = primitive.attributes?.POSITION
      if (!posAccessorName) continue

      const posAccessor = accessors[posAccessorName]
      if (!posAccessor?.min || !posAccessor?.max) continue

      if (posAccessor.min[0] < leftMostX) leftMostX = posAccessor.min[0]
      if (posAccessor.max[0] > rightMostX) rightMostX = posAccessor.max[0]
    }
  }

  if (!isFinite(leftMostX) || !isFinite(rightMostX)) {
    return null
  }

  // Tolerance for finding primitives "at" the wingtip
  const tolerance = 0.5

  // Second pass: find maximum Y at each wingtip
  for (const meshName of Object.keys(meshes)) {
    const mesh = meshes[meshName]
    if (!mesh.primitives) continue

    for (const primitive of mesh.primitives) {
      const posAccessorName = primitive.attributes?.POSITION
      if (!posAccessorName) continue

      const posAccessor = accessors[posAccessorName]
      if (!posAccessor?.min || !posAccessor?.max) continue

      const minX = posAccessor.min[0]
      const maxX = posAccessor.max[0]
      const maxY = posAccessor.max[1]

      // Check if this primitive reaches the left wingtip
      if (minX <= leftMostX + tolerance) {
        leftWingMaxY = Math.max(leftWingMaxY, maxY)
      }

      // Check if this primitive reaches the right wingtip
      if (maxX >= rightMostX - tolerance) {
        rightWingMaxY = Math.max(rightWingMaxY, maxY)
      }
    }
  }

  // Validate we found reasonable wing data
  if (!isFinite(leftWingMaxY) || !isFinite(rightWingMaxY)) {
    return null
  }

  const wingspan = rightMostX - leftMostX
  if (wingspan < 5 || wingspan > 100) {
    return null
  }

  return {
    leftWingX: leftMostX,
    rightWingX: rightMostX,
    leftWingY: leftWingMaxY,
    rightWingY: rightWingMaxY
  }
}
