/**
 * Terrain flattening types
 *
 * Types for the airport terrain flattening system that creates smooth,
 * flat runway surfaces on top of Cesium World Terrain.
 */

/**
 * Polygon representing a flattened surface (runway, taxiway, apron)
 *
 * IMPORTANT: All elevations are in meters above the WGS84 ellipsoid (ellipsoidal height),
 * NOT meters above Mean Sea Level (MSL). This matches Cesium World Terrain's native
 * coordinate system and avoids geoid conversion issues during rendering.
 *
 * Source data (runway elevations, apt.dat, etc.) is in MSL and must be converted
 * to ellipsoidal using GeoidService.mslToEllipsoidal() when creating polygons.
 */
export interface FlatteningPolygon {
  /** Unique identifier for this polygon */
  id: string
  /** Closed ring of vertices as [longitude, latitude][] pairs (exterior boundary) */
  vertices: [number, number][]
  /** Optional holes (interior rings) as arrays of [longitude, latitude][] pairs */
  holes?: [number, number][][]
  /** Target elevation in meters ellipsoidal (WGS84) - used if no gradient */
  elevation: number
  /** Distance in meters for edge blending/gradient */
  blendDistance: number
  /** Source type for this polygon */
  source: 'runway' | 'taxiway' | 'apron' | 'fill' | 'custom'

  // Optional: elevation gradient along runway length
  /** Start point of the runway centerline [lon, lat] */
  gradientStart?: [number, number]
  /** End point of the runway centerline [lon, lat] */
  gradientEnd?: [number, number]
  /** Elevation at the start point in meters ellipsoidal (WGS84) */
  startElevation?: number
  /** Elevation at the end point in meters ellipsoidal (WGS84) */
  endElevation?: number
}

/**
 * Airport flattening configuration
 *
 * Contains all flattening polygons for a single airport
 */
export interface AirportFlatteningConfig {
  /** Airport ICAO code */
  icao: string
  /** All flattening polygons for this airport */
  polygons: FlatteningPolygon[]
  /** Bounding box [west, south, east, north] in degrees */
  bounds: [number, number, number, number]
}

/**
 * R-tree bounding box entry for spatial indexing
 */
export interface PolygonBBox {
  /** Western longitude bound */
  minX: number
  /** Southern latitude bound */
  minY: number
  /** Eastern longitude bound */
  maxX: number
  /** Northern latitude bound */
  maxY: number
  /** Reference to the flattening polygon */
  polygon: FlatteningPolygon
}
