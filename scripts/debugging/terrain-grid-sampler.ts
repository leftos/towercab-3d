/**
 * Terrain Grid Sampler - Comprehensive terrain flattening analysis tool
 *
 * Samples terrain in a grid pattern across an airport and outputs:
 * - Full source data (runways from OurAirports, pavements from X-Plane apt.dat)
 * - Original vs flattened terrain comparison
 * - Statistics and problem detection
 *
 * Usage:
 *   npx tsx scripts/debugging/terrain-grid-sampler.ts KMIA
 *   npx tsx scripts/debugging/terrain-grid-sampler.ts YMML --grid=100
 *
 * Requires CESIUM_ION_TOKEN in .env file
 */

import * as Cesium from 'cesium'
import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'
import * as turf from '@turf/turf'

import { createFlatteningTerrainProvider } from '../../src/renderer/terrain/FlatteningTerrainProvider'
import { airportPolygonService } from '../../src/renderer/services/AirportPolygonService'
import { airportSurfacesService } from '../../src/renderer/services/AirportSurfacesService'
import type { Runway, RunwayEnd } from '../../src/renderer/types/airport'
import type { FlatteningPolygon } from '../../src/renderer/types/terrain'
import type { AirportSurfacesData } from '../../src/renderer/types/airportSurfaces'

// ============================================================================
// Config & Types
// ============================================================================

interface SamplePoint {
  lon: number
  lat: number
  originalHeight: number | null
  flattenedHeight: number | null
  cacheHeight: number | null
  cacheSlope: number | null
  inPolygon: boolean
  polygonId: string | null
  delta: number | null
}

interface GridConfig {
  icao: string
  gridSize: number
  bounds: {
    west: number
    south: number
    east: number
    north: number
  }
  blendDistance: number
  outputFormat: 'csv' | 'json' | 'ascii' | 'all'
}

// ============================================================================
// Environment Setup
// ============================================================================

function loadEnv() {
  const envPath = path.join(process.cwd(), '.env')
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=')
        const value = valueParts.join('=').replace(/^["']|["']$/g, '')
        if (key && value) process.env[key.trim()] = value.trim()
      }
    }
  }
}

loadEnv()

// ============================================================================
// Data Loading - Node.js compatible versions
// ============================================================================

const RUNWAYS_DB_URL = 'https://davidmegginson.github.io/ourairports-data/runways.csv'

async function loadRunwaysFromOurAirports(icao: string): Promise<Runway[]> {
  console.log(`Loading runway data for ${icao} from OurAirports...`)

  // Try fetching from URL first
  let csvText: string
  try {
    const response = await fetch(RUNWAYS_DB_URL)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    csvText = await response.text()
    console.log(`  Fetched ${(csvText.length / 1024 / 1024).toFixed(1)} MB`)
  } catch (error) {
    // Fall back to bundled file
    const bundledPath = path.join(process.cwd(), 'src-tauri', 'resources', 'runways.csv')
    if (fs.existsSync(bundledPath)) {
      console.log(`  Using bundled runways.csv`)
      csvText = fs.readFileSync(bundledPath, 'utf-8')
    } else {
      throw new Error(`Failed to load runway data: ${error}`)
    }
  }

  // Parse CSV
  const lines = csvText.split('\n')
  const header = parseCSVLine(lines[0])
  const colIndex: Record<string, number> = {}
  header.forEach((col, i) => { colIndex[col] = i })

  const runways: Runway[] = []
  const targetIcao = icao.toUpperCase()

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    const values = parseCSVLine(line)
    if (values.length < header.length) continue

    const airportIdent = (values[colIndex['airport_ident']] || '').toUpperCase()
    if (airportIdent !== targetIcao) continue

    // Skip closed runways
    if (values[colIndex['closed']] === '1') continue

    const runway = parseRunwayFromCSV(values, colIndex)
    if (runway) runways.push(runway)
  }

  console.log(`  Found ${runways.length} runways for ${icao}`)
  return runways
}

function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  result.push(current.trim())
  return result
}

