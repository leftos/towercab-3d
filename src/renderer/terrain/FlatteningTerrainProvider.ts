/**
 * Flattening Terrain Provider
 *
 * Wraps a CesiumTerrainProvider to flatten designated areas (runways, taxiways)
 * by intercepting terrain tile requests and modifying quantized mesh vertex heights.
 *
 * Based on approach from: https://github.com/alexgoni/Stans-Map
 */

import * as turf from '@turf/turf'
import * as Cesium from 'cesium'
import type { Feature, Polygon } from 'geojson'
import RBush from 'rbush'
import type { FlatteningPolygon } from '../types/terrain'

// ============================================================================
// Inline Geometry Functions (performance-optimized replacements for turf)
// ============================================================================

/**
 * Ray casting algorithm for point-in-polygon test
 * Works with flat coordinate arrays for maximum performance
 *
 * @param x - Point X coordinate (longitude)
 * @param y - Point Y coordinate (latitude)
 * @param coordsX - Polygon X coordinates (Float64Array)
 * @param coordsY - Polygon Y coordinates (Float64Array)
 * @returns true if point is inside polygon
 */
function pointInPolygonRayCast(x: number, y: number, coordsX: Float64Array, coordsY: Float64Array): boolean {
  const n = coordsX.length
  let inside = false

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = coordsX[i],
      yi = coordsY[i]
    const xj = coordsX[j],
      yj = coordsY[j]

    // Check if ray from point intersects edge
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }

  return inside
}

/**
 * Check if point is inside a polygon with holes
 * Must be inside exterior ring and outside all hole rings
 *
 * @param x - Point X coordinate (longitude)
 * @param y - Point Y coordinate (latitude)
 * @param exteriorX - Exterior ring X coordinates
 * @param exteriorY - Exterior ring Y coordinates
 * @param holesX - Array of hole ring X coordinates (or null if no holes)
 * @param holesY - Array of hole ring Y coordinates (or null if no holes)
 * @returns true if point is inside polygon (and outside all holes)
 */
function pointInPolygonWithHoles(
  x: number,
  y: number,
  exteriorX: Float64Array,
  exteriorY: Float64Array,
  holesX: Float64Array[] | null,
  holesY: Float64Array[] | null,
): boolean {
  // Must be inside exterior ring
  if (!pointInPolygonRayCast(x, y, exteriorX, exteriorY)) {
    return false
  }

  // Must be outside all holes
  if (holesX && holesY) {
    for (let i = 0; i < holesX.length; i++) {
      if (pointInPolygonRayCast(x, y, holesX[i], holesY[i])) {
        return false // Inside a hole, so outside the polygon
      }
    }
  }

  return true
}

/**
 * Squared distance from point to line segment
 * Uses squared distance to avoid expensive sqrt() call
 *
 * @param px - Point X
 * @param py - Point Y
 * @param x1 - Segment start X
 * @param y1 - Segment start Y
 * @param x2 - Segment end X
 * @param y2 - Segment end Y
 * @returns Squared distance to segment
 */
function distanceToSegmentSquared(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSq = dx * dx + dy * dy

  if (lengthSq === 0) {
    // Segment is a point
    const ddx = px - x1
    const ddy = py - y1
    return ddx * ddx + ddy * ddy
  }

  // Project point onto line, clamped to segment
  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq
  t = Math.max(0, Math.min(1, t))

  // Closest point on segment
  const closestX = x1 + t * dx
  const closestY = y1 + t * dy

  const ddx = px - closestX
  const ddy = py - closestY
  return ddx * ddx + ddy * ddy
}

/**
 * Distance from point to polygon edge (exterior ring only for simplicity)
 * Returns distance in the same units as input coordinates (degrees)
 *
 * @param x - Point X coordinate (longitude)
 * @param y - Point Y coordinate (latitude)
 * @param coordsX - Polygon X coordinates
 * @param coordsY - Polygon Y coordinates
 * @param maxDistSq - Maximum distance squared to check (early exit optimization)
 * @returns Distance to nearest edge, or Infinity if > sqrt(maxDistSq)
 */
function distanceToPolygonEdge(
  x: number,
  y: number,
  coordsX: Float64Array,
  coordsY: Float64Array,
  maxDistSq: number,
): number {
  const n = coordsX.length
  let minDistSq = Infinity

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const distSq = distanceToSegmentSquared(x, y, coordsX[j], coordsY[j], coordsX[i], coordsY[i])

    if (distSq < minDistSq) {
      minDistSq = distSq
      // Early exit if we've found a close enough edge
      // (we know we're in blend zone, no need to check other edges)
      if (minDistSq < maxDistSq * 0.01) break
    }
  }

  return Math.sqrt(minDistSq)
}

