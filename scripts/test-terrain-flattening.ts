/**
 * Test script for terrain flattening at YMML (Melbourne Airport)
 *
 * This script uses the actual shipping code to:
 * 1. Load runway data for YMML
 * 2. Load airport surfaces (taxiways, aprons) from X-Plane apt.dat
 * 3. Generate flattening polygons using AirportPolygonService
 * 4. Test point-in-polygon and elevation interpolation
 * 5. Sample real Cesium terrain at various points
 *
 * Run with: npx tsx scripts/test-terrain-flattening.ts
 *
 * Requires CESIUM_ION_TOKEN in .env file at project root
 */

import * as Cesium from 'cesium'
import * as turf from '@turf/turf'
import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'

// Import actual shipping code
import { airportPolygonService } from '../src/renderer/services/AirportPolygonService'
import { airportSurfacesService } from '../src/renderer/services/AirportSurfacesService'
import type { Runway } from '../src/renderer/types/airport'
import type { FlatteningPolygon } from '../src/renderer/types/terrain'
import type { AirportSurfacesData } from '../src/renderer/types/airportSurfaces'

// Load .env file from project root
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
// Airport Surfaces Data Loading (Node.js - loads gzip file directly)
// ============================================================================

function loadAirportSurfacesForNode(): AirportSurfacesData | null {
  const gzPath = path.join(process.cwd(), 'src-tauri', 'resources', 'airport-surfaces.json.gz')
  if (!fs.existsSync(gzPath)) {
    console.warn(`Airport surfaces file not found: ${gzPath}`)
    return null
  }

  const compressed = fs.readFileSync(gzPath)
  const decompressed = zlib.gunzipSync(compressed)
  return JSON.parse(decompressed.toString('utf-8')) as AirportSurfacesData
}

// YMML runway data (from OurAirports - matching actual RunwayService format)
const YMML_RUNWAYS: Runway[] = [
  {
    ident: '09/27',
    lowEnd: {
      ident: '09',
      lat: -37.660801,
      lon: 144.822006,
      headingTrue: 94,
      elevationFt: 395,
      displacedThresholdFt: 0
    },
    highEnd: {
      ident: '27',
      lat: -37.662300,
      lon: 144.848007,
      headingTrue: 274,
      elevationFt: 407,
      displacedThresholdFt: 0
    },
    lengthFt: 7500,
    widthFt: 148,
    surface: 'ASPH',
    lighted: true,
    closed: false
  },
  {
    ident: '16/34',
    lowEnd: {
      ident: '16',
      lat: -37.653198,
      lon: 144.835007,
      headingTrue: 171,
      elevationFt: 432,
      displacedThresholdFt: 0
    },
    highEnd: {
      ident: '34',
      lat: -37.685799,
      lon: 144.841003,
      headingTrue: 351,
      elevationFt: 330,
      displacedThresholdFt: 0
    },
    lengthFt: 11998,
    widthFt: 148,
    surface: 'ASPH',
    lighted: true,
    closed: false
  }
]

// ============================================================================
// Elevation Gradient Calculation (matches FlatteningTerrainProvider logic)
// ============================================================================

function getGradientElevation(
  lon: number,
  lat: number,
  polygon: FlatteningPolygon
): number {
  // If no gradient data, use flat elevation
  if (!polygon.gradientStart || !polygon.gradientEnd ||
      polygon.startElevation === undefined || polygon.endElevation === undefined) {
    return polygon.elevation
  }

  const [startLon, startLat] = polygon.gradientStart
  const [endLon, endLat] = polygon.gradientEnd

  // Vector from start to end
  const dx = endLon - startLon
  const dy = endLat - startLat
  const lengthSq = dx * dx + dy * dy

  if (lengthSq === 0) return polygon.elevation

  // Project point onto the line (start -> end)
  const px = lon - startLon
  const py = lat - startLat
  let t = (px * dx + py * dy) / lengthSq

  // Clamp t to [0, 1] to stay within runway bounds
  t = Math.max(0, Math.min(1, t))

  // Interpolate elevation
  return polygon.startElevation + t * (polygon.endElevation - polygon.startElevation)
}