function parseRunwayFromCSV(values: string[], colIndex: Record<string, number>): Runway | null {
  const leIdent = values[colIndex['le_ident']] || ''
  const heIdent = values[colIndex['he_ident']] || ''
  if (!leIdent || !heIdent) return null

  const lowEnd = parseRunwayEnd(
    leIdent,
    values[colIndex['le_latitude_deg']],
    values[colIndex['le_longitude_deg']],
    values[colIndex['le_heading_degT']],
    values[colIndex['le_elevation_ft']],
    values[colIndex['le_displaced_threshold_ft']]
  )

  const highEnd = parseRunwayEnd(
    heIdent,
    values[colIndex['he_latitude_deg']],
    values[colIndex['he_longitude_deg']],
    values[colIndex['he_heading_degT']],
    values[colIndex['he_elevation_ft']],
    values[colIndex['he_displaced_threshold_ft']]
  )

  if (!lowEnd || !highEnd) return null

  // Skip if missing coordinates
  if ((lowEnd.lat === 0 && lowEnd.lon === 0) || (highEnd.lat === 0 && highEnd.lon === 0)) {
    return null
  }

  return {
    ident: `${lowEnd.ident}/${highEnd.ident}`,
    lowEnd,
    highEnd,
    lengthFt: parseFloat(values[colIndex['length_ft']]) || 0,
    widthFt: parseFloat(values[colIndex['width_ft']]) || 0,
    surface: values[colIndex['surface']] || 'UNKNOWN',
    lighted: values[colIndex['lighted']] === '1',
    closed: values[colIndex['closed']] === '1'
  }
}

function parseRunwayEnd(
  ident: string,
  lat: string,
  lon: string,
  heading: string,
  elevation: string,
  displacedThreshold: string
): RunwayEnd | null {
  if (!ident) return null

  const parsedLat = parseFloat(lat) || 0
  const parsedLon = parseFloat(lon) || 0

  let parsedHeading = parseFloat(heading)
  if (isNaN(parsedHeading)) {
    const match = ident.match(/^(\d{1,2})/)
    parsedHeading = match ? parseInt(match[1], 10) * 10 : 0
  }

  return {
    ident,
    lat: parsedLat,
    lon: parsedLon,
    headingTrue: parsedHeading,
    elevationFt: parseFloat(elevation) || 0,
    displacedThresholdFt: parseFloat(displacedThreshold) || 0
  }
}

function loadAirportSurfacesData(): AirportSurfacesData | null {
  const gzPath = path.join(process.cwd(), 'src-tauri', 'resources', 'airport-surfaces.json.gz')
  if (!fs.existsSync(gzPath)) return null
  const compressed = fs.readFileSync(gzPath)
  const decompressed = zlib.gunzipSync(compressed)
  return JSON.parse(decompressed.toString('utf-8')) as AirportSurfacesData
}

// ============================================================================
// Bounds Calculation
// ============================================================================

function calculateBounds(runways: Runway[], polygons: FlatteningPolygon[], padding: number = 500): GridConfig['bounds'] {
  let west = 180, south = 90, east = -180, north = -90

  for (const rwy of runways) {
    west = Math.min(west, rwy.lowEnd.lon, rwy.highEnd.lon)
    east = Math.max(east, rwy.lowEnd.lon, rwy.highEnd.lon)
    south = Math.min(south, rwy.lowEnd.lat, rwy.highEnd.lat)
    north = Math.max(north, rwy.lowEnd.lat, rwy.highEnd.lat)
  }

  for (const poly of polygons) {
    for (const [lon, lat] of poly.vertices) {
      west = Math.min(west, lon)
      east = Math.max(east, lon)
      south = Math.min(south, lat)
      north = Math.max(north, lat)
    }
  }

  const centerLat = (south + north) / 2
  const metersPerDegreeLat = 111320
  const metersPerDegreeLon = 111320 * Math.cos(centerLat * Math.PI / 180)
  const padLat = padding / metersPerDegreeLat
  const padLon = padding / metersPerDegreeLon

  return {
    west: west - padLon,
    south: south - padLat,
    east: east + padLon,
    north: north + padLat
  }
}

// ============================================================================
// Grid Sampling
// ============================================================================

