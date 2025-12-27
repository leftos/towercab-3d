/**
 * glTF Animation Parser Types
 *
 * Type definitions for glTF animation parsing and ground data computation.
 */

import type * as Cesium from 'cesium'

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