// ============================================================================
// Point Classification (matches FlatteningTerrainProvider logic)
// ============================================================================

function classifyPoint(
  lon: number,
  lat: number,
  originalHeight: number,
  polygons: FlatteningPolygon[]
): { height: number; reason: string } {
  const point = turf.point([lon, lat])

  // Check all polygons for matches (intersection handling)
  const insidePolygons: { polygon: FlatteningPolygon; height: number }[] = []
  const blendPolygons: { polygon: FlatteningPolygon; height: number; factor: number }[] = []

  for (const polygon of polygons) {
    const turfPolygon = turf.polygon([polygon.vertices])

    if (turf.booleanPointInPolygon(point, turfPolygon)) {
      const targetHeight = getGradientElevation(lon, lat, polygon)
      insidePolygons.push({ polygon, height: targetHeight })
    } else if (polygon.blendDistance > 0) {
      const distance = turf.pointToPolygonDistance(point, turfPolygon, { units: 'meters' })
      if (distance <= polygon.blendDistance) {
        const targetHeight = getGradientElevation(lon, lat, polygon)
        const blendFactor = 1.0 - (distance / polygon.blendDistance)
        const easedFactor = blendFactor * blendFactor * (3 - 2 * blendFactor)
        blendPolygons.push({ polygon, height: targetHeight, factor: easedFactor })
      }
    }
  }

  // Determine final height
  if (insidePolygons.length > 0) {
    // Average heights for intersection handling
    const avgHeight = insidePolygons.reduce((sum, p) => sum + p.height, 0) / insidePolygons.length
    const polygonNames = insidePolygons.map(p => p.polygon.id).join(' + ')
    return {
      height: avgHeight,
      reason: insidePolygons.length > 1
        ? `Intersection: ${polygonNames} (avg)`
        : `Inside ${polygonNames}`
    }
  }

  if (blendPolygons.length > 0) {
    let totalWeight = 0
    let weightedHeight = 0
    for (const bp of blendPolygons) {
      weightedHeight += bp.height * bp.factor
      totalWeight += bp.factor
    }
    const remainingWeight = Math.max(0, 1 - totalWeight)
    const finalHeight = (weightedHeight + originalHeight * remainingWeight) / (totalWeight + remainingWeight)
    return {
      height: finalHeight,
      reason: `Blend zone (${blendPolygons.map(p => p.polygon.id).join(', ')})`
    }
  }

  return { height: originalHeight, reason: 'Outside all polygons' }
}

// ============================================================================
// Main Test
// ============================================================================

