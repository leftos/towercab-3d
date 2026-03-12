/**
 * Spatial Index Utility
 *
 * Provides R-tree spatial indexing for efficient polygon lookup.
 * Uses rbush library for fast spatial queries.
 */

import RBush from 'rbush'
import type { FlatteningPolygon, PolygonBBox } from '../types/terrain'

/**
 * Create a new spatial index for flattening polygons
 */
export function createSpatialIndex(): RBush<PolygonBBox> {
  return new RBush<PolygonBBox>()
}

/**
 * Calculate the bounding box for a polygon
 */
function getPolygonBBox(polygon: FlatteningPolygon): PolygonBBox {
  let minX = 180
  let minY = 90
  let maxX = -180
  let maxY = -90

  for (const [lon, lat] of polygon.vertices) {
    if (lon < minX) minX = lon
    if (lon > maxX) maxX = lon
    if (lat < minY) minY = lat
    if (lat > maxY) maxY = lat
  }

  // Expand bounds by blend distance (convert meters to rough degrees)
  // At equator, 1 degree ≈ 111km, but we use a conservative estimate
  const blendDegrees = polygon.blendDistance / 111000

  return {
    minX: minX - blendDegrees,
    minY: minY - blendDegrees,
    maxX: maxX + blendDegrees,
    maxY: maxY + blendDegrees,
    polygon,
  }
}

/**
 * Insert polygons into the spatial index
 *
 * @param index - RBush spatial index
 * @param polygons - Array of flattening polygons to insert
 */
export function insertPolygons(index: RBush<PolygonBBox>, polygons: FlatteningPolygon[]): void {
  const items = polygons.map(getPolygonBBox)
  index.load(items)
}

/**
 * Clear all polygons from the spatial index
 *
 * @param index - RBush spatial index to clear
 */
export function clearIndex(index: RBush<PolygonBBox>): void {
  index.clear()
}

/**
 * Search for polygons that might intersect a tile
 *
 * @param index - RBush spatial index
 * @param west - Western longitude bound
 * @param south - Southern latitude bound
 * @param east - Eastern longitude bound
 * @param north - Northern latitude bound
 * @returns Array of polygons whose bounding boxes intersect the search area
 */
export function searchTile(
  index: RBush<PolygonBBox>,
  west: number,
  south: number,
  east: number,
  north: number,
): FlatteningPolygon[] {
  const results = index.search({
    minX: west,
    minY: south,
    maxX: east,
    maxY: north,
  })
  return results.map((r) => r.polygon)
}

/**
 * Search for polygons near a specific point
 *
 * @param index - RBush spatial index
 * @param lon - Longitude in degrees
 * @param lat - Latitude in degrees
 * @param radiusDegrees - Search radius in degrees
 * @returns Array of nearby polygons
 */
export function searchPoint(
  index: RBush<PolygonBBox>,
  lon: number,
  lat: number,
  radiusDegrees: number = 0.01,
): FlatteningPolygon[] {
  return searchTile(index, lon - radiusDegrees, lat - radiusDegrees, lon + radiusDegrees, lat + radiusDegrees)
}
