/**
 * Airport Polygon Service
 *
 * Generates flattening polygons for airport surfaces (runways, taxiways, aprons).
 * These polygons are used by the FlatteningTerrainProvider to create
 * smooth, flat surfaces.
 *
 * Data sources:
 * - Runways: OurAirports CSV (via RunwayService)
 * - Taxiways/Aprons: X-Plane apt.dat (via AirportSurfacesService)
 */

import * as turf from '@turf/turf'
import type { Runway } from '../types/airport'
import type { FlatteningPolygon, AirportFlatteningConfig } from '../types/terrain'
import { airportSurfacesService } from './AirportSurfacesService'

/** Default blend distance in meters for edge transitions */
const DEFAULT_BLEND_DISTANCE = 50

/** Extension beyond runway thresholds in meters (for overrun areas) */
const RUNWAY_EXTENSION_METERS = 50

/** Number of intermediate points along each runway edge for accurate polygon */
const RUNWAY_EDGE_SEGMENTS = 10

/** Extra width buffer in meters to ensure centerline is fully contained and mesh edges don't cause dips */
const WIDTH_BUFFER_METERS = 75

/** Maximum elevation spread (in meters) to consider an airport "flat" */
const FLAT_AIRPORT_TOLERANCE_METERS = 10

/** Buffer distance (meters) to expand airport fill polygon beyond known surfaces */
const AIRPORT_FILL_BUFFER_METERS = 100

/**
 * Convert feet to meters
 */
function feetToMeters(feet: number): number {
  return feet * 0.3048
}

/**
 * Calculate the field elevation from runway threshold data
 *
 * If all runway thresholds are within a tolerance of each other, the airport
 * is considered to be on flat/levelled land, and we use the average elevation.
 * This is more accurate than the apt.dat reference elevation which can be wrong.
 *
 * @param runways - Array of runway data
 * @returns Field elevation in meters, or undefined if runways have large elevation differences
 */
