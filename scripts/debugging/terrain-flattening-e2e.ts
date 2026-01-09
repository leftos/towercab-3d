/**
 * End-to-End Terrain Flattening Test
 *
 * Tests the actual FlatteningTerrainProvider from shipping code against
 * real Cesium terrain data. Compares:
 * 1. Original terrain heights (no flattening)
 * 2. Polygon cache query (getHeightAndSlopeAtPosition - fast path)
 * 3. Terrain sampling through flattened provider (sampleTerrainMostDetailed)
 *
 * Usage:
 *   npx tsx scripts/debugging/terrain-flattening-e2e.ts [ICAO]
 *   npx tsx scripts/debugging/terrain-flattening-e2e.ts YMML
 *   npx tsx scripts/debugging/terrain-flattening-e2e.ts KJFK
 *
 * Requires CESIUM_ION_TOKEN in .env file at project root
 */

import * as Cesium from 'cesium'
import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'

// Import actual shipping code
import { createFlatteningTerrainProvider } from '../../src/renderer/terrain/FlatteningTerrainProvider'
import { airportPolygonService } from '../../src/renderer/services/AirportPolygonService'
import { airportSurfacesService } from '../../src/renderer/services/AirportSurfacesService'
import type { Runway } from '../../src/renderer/types/airport'
import type { FlatteningPolygon } from '../../src/renderer/types/terrain'
import type { AirportSurfacesData } from '../../src/renderer/types/airportSurfaces'

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
        if (key && value) {
          process.env[key.trim()] = value.trim()
        }
      }
    }
  }
}

loadEnv()

// ============================================================================
// Airport Data Loading
// ============================================================================

function loadAirportSurfacesData(): AirportSurfacesData | null {
  const gzPath = path.join(process.cwd(), 'src-tauri', 'resources', 'airport-surfaces.json.gz')
  if (!fs.existsSync(gzPath)) {
    console.warn(`Airport surfaces file not found: ${gzPath}`)
    return null
  }
  const compressed = fs.readFileSync(gzPath)
  const decompressed = zlib.gunzipSync(compressed)
  return JSON.parse(decompressed.toString('utf-8')) as AirportSurfacesData
}