async function sampleGrid(
  config: GridConfig,
  baseProvider: Cesium.CesiumTerrainProvider,
  flatProvider: ReturnType<typeof createFlatteningTerrainProvider>,
  polygons: FlatteningPolygon[]
): Promise<SamplePoint[][]> {
  const { bounds, gridSize } = config
  const results: SamplePoint[][] = []

  const lonStep = (bounds.east - bounds.west) / (gridSize - 1)
  const latStep = (bounds.north - bounds.south) / (gridSize - 1)

  console.log(`Sampling ${gridSize}x${gridSize} grid (${gridSize * gridSize} points)...`)

  const allPositions: Cesium.Cartographic[] = []
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const lat = bounds.south + row * latStep
      const lon = bounds.west + col * lonStep
      allPositions.push(Cesium.Cartographic.fromDegrees(lon, lat))
    }
  }

  console.log('  Sampling original terrain...')
  const originalPositions = allPositions.map(p => Cesium.Cartographic.clone(p))
  await Cesium.sampleTerrainMostDetailed(baseProvider, originalPositions)

  console.log('  Sampling flattened terrain...')
  const flattenedPositions = allPositions.map(p => Cesium.Cartographic.clone(p))
  await Cesium.sampleTerrainMostDetailed(flatProvider, flattenedPositions)

  console.log('  Querying polygon cache...')
  let idx = 0
  for (let row = 0; row < gridSize; row++) {
    const rowResults: SamplePoint[] = []
    for (let col = 0; col < gridSize; col++) {
      const lat = bounds.south + row * latStep
      const lon = bounds.west + col * lonStep

      const originalHeight = originalPositions[idx].height
      const flattenedHeight = flattenedPositions[idx].height
      const cacheResult = flatProvider.getHeightAndSlopeAtPosition(lon, lat, 0)

      let polygonId: string | null = null
      if (cacheResult) {
        for (const poly of polygons) {
          const lons = poly.vertices.map(v => v[0])
          const lats = poly.vertices.map(v => v[1])
          if (lon >= Math.min(...lons) && lon <= Math.max(...lons) &&
              lat >= Math.min(...lats) && lat <= Math.max(...lats)) {
            polygonId = poly.id
            break
          }
        }
      }

      rowResults.push({
        lon,
        lat,
        originalHeight,
        flattenedHeight,
        cacheHeight: cacheResult?.height ?? null,
        cacheSlope: cacheResult?.slopeDegrees ?? null,
        inPolygon: cacheResult !== null,
        polygonId,
        delta: (flattenedHeight !== null && originalHeight !== null)
          ? flattenedHeight - originalHeight
          : null
      })

      idx++
    }
    results.push(rowResults)
  }

  return results
}

// ============================================================================
// Output Formatters
// ============================================================================

function outputCSV(grid: SamplePoint[][]): string {
  const lines: string[] = []
  lines.push('lon,lat,original_m,flattened_m,cache_m,delta_m,in_polygon,polygon_id')

  for (const row of grid) {
    for (const pt of row) {
      lines.push([
        pt.lon.toFixed(6),
        pt.lat.toFixed(6),
        pt.originalHeight?.toFixed(2) ?? '',
        pt.flattenedHeight?.toFixed(2) ?? '',
        pt.cacheHeight?.toFixed(2) ?? '',
        pt.delta?.toFixed(2) ?? '',
        pt.inPolygon ? '1' : '0',
        pt.polygonId ?? ''
      ].join(','))
    }
  }

  return lines.join('\n')
}

interface FullOutputData {
  metadata: {
    icao: string
    timestamp: string
    gridSize: number
    bounds: GridConfig['bounds']
    blendDistance: number
  }
  sourceData: {
    runways: Runway[]
    airportSurfaces: {
      name: string
      elevation_ft: number
      pavement_count: number
      pavements: Array<{
        id: string
        surface_type: string
        vertex_count: number
        vertices: [number, number][]
      }>
    } | null
  }
  generatedPolygons: Array<{
    id: string
    source: string
    elevation_m: number
    blend_distance_m: number
    vertex_count: number
    vertices: [number, number][]
    hasGradient: boolean
    startElevation_m?: number
    endElevation_m?: number
    gradientStart?: [number, number]
    gradientEnd?: [number, number]
  }>
  statistics: {
    totalPoints: number
    insidePolygons: number
    outsidePolygons: number
    deltaMin_m: number
    deltaMax_m: number
    deltaAvg_m: number
    deltaStdDev_m: number
  }
  samplePoints: SamplePoint[]
}