function calculateFieldElevation(runways: Runway[]): { elevation: number; isFlat: boolean } | null {
  if (runways.length === 0) return null

  // Collect all threshold elevations
  const elevations: number[] = []
  for (const runway of runways) {
    if (runway.lowEnd.elevationFt !== 0) {
      elevations.push(feetToMeters(runway.lowEnd.elevationFt))
    }
    if (runway.highEnd.elevationFt !== 0) {
      elevations.push(feetToMeters(runway.highEnd.elevationFt))
    }
  }

  if (elevations.length === 0) return null

  const minElev = Math.min(...elevations)
  const maxElev = Math.max(...elevations)
  const avgElev = elevations.reduce((a, b) => a + b, 0) / elevations.length
  const spread = maxElev - minElev

  // If all elevations are within tolerance, consider it a flat airport
  const isFlat = spread <= FLAT_AIRPORT_TOLERANCE_METERS

  return { elevation: avgElev, isFlat }
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

  // Validate elevations to prevent NaN propagation in terrain flattening
  if (!Number.isFinite(elevationMeters) || !Number.isFinite(lowElevationMeters) || !Number.isFinite(highElevationMeters)) {
    console.error(`[AirportPolygonService] INVALID ELEVATION in runway ${runway.ident}:`, {
      elevationMeters,
      lowElevationMeters,
      highElevationMeters,
      lowEnd: lowEnd.elevationFt,
      highEnd: highEnd.elevationFt
    })
    return null
  }

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
 * Create an airport fill polygon from the convex hull of all existing surfaces
 *
 * This fills gaps between pavement polygons that exist in reality but aren't
 * modeled in the apt.dat data. The fill polygon is created from:
 * - All runway endpoint coordinates
 * - All pavement polygon vertices
 *
 * The convex hull is then buffered slightly to ensure complete coverage.
 *
 * @param runways - Array of runway data
 * @param pavementPolygons - Array of pavement polygons from apt.dat
 * @param elevation - Field elevation in meters
 * @param blendDistance - Edge blend distance in meters
 * @returns Fill polygon or null if not enough points
 */
function createAirportFillPolygon(
  runways: Runway[],
  pavementPolygons: FlatteningPolygon[],
  elevation: number,
  blendDistance: number
): FlatteningPolygon | null {
  // Collect all points from runways and pavements
  const allPoints: [number, number][] = []

  // Add runway endpoints
  for (const runway of runways) {
    if (runway.lowEnd.lat !== 0 || runway.lowEnd.lon !== 0) {
      allPoints.push([runway.lowEnd.lon, runway.lowEnd.lat])
    }
    if (runway.highEnd.lat !== 0 || runway.highEnd.lon !== 0) {
      allPoints.push([runway.highEnd.lon, runway.highEnd.lat])
    }
  }

  // Add all pavement polygon vertices
  for (const pav of pavementPolygons) {
    for (const vertex of pav.vertices) {
      allPoints.push(vertex)
    }
  }

  if (allPoints.length < 3) {
    return null
  }

  // Create convex hull
  const pointsFeature = turf.featureCollection(
    allPoints.map(p => turf.point(p))
  )
  const hull = turf.convex(pointsFeature)

  if (!hull) {
    return null
  }

  // Buffer the hull slightly to ensure coverage
  const buffered = turf.buffer(hull, AIRPORT_FILL_BUFFER_METERS / 1000, { units: 'kilometers' })
  if (!buffered) {
    return null
  }

  // Extract vertices from buffered polygon
  const coords = buffered.geometry.coordinates[0] as [number, number][]

  return {
    id: 'airport-fill',
    vertices: coords,
    elevation,
    blendDistance,
    source: 'fill'
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
 * Generates flattening polygons for airport surfaces (runways, taxiways, aprons).
 */
class AirportPolygonService {
  /**
   * Generate flattening polygons for all surfaces at an airport
   *
   * This includes:
   * - Runways (from OurAirports via RunwayService)
   * - Taxiways and aprons (from X-Plane apt.dat via AirportSurfacesService)
   *
   * @param icao - Airport ICAO code
   * @param runways - Array of runway data from RunwayService
   * @param blendDistance - Edge blend distance in meters (default: 50)
   * @param includePavements - Whether to include taxiway/apron polygons (default: true)
   * @returns Airport flattening configuration with all polygons
   */
  generateRunwayPolygons(
    icao: string,
    runways: Runway[],
    blendDistance: number = DEFAULT_BLEND_DISTANCE,
    includePavements: boolean = true
  ): AirportFlatteningConfig {
    const polygons: FlatteningPolygon[] = []

    // Calculate field elevation from runway data
    // If all runways are at similar elevations, we can use this for taxiways/aprons
    const fieldElevationResult = calculateFieldElevation(runways)
    if (fieldElevationResult) {
      const { elevation, isFlat } = fieldElevationResult
      if (isFlat) {
        console.log(`[AirportPolygonService] ${icao}: Flat airport detected, field elevation ${elevation.toFixed(1)}m`)
      } else {
        console.log(`[AirportPolygonService] ${icao}: Variable runway elevations, using average ${elevation.toFixed(1)}m for taxiways`)
      }
    }

    // Add runway polygons
    for (const runway of runways) {
      const polygon = createRunwayPolygon(runway, blendDistance)
      if (polygon) {
        polygons.push(polygon)
      }
    }

    // Add pavement polygons (taxiways, aprons) if available and enabled
    // Use runway-derived field elevation instead of apt.dat reference elevation
    let pavementPolygons: FlatteningPolygon[] = []
    if (includePavements && airportSurfacesService.isLoaded()) {
      pavementPolygons = airportSurfacesService.getPavementPolygons(
        icao,
        ['a', 'c'], // asphalt and concrete
        fieldElevationResult?.elevation // Pass runway-derived elevation
      )
      if (pavementPolygons.length > 0) {
        polygons.push(...pavementPolygons)
      }
    }

    // Create airport fill polygon to cover gaps between pavement polygons
    // This uses the convex hull of all runways and pavements to ensure complete coverage
    // Add it at the BEGINNING so specific polygons (runways, taxiways) take precedence
    if (fieldElevationResult && (runways.length > 0 || pavementPolygons.length > 0)) {
      const fillPolygon = createAirportFillPolygon(
        runways,
        pavementPolygons,
        fieldElevationResult.elevation,
        blendDistance
      )
      if (fillPolygon) {
        // Insert at beginning - lower priority than specific polygons
        polygons.unshift(fillPolygon)
        console.log(`[AirportPolygonService] ${icao}: Added airport fill polygon (convex hull of ${runways.length} runways + ${pavementPolygons.length} pavements)`)
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
