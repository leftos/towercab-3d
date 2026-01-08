/**
 * Airport Polygon Service
 *
 * Generates flattening polygons for runways based on runway data.
 * These polygons are used by the FlatteningTerrainProvider to create
 * smooth, flat runway surfaces.
 */

import * as turf from '@turf/turf'
import type { Runway } from '../types/airport'
import type { FlatteningPolygon, AirportFlatteningConfig } from '../types/terrain'

/** Default blend distance in meters for edge transitions */
const DEFAULT_BLEND_DISTANCE = 50

/** Extension beyond runway thresholds in meters (for overrun areas) */
const RUNWAY_EXTENSION_METERS = 50

/** Number of intermediate points along each runway edge for accurate polygon */
const RUNWAY_EDGE_SEGMENTS = 10

/** Extra width buffer in meters to ensure centerline is fully contained and mesh edges don't cause dips */
const WIDTH_BUFFER_METERS = 75

/**
 * Convert feet to meters
 */
function feetToMeters(feet: number): number {
  return feet * 0.3048
}

/**
 * Calculate the destination point given a start point, bearing, and distance
 *
 * @param lon - Starting longitude in degrees
 * @param lat - Starting latitude in degrees
 * @param bearing - Bearing in degrees (0-360, clockwise from north)
 * @param distanceMeters - Distance in meters
 * @returns [longitude, latitude] of destination point
 */
function destinationPoint(
  lon: number,
  lat: number,
  bearing: number,
  distanceMeters: number
): [number, number] {
  const point = turf.point([lon, lat])
  const destination = turf.destination(point, distanceMeters / 1000, bearing, { units: 'kilometers' })
  return destination.geometry.coordinates as [number, number]
}

/**
 * Interpolate between two angles (in degrees), handling wrap-around
 */
function interpolateHeading(heading1: number, heading2: number, t: number): number {
  // Normalize headings to 0-360
  const h1 = ((heading1 % 360) + 360) % 360
  const h2 = ((heading2 % 360) + 360) % 360

  // Find the shortest angular distance
  let diff = h2 - h1
  if (diff > 180) diff -= 360
  if (diff < -180) diff += 360

  const result = h1 + diff * t
  return ((result % 360) + 360) % 360
}

/**
 * Create a runway polygon from runway data using intermediate edge points
 *
 * Instead of a simple 4-corner rectangle, this generates points along both
 * runway edges to handle runways where headings differ at each end.
 *
 * @param runway - Runway data from RunwayService
 * @param blendDistance - Edge blend distance in meters
 * @returns Flattening polygon for the runway
 */
function createRunwayPolygon(runway: Runway, blendDistance: number): FlatteningPolygon | null {
  const { lowEnd, highEnd, widthFt } = runway

  // Skip runways without valid coordinates
  if (lowEnd.lat === 0 && lowEnd.lon === 0) return null
  if (highEnd.lat === 0 && highEnd.lon === 0) return null

  // Calculate runway width in meters (half on each side) plus buffer
  const halfWidthMeters = feetToMeters(widthFt) / 2 + WIDTH_BUFFER_METERS

  // Use average elevation of both ends
  const averageElevationFt = (lowEnd.elevationFt + highEnd.elevationFt) / 2
  const elevationMeters = feetToMeters(averageElevationFt)

  const lowHeading = lowEnd.headingTrue

  // Calculate extension for each end, accounting for displaced thresholds
  // Displaced threshold means the actual runway pavement extends beyond the threshold
  const lowDisplacedMeters = feetToMeters(lowEnd.displacedThresholdFt || 0)
  const highDisplacedMeters = feetToMeters(highEnd.displacedThresholdFt || 0)

  // Extend the runway beyond thresholds to get the full centerline
  // Add displaced threshold distance since pavement extends that far beyond the threshold
  const lowEndExtended = destinationPoint(
    lowEnd.lon,
    lowEnd.lat,
    (lowHeading + 180) % 360,
    RUNWAY_EXTENSION_METERS + lowDisplacedMeters
  )

  const highEndExtended = destinationPoint(
    highEnd.lon,
    highEnd.lat,
    (highEnd.headingTrue + 180) % 360,
    RUNWAY_EXTENSION_METERS + highDisplacedMeters
  )

  // Generate points along both edges of the runway
  // We'll walk from low end to high end, generating left and right edge points
  const leftEdge: [number, number][] = []
  const rightEdge: [number, number][] = []

  for (let i = 0; i <= RUNWAY_EDGE_SEGMENTS; i++) {
    const t = i / RUNWAY_EDGE_SEGMENTS

    // Interpolate centerline position
    const centerLon = lowEndExtended[0] + t * (highEndExtended[0] - lowEndExtended[0])
    const centerLat = lowEndExtended[1] + t * (highEndExtended[1] - lowEndExtended[1])

    // Interpolate heading (use low heading direction, high heading is ~opposite)
    // At t=0, use lowHeading; at t=1, use highHeading+180 (same direction as low)
    const highHeadingSameDir = (highEnd.headingTrue + 180) % 360
    const currentHeading = interpolateHeading(lowHeading, highHeadingSameDir, t)

    // Calculate perpendicular edge points
    const leftPoint = destinationPoint(
      centerLon,
      centerLat,
      (currentHeading - 90 + 360) % 360,
      halfWidthMeters
    )
    const rightPoint = destinationPoint(
      centerLon,
      centerLat,
      (currentHeading + 90) % 360,
      halfWidthMeters
    )

    leftEdge.push(leftPoint)
    rightEdge.push(rightPoint)
  }

  // Create closed polygon: left edge forward, then right edge backward
  // This creates a proper closed ring going around the runway
  const vertices: [number, number][] = [
    ...leftEdge,
    ...rightEdge.reverse(),
    leftEdge[0] // Close the ring
  ]

  // Calculate individual end elevations for gradient
  const lowElevationMeters = feetToMeters(lowEnd.elevationFt)
  const highElevationMeters = feetToMeters(highEnd.elevationFt)

  return {
    id: `runway-${runway.ident}`,
    vertices,
    elevation: elevationMeters, // Average, used as fallback
    blendDistance,
    source: 'runway',
    // Gradient data for elevation interpolation along runway
    gradientStart: [lowEnd.lon, lowEnd.lat],
    gradientEnd: [highEnd.lon, highEnd.lat],
    startElevation: lowElevationMeters,
    endElevation: highElevationMeters
  }
}