function outputJSON(
  grid: SamplePoint[][],
  config: GridConfig,
  polygons: FlatteningPolygon[],
  runways: Runway[],
  surfacesData: AirportSurfacesData | null
): string {
  const flat = grid.flat()
  const withDeltas = flat.filter(p => p.delta !== null)
  const deltas = withDeltas.map(p => p.delta!)
  const avgDelta = deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0
  const stdDev = deltas.length > 0
    ? Math.sqrt(deltas.map(d => (d - avgDelta) ** 2).reduce((a, b) => a + b, 0) / deltas.length)
    : 0

  const airportData = surfacesData?.airports[config.icao]

  const output: FullOutputData = {
    metadata: {
      icao: config.icao,
      timestamp: new Date().toISOString(),
      gridSize: config.gridSize,
      bounds: config.bounds,
      blendDistance: config.blendDistance
    },
    sourceData: {
      runways: runways,
      airportSurfaces: airportData ? {
        name: airportData.n,
        elevation_ft: airportData.e,
        pavement_count: airportData.p.length,
        pavements: airportData.p.map((p, i) => ({
          id: `${config.icao}-pavement-${i}`,
          surface_type: { a: 'asphalt', c: 'concrete', g: 'grass', d: 'dirt', o: 'other' }[p.s] || p.s,
          vertex_count: p.v.length,
          vertices: p.v as [number, number][]
        }))
      } : null
    },
    generatedPolygons: polygons.map(p => ({
      id: p.id,
      source: p.source,
      elevation_m: p.elevation,
      blend_distance_m: p.blendDistance,
      vertex_count: p.vertices.length,
      vertices: p.vertices,
      hasGradient: p.gradientStart !== undefined,
      startElevation_m: p.startElevation,
      endElevation_m: p.endElevation,
      gradientStart: p.gradientStart,
      gradientEnd: p.gradientEnd
    })),
    statistics: {
      totalPoints: flat.length,
      insidePolygons: flat.filter(p => p.inPolygon).length,
      outsidePolygons: flat.filter(p => !p.inPolygon).length,
      deltaMin_m: deltas.length > 0 ? Math.min(...deltas) : 0,
      deltaMax_m: deltas.length > 0 ? Math.max(...deltas) : 0,
      deltaAvg_m: avgDelta,
      deltaStdDev_m: stdDev
    },
    samplePoints: flat
  }

  return JSON.stringify(output, null, 2)
}

function outputASCII(grid: SamplePoint[][], config: GridConfig): string {
  const lines: string[] = []
  lines.push(`ASCII Elevation Heatmap: ${config.icao}`)
  lines.push(`Grid: ${config.gridSize}x${config.gridSize}`)
  lines.push('')
  lines.push('Legend: . = outside, # = flattened, +/- = raised/lowered, X = large delta (>5m)')
  lines.push('')

  const reversed = [...grid].reverse()
  for (const row of reversed) {
    let line = ''
    for (const pt of row) {
      if (!pt.inPolygon) {
        line += '.'
      } else if (pt.delta === null) {
        line += '?'
      } else if (Math.abs(pt.delta) > 5) {
        line += 'X'
      } else if (pt.delta > 1) {
        line += '+'
      } else if (pt.delta < -1) {
        line += '-'
      } else {
        line += '#'
      }
    }
    lines.push(line)
  }

  return lines.join('\n')
}

// ============================================================================
// Statistics & Analysis
// ============================================================================

