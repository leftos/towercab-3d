/**
 * Matrix Math Utilities for glTF
 *
 * Pure math functions for 4x4 matrix operations used in glTF parsing.
 * All matrices are column-major (glTF standard).
 */

import type { MeshBounds } from './types'

/**
 * Create a 4x4 identity matrix
 */
export function identityMatrix(): number[] {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
  ]
}

/**
 * Create a 4x4 matrix from translation, rotation (quaternion), and scale
 */
export function matrixFromTRS(t: number[], r: number[], s: number[]): number[] {
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
export function multiplyMatrices(a: number[], b: number[]): number[] {
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
 * Transform a point by a 4x4 matrix (column-major)
 */
export function transformPoint(point: [number, number, number], matrix: number[]): [number, number, number] {
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
 * Get the 8 corners of a bounding box
 */
export function getBoundingBoxCorners(bounds: MeshBounds): [number, number, number][] {
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