async function main() {
  console.log('='.repeat(70))
  console.log('TERRAIN FLATTENING TEST - YMML (Melbourne Airport)')
  console.log('Using actual AirportPolygonService shipping code')
  console.log('Now includes taxiways and aprons from X-Plane apt.dat')
  console.log('='.repeat(70))
  console.log()

  // Check for Cesium token
  const token = process.env.CESIUM_ION_TOKEN
  if (!token) {
    console.error('ERROR: CESIUM_ION_TOKEN environment variable not set')
    console.error('Create a .env file with: CESIUM_ION_TOKEN=your_token_here')
    process.exit(1)
  }

  Cesium.Ion.defaultAccessToken = token

  // Load airport surfaces data using Node.js file reading, then inject into service
  console.log('Loading airport surfaces data...')
  const surfacesData = loadAirportSurfacesForNode()
  if (surfacesData) {
    // Inject into the actual service so AirportPolygonService can use it
    airportSurfacesService.loadFromData(surfacesData)

    // Show YMML-specific stats
    const ymmlSurfaces = surfacesData.airports['YMML']
    if (ymmlSurfaces) {
      console.log(`YMML airport data:`)
      console.log(`  Name: ${ymmlSurfaces.n}`)
      console.log(`  Elevation: ${ymmlSurfaces.e} ft`)
      console.log(`  Pavement polygons: ${ymmlSurfaces.p.length}`)

      // Surface breakdown
      const surfaceCounts: Record<string, number> = {}
      for (const p of ymmlSurfaces.p) {
        surfaceCounts[p.s] = (surfaceCounts[p.s] || 0) + 1
      }
      console.log(`  Surface breakdown:`)
      for (const [s, count] of Object.entries(surfaceCounts)) {
        const name = { a: 'asphalt', c: 'concrete', g: 'grass', d: 'dirt', o: 'other' }[s] || s
        console.log(`    ${name}: ${count} polygons`)
      }
    }
  } else {
    console.log('No airport surfaces data found - will only use runway polygons')
  }
  console.log()

  // Generate all flattening polygons using actual shipping code
  // This now includes both runways AND pavement polygons automatically
  const blendDistance = 50
  const config = airportPolygonService.generateRunwayPolygons('YMML', YMML_RUNWAYS, blendDistance)
  const allPolygons = config.polygons

  // Separate for reporting
  const runwayPolygons = allPolygons.filter(p => p.source === 'runway')
  const pavementPolygons = allPolygons.filter(p => p.source === 'taxiway' || p.source === 'apron')

  console.log(`Generated ${allPolygons.length} Total Flattening Polygons:`)
  console.log(`  Runways: ${runwayPolygons.length}`)
  console.log(`  Pavements (taxiways/aprons): ${pavementPolygons.length}`)
  console.log()

  console.log('Runway Polygons:')
  for (const p of runwayPolygons) {
    const lats = p.vertices.map(v => v[1])
    const lons = p.vertices.map(v => v[0])
    console.log(`  ${p.id}:`)
    console.log(`    Average elevation: ${p.elevation.toFixed(1)}m`)
    if (p.startElevation !== undefined && p.endElevation !== undefined) {
      console.log(`    Gradient: ${p.startElevation.toFixed(1)}m -> ${p.endElevation.toFixed(1)}m`)
    }
    console.log(`    Lat range: ${Math.min(...lats).toFixed(6)} to ${Math.max(...lats).toFixed(6)}`)
    console.log(`    Lon range: ${Math.min(...lons).toFixed(6)} to ${Math.max(...lons).toFixed(6)}`)
    console.log(`    Blend distance: ${p.blendDistance}m`)
  }
  console.log()

  // Test specific problematic points reported by user
  console.log('Testing User-Reported Problem Points:')
  console.log('-'.repeat(70))

  const problemPoints = [
    { name: 'Bump location', lon: 144.836481, lat: -37.660918, reportedHeight: 130.4 },
    { name: 'Runway intersection', lon: 144.836447, lat: -37.661649, reportedHeight: 122.5 },
    { name: 'Sample 1', lon: 144.836029, lat: -37.659505, reportedHeight: 115.8 },
    { name: 'Sample 2', lon: 144.836248, lat: -37.660806, reportedHeight: 122.4 },
    { name: 'Sample 3', lon: 144.836653, lat: -37.662378, reportedHeight: 122.7 },
    { name: 'Sample 4', lon: 144.836845, lat: -37.663293, reportedHeight: 116.1 },
    { name: 'Sample 5', lon: 144.835265, lat: -37.655067, reportedHeight: 115.5 },
    // Bumpy taxiway samples
    { name: 'Taxiway bump 1', lon: 144.840490, lat: -37.660318, reportedHeight: 132.2 },
    { name: 'Taxiway bump 2', lon: 144.840566, lat: -37.660785, reportedHeight: 127.4 },
    { name: 'Taxiway bump 3', lon: 144.840618, lat: -37.661124, reportedHeight: 123.1 },
    { name: 'Taxiway bump 4', lon: 144.840300, lat: -37.659707, reportedHeight: 132.6 },
    { name: 'Taxiway bump 5', lon: 144.840289, lat: -37.659358, reportedHeight: 132.4 },
    { name: 'Taxiway bump 6', lon: 144.840094, lat: -37.658420, reportedHeight: 133.5 },
    // New taxiway bumps (west side)
    { name: 'Taxiway west 1', lon: 144.830527, lat: -37.664592, reportedHeight: 123.8 },
    { name: 'Taxiway west 2', lon: 144.829656, lat: -37.664560, reportedHeight: 131.9 },
    { name: 'Taxiway west 3', lon: 144.830202, lat: -37.664576, reportedHeight: 125.5 },
    { name: 'Taxiway west 4', lon: 144.830017, lat: -37.664555, reportedHeight: 129.0 },
    { name: 'Taxiway west 5', lon: 144.831404, lat: -37.664691, reportedHeight: 128.8 },
  ]

  console.log('Point Name           | Reported | Calculated | Reason')
  console.log('-'.repeat(70))

  for (const pt of problemPoints) {
    const result = classifyPoint(pt.lon, pt.lat, pt.reportedHeight, allPolygons)
    const delta = result.height - pt.reportedHeight
    console.log(
      `${pt.name.padEnd(20)} | ${pt.reportedHeight.toFixed(1).padStart(8)}m | ${result.height.toFixed(1).padStart(10)}m | ${result.reason}`
    )
  }
  console.log()

  // Create terrain provider for sampling actual terrain
  console.log('Loading Cesium World Terrain...')
  const terrainProvider = await Cesium.CesiumTerrainProvider.fromIonAssetId(1)
  console.log('Terrain provider ready')
  console.log()

  // Test points along runway 16/34 centerline
  console.log('Terrain Profile - RWY 16/34 Centerline (with gradient):')
  console.log('-'.repeat(80))

  const rwy16_34 = YMML_RUNWAYS.find(r => r.ident === '16/34')!
  const gridPositions: Cesium.Cartographic[] = []
  const gridPoints: { lat: number; lon: number; pct: number }[] = []

  for (let i = 0; i <= 20; i++) {
    const t = i / 20
    const lat = rwy16_34.lowEnd.lat + t * (rwy16_34.highEnd.lat - rwy16_34.lowEnd.lat)
    const lon = rwy16_34.lowEnd.lon + t * (rwy16_34.highEnd.lon - rwy16_34.lowEnd.lon)
    gridPositions.push(Cesium.Cartographic.fromDegrees(lon, lat))
    gridPoints.push({ lat, lon, pct: t * 100 })
  }

  const gridSampled = await Cesium.sampleTerrainMostDetailed(terrainProvider, gridPositions)

  console.log('Position    | Orig Terrain | Target Elev | Delta  | Status')
  console.log('-'.repeat(80))

  for (let i = 0; i < gridPoints.length; i++) {
    const pt = gridPoints[i]
    const original = gridSampled[i].height
    const result = classifyPoint(pt.lon, pt.lat, original, allPolygons)
    const delta = result.height - original

    const label = i === 0 ? 'THR 16' : i === 20 ? 'THR 34' : `${pt.pct.toFixed(0)}%`.padStart(6)
    console.log(
      `${label.padEnd(11)} | ${original.toFixed(1).padStart(12)}m | ${result.height.toFixed(1).padStart(11)}m | ${(delta >= 0 ? '+' : '') + delta.toFixed(1).padStart(5)}m | ${result.reason}`
    )
  }

  console.log()

  // Test the intersection area specifically
  console.log('Intersection Area Test (where 09/27 crosses 16/34):')
  console.log('-'.repeat(80))

  // The intersection is roughly at lat -37.661 to -37.662
  const intersectionPoints: { lon: number; lat: number; name: string }[] = []
  for (let i = 0; i <= 10; i++) {
    const lat = -37.660 - i * 0.0003
    intersectionPoints.push({
      lon: 144.8365,
      lat,
      name: `Lat ${lat.toFixed(4)}`
    })
  }

  const intPositions = intersectionPoints.map(p => Cesium.Cartographic.fromDegrees(p.lon, p.lat))
  const intSampled = await Cesium.sampleTerrainMostDetailed(terrainProvider, intPositions)

  console.log('Latitude     | Orig Terrain | Target Elev | Inside Polygons')
  console.log('-'.repeat(80))

  for (let i = 0; i < intersectionPoints.length; i++) {
    const pt = intersectionPoints[i]
    const original = intSampled[i].height
    const result = classifyPoint(pt.lon, pt.lat, original, allPolygons)

    console.log(
      `${pt.lat.toFixed(6)} | ${original.toFixed(1).padStart(12)}m | ${result.height.toFixed(1).padStart(11)}m | ${result.reason}`
    )
  }

  console.log()
  console.log('='.repeat(70))
  console.log('TEST COMPLETE')
  console.log('='.repeat(70))
}

main().catch(console.error)
