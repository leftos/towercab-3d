/**
 * glTF Parsing Utilities
 *
 * Barrel export for glTF animation parsing and ground data computation modules.
 */

// Types
export type {
  AnimationKey,
  AnimationTrack,
  Animation,
  NodeData,
  AnimationSet,
  MeshBounds,
  ExtendedNodeData,
  ModelGroundData
} from './types'

// Matrix math utilities
export {
  identityMatrix,
  matrixFromTRS,
  multiplyMatrices,
  transformPoint,
  getBoundingBoxCorners
} from './matrixMath'

// Animation interpolation
export {
  getKeysAtTime,
  interpolateVec3,
  interpolateQuat,
  slerpQuat
} from './animationInterpolation'

// Ground data computation
export {
  parseExtendedNodes,
  getMeshBounds,
  computeMinYAtGearState,
  computeGearAnimationTransforms,
  getWorldMatrix,
  parseGroundDataGltf1
} from './groundDataComputation'
