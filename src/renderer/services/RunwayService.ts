/**
 * Runway data service
 *
 * Fetches and parses runway data from OurAirports for use in smart sort
 * and other features that need runway geometry (threshold positions, headings).
 *
 * Data source: https://ourairports.com/data/
 * Format: CSV with ~45,000 runways worldwide
 */

import type { Runway, RunwayEnd, RawRunwayCSV } from '../types/airport'
import { RUNWAYS_DB_URL } from '../constants/api'

class RunwayService {
  /** Index of runways by airport ICAO code */
  private runwaysByAirport: Map<string, Runway[]> = new Map()

  /** Whether the full database has been loaded */
  private loaded = false

  /** Whether loading is in progress */
  private loading = false

  /** Promise that resolves when loading completes */
  private loadPromise: Promise<void> | null = null

  /**
   * Load the complete runway database from OurAirports
   * This fetches ~3MB of CSV data and parses it into memory
   */
  async loadRunways(): Promise<void> {
    if (this.loaded) return
    if (this.loading && this.loadPromise) {
      return this.loadPromise
    }

    this.loading = true
    this.loadPromise = this.doLoad()
    return this.loadPromise
  }

  private async doLoad(): Promise<void> {
    try {
      console.log('[RunwayService] Fetching runway database...')
      const response = await fetch(RUNWAYS_DB_URL)

      if (!response.ok) {
        throw new Error(`Failed to fetch runways: ${response.status}`)
      }

      const csvText = await response.text()
      const runwayCount = this.parseCSV(csvText).length

      console.log(`[RunwayService] Parsed ${runwayCount} runways`)
      this.loaded = true
      console.log(`[RunwayService] Indexed runways for ${this.runwaysByAirport.size} airports`)
    } catch (error) {
      console.error('[RunwayService] Failed to load runways:', error)
      throw error
    } finally {
      this.loading = false
    }
  }

  /**
   * Parse CSV text into Runway objects
   */
  private parseCSV(csvText: string): Runway[] {
    const lines = csvText.split('\n')
    if (lines.length < 2) return []

    // Parse header to get column indices
    const header = this.parseCSVLine(lines[0])
    const colIndex: Record<string, number> = {}
    header.forEach((col, i) => {
      colIndex[col] = i
    })

    // Validate required columns exist
    const requiredCols = [
      'airport_ident',
      'le_ident', 'le_latitude_deg', 'le_longitude_deg',
      'he_ident', 'he_latitude_deg', 'he_longitude_deg'
    ]
    const missingCols = requiredCols.filter(col => colIndex[col] === undefined)
    if (missingCols.length > 0) {
      console.error(`[RunwayService] CSV missing required columns: ${missingCols.join(', ')}`)
      console.error('[RunwayService] Available columns:', header.join(', '))
      return []
    }

    const runways: Runway[] = []

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      const values = this.parseCSVLine(line)
      if (values.length < header.length) continue

      const raw: RawRunwayCSV = {
        id: values[colIndex['id']] || '',
        airport_ref: values[colIndex['airport_ref']] || '',
        airport_ident: values[colIndex['airport_ident']] || '',
        length_ft: values[colIndex['length_ft']] || '',
        width_ft: values[colIndex['width_ft']] || '',
        surface: values[colIndex['surface']] || '',
        lighted: values[colIndex['lighted']] || '',
        closed: values[colIndex['closed']] || '',
        le_ident: values[colIndex['le_ident']] || '',
        le_latitude_deg: values[colIndex['le_latitude_deg']] || '',
        le_longitude_deg: values[colIndex['le_longitude_deg']] || '',
        le_elevation_ft: values[colIndex['le_elevation_ft']] || '',
        le_heading_degT: values[colIndex['le_heading_degT']] || '',
        le_displaced_threshold_ft: values[colIndex['le_displaced_threshold_ft']] || '',
        he_ident: values[colIndex['he_ident']] || '',
        he_latitude_deg: values[colIndex['he_latitude_deg']] || '',
        he_longitude_deg: values[colIndex['he_longitude_deg']] || '',
        he_elevation_ft: values[colIndex['he_elevation_ft']] || '',
        he_heading_degT: values[colIndex['he_heading_degT']] || '',
        he_displaced_threshold_ft: values[colIndex['he_displaced_threshold_ft']] || ''
      }

      // Skip runways without threshold coordinates (many smaller airports lack this)
      const hasLowEndCoords = raw.le_latitude_deg && raw.le_longitude_deg
      const hasHighEndCoords = raw.he_latitude_deg && raw.he_longitude_deg

      // We need at least one end with coordinates to be useful
      if (!hasLowEndCoords && !hasHighEndCoords) continue

      // Skip closed runways
      if (raw.closed === '1') continue

      const runway = this.parseRunway(raw)
      if (runway) {
        runways.push(runway)

        // Index by airport ICAO
        const icao = raw.airport_ident.toUpperCase()
        const existing = this.runwaysByAirport.get(icao) || []
        existing.push(runway)
        this.runwaysByAirport.set(icao, existing)
      }
    }