// Sample runway data for common airports (would normally come from RunwayService)
const AIRPORT_RUNWAYS: Record<string, Runway[]> = {
  YMML: [
    {
      ident: '09/27',
      lowEnd: { ident: '09', lat: -37.660801, lon: 144.822006, headingTrue: 94, elevationFt: 395, displacedThresholdFt: 0 },
      highEnd: { ident: '27', lat: -37.662300, lon: 144.848007, headingTrue: 274, elevationFt: 407, displacedThresholdFt: 0 },
      lengthFt: 7500, widthFt: 148, surface: 'ASPH', lighted: true, closed: false
    },
    {
      ident: '16/34',
      lowEnd: { ident: '16', lat: -37.653198, lon: 144.835007, headingTrue: 171, elevationFt: 432, displacedThresholdFt: 0 },
      highEnd: { ident: '34', lat: -37.685799, lon: 144.841003, headingTrue: 351, elevationFt: 330, displacedThresholdFt: 0 },
      lengthFt: 11998, widthFt: 148, surface: 'ASPH', lighted: true, closed: false
    }
  ],
  KJFK: [
    {
      ident: '04L/22R',
      lowEnd: { ident: '04L', lat: 40.627806, lon: -73.786111, headingTrue: 43, elevationFt: 12, displacedThresholdFt: 0 },
      highEnd: { ident: '22R', lat: 40.657139, lon: -73.761806, headingTrue: 223, elevationFt: 13, displacedThresholdFt: 0 },
      lengthFt: 11351, widthFt: 200, surface: 'ASPH', lighted: true, closed: false
    },
    {
      ident: '04R/22L',
      lowEnd: { ident: '04R', lat: 40.632222, lon: -73.777500, headingTrue: 43, elevationFt: 12, displacedThresholdFt: 0 },
      highEnd: { ident: '22L', lat: 40.652500, lon: -73.758889, headingTrue: 223, elevationFt: 13, displacedThresholdFt: 0 },
      lengthFt: 8400, widthFt: 200, surface: 'ASPH', lighted: true, closed: false
    },
    {
      ident: '13L/31R',
      lowEnd: { ident: '13L', lat: 40.650917, lon: -73.788028, headingTrue: 133, elevationFt: 13, displacedThresholdFt: 0 },
      highEnd: { ident: '31R', lat: 40.622333, lon: -73.758917, headingTrue: 313, elevationFt: 13, displacedThresholdFt: 0 },
      lengthFt: 10000, widthFt: 200, surface: 'ASPH', lighted: true, closed: false
    },
    {
      ident: '13R/31L',
      lowEnd: { ident: '13R', lat: 40.640806, lon: -73.778528, headingTrue: 133, elevationFt: 13, displacedThresholdFt: 0 },
      highEnd: { ident: '31L', lat: 40.617528, lon: -73.754639, headingTrue: 313, elevationFt: 12, displacedThresholdFt: 0 },
      lengthFt: 14511, widthFt: 200, surface: 'ASPH', lighted: true, closed: false
    }
  ],
  EGLL: [
    {
      ident: '09L/27R',
      lowEnd: { ident: '09L', lat: 51.464722, lon: -0.487778, headingTrue: 92, elevationFt: 79, displacedThresholdFt: 0 },
      highEnd: { ident: '27R', lat: 51.464444, lon: -0.434167, headingTrue: 272, elevationFt: 80, displacedThresholdFt: 0 },
      lengthFt: 12799, widthFt: 164, surface: 'ASPH', lighted: true, closed: false
    },
    {
      ident: '09R/27L',
      lowEnd: { ident: '09R', lat: 51.477778, lon: -0.489444, headingTrue: 92, elevationFt: 79, displacedThresholdFt: 0 },
      highEnd: { ident: '27L', lat: 51.477500, lon: -0.433056, headingTrue: 272, elevationFt: 80, displacedThresholdFt: 0 },
      lengthFt: 12008, widthFt: 164, surface: 'ASPH', lighted: true, closed: false
    }
  ]
}

// ============================================================================
// Test Point Generation
// ============================================================================

interface TestPoint {
  name: string
  lon: number
  lat: number
  heading: number // For slope calculation
  category: 'runway' | 'taxiway' | 'intersection' | 'edge' | 'outside'
}

