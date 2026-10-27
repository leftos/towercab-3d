/**
 * Aerodrome Service
 *
 * Loads the aerodrome boundary polygons (OSM `aeroway=aerodrome`) of the towered airports and
 * answers whether a position lies inside one.
 *
 * Data source: OpenStreetMap planet (ODbL 1.0, © OpenStreetMap contributors)
 * Compressed file: aerodromes.json.gz (~518 KB)
 *
 * In Tauri desktop mode: loads via Tauri's resource API with local decompression.
 * In remote browser mode: fetches from /api/aerodromes (pre-decompressed).
 */

import type { AerodromeBoundary, AerodromeData, AerodromeRing } from '../types/aerodromes'
import { isTauri } from '../utils/tauriApi'

/** Timeout for fetch requests in milliseconds */
const FETCH_TIMEOUT = 30000

/**
 * Whether a position lies inside one ring, by even-odd ray casting east along the parallel.
 */
function ringContains(ring: AerodromeRing, lon: number, lat: number): boolean {
  let inside = false
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [lonA, latA] = ring[previous]
    const [lonB, latB] = ring[index]
    if (latA > lat !== latB > lat && lon < ((lonB - lonA) * (lat - latA)) / (latB - latA) + lonA) {
      inside = !inside
    }
  }
  return inside
}

/** Whether a position lies inside any one of the rings. */
function ringsContain(rings: readonly AerodromeRing[], lon: number, lat: number): boolean {
  for (const ring of rings) {
    if (ringContains(ring, lon, lat)) return true
  }
  return false
}

/**
 * Whether a position lies inside a boundary: inside one of its outer rings and inside no hole.
 *
 * @param boundary - The airport's boundary rings
 * @param lon - Longitude in degrees
 * @param lat - Latitude in degrees
 * @returns true when the position is inside the aerodrome
 */
export function pointInBoundary(boundary: AerodromeBoundary, lon: number, lat: number): boolean {
  if (!ringsContain(boundary.p, lon, lat)) return false
  return boundary.h === undefined || !ringsContain(boundary.h, lon, lat)
}

/**
 * Aerodrome Service
 *
 * Loads the aerodrome boundaries once and answers inside-the-fence questions.
 */
export class AerodromeService {
  /** Cached aerodrome data */
  private data: AerodromeData | null = null

  /** Whether the data is currently being loaded */
  private loading = false

  /** Promise that resolves when loading completes */
  private loadPromise: Promise<void> | null = null

  /**
   * Load the aerodrome boundary data
   *
   * This fetches and caches the data on the first call, and a call made while that fetch runs
   * waits on the same one. A failed load logs and rethrows, and the next call fetches again: only
   * a success is kept.
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
      console.log('[AerodromeService] Loading aerodrome boundaries...')

      if (isTauri()) {
        // In Tauri mode, load from bundled resources
        await this.loadFromTauri()
      } else {
        // In remote browser mode, fetch from API
        await this.loadFromApi()
      }

      if (this.data) {
        console.log(`[AerodromeService] Loaded ${Object.keys(this.data.airports).length} aerodromes`)
      }
    } catch (error) {
      console.error('[AerodromeService] Failed to load aerodrome boundaries:', error)
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
    const resourcePath = await pathModule.resolveResource('resources/aerodromes.json.gz')
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
    this.data = JSON.parse(jsonText) as AerodromeData
  }

  /**
   * Load data from API endpoint (for remote browser mode)
   */
  private async loadFromApi(): Promise<void> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT)

    try {
      const response = await fetch('/api/aerodromes', {
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      this.data = (await response.json()) as AerodromeData
    } catch (error) {
      clearTimeout(timeoutId)
      throw error
    }
  }

  /**
   * Whether a position lies inside an airport's aerodrome boundary
   *
   * @param icao - Airport ICAO code (e.g., "KSFO")
   * @param lon - Longitude in degrees
   * @param lat - Latitude in degrees
   * @returns true when the airport has a boundary and the position is inside it
   */
  contains(icao: string, lon: number, lat: number): boolean {
    const boundary = this.data?.airports[icao.toUpperCase()]
    return boundary !== undefined && pointInBoundary(boundary, lon, lat)
  }
}

/** The app's one aerodrome boundary store. */
export const aerodromeService = new AerodromeService()