function computeStatistics(
  grid: SamplePoint[][],
  runways: Runway[],
  polygons: FlatteningPolygon[],
  surfacesData: AirportSurfacesData | null,
  icao: string
): void {
  const flat = grid.flat()

  console.log('\n' + '='.repeat(80))
  console.log('SOURCE DATA')
  console.log('='.repeat(80))

  console.log('\nRUNWAYS (from OurAirports):')
  for (const rwy of runways) {
    const lowElev = (rwy.lowEnd.elevationFt * 0.3048).toFixed(1)
    const highElev = (rwy.highEnd.elevationFt * 0.3048).toFixed(1)
    const gradient = ((rwy.highEnd.elevationFt - rwy.lowEnd.elevationFt) * 0.3048).toFixed(1)
    console.log(`  ${rwy.ident}: ${rwy.lengthFt}ft x ${rwy.widthFt}ft, surface: ${rwy.surface}`)
    console.log(`    ${rwy.lowEnd.ident}: (${rwy.lowEnd.lon.toFixed(6)}, ${rwy.lowEnd.lat.toFixed(6)}) elev ${lowElev}m`)
    console.log(`    ${rwy.highEnd.ident}: (${rwy.highEnd.lon.toFixed(6)}, ${rwy.highEnd.lat.toFixed(6)}) elev ${highElev}m`)
    console.log(`    Gradient: ${gradient}m over ${(rwy.lengthFt * 0.3048).toFixed(0)}m`)
  }

  const airportData = surfacesData?.airports[icao]
  if (airportData) {
    console.log(`\nAIRPORT SURFACES (from X-Plane apt.dat):`)
    console.log(`  Name: ${airportData.n}`)
    console.log(`  Reference elevation: ${airportData.e} ft (${(airportData.e * 0.3048).toFixed(1)} m)`)
    console.log(`  Pavement polygons: ${airportData.p.length}`)

    const surfaceCounts: Record<string, number> = {}
    for (const p of airportData.p) {
      const name = { a: 'asphalt', c: 'concrete', g: 'grass', d: 'dirt', o: 'other' }[p.s] || p.s
      surfaceCounts[name] = (surfaceCounts[name] || 0) + 1
    }
    console.log(`  By surface type:`)
    for (const [type, count] of Object.entries(surfaceCounts)) {
      console.log(`    ${type}: ${count}`)
    }
  } else {
    console.log(`\nAIRPORT SURFACES: No data for ${icao} in apt.dat database`)
  }

  console.log(`\nGENERATED FLATTENING POLYGONS:`)
  const bySource: Record<string, FlatteningPolygon[]> = {}
  for (const p of polygons) {
    bySource[p.source] = bySource[p.source] || []
    bySource[p.source].push(p)
  }
  for (const [source, polys] of Object.entries(bySource)) {
    console.log(`  ${source}: ${polys.length} polygons`)
    if (source === 'runway') {
      for (const p of polys) {
        const hasGrad = p.gradientStart !== undefined
        console.log(`    ${p.id}: elev ${p.elevation.toFixed(1)}m, blend ${p.blendDistance}m${hasGrad ? `, gradient ${p.startElevation?.toFixed(1)}->${p.endElevation?.toFixed(1)}m` : ''}`)
      }
    }
  }

  console.log('\n' + '='.repeat(80))
  console.log('TERRAIN SAMPLING RESULTS')
  console.log('='.repeat(80))

  const insidePoints = flat.filter(p => p.inPolygon)
  const outsidePoints = flat.filter(p => !p.inPolygon)
  const withDeltas = flat.filter(p => p.delta !== null)

  console.log(`\nCoverage:`)
  console.log(`  Total sampled: ${flat.length} points`)
  console.log(`  Inside polygons: ${insidePoints.length} (${(insidePoints.length / flat.length * 100).toFixed(1)}%)`)
  console.log(`  Outside polygons: ${outsidePoints.length} (${(outsidePoints.length / flat.length * 100).toFixed(1)}%)`)

  if (withDeltas.length > 0) {
    const deltas = withDeltas.map(p => p.delta!)
    const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length
    const minDelta = Math.min(...deltas)
    const maxDelta = Math.max(...deltas)
    const stdDev = Math.sqrt(deltas.map(d => (d - avgDelta) ** 2).reduce((a, b) => a + b, 0) / deltas.length)

    console.log(`\nElevation changes (flattened - original):`)
    console.log(`  Min delta: ${minDelta.toFixed(2)}m`)
    console.log(`  Max delta: ${maxDelta.toFixed(2)}m`)
    console.log(`  Avg delta: ${avgDelta.toFixed(2)}m`)
    console.log(`  Std dev: ${stdDev.toFixed(2)}m`)

    const buckets = { largeNeg: 0, smallNeg: 0, minimal: 0, smallPos: 0, largePos: 0 }
    for (const d of deltas) {
      if (d < -5) buckets.largeNeg++
      else if (d < -1) buckets.smallNeg++
      else if (d <= 1) buckets.minimal++
      else if (d <= 5) buckets.smallPos++
      else buckets.largePos++
    }
    console.log(`\nDelta distribution:`)
    console.log(`  < -5m (large cut): ${buckets.largeNeg} (${(buckets.largeNeg / deltas.length * 100).toFixed(1)}%)`)
    console.log(`  -5 to -1m (small cut): ${buckets.smallNeg} (${(buckets.smallNeg / deltas.length * 100).toFixed(1)}%)`)
    console.log(`  -1 to +1m (minimal): ${buckets.minimal} (${(buckets.minimal / deltas.length * 100).toFixed(1)}%)`)
    console.log(`  +1 to +5m (small fill): ${buckets.smallPos} (${(buckets.smallPos / deltas.length * 100).toFixed(1)}%)`)
    console.log(`  > +5m (large fill): ${buckets.largePos} (${(buckets.largePos / deltas.length * 100).toFixed(1)}%)`)
  }

  // Cache consistency - analyze mismatches and their distance to polygon edges
  // The hypothesis is that mismatches occur near polygon boundaries due to mesh triangle
  // interpolation: triangles spanning the boundary have mixed (modified + unmodified) vertices.
  const mismatches = insidePoints.filter(p =>
    p.cacheHeight !== null &&
    p.flattenedHeight !== null &&
    Math.abs(p.cacheHeight - p.flattenedHeight) > 1.0
  )

  console.log(`\nCache consistency (polygon cache vs terrain sampling):`)
  console.log(`  Note: Mismatches are expected near polygon edges due to mesh triangle interpolation.`)
  console.log(`  When a mesh triangle spans a polygon boundary, Cesium interpolates between`)
  console.log(`  modified and unmodified vertices, producing intermediate heights.`)

  if (mismatches.length === 0) {
    console.log(`\n  All ${insidePoints.length} inside-polygon points match within 1m tolerance`)
  } else {
    // Calculate distance to polygon edge for each mismatch
    // Note: turf.pointToPolygonDistance returns 0 for interior points, so we need to
    // calculate the distance to the nearest edge by checking each edge segment
    const mismatchAnalysis = mismatches.map(m => {
      const point = turf.point([m.lon, m.lat])
      let minDistToEdge = Infinity

      // Find the polygon this point is in and calculate distance to its nearest edge
      for (const poly of polygons) {
        const vertices = poly.vertices.map(v => [v[0], v[1]] as [number, number])
        const closedRing = [...vertices, vertices[0]]
        const polygon = turf.polygon([closedRing])

        if (turf.booleanPointInPolygon(point, polygon)) {
          // Calculate distance to each edge and find minimum
          for (let i = 0; i < closedRing.length - 1; i++) {
            const edge = turf.lineString([closedRing[i], closedRing[i + 1]])
            const nearestPt = turf.nearestPointOnLine(edge, point, { units: 'meters' })
            const dist = nearestPt.properties.dist ?? Infinity
            if (dist < minDistToEdge) {
              minDistToEdge = dist
            }
          }
        }
      }

      return {
        ...m,
        distToEdge: minDistToEdge === Infinity ? null : minDistToEdge,
        heightDiff: Math.abs((m.cacheHeight ?? 0) - (m.flattenedHeight ?? 0))
      }
    })

    // Group by distance to edge
    const nearEdge = mismatchAnalysis.filter(m => m.distToEdge !== null && m.distToEdge < 20)
    const midDistance = mismatchAnalysis.filter(m => m.distToEdge !== null && m.distToEdge >= 20 && m.distToEdge < 50)
    const farFromEdge = mismatchAnalysis.filter(m => m.distToEdge !== null && m.distToEdge >= 50)
    const unknown = mismatchAnalysis.filter(m => m.distToEdge === null)

    console.log(`\n  Found ${mismatches.length} mismatches > 1m:`)
    console.log(`    Near edge (<20m):     ${nearEdge.length} (${(nearEdge.length / mismatches.length * 100).toFixed(0)}%)`)
    console.log(`    Mid-distance (20-50m): ${midDistance.length} (${(midDistance.length / mismatches.length * 100).toFixed(0)}%)`)
    console.log(`    Far from edge (>50m):  ${farFromEdge.length} (${(farFromEdge.length / mismatches.length * 100).toFixed(0)}%)`)
    if (unknown.length > 0) {
      console.log(`    Unknown distance:      ${unknown.length}`)
    }

    if (nearEdge.length > mismatches.length * 0.7) {
      console.log(`\n  DIAGNOSIS: Most mismatches are near polygon edges - this is expected behavior.`)
      console.log(`  The flattening is working correctly; mesh triangle interpolation at boundaries`)
      console.log(`  causes small deviations. Aircraft will use cache values, not sampled terrain.`)
    } else if (farFromEdge.length > 0) {
      console.log(`\n  POTENTIAL ISSUE: ${farFromEdge.length} mismatches are far from edges.`)
      console.log(`  This may indicate tiles not loading at highest resolution or other problems.`)
    }

    console.log(`\n  Sample mismatches (sorted by distance from edge):`)
    const sorted = mismatchAnalysis.sort((a, b) => (b.distToEdge ?? 0) - (a.distToEdge ?? 0))
    for (const m of sorted.slice(0, 10)) {
      const distStr = m.distToEdge !== null ? `${m.distToEdge.toFixed(0)}m` : '?'
      console.log(`    (${m.lon.toFixed(5)}, ${m.lat.toFixed(5)}): cache=${m.cacheHeight?.toFixed(1)}m, terrain=${m.flattenedHeight?.toFixed(1)}m, diff=${m.heightDiff.toFixed(1)}m, dist_to_edge=${distStr}`)
    }
  }

  // Problem detection
  const insideDeltas = insidePoints.filter(p => p.delta !== null).map(p => p.delta!)
  if (insideDeltas.length > 0) {
    const insideAvg = insideDeltas.reduce((a, b) => a + b, 0) / insideDeltas.length
    const outliers = insidePoints.filter(p =>
      p.delta !== null && Math.abs(p.delta - insideAvg) > 3
    )

    console.log(`\nPotential issues:`)
    if (outliers.length > 0) {
      console.log(`  Found ${outliers.length} outlier points (>3m from avg) inside polygons:`)
      for (const o of outliers.slice(0, 10)) {
        console.log(`    (${o.lon.toFixed(5)}, ${o.lat.toFixed(5)}): orig=${o.originalHeight?.toFixed(1)}m, flat=${o.flattenedHeight?.toFixed(1)}m, delta=${o.delta?.toFixed(1)}m`)
      }
    } else {
      console.log(`  No significant outliers detected inside polygons`)
    }
  }

  // Runway profiles
  // NOTE: Runway slopes (gradients from threshold to threshold) are intentional by design.
  // The flattening preserves smooth gradients but removes bumps/dips. A spread across
  // the runway length is expected if the runway has a gradient - what matters is that
  // the elevation changes monotonically (no reversals = no bumps).
  console.log(`\nRUNWAY PROFILES (sampled terrain along centerlines):`)
  console.log(`  Note: Spreads are expected for runways with gradients. Check for monotonicity (no bumps).`)
  for (const rwy of runways) {
    const rwyPts = flat.filter(p => {
      if (!p.inPolygon) return false
      const t = projectPointToLine(
        p.lon, p.lat,
        rwy.lowEnd.lon, rwy.lowEnd.lat,
        rwy.highEnd.lon, rwy.highEnd.lat
      )
      if (t < 0 || t > 1) return false
      const projLon = rwy.lowEnd.lon + t * (rwy.highEnd.lon - rwy.lowEnd.lon)
      const projLat = rwy.lowEnd.lat + t * (rwy.highEnd.lat - rwy.lowEnd.lat)
      const dist = haversineDistance(p.lat, p.lon, projLat, projLon)
      return dist < 100
    })

    if (rwyPts.length < 3) continue

    const sorted = rwyPts.map(p => ({
      ...p,
      t: projectPointToLine(p.lon, p.lat, rwy.lowEnd.lon, rwy.lowEnd.lat, rwy.highEnd.lon, rwy.highEnd.lat)
    })).sort((a, b) => a.t - b.t)

    const elevs = sorted.map(p => p.flattenedHeight ?? 0)
    const minE = Math.min(...elevs)
    const maxE = Math.max(...elevs)

    console.log(`  ${rwy.ident}:`)
    console.log(`    Expected: ${(rwy.lowEnd.elevationFt * 0.3048).toFixed(1)}m at ${rwy.lowEnd.ident} -> ${(rwy.highEnd.elevationFt * 0.3048).toFixed(1)}m at ${rwy.highEnd.ident}`)
    console.log(`    Sampled: ${minE.toFixed(1)}m to ${maxE.toFixed(1)}m (spread: ${(maxE - minE).toFixed(1)}m)`)

    let increasing = 0, decreasing = 0
    for (let i = 1; i < elevs.length; i++) {
      const diff = elevs[i] - elevs[i - 1]
      if (diff > 0.5) increasing++
      else if (diff < -0.5) decreasing++
    }
    const expectedDir = rwy.highEnd.elevationFt > rwy.lowEnd.elevationFt ? 'increasing' : 'decreasing'
    const actualDir = increasing > decreasing ? 'mostly increasing' : decreasing > increasing ? 'mostly decreasing' : 'mostly flat'
    console.log(`    Gradient: ${actualDir} (expected ${expectedDir})`)
  }
}