/**
 * Convert distance in degrees to meters at a given latitude
 * Uses spherical approximation for speed
 */
function degreesToMeters(distDegrees: number, lat: number): number {
  // Average meters per degree at this latitude
  const metersPerDegreeLat = 111320
  const metersPerDegreeLon = 111320 * Math.cos((lat * Math.PI) / 180)
  // Use geometric mean for reasonable approximation
  const avgMetersPerDegree = Math.sqrt(metersPerDegreeLat * metersPerDegreeLon)
  return distDegrees * avgMetersPerDegree
}

/**
 * Convert meters to degrees at a given latitude
 */
function metersToDegrees(distMeters: number, lat: number): number {
  const metersPerDegreeLat = 111320
  const metersPerDegreeLon = 111320 * Math.cos((lat * Math.PI) / 180)
  const avgMetersPerDegree = Math.sqrt(metersPerDegreeLat * metersPerDegreeLon)
  return distMeters / avgMetersPerDegree
}

/**
 * Project a point onto a runway gradient and get the interpolated elevation.
 * Used to compute taxiway vertex elevation based on runway proximity.
 */
function projectToRunwayElevation(
  lon: number,
  lat: number,
  gradientStart: [number, number],
  gradientEnd: [number, number],
  startElevation: number,
  endElevation: number,
): number {
  const [startLon, startLat] = gradientStart
  const [endLon, endLat] = gradientEnd

  // Vector from start to end
  const dx = endLon - startLon
  const dy = endLat - startLat
  const lengthSq = dx * dx + dy * dy

  if (lengthSq === 0) return startElevation

  // Project point onto line
  const px = lon - startLon
  const py = lat - startLat
  const t = (px * dx + py * dy) / lengthSq

  // Clamp t to [0, 1] and interpolate elevation
  const tClamped = Math.max(0, Math.min(1, t))
  return startElevation + tClamped * (endElevation - startElevation)
}

// ============================================================================
// Data Structures
// ============================================================================

/** Terrain modification data for a single flattening zone */
interface FloorData {
  id: string // Unique identifier to link with spatial index
  floorHeight: number
  floorBoundingRect: Cesium.Rectangle
  floorPolygon: Feature<Polygon>
  blendDistance: number // meters for edge blending (0 = hard edge)
  // Optional gradient data for elevation interpolation
  gradientStart?: [number, number] // [lon, lat]
  gradientEnd?: [number, number] // [lon, lat]
  startElevation?: number
  endElevation?: number
  // If true, use IDW from runway thresholds instead of fixed height
  useFieldElevation?: boolean

  // Pre-computed data for fast geometry operations
  exteriorX: Float64Array // Exterior ring X coordinates (longitude)
  exteriorY: Float64Array // Exterior ring Y coordinates (latitude)
  holesX: Float64Array[] | null // Hole rings X coordinates (null if no holes)
  holesY: Float64Array[] | null // Hole rings Y coordinates (null if no holes)

