/**
 * Cloud texture generation functions
 * Creates dynamic textures for patchy and overcast cloud layers
 */

import * as BABYLON from '@babylonjs/core'
import { fbmNoise } from './cloudNoiseGenerator'
import {
  CLOUD_NOISE_SCALE,
  CLOUD_NOISE_OCTAVES,
  CLOUD_NOISE_PERSISTENCE,
  CLOUD_EDGE_SOFTNESS,
  CLOUD_RADIAL_FADE_START,
  CLOUD_RADIAL_FADE_END,
  CLOUD_DOME_HORIZON_DARKENING
} from '@/constants'

/**
 * Generate a patchy cloud opacity texture using fBm noise.
 * Coverage determines how much of the noise becomes visible cloud vs transparent gap.
 *
 * @param scene - Babylon.js scene
 * @param textureSize - Size of the texture in pixels
 * @param coverage - Cloud coverage (0-1, from METAR oktas)
 * @param seed - Random seed for unique patterns per layer
 * @returns DynamicTexture with patchy cloud pattern and radial edge fade
 */
export function createPatchyCloudTexture(
  scene: BABYLON.Scene,
  textureSize: number,
  coverage: number,
  seed: number = 0
): BABYLON.DynamicTexture {
  const texture = new BABYLON.DynamicTexture(
    `cloud_patchy_${seed}_${coverage.toFixed(3)}`,
    textureSize,
    scene,
    true // generateMipMaps - prevents jagged edges when stretched over large plane
  )
  const ctx = texture.getContext() as CanvasRenderingContext2D

  const imageData = ctx.createImageData(textureSize, textureSize)
  const data = imageData.data

  const centerX = textureSize / 2
  const centerY = textureSize / 2
  const maxRadius = textureSize / 2

  // Coverage determines the noise threshold
  // For BKN/OVC (high coverage), we want mostly solid with small breaks
  // For FEW/SCT (low coverage), we want mostly clear with cloud patches
  const noiseScale = CLOUD_NOISE_SCALE

  for (let y = 0; y < textureSize; y++) {
    for (let x = 0; x < textureSize; x++) {
      const idx = (y * textureSize + x) * 4

      // Generate fBm noise value with seed offset for variety between layers
      const nx = (x / textureSize) * noiseScale + seed * 100
      const ny = (y / textureSize) * noiseScale + seed * 100
      const noiseValue = fbmNoise(nx, ny, CLOUD_NOISE_OCTAVES, CLOUD_NOISE_PERSISTENCE)

      // Calculate cloud opacity based on coverage level
      let cloudAlpha: number
      if (coverage >= 0.95) {
        // OVC: completely solid, no breaks at all
        cloudAlpha = 1.0
      } else if (coverage >= 0.6) {
        // BKN: mostly solid with visible breaks where noise is low
        // Use higher gap threshold to ensure visible sky breaks
        // For BKN (0.6875): gap threshold ≈ 0.45, so ~40% of texture is gaps
        const gapThreshold = (1.0 - coverage) + 0.15
        if (noiseValue < gapThreshold) {
          // Clear gap - fully transparent for visible sky
          cloudAlpha = 0.0
        } else if (noiseValue < gapThreshold + 0.1) {
          // Soft edge transition
          cloudAlpha = (noiseValue - gapThreshold) / 0.1
        } else {
          cloudAlpha = 1.0
        }
      } else {
        // FEW/SCT: patches of cloud where noise is high
        // Higher coverage = lower threshold = more cloud patches
        const threshold = 0.5 + 0.2 * (1.0 - 2.0 * coverage)
        if (noiseValue > threshold) {
          const edge = (noiseValue - threshold) / CLOUD_EDGE_SOFTNESS
          cloudAlpha = Math.min(1.0, edge)
        } else {
          cloudAlpha = 0.0
        }
      }

      // Apply radial fade (clouds fade to transparent at edges)
      // But for high coverage, delay the fade start so center area is fully covered
      const dx = x - centerX
      const dy = y - centerY
      const distance = Math.sqrt(dx * dx + dy * dy) / maxRadius

      // Coverage determines fade start:
      // - OVC (0.95+): softer edge starting at 0.5 for gradual horizon fade
      // - BKN (0.6+): later fade at 0.7 for mostly solid center
      // - FEW/SCT: default fade start
      let fadeStart: number
      if (coverage >= 0.95) {
        fadeStart = 0.5  // OVC: soft gradual edge
      } else if (coverage >= 0.6) {
        fadeStart = 0.7  // BKN: later start, mostly solid
      } else {
        fadeStart = CLOUD_RADIAL_FADE_START  // FEW/SCT: default
      }
      let radialFade = 1.0
      if (distance > fadeStart) {
        radialFade = 1.0 - (distance - fadeStart) / (CLOUD_RADIAL_FADE_END - fadeStart)
        radialFade = Math.max(0, Math.min(1, radialFade))
      }

      // Combine patchy cloud with radial fade
      const finalAlpha = cloudAlpha * radialFade

      // Write RGBA - white color with alpha for transparency
      data[idx] = 255     // R
      data[idx + 1] = 255 // G
      data[idx + 2] = 255 // B
      data[idx + 3] = Math.round(finalAlpha * 255) // A
    }
  }

  ctx.putImageData(imageData, 0, 0)
  texture.hasAlpha = true
  texture.update()

  return texture
}

