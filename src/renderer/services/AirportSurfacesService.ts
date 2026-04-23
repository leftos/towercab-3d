/**
 * Airport Surfaces Service
 *
 * Loads and provides access to airport pavement data (taxiways, aprons) from
 * X-Plane apt.dat. This data is used for terrain flattening beyond just runways.
 *
 * Data source: X-Plane apt.dat (GNU GPL licensed)
 * Compressed file: airport-surfaces.json.gz (~15 MB)
 *
 * In Tauri desktop mode: Loads via Tauri's resource API with local decompression
 * In remote browser mode: Fetches from /api/airport-surfaces endpoint (pre-decompressed)
 */

import type { AirportSurfacesData, AptDatAirport, AptDatPavement } from '../types/airportSurfaces'
import type { FlatteningPolygon } from '../types/terrain'
import { isTauri } from '../utils/tauriApi'
import { geoidService } from './GeoidService'

/** Blend distance in meters for pavement edges */
const PAVEMENT_BLEND_DISTANCE = 30

/** Timeout for fetch requests in milliseconds */
const FETCH_TIMEOUT = 30000

/**
 * Convert feet to meters
 */
function feetToMeters(feet: number): number {
  return feet * 0.3048
}

/**
 * Airport Surfaces Service
 *
 * Loads pavement data from X-Plane apt.dat and converts it to flattening polygons.
 */
class AirportSurfacesService {
  /** Cached airport surfaces data */
  private data: AirportSurfacesData | null = null

  /** Whether the data is currently being loaded */
  private loading = false

  /** Promise that resolves when loading completes */
  private loadPromise: Promise<void> | null = null

  /**
   * Load the airport surfaces data
   *
   * This will fetch and cache the data on first call.
   * Subsequent calls return immediately if already loaded.
   */
  async load(): Promise<void> {
    if (this.data) return
    if (this.loading && this.loadPromise) {
      return this.loadPromise
    }

    this.loading = true
    this.loadPromise = this.doLoad()
    return this.loadPromise
  }

  private async doLoad(): Promise<void> {
    try {
      console.log('[AirportSurfacesService] Loading airport surfaces data...')

      if (isTauri()) {
        // In Tauri mode, load from bundled resources
        await this.loadFromTauri()
      } else {
        // In remote browser mode, fetch from API
        await this.loadFromApi()
      }

      if (this.data) {
        console.log(
          `[AirportSurfacesService] Loaded ${this.data._meta.airport_count} airports with ${this.data._meta.total_pavements} pavements`,
        )
      }
    } catch (error) {
      console.error('[AirportSurfacesService] Failed to load airport surfaces:', error)
      throw error
    } finally {
      this.loading = false
    }
  }

  /**
   * Load data from Tauri bundled resources
   */
  private async loadFromTauri(): Promise<void> {
    const [pathModule, fsModule] = await Promise.all([import('@tauri-apps/api/path'), import('@tauri-apps/plugin-fs')])

    // Read the compressed file (path must match tauri.conf.json resources entry)
    const resourcePath = await pathModule.resolveResource('resources/airport-surfaces.json.gz')
    const compressedData = await fsModule.readFile(resourcePath)

    // Decompress using the browser's DecompressionStream API
    const decompressedStream = new Blob([compressedData]).stream().pipeThrough(new DecompressionStream('gzip'))

    const reader = decompressedStream.getReader()
    const chunks: Uint8Array[] = []

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }

    // Combine chunks and decode as UTF-8
    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0)
    const combined = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
      combined.set(chunk, offset)
      offset += chunk.length
    }

    const jsonText = new TextDecoder().decode(combined)
    this.data = JSON.parse(jsonText) as AirportSurfacesData
  }

  /**
   * Load data from API endpoint (for remote browser mode)
   */
  private async loadFromApi(): Promise<void> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT)

    try {
      const response = await fetch('/api/airport-surfaces', {
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      this.data = (await response.json()) as AirportSurfacesData
    } catch (error) {
      clearTimeout(timeoutId)
      throw error
    }
  }

  /**
   * Check if the data is loaded
   */
  isLoaded(): boolean {
    return this.data !== null
  }

  /**
   * Get raw airport data for an ICAO code
   *
   * @param icao - Airport ICAO code (e.g., "KJFK")
   * @returns Airport data or undefined if not found
   */
  getAirportData(icao: string): AptDatAirport | undefined {
    if (!this.data) return undefined
    return this.data.airports[icao.toUpperCase()]
  }

  /**
   * Check if an airport has pavement data
   *
   * @param icao - Airport ICAO code
   * @returns true if the airport has pavement polygons
   */
  hasAirportData(icao: string): boolean {
    if (!this.data) return false
    return icao.toUpperCase() in this.data.airports
  }

  /**
   * Convert airport pavements to flattening polygons
   *
   * @param icao - Airport ICAO code
   * @param surfaceTypes - Optional array of surface types to include (default: all paved surfaces)
   * @param fieldElevationEllipsoidal - Optional override elevation in meters ellipsoidal (WGS84)
   * @returns Array of flattening polygons for terrain modification
   */
  getPavementPolygons(
    icao: string,
    surfaceTypes: string[] = ['a', 'c'], // Default to asphalt and concrete only
    fieldElevationEllipsoidal?: number,
  ): FlatteningPolygon[] {
    const airport = this.getAirportData(icao)
    if (!airport?.p || airport.p.length === 0) {
      return []
    }

    // Use provided ellipsoidal elevation (from runway data) if available, otherwise fall back to apt.dat
    let elevationMeters: number
    if (fieldElevationEllipsoidal !== undefined && Number.isFinite(fieldElevationEllipsoidal)) {
      elevationMeters = fieldElevationEllipsoidal
      console.log(
        `[AirportSurfacesService] Using runway-derived elevation for ${icao}: ${elevationMeters.toFixed(1)}m ellipsoidal`,
      )
    } else {
      // Validate elevation - log if malformed (helps debug NaN issues)
      if (typeof airport.e !== 'number' || !Number.isFinite(airport.e)) {
        console.error(
          `[AirportSurfacesService] INVALID ELEVATION for ${icao}: airport.e = ${airport.e} (type: ${typeof airport.e})`,
        )
        return [] // Skip this airport to prevent NaN propagation
      }

      // Calculate centroid from pavement vertices for geoid lookup
      let centerLat = 0,
        centerLon = 0,
        vertexCount = 0
      for (const pavement of airport.p) {
        for (const [lon, lat] of pavement.v) {
          centerLon += lon
          centerLat += lat
          vertexCount++
        }
      }
      if (vertexCount > 0) {
        centerLat /= vertexCount
        centerLon /= vertexCount
      }

      // Convert apt.dat MSL elevation to ellipsoidal
      const mslMeters = feetToMeters(airport.e)
      elevationMeters = vertexCount > 0 ? geoidService.mslToEllipsoidal(centerLat, centerLon, mslMeters) : mslMeters // Fallback if no vertices (shouldn't happen)
      console.log(
        `[AirportSurfacesService] Using apt.dat elevation for ${icao}: ${mslMeters.toFixed(1)}m MSL (${elevationMeters.toFixed(1)}m ellipsoidal)`,
      )
    }
    const polygons: FlatteningPolygon[] = []

    for (let i = 0; i < airport.p.length; i++) {
      const pavement = airport.p[i]

      // Filter by surface type if specified
      if (!surfaceTypes.includes(pavement.s)) {
        continue
      }

      // Skip pavements with too few vertices
      if (pavement.v.length < 3) {
        continue
      }

      // Convert to FlatteningPolygon format
      // Note: apt.dat uses [lon, lat] format which matches our FlatteningPolygon format
      const polygon = this.convertPavementToPolygon(pavement, icao, i, elevationMeters)

      if (polygon) {
        polygons.push(polygon)
      }
    }

    return polygons
  }

  /**
   * Ensure a polygon ring is closed (first point == last point)
   */
  private ensureRingClosed(ring: [number, number][]): [number, number][] {
    if (ring.length < 2) return ring

    const first = ring[0]
    const last = ring[ring.length - 1]

    if (first[0] !== last[0] || first[1] !== last[1]) {
      return [...ring, [first[0], first[1]]]
    }
    return ring
  }

  /**
   * Convert a single pavement to a flattening polygon
   */
  private convertPavementToPolygon(
    pavement: AptDatPavement,
    icao: string,
    index: number,
    elevationMeters: number,
  ): FlatteningPolygon | null {
    // Ensure the exterior ring is closed
    const vertices = this.ensureRingClosed([...pavement.v] as [number, number][])

    // Process holes if present
    let holes: [number, number][][] | undefined
    if (pavement.h && pavement.h.length > 0) {
      holes = pavement.h.map((hole) => this.ensureRingClosed([...hole] as [number, number][]))
    }

    // Determine source type based on surface
    // For now, we categorize everything as 'taxiway' or 'apron'
    // In the future, we could use polygon size or other heuristics
    const source: 'taxiway' | 'apron' = 'taxiway' // Default to taxiway

    return {
      id: `${icao}-pavement-${index}`,
      vertices,
      holes,
      elevation: elevationMeters,
      blendDistance: PAVEMENT_BLEND_DISTANCE,
      source,
      // Note: We don't set gradient fields for pavements since they should be flat
      // at the airport elevation
    }
  }

  /**
   * Get metadata about the loaded data
   */
  getMetadata(): AirportSurfacesData['_meta'] | null {
    return this.data?._meta ?? null
  }

  /**
   * Get the number of airports with pavement data
   */
  getAirportCount(): number {
    if (!this.data) return 0
    return Object.keys(this.data.airports).length
  }

  /**
   * Load data directly from a parsed object (for testing in Node.js)
   *
   * @param data - Pre-parsed airport surfaces data
   */
  loadFromData(data: AirportSurfacesData): void {
    this.data = data
    console.log(`[AirportSurfacesService] Loaded ${data._meta.airport_count} airports from provided data`)
  }
}

// Export singleton instance
export const airportSurfacesService = new AirportSurfacesService()
export default airportSurfacesService