  // Bounding box in degrees (for fast rejection)
  minLon: number
  maxLon: number
  minLat: number
  maxLat: number
  // Expanded bbox including blend distance (in degrees)
  expandedMinLon: number
  expandedMaxLon: number
  expandedMinLat: number
  expandedMaxLat: number
  // Blend distance in degrees (pre-computed at polygon center latitude)
  blendDistanceDeg: number
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

/**
 * Distance (meters) from runway edge where taxiways should ramp to meet runway elevation.
 * Creates smooth slopes at taxiway-runway junctions instead of abrupt elevation changes.
 */
const TAXIWAY_RAMP_DISTANCE_METERS = 200

export function createFlatteningTerrainProvider(
  baseProvider: Cesium.CesiumTerrainProvider,
): Cesium.CesiumTerrainProvider & {
  setFlatteningPolygons: (polygons: FlatteningPolygon[]) => void
  clearFlatteningPolygons: () => void
  getHeightAndSlopeAtPosition: (
    lon: number,
    lat: number,
    headingDegrees: number,
  ) => { height: number; slopeDegrees: number } | null
  setTileCacheSize: (size: number) => void
} {
  // Store modification data by ID for fast lookup
  const floorDataMap = new Map<string, FloorData>()

  // Pre-filtered list of runway floors (with gradient data) for taxiway elevation computation
  // This is needed because taxiways may be on tiles that don't intersect any runway,
  // but we still need runway data to compute their elevation based on the gradient
  let runwayFloors: FloorData[] = []

  // Spatial index for fast polygon lookup (references FloorData by ID)
  const spatialIndex = new RBush<FloorBBox>()

  // Track logged tiles to avoid spam (tile key -> true)
  const loggedTiles = new Set<string>()

  // LRU cache for processed terrain data (tile key -> modified TerrainData)
  const processedTileCache = new Map<string, Cesium.TerrainData>()
  // Track access timestamps for O(1) LRU eviction (tile key -> timestamp)
  const tileCacheTimestamps = new Map<string, number>()
  // Monotonic timestamp counter (faster than Date.now())
  let cacheTimestamp = 0
  // Maximum cache size (matches user's inMemoryTileCacheSize setting)
  let maxTileCacheSize = DEFAULT_TILE_CACHE_SIZE

  /**
   * Update the tile cache size limit
   */
  function setTileCacheSize(size: number): void {
    maxTileCacheSize = Math.max(100, size) // Minimum 100 tiles
    // Evict excess tiles if new limit is smaller
    evictOldestTiles()
  }

  /**
   * Evict oldest tiles to stay within cache size limit
   * Uses timestamp-based LRU eviction
   */
  function evictOldestTiles(): void {
    while (processedTileCache.size > maxTileCacheSize) {
      // Find oldest tile by timestamp
      let oldestKey: string | null = null
      let oldestTime = Infinity

      for (const [key, time] of tileCacheTimestamps) {
        if (time < oldestTime) {
          oldestTime = time
          oldestKey = key
        }
      }

      if (oldestKey) {
        processedTileCache.delete(oldestKey)
        tileCacheTimestamps.delete(oldestKey)
      } else {
        break // Safety: no tiles to evict
      }
    }
  }

  /**
   * Add a tile to the cache with LRU eviction
   * O(1) for cache hit, O(n) only during eviction (amortized)
   */
  function cacheTile(key: string, data: Cesium.TerrainData): void {
    // Update timestamp (newer = higher)
    cacheTimestamp++
    tileCacheTimestamps.set(key, cacheTimestamp)
    processedTileCache.set(key, data)

    // Evict if over limit
    if (processedTileCache.size > maxTileCacheSize) {
      evictOldestTiles()
    }
  }

  /**
   * Get a tile from cache and update LRU timestamp
   * O(1) operation
   */
  function getCachedTile(key: string): Cesium.TerrainData | undefined {
    const data = processedTileCache.get(key)
    if (data) {
      // Update timestamp to mark as recently used (O(1))
      cacheTimestamp++
      tileCacheTimestamps.set(key, cacheTimestamp)
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
    tileCacheTimestamps.clear()
    cacheTimestamp = 0

    if (polygons.length === 0) return

    // Batch items for spatial index bulk load (more efficient than individual inserts)
    const spatialItems: FloorBBox[] = []

    // Convert polygons to floor data
    for (const polygon of polygons) {
      // Validate elevation before processing
      if (!Number.isFinite(polygon.elevation)) {
        console.error(
          `[FlatteningTerrainProvider] INVALID ELEVATION in polygon ${polygon.id}: elevation = ${polygon.elevation}`,
        )
        continue // Skip invalid polygons
      }
      if (polygon.startElevation !== undefined && !Number.isFinite(polygon.startElevation)) {
        console.error(
          `[FlatteningTerrainProvider] INVALID startElevation in polygon ${polygon.id}: ${polygon.startElevation}`,
        )
        continue
      }
      if (polygon.endElevation !== undefined && !Number.isFinite(polygon.endElevation)) {
        console.error(
          `[FlatteningTerrainProvider] INVALID endElevation in polygon ${polygon.id}: ${polygon.endElevation}`,
        )
        continue
      }
      // Calculate bounding rectangle
      let west = 180,
        south = 90,
        east = -180,
        north = -90
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

      // Pre-compute flat coordinate arrays for fast inline geometry operations
      // Extract coordinates from the rewound polygon (correct winding order)
      const exteriorRing = floorPolygon.geometry.coordinates[0]
      const exteriorX = new Float64Array(exteriorRing.length)
      const exteriorY = new Float64Array(exteriorRing.length)
      for (let i = 0; i < exteriorRing.length; i++) {
        exteriorX[i] = exteriorRing[i][0]
        exteriorY[i] = exteriorRing[i][1]
      }

      // Pre-compute hole coordinate arrays if present
      let holesX: Float64Array[] | null = null
      let holesY: Float64Array[] | null = null
      if (floorPolygon.geometry.coordinates.length > 1) {
        holesX = []
        holesY = []
        for (let h = 1; h < floorPolygon.geometry.coordinates.length; h++) {
          const holeRing = floorPolygon.geometry.coordinates[h]
          const holeX = new Float64Array(holeRing.length)
          const holeY = new Float64Array(holeRing.length)
          for (let i = 0; i < holeRing.length; i++) {
            holeX[i] = holeRing[i][0]
            holeY[i] = holeRing[i][1]
          }
          holesX.push(holeX)
          holesY.push(holeY)
        }
      }

      // Pre-compute blend distance in degrees at polygon center latitude
      const centerLat = (south + north) / 2
      const blendDistanceDeg = metersToDegrees(polygon.blendDistance, centerLat)

      // Pre-compute expanded bounding box (bbox + blend distance)
      const expandedMinLon = west - blendDistanceDeg
      const expandedMaxLon = east + blendDistanceDeg
      const expandedMinLat = south - blendDistanceDeg
      const expandedMaxLat = north + blendDistanceDeg

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
        endElevation: polygon.endElevation,
        // Copy field elevation flag (for sloped airport fill polygons)
        useFieldElevation: polygon.useFieldElevation,
        // Pre-computed coordinate arrays
        exteriorX,
        exteriorY,
        holesX,
        holesY,
        // Bounding boxes in degrees
        minLon: west,
        maxLon: east,
        minLat: south,
        maxLat: north,
        expandedMinLon,
        expandedMaxLon,
        expandedMinLat,
        expandedMaxLat,
        blendDistanceDeg,
      })

      // Add to spatial index batch (in degrees for easier lookup)
      spatialItems.push({
        minX: west,
        minY: south,
        maxX: east,
        maxY: north,
        floorId: polygon.id,
        blendDistance: polygon.blendDistance,
      })
    }

    // Bulk load spatial index (more efficient than individual inserts)
    spatialIndex.load(spatialItems)

    // Build list of runway floors (with gradient data) for taxiway elevation computation
    runwayFloors = Array.from(floorDataMap.values()).filter(
      (floor) =>
        floor.gradientStart !== undefined &&
        floor.gradientEnd !== undefined &&
        floor.startElevation !== undefined &&
        floor.endElevation !== undefined,
    )

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
    tileCacheTimestamps.clear()
    cacheTimestamp = 0
    runwayFloors = []
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
    const metersPerDegreeLon = 111320 * Math.cos((centerLat * Math.PI) / 180)

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
      maxY: north + blendDegreesLat,
    })

    if (candidates.length === 0) return []

    // Convert R-tree results directly to FloorData using the stored IDs
    const results: FloorData[] = []
    for (const candidate of candidates) {
      const floor = floorDataMap.get(candidate.floorId)
      if (floor) {
        // Verify intersection with expanded bounds (accounting for blend distance)
        const blendRadiansLat = floor.blendDistance / 6371000
        const blendRadiansLon = blendRadiansLat / Math.cos((centerLat * Math.PI) / 180)
        const expandedRect = new Cesium.Rectangle(
          floor.floorBoundingRect.west - blendRadiansLon,
          floor.floorBoundingRect.south - blendRadiansLat,
          floor.floorBoundingRect.east + blendRadiansLon,
          floor.floorBoundingRect.north + blendRadiansLat,
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
  function getGradientElevation(lon: number, lat: number, floor: FloorData): number {
    // If no gradient data, use flat elevation
    if (
      !floor.gradientStart ||
      !floor.gradientEnd ||
      floor.startElevation === undefined ||
      floor.endElevation === undefined
    ) {
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
   * Compute field elevation using inverse distance weighting from runway thresholds.
   *
   * Creates a continuous elevation field across the airport that smoothly
   * interpolates between runway threshold elevations. This prevents bumps
   * between taxiway polygons that have different pre-computed elevations.
   *
   * @param lon - Longitude in degrees
   * @param lat - Latitude in degrees
   * @param runwayFloors - Array of runway FloorData (with gradient info)
   * @param fallbackHeight - Elevation to use if no thresholds found
   * @returns Weighted average elevation based on distance to thresholds
   */
  function computeFieldElevation(lon: number, lat: number, runwayFloors: FloorData[], fallbackHeight: number): number {
    // Collect all threshold points and elevations
    const thresholds: { lon: number; lat: number; elevation: number }[] = []

    for (const floor of runwayFloors) {
      if (
        floor.gradientStart === undefined ||
        floor.gradientEnd === undefined ||
        floor.startElevation === undefined ||
        floor.endElevation === undefined
      )
        continue

      // Add both runway threshold points
      thresholds.push({
        lon: floor.gradientStart[0],
        lat: floor.gradientStart[1],
        elevation: floor.startElevation,
      })
      thresholds.push({
        lon: floor.gradientEnd[0],
        lat: floor.gradientEnd[1],
        elevation: floor.endElevation,
      })
    }

    if (thresholds.length === 0) return fallbackHeight

    // Inverse distance weighting with power 2 for smooth gradients
    let sumWeight = 0
    let sumWeightedElev = 0

    for (const threshold of thresholds) {
      // Approximate distance in degrees (faster than haversine for relative comparison)
      const dLon = (lon - threshold.lon) * Math.cos((lat * Math.PI) / 180)
      const dLat = lat - threshold.lat
      const distDegSq = dLon * dLon + dLat * dLat

      // Avoid division by zero for points exactly on threshold
      const minDistSq = 1e-12
      const weight = 1 / Math.max(distDegSq, minDistSq)

      sumWeight += weight
      sumWeightedElev += weight * threshold.elevation
    }

    return sumWeightedElev / sumWeight
  }

  /**
   * Compute elevation for a taxiway point based on nearest runway gradient.
   *
   * For airports with sloped runways, taxiways should follow the runway gradient
   * rather than using a fixed elevation. This function:
   * 1. Finds the nearest runway to the given point
   * 2. Projects the point onto that runway's gradient
   * 3. Applies ramp blending near runway edges for smooth transitions
   * 4. Beyond ramp zone, uses continuous field elevation from all thresholds
   *
   * @param lon - Longitude in degrees
   * @param lat - Latitude in degrees
   * @param taxiwayBaseHeight - Fallback elevation if no runway found
   * @param runwayFloors - Array of runway FloorData (with gradient info)
   * @returns Computed elevation and closest runway info
   */
  function computeTaxiwayElevation(
    lon: number,
    lat: number,
    taxiwayBaseHeight: number,
    runwayFloors: FloorData[],
  ): { height: number; closestRunway: FloorData | null; distanceToRunway: number } {
    let closestRunwayHeight: number | null = null
    let closestRunwayDistToEdge = Infinity
    let closestRunway: FloorData | null = null

    for (const floor of runwayFloors) {
      // Only consider floors with complete gradient data
      if (
        floor.gradientStart === undefined ||
        floor.gradientEnd === undefined ||
        floor.startElevation === undefined ||
        floor.endElevation === undefined
      )
        continue

      // Project position onto runway gradient to get elevation
      const projectedHeight = projectToRunwayElevation(
        lon,
        lat,
        floor.gradientStart,
        floor.gradientEnd,
        floor.startElevation,
        floor.endElevation,
      )

      // Use distance to runway edge to pick closest runway
      const distDeg = distanceToPolygonEdge(lon, lat, floor.exteriorX, floor.exteriorY, Infinity)
      const distMeters = degreesToMeters(distDeg, lat)

      if (distMeters < closestRunwayDistToEdge) {
        closestRunwayDistToEdge = distMeters
        closestRunwayHeight = projectedHeight
        closestRunway = floor
      }
    }

    if (closestRunwayHeight === null) {
      // No runways found - use taxiway's pre-computed elevation
      return { height: taxiwayBaseHeight, closestRunway: null, distanceToRunway: Infinity }
    }

    // Compute continuous field elevation for beyond-ramp-zone blending
    // This creates a smooth gradient across the airport based on threshold positions
    const fieldElevation = computeFieldElevation(lon, lat, runwayFloors, taxiwayBaseHeight)

    let height: number
    if (closestRunwayDistToEdge < TAXIWAY_RAMP_DISTANCE_METERS) {
      // Within ramp zone - blend from runway edge toward field elevation
      const t = closestRunwayDistToEdge / TAXIWAY_RAMP_DISTANCE_METERS
      const easedT = t * t * (3 - 2 * t) // Smooth easing
      // At runway edge (t=0): use runway elevation
      // At ramp end (t=1): use field elevation
      height = closestRunwayHeight + easedT * (fieldElevation - closestRunwayHeight)
    } else {
      // Beyond ramp zone - use continuous field elevation based on threshold distances
      // This creates smooth gradients across the airport without polygon boundary jumps
      height = fieldElevation
    }

    return { height, closestRunway, distanceToRunway: closestRunwayDistToEdge }
  }

  /**
   * Modify terrain vertex heights for flattening with edge blending
   *
   * Uses single-pass algorithm with optimized inline geometry functions:
   * 1. Iterate vertices once, collecting modification data and computing new min/max
   * 2. Apply modifications in second pass only if needed
   *
   * Performance optimizations:
   * - Bounding box pre-filtering to skip polygons far from vertex
   * - Inline ray-casting instead of turf.booleanPointInPolygon
   * - Inline distance calculation instead of turf.pointToPolygonDistance
   * - No GeoJSON object allocation per vertex
   */
  function modifyTerrain(
    uBuffer: Uint16Array,
    vBuffer: Uint16Array,
    heightBuffer: Uint16Array,
    tileRect: Cesium.Rectangle,
    minHeight: number,
    maxHeight: number,
    floors: FloorData[],
  ): { newMinHeight: number; newMaxHeight: number; modified: boolean; modifiedCount: number } {
    const tileWidth = tileRect.east - tileRect.west
    const tileHeight = tileRect.north - tileRect.south

    // Pre-compute tile bounds in degrees for coordinate conversion
    const tileWestDeg = Cesium.Math.toDegrees(tileRect.west)
    const tileSouthDeg = Cesium.Math.toDegrees(tileRect.south)
    const tileWidthDeg = Cesium.Math.toDegrees(tileWidth)
    const tileHeightDeg = Cesium.Math.toDegrees(tileHeight)

    // Collect modification data in single pass
    // Map: vertex index -> target height
    const modifications = new Map<number, number>()
    let newMinHeight = minHeight
    let newMaxHeight = maxHeight

    // Reusable arrays to reduce per-vertex allocations
    const insideFloors: { floor: FloorData; height: number }[] = []
    const blendFloors: { floor: FloorData; height: number; factor: number }[] = []

    for (let i = 0; i < uBuffer.length; i++) {
      const u = uBuffer[i] / 32767
      const v = vBuffer[i] / 32767

      // Compute vertex position in degrees (no GeoJSON allocation)
      const lon = tileWestDeg + u * tileWidthDeg
      const lat = tileSouthDeg + v * tileHeightDeg

      // Get original height for potential blending
      const originalHeight = getActualHeight(heightBuffer[i], minHeight, maxHeight)

      // Clear reusable arrays
      insideFloors.length = 0
      blendFloors.length = 0

      // Check all floors for this vertex
      for (const floor of floors) {
        // OPTIMIZATION: Quick bbox rejection before expensive polygon tests
        // Check against expanded bbox (includes blend distance)
        if (
          lon < floor.expandedMinLon ||
          lon > floor.expandedMaxLon ||
          lat < floor.expandedMinLat ||
          lat > floor.expandedMaxLat
        ) {
          continue // Vertex is outside this floor's area of influence
        }

        // Use inline ray-casting instead of turf.booleanPointInPolygon
        if (pointInPolygonWithHoles(lon, lat, floor.exteriorX, floor.exteriorY, floor.holesX, floor.holesY)) {
          // Inside this polygon - compute target height
          let targetHeight: number
          if (floor.useFieldElevation && runwayFloors.length > 0) {
            // Fill polygon with dynamic elevation - use IDW from runway thresholds
            targetHeight = computeFieldElevation(lon, lat, runwayFloors, floor.floorHeight)
          } else {
            // Runway (gradient) or regular taxiway/apron (fixed height)
            targetHeight = getGradientElevation(lon, lat, floor)
          }
          insideFloors.push({ floor, height: targetHeight })
        } else if (floor.blendDistance > 0) {
          // Check if within blend distance using inline distance calculation
          // Only check if within core bbox (not in polygon but might be in blend zone)
          if (
            lon >= floor.minLon - floor.blendDistanceDeg &&
            lon <= floor.maxLon + floor.blendDistanceDeg &&
            lat >= floor.minLat - floor.blendDistanceDeg &&
            lat <= floor.maxLat + floor.blendDistanceDeg
          ) {
            // Compute distance to polygon edge in degrees
            const maxDistDegSq = floor.blendDistanceDeg * floor.blendDistanceDeg
            const distDeg = distanceToPolygonEdge(lon, lat, floor.exteriorX, floor.exteriorY, maxDistDegSq)

            // Convert to meters for blend calculation
            const distMeters = degreesToMeters(distDeg, lat)

            if (distMeters <= floor.blendDistance) {
              // Compute target height for blend zone
              let targetHeight: number
              if (floor.useFieldElevation && runwayFloors.length > 0) {
                // Fill polygon with dynamic elevation - use IDW from runway thresholds
                targetHeight = computeFieldElevation(lon, lat, runwayFloors, floor.floorHeight)
              } else {
                // Runway (gradient) or regular taxiway/apron (fixed height)
                targetHeight = getGradientElevation(lon, lat, floor)
              }
              const blendFactor = 1.0 - distMeters / floor.blendDistance
              const easedFactor = blendFactor * blendFactor * (3 - 2 * blendFactor)
              blendFloors.push({ floor, height: targetHeight, factor: easedFactor })
            }
          }
        }
      }

      // Determine final height based on matches
      let finalHeight: number | null = null

      if (insideFloors.length > 0) {
        // Inside one or more polygons (intersection case)
        // Prioritize runways (floors with gradient data) over flat pavements
        let hasRunway = false

        for (const f of insideFloors) {
          if (f.floor.gradientStart !== undefined) {
            hasRunway = true
            break
          }
        }

        if (hasRunway) {
          // Inside a runway - use runway's gradient elevation (authoritative)
          let sumHeight = 0
          let count = 0
          for (const f of insideFloors) {
            if (f.floor.gradientStart !== undefined) {
              sumHeight += f.height
              count++
            }
          }
          finalHeight = count > 0 ? sumHeight / count : insideFloors[0].height
        } else {
          // Inside taxiway(s) only - compute elevation from nearest runway's gradient
          // Use runwayFloors (global list) since the tile may not intersect any runway
          const taxiwayBaseHeight = insideFloors[0].height
          const result = computeTaxiwayElevation(lon, lat, taxiwayBaseHeight, runwayFloors)
          finalHeight = result.height
        }
      } else if (blendFloors.length > 0) {
        // In blend zone of one or more polygons
        // Weight by blend factor for smooth edge transitions
        let totalWeight = 0
        let weightedHeight = 0

        // Check if any blend floor is a runway (has gradient data)
        const hasRunwayInBlend = blendFloors.some((bf) => bf.floor.gradientStart !== undefined)

        for (const bf of blendFloors) {
          let heightToUse = bf.height
          // For taxiway blend zones, use IDW field elevation instead of polygon's base height
          // This ensures smooth transitions that respect the airport's terrain gradient
          if (!hasRunwayInBlend && bf.floor.gradientStart === undefined && runwayFloors.length > 0) {
            heightToUse = computeFieldElevation(lon, lat, runwayFloors, bf.height)
          }
          weightedHeight += heightToUse * bf.factor
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
            insideFloors: insideFloors.map((f) => ({ id: f.floor.id, height: f.height })),
            blendFloors: blendFloors.map((f) => ({ id: f.floor.id, height: f.height, factor: f.factor })),
            originalHeight,
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
  baseProvider.requestTileGeometry = (
    x: number,
    y: number,
    level: number,
    request?: Cesium.Request,
  ): Promise<Cesium.TerrainData> | undefined => {
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

    return promise
      .then((terrainData: Cesium.TerrainData) => {
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
        const {
          newMinHeight,
          newMaxHeight,
          modified,
          modifiedCount: _modifiedCount,
        } = modifyTerrain(uBuffer, vBuffer, heightBuffer, tileRect, mesh._minimumHeight, mesh._maximumHeight, floors)

        if (!modified) {
          // Cache even unmodified tiles to avoid re-checking
          cacheTile(tileKey, terrainData)
          return terrainData
        }

        // Debug logging - uncomment to debug terrain flattening issues (also rename _modifiedCount back to modifiedCount above)
        // if (!loggedTiles.has(tileKey)) {
        //   loggedTiles.add(tileKey)
        //   const pct = ((_modifiedCount / vertexCount) * 100).toFixed(0)
        //   console.log(`[FlatteningTerrainProvider] Modified tile ${tileKey}: ${_modifiedCount}/${vertexCount} (${pct}%) flattened, height ${mesh._minimumHeight.toFixed(1)}-${mesh._maximumHeight.toFixed(1)} -> ${newMinHeight.toFixed(1)}-${newMaxHeight.toFixed(1)}`)
        // }

        // Reconstruct quantized vertices
        const newQuantizedVertices = new Uint16Array(vertexCount * 3)
        for (let i = 0; i < vertexCount; i++) {
          newQuantizedVertices[i] = uBuffer[i]
          newQuantizedVertices[vertexCount + i] = vBuffer[i]
          newQuantizedVertices[vertexCount * 2 + i] = heightBuffer[i]
        }

        // Recompute bounding sphere to account for modified heights
        // This is critical for frustum culling - if we use the original bounding sphere
        // (computed from the original lower heights), tiles may be incorrectly culled
        // when their modified geometry is raised above the original bounding volume.
        const newBoundingSphere = Cesium.BoundingSphere.fromRectangle3D(
          tileRect,
          Cesium.Ellipsoid.WGS84,
          newMaxHeight, // Use max height to ensure the sphere encompasses all modified geometry
        )
        // Expand the radius slightly to account for the height range
        const heightRange = newMaxHeight - newMinHeight
        newBoundingSphere.radius += heightRange / 2

        // Create new QuantizedMeshTerrainData with modified heights
        // Convert Uint16Array to number[] for Cesium's constructor
        const modifiedTerrainData = new Cesium.QuantizedMeshTerrainData({
          minimumHeight: newMinHeight,
          maximumHeight: newMaxHeight,
          quantizedVertices: newQuantizedVertices,
          indices: mesh._indices,
          boundingSphere: newBoundingSphere,
          orientedBoundingBox: mesh._orientedBoundingBox, // TODO: may also need recomputation
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
          credits: mesh._credits,
        })

        // Cache the processed tile (with LRU eviction)
        cacheTile(tileKey, modifiedTerrainData)

        return modifiedTerrainData
      })
      .catch((error) => {
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
   * This is much faster than terrain sampling since it uses cached polygon data
   * and inline geometry functions (no turf overhead).
   */
  function getHeightAndSlopeAtPosition(
    lon: number,
    lat: number,
    headingDegrees: number,
  ): { height: number; slopeDegrees: number } | null {
    if (floorDataMap.size === 0) return null

    // Check all floors to find which polygon contains this point
    // Use spatial index for fast lookup
    const searchRadiusDeg = metersToDegrees(100, lat) // 100m buffer

    const candidates = spatialIndex.search({
      minX: lon - searchRadiusDeg,
      minY: lat - searchRadiusDeg,
      maxX: lon + searchRadiusDeg,
      maxY: lat + searchRadiusDeg,
    })

    if (candidates.length === 0) return null

    // Find the floor that contains this point
    // Prioritize runways (with gradient) over flat surfaces
    let matchingFloor: FloorData | null = null
    let isInsidePolygon = false

    for (const candidate of candidates) {
      const floor = floorDataMap.get(candidate.floorId)
      if (!floor) continue

      // Use inline ray-casting instead of turf.booleanPointInPolygon
      if (pointInPolygonWithHoles(lon, lat, floor.exteriorX, floor.exteriorY, floor.holesX, floor.holesY)) {
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
    let height: number
    let closestRunway: FloorData | null = null

    if (matchingFloor.gradientStart !== undefined) {
      // Inside a runway - use runway's gradient elevation (authoritative)
      height = getGradientElevation(lon, lat, matchingFloor)
      closestRunway = matchingFloor
    } else if (matchingFloor.useFieldElevation && runwayFloors.length > 0) {
      // Inside a fill polygon with dynamic elevation - use IDW from runway thresholds
      height = computeFieldElevation(lon, lat, runwayFloors, matchingFloor.floorHeight)
      // Find closest runway for slope calculation
      let minDist = Infinity
      for (const floor of runwayFloors) {
        const distDeg = distanceToPolygonEdge(lon, lat, floor.exteriorX, floor.exteriorY, Infinity)
        const distMeters = degreesToMeters(distDeg, lat)
        if (distMeters < minDist) {
          minDist = distMeters
          closestRunway = floor
        }
      }
    } else {
      // Inside a taxiway - compute elevation from nearest runway's gradient
      // Convert floorDataMap to array for the helper function
      const allFloors = Array.from(floorDataMap.values())
      const result = computeTaxiwayElevation(lon, lat, matchingFloor.floorHeight, allFloors)
      height = result.height
      closestRunway = result.closestRunway
    }

    // Calculate slope in the aircraft's heading direction
    let slopeDegrees = 0

    // Use closest runway for slope calculation (works for both runways and taxiways)
    if (
      closestRunway &&
      closestRunway.gradientStart &&
      closestRunway.gradientEnd &&
      closestRunway.startElevation !== undefined &&
      closestRunway.endElevation !== undefined
    ) {
      // Runway with gradient - calculate slope
      const [startLon, startLat] = closestRunway.gradientStart
      const [endLon, endLat] = closestRunway.gradientEnd

      // Calculate runway heading (direction from start to end threshold)
      const runwayHeadingRad = Math.atan2((endLon - startLon) * Math.cos((lat * Math.PI) / 180), endLat - startLat)
      const runwayHeadingDeg = (Cesium.Math.toDegrees(runwayHeadingRad) + 360) % 360

      // Calculate runway length in meters
      const dLat = ((endLat - startLat) * Math.PI) / 180
      const dLon = ((endLon - startLon) * Math.PI) / 180
      const avgLat = (((startLat + endLat) / 2) * Math.PI) / 180
      const x = dLon * Math.cos(avgLat) * 6371000
      const y = dLat * 6371000
      const runwayLengthM = Math.sqrt(x * x + y * y)

      if (runwayLengthM > 0) {
        // Runway slope magnitude (positive = uphill from start to end)
        const elevationDiff = closestRunway.endElevation - closestRunway.startElevation
        const runwaySlopeRad = Math.atan2(elevationDiff, runwayLengthM)

        // Calculate angle between aircraft heading and runway direction
        // If heading same direction as runway gradient: use runway slope
        // If heading opposite: negate slope
        const headingDiff = ((headingDegrees - runwayHeadingDeg + 180 + 360) % 360) - 180
        const headingAlignment = Math.cos((headingDiff * Math.PI) / 180)

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
    getHeightAndSlopeAtPosition: (
      lon: number,
      lat: number,
      headingDegrees: number,
    ) => { height: number; slopeDegrees: number } | null
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
  baseProvider: Cesium.CesiumTerrainProvider,
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
  headingDegrees: number,
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
