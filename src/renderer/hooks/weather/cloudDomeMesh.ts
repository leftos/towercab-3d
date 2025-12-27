/**
 * Cloud dome mesh geometry generation
 * Creates hemisphere meshes for overcast cloud layers
 */

import * as BABYLON from '@babylonjs/core'
import {
  CLOUD_DOME_SEGMENTS,
  CLOUD_DOME_RADIUS,
  CLOUD_DOME_CURVATURE
} from '@/constants'

/**
 * Creates a dome/hemisphere mesh for overcast cloud layers.
 * The dome curves downward toward the horizon, creating a more realistic
 * overcast sky appearance compared to a flat plane.
 *
 * @param name - Mesh name
 * @param scene - Babylon.js scene
 * @returns Dome mesh positioned at origin
 */
export function createCloudDomeMesh(name: string, scene: BABYLON.Scene): BABYLON.Mesh {
  const segments = CLOUD_DOME_SEGMENTS
  const radius = CLOUD_DOME_RADIUS
  const curvature = CLOUD_DOME_CURVATURE

  // Create custom mesh with vertices
  const positions: number[] = []
  const indices: number[] = []
  const uvs: number[] = []
  const normals: number[] = []

  // Generate dome vertices in concentric rings
  // Ring 0 is center, ring segments is the outer edge
  for (let ring = 0; ring <= segments; ring++) {
    const ringRadius = (ring / segments) * radius
    const ringT = ring / segments // 0 at center, 1 at edge

    // Calculate Y offset based on curvature - lower at edges
    // Use smooth curve that drops more at the horizon
    const yOffset = -ringRadius * curvature * ringT

    const ringSegments = ring === 0 ? 1 : segments * 2

    for (let seg = 0; seg < ringSegments; seg++) {
      const angle = (seg / ringSegments) * Math.PI * 2

      let x: number, z: number
      if (ring === 0) {
        x = 0
        z = 0
      } else {
        x = Math.cos(angle) * ringRadius
        z = Math.sin(angle) * ringRadius
      }

      positions.push(x, yOffset, z)

      // UV mapping: radial from center
      const u = 0.5 + (x / radius) * 0.5
      const v = 0.5 + (z / radius) * 0.5
      uvs.push(u, v)

      // Normal pointing up (will be adjusted by curvature)
      const normalY = 1 / Math.sqrt(1 + curvature * curvature * ringT * ringT)
      const normalRadial = curvature * ringT * normalY
      if (ring === 0) {
        normals.push(0, 1, 0)
      } else {
        const nx = -normalRadial * Math.cos(angle)
        const nz = -normalRadial * Math.sin(angle)
        normals.push(nx, normalY, nz)
      }
    }
  }

  // Generate indices for triangles
  // Center triangle fan (ring 0 to ring 1)
  const ring1Segments = segments * 2
  for (let seg = 0; seg < ring1Segments; seg++) {
    const nextSeg = (seg + 1) % ring1Segments
    indices.push(0, 1 + seg, 1 + nextSeg)
  }

  // Remaining rings: quad strips between rings
  let currentOffset = 1 // Start after center vertex
  for (let ring = 1; ring < segments; ring++) {
    const currentRingSegments = segments * 2
    const nextRingSegments = segments * 2
    const nextOffset = currentOffset + currentRingSegments

    for (let seg = 0; seg < currentRingSegments; seg++) {
      const nextSeg = (seg + 1) % currentRingSegments
      const currentIdx = currentOffset + seg
      const currentNextIdx = currentOffset + nextSeg
      const nextIdx = nextOffset + seg
      const nextNextIdx = nextOffset + nextSeg

      // Two triangles per quad
      indices.push(currentIdx, nextIdx, currentNextIdx)
      indices.push(currentNextIdx, nextIdx, nextNextIdx)
    }

    currentOffset = nextOffset
  }

  // Create the mesh
  const mesh = new BABYLON.Mesh(name, scene)
  const vertexData = new BABYLON.VertexData()

  vertexData.positions = positions
  vertexData.indices = indices
  vertexData.uvs = uvs
  vertexData.normals = normals

  vertexData.applyToMesh(mesh)

  // Enable both sides visible
  mesh.material = null
  mesh.isPickable = false

  return mesh
}