function projectPointToLine(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return 0
  return ((px - x1) * dx + (py - y1) * dy) / lenSq
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = process.argv.slice(2)
  const icao = args.find(a => !a.startsWith('--'))?.toUpperCase() || 'YMML'
  const gridSize = parseInt(args.find(a => a.startsWith('--grid='))?.split('=')[1] || '50')
  const outputFormat = (args.find(a => a.startsWith('--output='))?.split('=')[1] || 'all') as GridConfig['outputFormat']

  console.log('='.repeat(80))
  console.log(`TERRAIN GRID SAMPLER: ${icao}`)
  console.log(`Grid size: ${gridSize}x${gridSize} (${gridSize * gridSize} points)`)
  console.log('='.repeat(80))
  console.log()

  const token = process.env.CESIUM_ION_TOKEN
  if (!token) {
    console.error('ERROR: CESIUM_ION_TOKEN not set in .env')
    process.exit(1)
  }
  Cesium.Ion.defaultAccessToken = token

  // Load runway data from OurAirports
  const runways = await loadRunwaysFromOurAirports(icao)
  if (runways.length === 0) {
    console.error(`ERROR: No runway data found for ${icao}`)
    process.exit(1)
  }

  // Load airport surfaces
  const surfacesData = loadAirportSurfacesData()
  if (surfacesData) {
    airportSurfacesService.loadFromData(surfacesData)
  }

  // Generate flattening polygons
  const blendDistance = 50
  const config = airportPolygonService.generateRunwayPolygons(icao, runways, blendDistance)
  const polygons = config.polygons
  console.log(`Generated ${polygons.length} flattening polygons`)

  // Calculate bounds
  const bounds = calculateBounds(runways, polygons, 500)
  console.log(`Bounds: ${bounds.west.toFixed(4)} to ${bounds.east.toFixed(4)} lon`)
  console.log(`        ${bounds.south.toFixed(4)} to ${bounds.north.toFixed(4)} lat`)

  // Create terrain providers
  // IMPORTANT: We need TWO separate provider instances because createFlatteningTerrainProvider
  // mutates the provider in place. If we used the same instance, both "original" and "flattened"
  // sampling would return identical results.
  console.log('\nCreating terrain providers...')
  console.log('  Creating original (unmodified) terrain provider...')
  const originalProvider = await Cesium.CesiumTerrainProvider.fromIonAssetId(1)

  console.log('  Creating flattened terrain provider...')
  const baseForFlattening = await Cesium.CesiumTerrainProvider.fromIonAssetId(1)
  const flatProvider = createFlatteningTerrainProvider(baseForFlattening)
  flatProvider.setFlatteningPolygons(polygons)

  // Sample grid
  const gridConfig: GridConfig = { icao, gridSize, bounds, blendDistance, outputFormat }
  const grid = await sampleGrid(gridConfig, originalProvider, flatProvider, polygons)

  // Statistics
  computeStatistics(grid, runways, polygons, surfacesData, icao)

  // Output files
  const outputDir = path.join(process.cwd(), 'temp')
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const baseFilename = `terrain-grid-${icao}-${timestamp}`

  if (outputFormat === 'csv' || outputFormat === 'all') {
    const csvPath = path.join(outputDir, `${baseFilename}.csv`)
    fs.writeFileSync(csvPath, outputCSV(grid))
    console.log(`\nCSV output: ${csvPath}`)
  }

  if (outputFormat === 'json' || outputFormat === 'all') {
    const jsonPath = path.join(outputDir, `${baseFilename}.json`)
    fs.writeFileSync(jsonPath, outputJSON(grid, gridConfig, polygons, runways, surfacesData))
    console.log(`JSON output: ${jsonPath}`)
  }

  if (outputFormat === 'ascii' || outputFormat === 'all') {
    console.log('\n' + outputASCII(grid, gridConfig))
  }

  console.log('\nDone.')
}

main().catch(console.error)
