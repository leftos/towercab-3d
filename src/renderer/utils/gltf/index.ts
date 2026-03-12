/**
 * glTF Parsing Utilities
 *
 * Barrel export for glTF animation parsing and ground data computation modules.
 */

// Animation interpolation
export {
  getKeysAtTime,
  interpolateQuat,
  interpolateVec3,
  slerpQuat,
} from './animationInterpolation'
// Ground and wing data computation
export {
  computeGearAnimationTransforms,
  computeMinYAtGearState,
  computeWingData,
  getMeshBounds,
  getWorldMatrix,
  parseExtendedNodes,
  parseGroundDataGltf1,
  parseWingDataGltf1,
} from './groundDataComputation'
// Matrix math utilities
export {
  getBoundingBoxCorners,
  identityMatrix,
  matrixFromTRS,
  multiplyMatrices,
  transformPoint,
} from './matrixMath'
// Types
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
} from './types'