/**
 * Calculate the bounding box for a set of polygons
 */
function calculateBounds(polygons: FlatteningPolygon[]): [number, number, number, number] {
  let west = 180
  let south = 90
  let east = -180
  let north = -90

  for (const polygon of polygons) {
    for (const [lon, lat] of polygon.vertices) {
      if (lon < west) west = lon
      if (lon > east) east = lon
      if (lat < south) south = lat
      if (lat > north) north = lat
    }
  }

  return [west, south, east, north]
}

/**
 * Airport Polygon Service
 *
 * Generates flattening polygons for airport surfaces (currently runways only).
 */
class AirportPolygonService {
  /**
   * Generate flattening polygons for all runways at an airport
   *
   * @param icao - Airport ICAO code
   * @param runways - Array of runway data from RunwayService
   * @param blendDistance - Edge blend distance in meters (default: 50)
   * @returns Airport flattening configuration with all runway polygons
   */
  generateRunwayPolygons(
    icao: string,
    runways: Runway[],
    blendDistance: number = DEFAULT_BLEND_DISTANCE
  ): AirportFlatteningConfig {
    const polygons: FlatteningPolygon[] = []

    for (const runway of runways) {
      const polygon = createRunwayPolygon(runway, blendDistance)
      if (polygon) {
        polygons.push(polygon)
        // Debug: log polygon details
        const lats = polygon.vertices.map(v => v[1])
        const lons = polygon.vertices.map(v => v[0])
        console.log(`[AirportPolygonService] Runway ${runway.ident}: elevation=${polygon.elevation.toFixed(1)}m, lat range ${Math.min(...lats).toFixed(6)} to ${Math.max(...lats).toFixed(6)}, lon range ${Math.min(...lons).toFixed(6)} to ${Math.max(...lons).toFixed(6)}`)
        console.log(`[AirportPolygonService] Runway ${runway.ident} source data: lowEnd=(${runway.lowEnd.lat.toFixed(6)}, ${runway.lowEnd.lon.toFixed(6)}) elev=${runway.lowEnd.elevationFt}ft heading=${runway.lowEnd.headingTrue}° displaced=${runway.lowEnd.displacedThresholdFt}ft, highEnd=(${runway.highEnd.lat.toFixed(6)}, ${runway.highEnd.lon.toFixed(6)}) elev=${runway.highEnd.elevationFt}ft heading=${runway.highEnd.headingTrue}° displaced=${runway.highEnd.displacedThresholdFt}ft`)
      }
    }

    // Calculate overall bounding box
    const bounds = polygons.length > 0
      ? calculateBounds(polygons)
      : [0, 0, 0, 0] as [number, number, number, number]

    return {
      icao: icao.toUpperCase(),
      polygons,
      bounds
    }
  }

  /**
   * Generate a single runway polygon (for testing or single-runway updates)
   *
   * @param runway - Runway data
   * @param blendDistance - Edge blend distance in meters
   * @returns Flattening polygon or null if runway has invalid coordinates
   */
  createRunwayPolygon(
    runway: Runway,
    blendDistance: number = DEFAULT_BLEND_DISTANCE
  ): FlatteningPolygon | null {
    return createRunwayPolygon(runway, blendDistance)
  }
}

// Export singleton instance
export const airportPolygonService = new AirportPolygonService()
export default airportPolygonService
