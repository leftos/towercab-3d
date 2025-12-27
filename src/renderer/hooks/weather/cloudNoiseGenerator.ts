/**
 * Procedural noise generation for cloud textures
 * Pure functions for generating patchy cloud patterns using fractal Brownian motion
 */

/**
 * Simple hash function for pseudo-random number generation.
 * Used as the basis for procedural noise.
 */
export function hash(x: number, y: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return n - Math.floor(n)
}

/**
 * Smooth noise interpolation at a point using bilinear interpolation.
 */
export function smoothNoise(x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0

  // Smoothstep interpolation for smoother transitions
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)

  // Sample corners
  const n00 = hash(x0, y0)
  const n10 = hash(x0 + 1, y0)
  const n01 = hash(x0, y0 + 1)
  const n11 = hash(x0 + 1, y0 + 1)

  // Bilinear interpolation
  const nx0 = n00 * (1 - sx) + n10 * sx
  const nx1 = n01 * (1 - sx) + n11 * sx
  return nx0 * (1 - sy) + nx1 * sy
}

/**
 * Fractal Brownian Motion (fBm) noise - layered noise for natural cloud patterns.
 * Combines multiple octaves of noise at different frequencies.
 */
export function fbmNoise(x: number, y: number, octaves: number, persistence: number): number {
  let total = 0
  let amplitude = 1
  let maxValue = 0
  let frequency = 1

  for (let i = 0; i < octaves; i++) {
    total += smoothNoise(x * frequency, y * frequency) * amplitude
    maxValue += amplitude
    amplitude *= persistence
    frequency *= 2
  }

  return total / maxValue // Normalize to 0-1
}
