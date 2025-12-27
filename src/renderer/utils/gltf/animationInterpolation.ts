/**
 * Animation Interpolation Utilities
 *
 * Pure functions for interpolating animation keyframes.
 * Supports linear interpolation for Vec3 and spherical linear interpolation (slerp) for quaternions.
 */

import type { AnimationKey } from './types'

/**
 * Get two keyframes surrounding a given time for interpolation
 */
export function getKeysAtTime(keys: AnimationKey[], time: number): [AnimationKey, AnimationKey] | null {
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
 * Interpolate Vec3 keyframes at a specific time
 */
export function interpolateVec3(keys: AnimationKey[], time: number): number[] | null {
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
export function interpolateQuat(keys: AnimationKey[], time: number): number[] | null {
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
export function slerpQuat(a: number[], b: number[], t: number): number[] {
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