/**
 * Creates a texture for the overcast dome with horizon darkening effect.
 * The texture has subtle noise variation and proper alpha for gradual fade.
 *
 * @param scene - Babylon.js scene
 * @param textureSize - Size of the texture in pixels
 * @param seed - Random seed for subtle pattern variation
 * @returns DynamicTexture with overcast pattern and horizon gradient
 */
export function createOvercastDomeTexture(
  scene: BABYLON.Scene,
  textureSize: number,
  seed: number = 0
): BABYLON.DynamicTexture {
  const texture = new BABYLON.DynamicTexture(
    `cloud_overcast_dome_${seed}`,
    textureSize,
    scene,
    true
  )
  const ctx = texture.getContext() as CanvasRenderingContext2D

  const imageData = ctx.createImageData(textureSize, textureSize)
  const data = imageData.data

  const centerX = textureSize / 2
  const centerY = textureSize / 2
  const maxRadius = textureSize / 2

  for (let y = 0; y < textureSize; y++) {
    for (let x = 0; x < textureSize; x++) {
      const idx = (y * textureSize + x) * 4

      // Distance from center (0 at center, 1 at edge)
      const dx = x - centerX
      const dy = y - centerY
      const distance = Math.sqrt(dx * dx + dy * dy) / maxRadius

      // Subtle noise for texture variation (very low amplitude for overcast)
      const nx = (x / textureSize) * 4 + seed * 100
      const ny = (y / textureSize) * 4 + seed * 100
      const noise = fbmNoise(nx, ny, 3, 0.5) * 0.15 // Subtle variation

      // Horizon darkening: darker at edges, lighter at center
      // This simulates looking through more atmosphere at shallow angles
      const horizonDarkening = distance * distance * CLOUD_DOME_HORIZON_DARKENING

      // Base gray value (lighter at center, darker at horizon)
      const baseGray = 0.85 - horizonDarkening + noise * 0.1

      // Clamp to valid range
      const gray = Math.max(0.3, Math.min(1.0, baseGray))

      // Alpha: gradual fade from center to edge
      // Start fading early so the dome doesn't block the horizon view
      // Use smooth curve: fully opaque at center, fully transparent at edge
      let alpha: number
      if (distance < 0.3) {
        // Center area: fully opaque
        alpha = 1.0
      } else if (distance < 0.7) {
        // Gradual fade zone
        const fadeT = (distance - 0.3) / 0.4
        alpha = 1.0 - fadeT * fadeT * 0.7 // Quadratic fade, max 70% reduction
      } else {
        // Outer edge: rapid fade to transparent
        const edgeT = (distance - 0.7) / 0.3
        alpha = 0.3 * (1.0 - edgeT)
        alpha = Math.max(0, alpha)
      }

      // Write RGB with gray value, full alpha
      const colorValue = Math.round(gray * 255)
      data[idx] = colorValue     // R
      data[idx + 1] = colorValue // G
      data[idx + 2] = Math.round(gray * 1.02 * 255) // B slightly higher for cool tint
      data[idx + 3] = Math.round(alpha * 255)       // A
    }
  }

  ctx.putImageData(imageData, 0, 0)
  texture.hasAlpha = true
  texture.update()

  return texture
}