function generateTestPoints(icao: string, runways: Runway[], polygons: FlatteningPolygon[]): TestPoint[] {
  const points: TestPoint[] = []

  // 1. Runway centerline points (every 5%)
  for (const runway of runways) {
    const heading = runway.lowEnd.headingTrue
    for (let pct = 0; pct <= 100; pct += 5) {
      const t = pct / 100
      const lat = runway.lowEnd.lat + t * (runway.highEnd.lat - runway.lowEnd.lat)
      const lon = runway.lowEnd.lon + t * (runway.highEnd.lon - runway.lowEnd.lon)
      const label = pct === 0 ? `THR ${runway.lowEnd.ident}` :
                   pct === 100 ? `THR ${runway.highEnd.ident}` :
                   `RWY ${runway.ident} ${pct}%`
      points.push({ name: label, lon, lat, heading, category: 'runway' })
    }
  }

  // 2. Sample pavement polygons (center of each)
  const pavementPolygons = polygons.filter(p => p.source === 'taxiway' || p.source === 'apron')
  for (let i = 0; i < Math.min(20, pavementPolygons.length); i++) {
    const p = pavementPolygons[i]
    // Calculate centroid
    const lons = p.vertices.map(v => v[0])
    const lats = p.vertices.map(v => v[1])
    const centerLon = lons.reduce((a, b) => a + b, 0) / lons.length
    const centerLat = lats.reduce((a, b) => a + b, 0) / lats.length
    points.push({
      name: `Pavement ${p.id}`,
      lon: centerLon,
      lat: centerLat,
      heading: 0,
      category: 'taxiway'
    })
  }

  // 3. Potential intersection points (where runways might cross)
  if (runways.length >= 2) {
    // For airports with crossing runways, find approximate intersection
    const r1 = runways[0]
    const r2 = runways[1]
    // Simple average as approximation
    const intLat = (r1.lowEnd.lat + r1.highEnd.lat + r2.lowEnd.lat + r2.highEnd.lat) / 4
    const intLon = (r1.lowEnd.lon + r1.highEnd.lon + r2.lowEnd.lon + r2.highEnd.lon) / 4
    points.push({
      name: 'Runway intersection (approx)',
      lon: intLon,
      lat: intLat,
      heading: r1.lowEnd.headingTrue,
      category: 'intersection'
    })
  }

  // 4. Edge blend zone points (offset from runway edge)
  for (const runway of runways.slice(0, 2)) {
    const midLat = (runway.lowEnd.lat + runway.highEnd.lat) / 2
    const midLon = (runway.lowEnd.lon + runway.highEnd.lon) / 2
    // Offset perpendicular to runway (rough approximation)
    const headingRad = runway.lowEnd.headingTrue * Math.PI / 180
    const perpLat = Math.cos(headingRad) / 111320 * 100 // ~100m offset
    const perpLon = -Math.sin(headingRad) / (111320 * Math.cos(midLat * Math.PI / 180)) * 100
    points.push({
      name: `RWY ${runway.ident} edge +100m`,
      lon: midLon + perpLon,
      lat: midLat + perpLat,
      heading: runway.lowEnd.headingTrue,
      category: 'edge'
    })
  }

  // 5. Outside points (well away from airport)
  const avgLat = runways.reduce((s, r) => s + (r.lowEnd.lat + r.highEnd.lat) / 2, 0) / runways.length
  const avgLon = runways.reduce((s, r) => s + (r.lowEnd.lon + r.highEnd.lon) / 2, 0) / runways.length
  for (const offset of [0.01, 0.02, 0.05]) { // ~1km, 2km, 5km
    points.push({
      name: `Outside ${Math.round(offset * 111)}km N`,
      lon: avgLon,
      lat: avgLat + offset,
      heading: 0,
      category: 'outside'
    })
  }

  return points
}

// ============================================================================
// Test Result Types
// ============================================================================

interface PointResult {
  point: TestPoint
  originalTerrain: number | null
  polygonCache: { height: number; slopeDegrees: number } | null
  flattenedTerrain: number | null
  expectedBehavior: string
  actual: string
  pass: boolean
}

// ============================================================================
// Main Test Runner
// ============================================================================

