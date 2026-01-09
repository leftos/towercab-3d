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
import type { FlatteningPolygon } from '../types/terrain'

/** Terrain modification data for a single flattening zone */
interface FloorData {
  id: string // Unique identifier to link with spatial index
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

/** R-tree entry that references FloorData by ID */
interface FloorBBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
  floorId: string
  blendDistance: number // Store blend distance for expanded search
}

/**
 * Create a custom terrain provider that flattens designated areas
 *
 * @param baseProvider - The base CesiumTerrainProvider to wrap
 * @returns Modified terrain provider with flattening capability
 */
/** Default tile cache size (will be overridden by user settings) */
const DEFAULT_TILE_CACHE_SIZE = 500

export function createFlatteningTerrainProvider(
  baseProvider: Cesium.CesiumTerrainProvider
): Cesium.CesiumTerrainProvider & {
  setFlatteningPolygons: (polygons: FlatteningPolygon[]) => void
  clearFlatteningPolygons: () => void
  getHeightAndSlopeAtPosition: (lon: number, lat: number, headingDegrees: number) => { height: number; slopeDegrees: number } | null
  setTileCacheSize: (size: number) => void
} {
  // Store modification data by ID for fast lookup
  const floorDataMap = new Map<string, FloorData>()

  // Spatial index for fast polygon lookup (references FloorData by ID)
  const spatialIndex = new RBush<FloorBBox>()

  // Track logged tiles to avoid spam (tile key -> true)
  const loggedTiles = new Set<string>()

  // LRU cache for processed terrain data (tile key -> modified TerrainData)
  // Uses a Map which maintains insertion order for LRU eviction
  const processedTileCache = new Map<string, Cesium.TerrainData>()
  // Track access order for LRU (most recent at end)
  const tileCacheOrder: string[] = []
  // Maximum cache size (matches user's inMemoryTileCacheSize setting)
  let maxTileCacheSize = DEFAULT_TILE_CACHE_SIZE

  /**
   * Update the tile cache size limit
   */
  function setTileCacheSize(size: number): void {
    maxTileCacheSize = Math.max(100, size) // Minimum 100 tiles
    // Evict excess tiles if new limit is smaller
    while (tileCacheOrder.length > maxTileCacheSize) {
      const oldest = tileCacheOrder.shift()
      if (oldest) {
        processedTileCache.delete(oldest)
      }
    }
  }

  /**
   * Add a tile to the cache with LRU eviction
   */
  function cacheTile(key: string, data: Cesium.TerrainData): void {
    // If already in cache, remove from order tracking (will re-add at end)
    const existingIndex = tileCacheOrder.indexOf(key)
    if (existingIndex !== -1) {
      tileCacheOrder.splice(existingIndex, 1)
    }

    // Add to cache and order
    processedTileCache.set(key, data)
    tileCacheOrder.push(key)

    // Evict oldest entries if over limit
    while (tileCacheOrder.length > maxTileCacheSize) {
      const oldest = tileCacheOrder.shift()
      if (oldest) {
        processedTileCache.delete(oldest)
      }
    }
  }

  /**
   * Get a tile from cache and update LRU order
   */
  function getCachedTile(key: string): Cesium.TerrainData | undefined {
    const data = processedTileCache.get(key)
    if (data) {
      // Move to end of order (most recently used)
      const index = tileCacheOrder.indexOf(key)
      if (index !== -1) {
        tileCacheOrder.splice(index, 1)
        tileCacheOrder.push(key)
      }
    }
    return data
  }

  /**
   * Set the flattening polygons
   */
  function setFlatteningPolygons(polygons: FlatteningPolygon[]): void {
    // Clear existing data
    floorDataMap.clear()
    spatialIndex.clear()
    loggedTiles.clear()
    processedTileCache.clear()
    tileCacheOrder.length = 0

    if (polygons.length === 0) return

    // Batch items for spatial index bulk load (more efficient than individual inserts)
    const spatialItems: FloorBBox[] = []

    // Convert polygons to floor data
    for (const polygon of polygons) {
      // Validate elevation before processing
      if (!Number.isFinite(polygon.elevation)) {
        console.error(`[FlatteningTerrainProvider] INVALID ELEVATION in polygon ${polygon.id}: elevation = ${polygon.elevation}`)
        continue // Skip invalid polygons
      }
      if (polygon.startElevation !== undefined && !Number.isFinite(polygon.startElevation)) {
        console.error(`[FlatteningTerrainProvider] INVALID startElevation in polygon ${polygon.id}: ${polygon.startElevation}`)
        continue
      }
      if (polygon.endElevation !== undefined && !Number.isFinite(polygon.endElevation)) {
        console.error(`[FlatteningTerrainProvider] INVALID endElevation in polygon ${polygon.id}: ${polygon.endElevation}`)
        continue
      }
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
      // Include holes if present (exterior ring + hole rings)
      const rings: [number, number][][] = [polygon.vertices]
      if (polygon.holes && polygon.holes.length > 0) {
        rings.push(...polygon.holes)
      }
      // Ensure correct winding order (counterclockwise for exterior, clockwise for holes)
      const turfPoly = turf.polygon(rings)
      const floorPolygon = turf.rewind(turfPoly, { reverse: false }) as Feature<Polygon>

      // Store floor data by ID
      floorDataMap.set(polygon.id, {
        id: polygon.id,
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

      // Add to spatial index batch (in degrees for easier lookup)
      spatialItems.push({
        minX: west,
        minY: south,
        maxX: east,
        maxY: north,
        floorId: polygon.id,
        blendDistance: polygon.blendDistance
      })
    }

    // Bulk load spatial index (more efficient than individual inserts)
    spatialIndex.load(spatialItems)

    console.log(`[FlatteningTerrainProvider] Set ${polygons.length} flattening polygons`)
  }

  /**
   * Clear all flattening polygons
   */
  function clearFlatteningPolygons(): void {
    floorDataMap.clear()
    spatialIndex.clear()
    loggedTiles.clear()
    processedTileCache.clear()
    tileCacheOrder.length = 0
    console.log('[FlatteningTerrainProvider] Cleared flattening polygons')
  }

  /**
   * Check if a tile rectangle intersects any flattening zones (including blend areas)
   * Returns matching floor data directly from R-tree results
   */
  function tileIntersectsFloors(tileRect: Cesium.Rectangle): FloorData[] {
    if (floorDataMap.size === 0) return []

    // Convert tile rectangle to degrees for spatial index query
    const west = Cesium.Math.toDegrees(tileRect.west)
    const south = Cesium.Math.toDegrees(tileRect.south)
    const east = Cesium.Math.toDegrees(tileRect.east)
    const north = Cesium.Math.toDegrees(tileRect.north)

    // Calculate latitude-dependent blend buffer in degrees
    // At equator: 1° ≈ 111km, at 60°N: 1° longitude ≈ 55km
    // Use the tile center latitude to estimate meters-per-degree
    const centerLat = (south + north) / 2
    const metersPerDegreeLat = 111320 // meters per degree latitude (constant)
    const metersPerDegreeLon = 111320 * Math.cos(centerLat * Math.PI / 180)

    // Find max blend distance from all floors (typically 30-100m)
    // Use 100m as safe default since we don't know which floors might match
    const maxBlendMeters = 100
    const blendDegreesLat = maxBlendMeters / metersPerDegreeLat
    const blendDegreesLon = maxBlendMeters / metersPerDegreeLon

    // Query spatial index with expanded bounds for blend zones
    const candidates = spatialIndex.search({
      minX: west - blendDegreesLon,
      minY: south - blendDegreesLat,
      maxX: east + blendDegreesLon,
      maxY: north + blendDegreesLat
    })

    if (candidates.length === 0) return []

    // Convert R-tree results directly to FloorData using the stored IDs
    const results: FloorData[] = []
    for (const candidate of candidates) {
      const floor = floorDataMap.get(candidate.floorId)
      if (floor) {
        // Verify intersection with expanded bounds (accounting for blend distance)
        const blendRadiansLat = floor.blendDistance / 6371000
        const blendRadiansLon = blendRadiansLat / Math.cos(centerLat * Math.PI / 180)
        const expandedRect = new Cesium.Rectangle(
          floor.floorBoundingRect.west - blendRadiansLon,
          floor.floorBoundingRect.south - blendRadiansLat,
          floor.floorBoundingRect.east + blendRadiansLon,
          floor.floorBoundingRect.north + blendRadiansLat
        )
        if (Cesium.Rectangle.intersection(tileRect, expandedRect) !== undefined) {
          results.push(floor)
        }
      }
    }

    return results
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
        // Catch NaN heights before they corrupt the terrain mesh
        if (!Number.isFinite(finalHeight)) {
          console.error(`[FlatteningTerrainProvider] NaN/Infinite height computed at vertex ${i}:`, {
            finalHeight,
            lon,
            lat,
            insideFloors: insideFloors.map(f => ({ id: f.floor.id, height: f.height })),
            blendFloors: blendFloors.map(f => ({ id: f.floor.id, height: f.height, factor: f.factor })),
            originalHeight
          })
          continue // Skip this vertex to prevent NaN propagation
        }
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

    // Check if we already processed this tile (updates LRU order)
    const cached = getCachedTile(tileKey)
    if (cached) {
      return Promise.resolve(cached)
    }

    // Request the original tile data
    const promise = originalRequestTileGeometry(x, y, level, request)
    if (!promise) {
      // Base provider returned undefined (throttled) - normal during heavy tile loading
      return undefined
    }

    return promise.then((terrainData: Cesium.TerrainData) => {
      // Check if this is QuantizedMeshTerrainData
      if (!(terrainData instanceof Cesium.QuantizedMeshTerrainData)) {
        console.log(`[FlatteningTerrainProvider] Tile ${tileKey} is not QuantizedMeshTerrainData, skipping`)
        cacheTile(tileKey, terrainData)
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
        cacheTile(tileKey, terrainData)
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

      // Cache the processed tile (with LRU eviction)
      cacheTile(tileKey, modifiedTerrainData)

      return modifiedTerrainData
    }).catch((error) => {
      // Log the error - this causes sampleTerrainMostDetailed to return undefined heights!
      console.error(`[FlatteningTerrainProvider] EXCEPTION in tile ${tileKey}:`, error)
      // Re-throw so Cesium handles it normally
      throw error
    })
  }

  /**
   * Query cached height and slope at a position without terrain sampling
   *
   * Returns height and slope if the position is inside a flattening polygon,
   * or null if the position is outside all polygons (requires terrain sampling).
   *
   * This is much faster than terrain sampling since it uses cached polygon data.
   */
  function getHeightAndSlopeAtPosition(
    lon: number,
    lat: number,
    headingDegrees: number
  ): { height: number; slopeDegrees: number } | null {
    if (floorDataMap.size === 0) return null

    const point = turf.point([lon, lat])

    // Check all floors to find which polygon contains this point
    // Use spatial index for fast lookup
    const metersPerDegreeLat = 111320
    const metersPerDegreeLon = 111320 * Math.cos(lat * Math.PI / 180)
    const searchRadiusDegLat = 100 / metersPerDegreeLat // 100m buffer
    const searchRadiusDegLon = 100 / metersPerDegreeLon

    const candidates = spatialIndex.search({
      minX: lon - searchRadiusDegLon,
      minY: lat - searchRadiusDegLat,
      maxX: lon + searchRadiusDegLon,
      maxY: lat + searchRadiusDegLat
    })

    if (candidates.length === 0) return null

    // Find the floor that contains this point
    // Prioritize runways (with gradient) over flat surfaces
    let matchingFloor: FloorData | null = null
    let isInsidePolygon = false

    for (const candidate of candidates) {
      const floor = floorDataMap.get(candidate.floorId)
      if (!floor) continue

      if (turf.booleanPointInPolygon(point, floor.floorPolygon)) {
        isInsidePolygon = true
        // Prefer runways (have gradient data) over flat surfaces
        if (floor.gradientStart !== undefined) {
          matchingFloor = floor
          break // Found a runway, use it
        } else if (!matchingFloor) {
          matchingFloor = floor // First match, could be taxiway/apron
        }
      }
    }

    if (!isInsidePolygon || !matchingFloor) return null

    // Calculate height at this position
    const height = getGradientElevation(lon, lat, matchingFloor)

    // Calculate slope in the aircraft's heading direction
    let slopeDegrees = 0

    if (matchingFloor.gradientStart && matchingFloor.gradientEnd &&
        matchingFloor.startElevation !== undefined && matchingFloor.endElevation !== undefined) {
      // Runway with gradient - calculate slope
      const [startLon, startLat] = matchingFloor.gradientStart
      const [endLon, endLat] = matchingFloor.gradientEnd

      // Calculate runway heading (direction from start to end threshold)
      const runwayHeadingRad = Math.atan2(
        (endLon - startLon) * Math.cos(lat * Math.PI / 180),
        endLat - startLat
      )
      const runwayHeadingDeg = (Cesium.Math.toDegrees(runwayHeadingRad) + 360) % 360

      // Calculate runway length in meters
      const dLat = (endLat - startLat) * Math.PI / 180
      const dLon = (endLon - startLon) * Math.PI / 180
      const avgLat = (startLat + endLat) / 2 * Math.PI / 180
      const x = dLon * Math.cos(avgLat) * 6371000
      const y = dLat * 6371000
      const runwayLengthM = Math.sqrt(x * x + y * y)

      if (runwayLengthM > 0) {
        // Runway slope magnitude (positive = uphill from start to end)
        const elevationDiff = matchingFloor.endElevation - matchingFloor.startElevation
        const runwaySlopeRad = Math.atan2(elevationDiff, runwayLengthM)

        // Calculate angle between aircraft heading and runway direction
        // If heading same direction as runway gradient: use runway slope
        // If heading opposite: negate slope
        const headingDiff = ((headingDegrees - runwayHeadingDeg + 180 + 360) % 360) - 180
        const headingAlignment = Math.cos(headingDiff * Math.PI / 180)

        slopeDegrees = Cesium.Math.toDegrees(runwaySlopeRad) * headingAlignment
      }
    }
    // For flat surfaces (taxiways, aprons), slope remains 0

    return { height, slopeDegrees }
  }

  // Add our custom methods
  const enhanced = baseProvider as Cesium.CesiumTerrainProvider & {
    setFlatteningPolygons: (polygons: FlatteningPolygon[]) => void
    clearFlatteningPolygons: () => void
    getHeightAndSlopeAtPosition: (lon: number, lat: number, headingDegrees: number) => { height: number; slopeDegrees: number } | null
    setTileCacheSize: (size: number) => void
  }

  enhanced.setFlatteningPolygons = setFlatteningPolygons
  enhanced.clearFlatteningPolygons = clearFlatteningPolygons
  enhanced.getHeightAndSlopeAtPosition = getHeightAndSlopeAtPosition
  enhanced.setTileCacheSize = setTileCacheSize

  return enhanced
}

// Singleton for the flattening provider instance
let flatteningProviderInstance: ReturnType<typeof createFlatteningTerrainProvider> | null = null
// Track which base provider was wrapped (to detect provider changes)
let wrappedBaseProvider: Cesium.CesiumTerrainProvider | null = null

/**
 * Get or create the flattening terrain provider
 *
 * If the base provider has changed since the last call, creates a new wrapper.
 */
export function getFlatteningTerrainProvider(
  baseProvider: Cesium.CesiumTerrainProvider
): ReturnType<typeof createFlatteningTerrainProvider> {
  // If base provider changed, recreate the wrapper
  if (flatteningProviderInstance && wrappedBaseProvider !== baseProvider) {
    console.log('[FlatteningTerrainProvider] Base provider changed, recreating wrapper')
    flatteningProviderInstance.clearFlatteningPolygons()
    flatteningProviderInstance = null
    wrappedBaseProvider = null
  }

  if (!flatteningProviderInstance) {
    flatteningProviderInstance = createFlatteningTerrainProvider(baseProvider)
    wrappedBaseProvider = baseProvider
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
    wrappedBaseProvider = null
  }
}

/**
 * Query cached height and slope at a position from flattening polygon data
 *
 * This is much faster than terrain sampling since it uses cached polygon data.
 * Returns null if the position is outside all flattening polygons.
 *
 * @param lon - Longitude in degrees
 * @param lat - Latitude in degrees
 * @param headingDegrees - Aircraft heading in degrees (for slope calculation)
 * @returns Height and slope if inside a flattening polygon, null otherwise
 */
export function getHeightAndSlopeFromPolygons(
  lon: number,
  lat: number,
  headingDegrees: number
): { height: number; slopeDegrees: number } | null {
  if (!flatteningProviderInstance) return null
  return flatteningProviderInstance.getHeightAndSlopeAtPosition(lon, lat, headingDegrees)
}

/**
 * Set the tile cache size for the flattening provider
 *
 * Should match the user's inMemoryTileCacheSize setting for consistency
 * with Cesium's globe tile cache.
 *
 * @param size - Maximum number of tiles to cache
 */
export function setFlatteningTileCacheSize(size: number): void {
  if (flatteningProviderInstance) {
    flatteningProviderInstance.setTileCacheSize(size)
  }
}