    return runways
  }

  /**
   * Parse a single CSV line, handling quoted fields
   */
  private parseCSVLine(line: string): string[] {
    const result: string[] = []
    let current = ''
    let inQuotes = false

    for (let i = 0; i < line.length; i++) {
      const char = line[i]

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

  /**
   * Convert raw CSV data to a Runway object
   */
  private parseRunway(raw: RawRunwayCSV): Runway | null {
    const lowEnd = this.parseRunwayEnd(
      raw.le_ident,
      raw.le_latitude_deg,
      raw.le_longitude_deg,
      raw.le_heading_degT,
      raw.le_elevation_ft,
      raw.le_displaced_threshold_ft
    )

    const highEnd = this.parseRunwayEnd(
      raw.he_ident,
      raw.he_latitude_deg,
      raw.he_longitude_deg,
      raw.he_heading_degT,
      raw.he_elevation_ft,
      raw.he_displaced_threshold_ft
    )

    // Need at least identifiers for both ends
    if (!lowEnd || !highEnd) return null

    return {
      ident: `${lowEnd.ident}/${highEnd.ident}`,
      lowEnd,
      highEnd,
      lengthFt: parseFloat(raw.length_ft) || 0,
      widthFt: parseFloat(raw.width_ft) || 0,
      surface: raw.surface || 'UNKNOWN',
      lighted: raw.lighted === '1',
      closed: raw.closed === '1'
    }
  }

  /**
   * Parse a single runway end from CSV fields
   */
  private parseRunwayEnd(
    ident: string,
    lat: string,
    lon: string,
    heading: string,
    elevation: string,
    displacedThreshold: string
  ): RunwayEnd | null {
    if (!ident) return null

    // Parse coordinates, defaulting to 0 if missing (will be interpolated from other end)
    const parsedLat = parseFloat(lat) || 0
    const parsedLon = parseFloat(lon) || 0

    // Parse heading, calculate from ident if missing
    let parsedHeading = parseFloat(heading)
    if (isNaN(parsedHeading)) {
      // Extract heading from runway identifier (e.g., "09L" -> 90, "27R" -> 270)
      const match = ident.match(/^(\d{1,2})/)
      if (match) {
        parsedHeading = parseInt(match[1], 10) * 10
      } else {
        parsedHeading = 0
      }
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

  /**
   * Get runways for a specific airport
   * Returns empty array if airport not found or no runways available
   */
  getRunwaysForAirport(icao: string): Runway[] {
    return this.runwaysByAirport.get(icao.toUpperCase()) || []
  }

  /**
   * Get all runways with threshold coordinates for an airport
   * Filters out runways missing coordinate data
   */
  getRunwaysWithCoordinates(icao: string): Runway[] {
    const runways = this.getRunwaysForAirport(icao)
    return runways.filter(
      (r) =>
        (r.lowEnd.lat !== 0 || r.lowEnd.lon !== 0) &&
        (r.highEnd.lat !== 0 || r.highEnd.lon !== 0)
    )
  }

  /**
   * Check if the database is loaded
   */
  isLoaded(): boolean {
    return this.loaded
  }

  /**
   * Get the number of airports with runway data
   */
  getAirportCount(): number {
    return this.runwaysByAirport.size
  }
}

// Export singleton instance
export const runwayService = new RunwayService()
export default runwayService