async function runE2ETest(icao: string) {
  console.log('='.repeat(80))
  console.log(`END-TO-END TERRAIN FLATTENING TEST: ${icao}`)
  console.log('Using actual FlatteningTerrainProvider from shipping code')
  console.log('='.repeat(80))
  console.log()

  // Check Cesium token
  const token = process.env.CESIUM_ION_TOKEN
  if (!token) {
    console.error('ERROR: CESIUM_ION_TOKEN not set in .env')
    process.exit(1)
  }
  Cesium.Ion.defaultAccessToken = token

  // Check runway data
  const runways = AIRPORT_RUNWAYS[icao]
  if (!runways) {
    console.error(`ERROR: No runway data for ${icao}`)
    console.log('Available airports:', Object.keys(AIRPORT_RUNWAYS).join(', '))
    process.exit(1)
  }

  // Load airport surfaces
  console.log('Loading airport surfaces data...')
  const surfacesData = loadAirportSurfacesData()
  if (surfacesData) {
    airportSurfacesService.loadFromData(surfacesData)
    const airportData = surfacesData.airports[icao]
    if (airportData) {
      console.log(`  ${icao}: ${airportData.n}`)
      console.log(`  Elevation: ${airportData.e} ft`)
      console.log(`  Pavement polygons: ${airportData.p.length}`)
    } else {
      console.log(`  No pavement data for ${icao} in database`)
    }
  }
  console.log()

  // Generate flattening polygons using actual service
  console.log('Generating flattening polygons...')
  const blendDistance = 50
  const config = airportPolygonService.generateRunwayPolygons(icao, runways, blendDistance)
  const polygons = config.polygons

  const runwayPolygons = polygons.filter(p => p.source === 'runway')
  const pavementPolygons = polygons.filter(p => p.source !== 'runway')
  console.log(`  Total: ${polygons.length} polygons`)
  console.log(`  Runways: ${runwayPolygons.length}`)
  console.log(`  Pavements: ${pavementPolygons.length}`)
  console.log()

  // Create terrain providers
  console.log('Creating terrain providers...')
  const baseProvider = await Cesium.CesiumTerrainProvider.fromIonAssetId(1)
  console.log('  Base Cesium World Terrain: ready')

  // Create flattening provider using actual shipping code
  const flatProvider = createFlatteningTerrainProvider(baseProvider)
  flatProvider.setFlatteningPolygons(polygons)
  console.log('  FlatteningTerrainProvider: ready with polygons')
  console.log()

  // Generate test points
  const testPoints = generateTestPoints(icao, runways, polygons)
  console.log(`Generated ${testPoints.length} test points`)
  console.log()

  // Prepare Cartographic positions for terrain sampling
  const positions = testPoints.map(p => Cesium.Cartographic.fromDegrees(p.lon, p.lat))

  // Sample original (unflattened) terrain
  console.log('Sampling original terrain (no flattening)...')
  const originalPositions = positions.map(p => Cesium.Cartographic.clone(p))
  await Cesium.sampleTerrainMostDetailed(baseProvider, originalPositions)
  console.log('  Done')

  // Sample through flattening provider
  console.log('Sampling terrain through FlatteningTerrainProvider...')
  const flattenedPositions = positions.map(p => Cesium.Cartographic.clone(p))
  await Cesium.sampleTerrainMostDetailed(flatProvider, flattenedPositions)
  console.log('  Done')
  console.log()

  // Process results
  const results: PointResult[] = []

  for (let i = 0; i < testPoints.length; i++) {
    const point = testPoints[i]
    const originalHeight = originalPositions[i].height
    const flattenedHeight = flattenedPositions[i].height

    // Query polygon cache directly
    const cacheResult = flatProvider.getHeightAndSlopeAtPosition(point.lon, point.lat, point.heading)

    // Determine expected behavior
    let expectedBehavior: string
    let actual: string
    let pass: boolean

    if (point.category === 'outside') {
      expectedBehavior = 'No change (outside polygons)'
      const delta = Math.abs((flattenedHeight ?? 0) - (originalHeight ?? 0))
      pass = delta < 0.5 // Within 0.5m tolerance
      actual = pass ? 'Unchanged' : `Changed by ${delta.toFixed(1)}m`
    } else if (point.category === 'runway' || point.category === 'taxiway' || point.category === 'intersection') {
      expectedBehavior = 'Flattened to polygon elevation'
      if (cacheResult) {
        const delta = Math.abs((flattenedHeight ?? 0) - cacheResult.height)
        pass = delta < 1.0 // Within 1m of cache value
        actual = pass ? `Flattened (cache: ${cacheResult.height.toFixed(1)}m)` : `Mismatch: terrain=${flattenedHeight?.toFixed(1)}, cache=${cacheResult.height.toFixed(1)}`
      } else {
        pass = false
        actual = 'ERROR: Not in polygon cache but expected to be inside'
      }
    } else { // edge
      expectedBehavior = 'Blended between terrain and polygon'
      // Edge points might or might not be in cache depending on exact position
      pass = true // Can't strictly validate blend zones
      actual = cacheResult ? `In cache: ${cacheResult.height.toFixed(1)}m` : `Terrain: ${flattenedHeight?.toFixed(1)}m`
    }

    results.push({
      point,
      originalTerrain: originalHeight,
      polygonCache: cacheResult,
      flattenedTerrain: flattenedHeight,
      expectedBehavior,
      actual,
      pass
    })
  }

  // Output results by category
  for (const category of ['runway', 'taxiway', 'intersection', 'edge', 'outside'] as const) {
    const categoryResults = results.filter(r => r.point.category === category)
    if (categoryResults.length === 0) continue

    console.log('-'.repeat(80))
    console.log(`${category.toUpperCase()} POINTS (${categoryResults.length})`)
    console.log('-'.repeat(80))
    console.log()
    console.log('Name                              | Original | Flattened | Cache    | Delta   | Status')
    console.log('-'.repeat(100))

    for (const r of categoryResults) {
      const orig = r.originalTerrain !== null ? r.originalTerrain.toFixed(1).padStart(8) : '    N/A '
      const flat = r.flattenedTerrain !== null ? r.flattenedTerrain.toFixed(1).padStart(8) : '    N/A '
      const cache = r.polygonCache ? r.polygonCache.height.toFixed(1).padStart(8) : '    N/A '
      const delta = (r.originalTerrain !== null && r.flattenedTerrain !== null)
        ? (r.flattenedTerrain - r.originalTerrain).toFixed(1).padStart(7)
        : '    N/A'
      const status = r.pass ? 'PASS' : 'FAIL'

      console.log(
        `${r.point.name.slice(0, 33).padEnd(33)} | ${orig}m | ${flat}m | ${cache}m | ${delta}m | ${status}`
      )
    }
    console.log()
  }

  // Summary
  const passed = results.filter(r => r.pass).length
  const failed = results.filter(r => !r.pass).length
  console.log('='.repeat(80))
  console.log(`SUMMARY: ${passed} passed, ${failed} failed out of ${results.length} points`)
  console.log('='.repeat(80))

  // Detailed runway elevation profiles
  console.log()
  console.log('RUNWAY ELEVATION PROFILES')
  console.log('-'.repeat(80))
  for (const runway of runways) {
    const rwPts = results.filter(r => r.point.name.includes(runway.ident) && r.point.category === 'runway')
    if (rwPts.length === 0) continue

    console.log(`\n${runway.ident}:`)
    console.log('  Expected gradient: %.1f ft (%.1f m) at %s to %.1f ft (%.1f m) at %s',
      runway.lowEnd.elevationFt, runway.lowEnd.elevationFt * 0.3048, runway.lowEnd.ident,
      runway.highEnd.elevationFt, runway.highEnd.elevationFt * 0.3048, runway.highEnd.ident)

    // Check for elevation consistency
    const elevations = rwPts.map(r => r.flattenedTerrain ?? 0)
    const minElev = Math.min(...elevations)
    const maxElev = Math.max(...elevations)
    const avgElev = elevations.reduce((a, b) => a + b, 0) / elevations.length

    console.log('  Actual range: %.1f to %.1f m (spread: %.1f m)', minElev, maxElev, maxElev - minElev)
    console.log('  Average: %.1f m', avgElev)

    // Check monotonicity (should increase or decrease consistently)
    let monotonic = true
    let increasing = elevations[1] > elevations[0]
    for (let i = 2; i < elevations.length; i++) {
      const currIncreasing = elevations[i] > elevations[i - 1]
      if (currIncreasing !== increasing && Math.abs(elevations[i] - elevations[i - 1]) > 0.5) {
        monotonic = false
        break
      }
    }
    console.log('  Gradient monotonic: %s', monotonic ? 'YES' : 'NO (has bumps!)')
  }

  console.log()
  console.log('Test complete.')
}

// ============================================================================
// CLI Entry Point
// ============================================================================

const icao = process.argv[2]?.toUpperCase() || 'YMML'
runE2ETest(icao).catch(console.error)
