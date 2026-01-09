/**
 * Flattening Terrain Provider
 *
 * Wraps a CesiumTerrainProvider to flatten designated areas (runways, taxiways)
 * by intercepting terrain tile requests and modifying quantized mesh vertex heights.
 *
 * Based on approach from: https://github.com/alexgoni/Stans-Map
 */

import * as Cesium from 'cesium'
import * as turf from '@turf/turf'
import type { Feature, Polygon } from 'geojson'
import RBush from 'rbush'
import type { FlatteningPolygon, PolygonBBox } from '../types/terrain'

/** Terrain modification data for a single flattening zone */
interface FloorData {
  floorHeight: number
  floorBoundingRect: Cesium.Rectangle
  floorPolygon: Feature<Polygon>
  blendDistance: number // meters for edge blending (0 = hard edge)
  // Optional gradient data for elevation interpolation
  gradientStart?: [number, number] // [lon, lat]
  gradientEnd?: [number, number]   // [lon, lat]
  startElevation?: number
  endElevation?: number
}

/**
 * Create a custom terrain provider that flattens designated areas
 *
 * @param baseProvider - The base CesiumTerrainProvider to wrap
 * @returns Modified terrain provider with flattening capability
 */
export function createFlatteningTerrainProvider(
  baseProvider: Cesium.CesiumTerrainProvider
): Cesium.CesiumTerrainProvider & {
  setFlatteningPolygons: (polygons: FlatteningPolygon[]) => void
  clearFlatteningPolygons: () => void
} {
  // Store modification data
  const modifyData: FloorData[] = []

  // Spatial index for fast polygon lookup
  const spatialIndex = new RBush<PolygonBBox>()

  // Track logged tiles to avoid spam (tile key -> true)
  const loggedTiles = new Set<string>()

  // Cache for processed terrain data (tile key -> modified TerrainData)
  // This prevents reprocessing tiles on every request
  const processedTileCache = new Map<string, Cesium.TerrainData>()

  /**
   * Set the flattening polygons
   */
  function setFlatteningPolygons(polygons: FlatteningPolygon[]): void {
    // Clear existing data
    modifyData.length = 0
    spatialIndex.clear()
    loggedTiles.clear()
    processedTileCache.clear()

    if (polygons.length === 0) return

    // Convert polygons to floor data
    for (const polygon of polygons) {
      // Calculate bounding rectangle
      let west = 180, south = 90, east = -180, north = -90
      for (const [lon, lat] of polygon.vertices) {
        if (lon < west) west = lon
        if (lon > east) east = lon
        if (lat < south) south = lat
        if (lat > north) north = lat
      }

      // Create Cesium rectangle (in radians)
      const floorBoundingRect = Cesium.Rectangle.fromDegrees(west, south, east, north)

      // Create turf polygon for point-in-polygon testing
      const floorPolygon = turf.polygon([polygon.vertices])

      modifyData.push({
        floorHeight: polygon.elevation,
        floorBoundingRect,
        floorPolygon,
        blendDistance: polygon.blendDistance,
        // Copy gradient data if available
        gradientStart: polygon.gradientStart,
        gradientEnd: polygon.gradientEnd,
        startElevation: polygon.startElevation,
        endElevation: polygon.endElevation
      })

      // Add to spatial index (in degrees for easier lookup)
      spatialIndex.insert({
        minX: west,
        minY: south,
        maxX: east,
        maxY: north,
        polygon
      })
    }

    console.log(`[FlatteningTerrainProvider] Set ${polygons.length} flattening polygons`)
  }

  /**
   * Clear all flattening polygons
   */
  function clearFlatteningPolygons(): void {
    modifyData.length = 0
    spatialIndex.clear()
    loggedTiles.clear()
    processedTileCache.clear()
    console.log('[FlatteningTerrainProvider] Cleared flattening polygons')
  }

  /**
   * Check if a tile rectangle intersects any flattening zones (including blend areas)
   */
  function tileIntersectsFloors(tileRect: Cesium.Rectangle): FloorData[] {
    if (modifyData.length === 0) return []

    // Convert tile rectangle to degrees for spatial index query
    const west = Cesium.Math.toDegrees(tileRect.west)
    const south = Cesium.Math.toDegrees(tileRect.south)
    const east = Cesium.Math.toDegrees(tileRect.east)
    const north = Cesium.Math.toDegrees(tileRect.north)

    // Expand search area by max blend distance (rough approximation in degrees)
    // ~0.001 degrees ≈ 111 meters at equator, less at higher latitudes
    const maxBlendDegrees = 0.001 // ~100m buffer for blend distance search
    const candidates = spatialIndex.search({
      minX: west - maxBlendDegrees,
      minY: south - maxBlendDegrees,
      maxX: east + maxBlendDegrees,
      maxY: north + maxBlendDegrees
    })
    if (candidates.length === 0) return []

    // Return matching floor data (expand floor bounds by blend distance)
    return modifyData.filter(floor => {
      // Expand the floor's bounding rect by blend distance for intersection check
      const blendRadians = floor.blendDistance / 6371000 // Earth radius in meters
      const expandedRect = new Cesium.Rectangle(
        floor.floorBoundingRect.west - blendRadians,
        floor.floorBoundingRect.south - blendRadians,
        floor.floorBoundingRect.east + blendRadians,
        floor.floorBoundingRect.north + blendRadians
      )
      return Cesium.Rectangle.intersection(tileRect, expandedRect) !== undefined
    })
  }

  /**
   * Convert quantized height to real height
   */
  function getActualHeight(quantizedHeight: number, minHeight: number, maxHeight: number): number {
    return minHeight + (maxHeight - minHeight) * (quantizedHeight / 32767)
  }

  /**
   * Convert real height to quantized height (0-32767)
   */
  function getQuantizedHeight(realHeight: number, minHeight: number, maxHeight: number): number {
    if (maxHeight === minHeight) return 0
    const normalized = (realHeight - minHeight) / (maxHeight - minHeight)
    return Math.round(Math.max(0, Math.min(32767, normalized * 32767)))
  }

  /**
   * Calculate interpolated elevation along a runway gradient
   * Projects the point onto the runway centerline and interpolates elevation
   */
  function getGradientElevation(
    lon: number,
    lat: number,
    floor: FloorData
  ): number {
    // If no gradient data, use flat elevation
    if (!floor.gradientStart || !floor.gradientEnd ||
        floor.startElevation === undefined || floor.endElevation === undefined) {
      return floor.floorHeight
    }

    const [startLon, startLat] = floor.gradientStart
    const [endLon, endLat] = floor.gradientEnd

    // Vector from start to end
    const dx = endLon - startLon
    const dy = endLat - startLat
    const lengthSq = dx * dx + dy * dy

    if (lengthSq === 0) return floor.floorHeight

    // Project point onto the line (start -> end)
    // t = dot(point - start, end - start) / |end - start|^2
    const px = lon - startLon
    const py = lat - startLat
    let t = (px * dx + py * dy) / lengthSq

    // Clamp t to [0, 1] to stay within runway bounds
    t = Math.max(0, Math.min(1, t))

    // Interpolate elevation
    return floor.startElevation + t * (floor.endElevation - floor.startElevation)
  }

  /**
   * Modify terrain vertex heights for flattening with edge blending
   *
   * Uses single-pass algorithm:
   * 1. Iterate vertices once, collecting modification data and computing new min/max
   * 2. Apply modifications in second pass only if needed
   */
  function modifyTerrain(
    uBuffer: Uint16Array,
    vBuffer: Uint16Array,
    heightBuffer: Uint16Array,
    tileRect: Cesium.Rectangle,
    minHeight: number,
    maxHeight: number,
    floors: FloorData[]
  ): { newMinHeight: number; newMaxHeight: number; modified: boolean; modifiedCount: number } {
    const tileWidth = tileRect.east - tileRect.west
    const tileHeight = tileRect.north - tileRect.south

    // Collect modification data in single pass
    // Map: vertex index -> target height
    const modifications = new Map<number, number>()
    let newMinHeight = minHeight
    let newMaxHeight = maxHeight

    for (let i = 0; i < uBuffer.length; i++) {
      const u = uBuffer[i] / 32767
      const v = vBuffer[i] / 32767

      const lon = Cesium.Math.toDegrees(tileRect.west + u * tileWidth)
      const lat = Cesium.Math.toDegrees(tileRect.south + v * tileHeight)
      const point = turf.point([lon, lat])

      // Get original height for potential blending
      const originalHeight = getActualHeight(heightBuffer[i], minHeight, maxHeight)

      // Check all floors for this vertex - collect all matches for intersection handling
      const insideFloors: { floor: FloorData; height: number }[] = []
      const blendFloors: { floor: FloorData; height: number; factor: number }[] = []

      for (const floor of floors) {
        if (turf.booleanPointInPolygon(point, floor.floorPolygon)) {
          // Inside this polygon
          const targetHeight = getGradientElevation(lon, lat, floor)
          insideFloors.push({ floor, height: targetHeight })
        } else if (floor.blendDistance > 0) {
          // Check if within blend distance
          const distanceToPolygon = turf.pointToPolygonDistance(point, floor.floorPolygon, { units: 'meters' })
          if (distanceToPolygon <= floor.blendDistance) {
            const targetHeight = getGradientElevation(lon, lat, floor)
            const blendFactor = 1.0 - (distanceToPolygon / floor.blendDistance)
            const easedFactor = blendFactor * blendFactor * (3 - 2 * blendFactor)
            blendFloors.push({ floor, height: targetHeight, factor: easedFactor })
          }
        }
      }

      // Determine final height based on matches
      let finalHeight: number | null = null

      if (insideFloors.length > 0) {
        // Inside one or more polygons (intersection case)
        // Prioritize runways (floors with gradient data) over flat pavements
        const runwayFloors = insideFloors.filter(f => f.floor.gradientStart !== undefined)
        const floorsToUse = runwayFloors.length > 0 ? runwayFloors : insideFloors

        // Average the heights from matching floors
        const sumHeight = floorsToUse.reduce((sum, f) => sum + f.height, 0)
        finalHeight = sumHeight / floorsToUse.length
      } else if (blendFloors.length > 0) {
        // In blend zone of one or more polygons
        // Weight by blend factor for smooth edge transitions
        let totalWeight = 0
        let weightedHeight = 0
        for (const bf of blendFloors) {
          weightedHeight += bf.height * bf.factor
          totalWeight += bf.factor
        }
        // Also factor in original height with remaining weight
        const remainingWeight = Math.max(0, 1 - totalWeight)
        finalHeight = (weightedHeight + originalHeight * remainingWeight) / (totalWeight + remainingWeight)
      }

      if (finalHeight !== null) {
        modifications.set(i, finalHeight)
        if (finalHeight < newMinHeight) newMinHeight = finalHeight
        if (finalHeight > newMaxHeight) newMaxHeight = finalHeight
      }
    }

    if (modifications.size === 0) {
      return { newMinHeight: minHeight, newMaxHeight: maxHeight, modified: false, modifiedCount: 0 }
    }

    // Apply modifications - requantize all heights with new range
    for (let i = 0; i < heightBuffer.length; i++) {
      const modifiedHeight = modifications.get(i)
      if (modifiedHeight !== undefined) {
        heightBuffer[i] = getQuantizedHeight(modifiedHeight, newMinHeight, newMaxHeight)
      } else {
        // Requantize original height with new range
        const originalHeight = getActualHeight(heightBuffer[i], minHeight, maxHeight)
        heightBuffer[i] = getQuantizedHeight(originalHeight, newMinHeight, newMaxHeight)
      }
    }

    return { newMinHeight, newMaxHeight, modified: true, modifiedCount: modifications.size }
  }

  // Store original requestTileGeometry
  const originalRequestTileGeometry = baseProvider.requestTileGeometry.bind(baseProvider)

  // Override requestTileGeometry to intercept and modify terrain data
  baseProvider.requestTileGeometry = function(
    x: number,
    y: number,
    level: number,
    request?: Cesium.Request
  ): Promise<Cesium.TerrainData> | undefined {
    const tileKey = `${x}/${y}/${level}`
    const tileRect = baseProvider.tilingScheme.tileXYToRectangle(x, y, level)
    const floors = tileIntersectsFloors(tileRect)

    // If no floors intersect this tile, use original behavior
    if (floors.length === 0) {
      return originalRequestTileGeometry(x, y, level, request)
    }

    // Check if we already processed this tile
    const cached = processedTileCache.get(tileKey)
    if (cached) {
      // Don't log cache hits - too noisy
      return Promise.resolve(cached)
    }

    // Request the original tile data
    const promise = originalRequestTileGeometry(x, y, level, request)
    if (!promise) return undefined

    return promise.then((terrainData: Cesium.TerrainData) => {
      // Check if this is QuantizedMeshTerrainData
      if (!(terrainData instanceof Cesium.QuantizedMeshTerrainData)) {
        console.log(`[FlatteningTerrainProvider] Tile ${tileKey} is not QuantizedMeshTerrainData, skipping`)
        processedTileCache.set(tileKey, terrainData)
        return terrainData
      }

      // Access internal data (these are private but we need them)
      const mesh = terrainData as unknown as {
        _minimumHeight: number
        _maximumHeight: number
        _quantizedVertices: Uint16Array
        _indices: Uint16Array | Uint32Array
        _westIndices: Uint16Array
        _southIndices: Uint16Array
        _eastIndices: Uint16Array
        _northIndices: Uint16Array
        _westSkirtHeight: number
        _southSkirtHeight: number
        _eastSkirtHeight: number
        _northSkirtHeight: number
        _boundingSphere: Cesium.BoundingSphere
        _orientedBoundingBox: Cesium.OrientedBoundingBox
        _horizonOcclusionPoint: Cesium.Cartesian3
        _credits: Cesium.Credit[]
      }

      const vertexCount = mesh._quantizedVertices.length / 3
      const uBuffer = new Uint16Array(vertexCount)
      const vBuffer = new Uint16Array(vertexCount)
      const heightBuffer = new Uint16Array(vertexCount)

      // Extract u, v, height from interleaved buffer
      for (let i = 0; i < vertexCount; i++) {
        uBuffer[i] = mesh._quantizedVertices[i]
        vBuffer[i] = mesh._quantizedVertices[vertexCount + i]
        heightBuffer[i] = mesh._quantizedVertices[vertexCount * 2 + i]
      }

      // Modify heights
      const { newMinHeight, newMaxHeight, modified, modifiedCount } = modifyTerrain(
        uBuffer,
        vBuffer,
        heightBuffer,
        tileRect,
        mesh._minimumHeight,
        mesh._maximumHeight,
        floors
      )

      if (!modified) {
        // Cache even unmodified tiles to avoid re-checking
        processedTileCache.set(tileKey, terrainData)
        return terrainData
      }

      // Only log each tile once to avoid spam
      if (!loggedTiles.has(tileKey)) {
        loggedTiles.add(tileKey)
        const pct = ((modifiedCount / vertexCount) * 100).toFixed(0)
        console.log(`[FlatteningTerrainProvider] Modified tile ${tileKey}: ${modifiedCount}/${vertexCount} (${pct}%) flattened, height ${mesh._minimumHeight.toFixed(1)}-${mesh._maximumHeight.toFixed(1)} -> ${newMinHeight.toFixed(1)}-${newMaxHeight.toFixed(1)}`)
      }

      // Reconstruct quantized vertices
      const newQuantizedVertices = new Uint16Array(vertexCount * 3)
      for (let i = 0; i < vertexCount; i++) {
        newQuantizedVertices[i] = uBuffer[i]
        newQuantizedVertices[vertexCount + i] = vBuffer[i]
        newQuantizedVertices[vertexCount * 2 + i] = heightBuffer[i]
      }

      // Create new QuantizedMeshTerrainData with modified heights
      // Convert Uint16Array to number[] for Cesium's constructor
      const modifiedTerrainData = new Cesium.QuantizedMeshTerrainData({
        minimumHeight: newMinHeight,
        maximumHeight: newMaxHeight,
        quantizedVertices: newQuantizedVertices,
        indices: mesh._indices,
        boundingSphere: mesh._boundingSphere,
        orientedBoundingBox: mesh._orientedBoundingBox,
        horizonOcclusionPoint: mesh._horizonOcclusionPoint,
        westIndices: Array.from(mesh._westIndices),
        southIndices: Array.from(mesh._southIndices),
        eastIndices: Array.from(mesh._eastIndices),
        northIndices: Array.from(mesh._northIndices),
        westSkirtHeight: mesh._westSkirtHeight,
        southSkirtHeight: mesh._southSkirtHeight,
        eastSkirtHeight: mesh._eastSkirtHeight,
        northSkirtHeight: mesh._northSkirtHeight,
        childTileMask: terrainData.wasCreatedByUpsampling() ? 0 : 15,
        credits: mesh._credits
      })

      // Cache the processed tile
      processedTileCache.set(tileKey, modifiedTerrainData)

      return modifiedTerrainData
    })
  }

  // Add our custom methods
  const enhanced = baseProvider as Cesium.CesiumTerrainProvider & {
    setFlatteningPolygons: (polygons: FlatteningPolygon[]) => void
    clearFlatteningPolygons: () => void
  }

  enhanced.setFlatteningPolygons = setFlatteningPolygons
  enhanced.clearFlatteningPolygons = clearFlatteningPolygons

  return enhanced
}

// Singleton for the flattening provider instance
let flatteningProviderInstance: ReturnType<typeof createFlatteningTerrainProvider> | null = null

/**
 * Get or create the flattening terrain provider
 */
export function getFlatteningTerrainProvider(
  baseProvider: Cesium.CesiumTerrainProvider
): ReturnType<typeof createFlatteningTerrainProvider> {
  if (!flatteningProviderInstance) {
    flatteningProviderInstance = createFlatteningTerrainProvider(baseProvider)
  }
  return flatteningProviderInstance
}

/**
 * Clear the singleton instance (for cleanup)
 */
export function clearFlatteningTerrainProvider(): void {
  if (flatteningProviderInstance) {
    flatteningProviderInstance.clearFlatteningPolygons()
    flatteningProviderInstance = null
  }
}
