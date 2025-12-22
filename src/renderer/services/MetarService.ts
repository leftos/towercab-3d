// METAR weather service
// Handles fetching and parsing METAR data from Aviation Weather API

import { invoke } from '@tauri-apps/api/core'
import type { Precipitation, PrecipitationType, PrecipitationIntensity, WindState } from '@/types'
import { METAR_PRECIP_CODES } from '@/constants'

const METAR_API_URL = 'https://aviationweather.gov/api/data/metar'

/**
 * Fetch a URL using Tauri backend (bypasses CORS) or browser fetch as fallback
 */
async function fetchUrl(url: string): Promise<string> {
  try {
    // Try Tauri command first (available in desktop mode)
    const response = await invoke<string>('fetch_url', { url })
    return response
  } catch {
    // Fallback to browser fetch (for serve mode)
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status}`)
    }
    return await response.text()
  }
}

export interface MetarCloudLayer {
  cover: string  // SKC, FEW, SCT, BKN, OVC
  base: number   // Altitude in feet AGL
}

export interface MetarData {
  icaoId: string
  visib: number           // Visibility in statute miles
  clouds: MetarCloudLayer[]
  fltCat: string          // VFR, MVFR, IFR, LIFR
  obsTime: number         // Observation timestamp (epoch ms)
  rawOb: string           // Raw METAR string
  precipitation: Precipitation[]  // Parsed precipitation types
  hasThunderstorm: boolean        // Whether TS code is present
  wind: WindState                 // Parsed wind data
}

interface CachedMetar {
  data: MetarData
  fetchTime: number
}

interface NearestMetarCache {
  data: MetarData
  fetchTime: number
  lat: number
  lon: number
}

// Haversine distance calculation (duplicated from interpolation.ts for service isolation)
function haversineDistanceNM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3440.065 // Earth radius in nautical miles
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

class MetarService {
  private cache: Map<string, CachedMetar> = new Map()
  private nearestCache: NearestMetarCache | null = null
  private nearestCacheGridSize = 0.1 // ~6nm grid for position caching
  private minFetchInterval = 60000 // 60 seconds minimum between fetches per ICAO
  private nearestFetchInterval = 60000 // 60 seconds minimum for nearest queries

  /**
   * Fetch METAR for an airport
   * Returns null if no data available or on error
   */
  async fetchMetar(icao: string): Promise<MetarData | null> {
    const normalizedIcao = icao.toUpperCase()
    const now = Date.now()

    // Check cache first
    const cached = this.cache.get(normalizedIcao)
    if (cached && now - cached.fetchTime < this.minFetchInterval) {
      return cached.data
    }

    try {
      const url = `${METAR_API_URL}?ids=${normalizedIcao}&format=json`
      const responseText = await fetchUrl(url)
      const data = JSON.parse(responseText)

      // API returns an array, take the first (most recent) observation
      if (!Array.isArray(data) || data.length === 0) {
        console.warn(`No METAR data available for ${normalizedIcao}`)
        return null
      }

      const raw = data[0]
      const rawOb = raw.rawOb || ''

      // Parse precipitation and wind from raw METAR
      const { precipitation, hasThunderstorm } = this.parsePrecipitation(rawOb)
      const wind = this.parseWind(rawOb)

      // Parse the response into our format
      const metar: MetarData = {
        icaoId: raw.icaoId || normalizedIcao,
        visib: this.parseVisibility(raw.visib),
        clouds: this.parseClouds(raw.clouds),
        fltCat: raw.fltCat || 'VFR',
        obsTime: raw.obsTime ? new Date(raw.obsTime * 1000).getTime() : now,
        rawOb,
        precipitation,
        hasThunderstorm,
        wind
      }

      // Cache the result
      this.cache.set(normalizedIcao, { data: metar, fetchTime: now })

      return metar
    } catch (error) {
      console.warn(`Failed to fetch METAR for ${normalizedIcao}:`, error)
      return cached?.data ?? null
    }
  }

  /**
   * Fetch the nearest METAR to given coordinates
   * Uses Aviation Weather API's distance query feature
   * Returns the closest station's METAR within maxDistanceNM
   *
   * @param latitude Latitude in decimal degrees
   * @param longitude Longitude in decimal degrees
   * @param maxDistanceNM Maximum search radius in nautical miles (default: 100)
   */
  async fetchNearestMetar(
    latitude: number,
    longitude: number,
    maxDistanceNM: number = 100
  ): Promise<MetarData | null> {
    const now = Date.now()

    // Round position to grid for cache lookup (~6nm grid)
    const roundedLat = Math.round(latitude / this.nearestCacheGridSize) * this.nearestCacheGridSize
    const roundedLon = Math.round(longitude / this.nearestCacheGridSize) * this.nearestCacheGridSize

    // Check cache - use cached result if within grid cell and not expired
    if (this.nearestCache) {
      const cachedLat = Math.round(this.nearestCache.lat / this.nearestCacheGridSize) * this.nearestCacheGridSize
      const cachedLon = Math.round(this.nearestCache.lon / this.nearestCacheGridSize) * this.nearestCacheGridSize

      if (cachedLat === roundedLat &&
          cachedLon === roundedLon &&
          now - this.nearestCache.fetchTime < this.nearestFetchInterval) {
        return this.nearestCache.data
      }
    }

    try {
      // Aviation Weather API uses bbox parameter for geographic queries
      // bbox format: lat0,lon0,lat1,lon1 (SW corner to NE corner)
      // Calculate bounding box from center point and radius
      // 1 degree latitude ≈ 60 nautical miles
      // 1 degree longitude ≈ 60 * cos(latitude) nautical miles
      const latOffset = maxDistanceNM / 60
      const lonOffset = maxDistanceNM / (60 * Math.cos(latitude * Math.PI / 180))

      const lat0 = (latitude - latOffset).toFixed(4)
      const lon0 = (longitude - lonOffset).toFixed(4)
      const lat1 = (latitude + latOffset).toFixed(4)
      const lon1 = (longitude + lonOffset).toFixed(4)

      const url = `${METAR_API_URL}?bbox=${lat0},${lon0},${lat1},${lon1}&format=json`
      const responseText = await fetchUrl(url)
      const data = JSON.parse(responseText)

      if (!Array.isArray(data) || data.length === 0) {
        console.warn(`No METAR stations within ${maxDistanceNM}nm of ${latitude.toFixed(2)}, ${longitude.toFixed(2)}`)
        return null
      }

      // Find the nearest station by calculating distance to each
      let nearestStation = data[0]
      let nearestDistance = Infinity

      for (const station of data) {
        if (typeof station.lat === 'number' && typeof station.lon === 'number') {
          const distance = haversineDistanceNM(latitude, longitude, station.lat, station.lon)
          if (distance < nearestDistance) {
            nearestDistance = distance
            nearestStation = station
          }
        }
      }

      const rawOb = nearestStation.rawOb || ''

      // Parse precipitation and wind from raw METAR
      const { precipitation, hasThunderstorm } = this.parsePrecipitation(rawOb)
      const wind = this.parseWind(rawOb)

      // Parse the response into our format
      const metar: MetarData = {
        icaoId: nearestStation.icaoId || 'UNKNOWN',
        visib: this.parseVisibility(nearestStation.visib),
        clouds: this.parseClouds(nearestStation.clouds),
        fltCat: nearestStation.fltCat || 'VFR',
        obsTime: nearestStation.obsTime ? new Date(nearestStation.obsTime * 1000).getTime() : now,
        rawOb,
        precipitation,
        hasThunderstorm,
        wind
      }

      // Cache the result with position
      this.nearestCache = {
        data: metar,
        fetchTime: now,
        lat: latitude,
        lon: longitude
      }

      // Also cache by ICAO for future direct lookups
      this.cache.set(metar.icaoId, { data: metar, fetchTime: now })

      return metar
    } catch (error) {
      console.warn(`Failed to fetch nearest METAR:`, error)
      return this.nearestCache?.data ?? null
    }
  }

  /**
   * Parse visibility value, handling special cases
   */
  private parseVisibility(visib: unknown): number {
    if (typeof visib === 'number') {
      return visib
    }
    if (typeof visib === 'string') {
      // Handle "10+" or similar
      const num = parseFloat(visib)
      if (!isNaN(num)) return num
    }
    // Default to good visibility if unknown
    return 10
  }

  /**
   * Parse cloud layers array
   */
  private parseClouds(clouds: unknown): MetarCloudLayer[] {
    if (!Array.isArray(clouds)) return []

    return clouds
      .filter((c): c is { cover: string; base: number } =>
        typeof c === 'object' && c !== null &&
        typeof c.cover === 'string' &&
        typeof c.base === 'number'
      )
      .map(c => ({
        cover: c.cover.toUpperCase(),
        base: c.base
      }))
  }

  /**
   * Parse precipitation from raw METAR string
   *
   * METAR precipitation format: optional intensity prefix + weather code(s)
   * Examples:
   * - "RA" = moderate rain
   * - "-SN" = light snow
   * - "+TSRA" = heavy thunderstorm with rain
   * - "RASN" = rain and snow mix
   *
   * @param rawOb Raw METAR string
   * @returns Object with precipitation array and thunderstorm flag
   */
  private parsePrecipitation(rawOb: string): { precipitation: Precipitation[], hasThunderstorm: boolean } {
    const precipitations: Precipitation[] = []
    let hasThunderstorm = false

    // Check for thunderstorm
    if (/\bTS\b/.test(rawOb) || /[+-]?TS[A-Z]{2}/.test(rawOb)) {
      hasThunderstorm = true
    }

    // Match weather groups: optional intensity + 2+ letter codes
    // Weather appears after visibility, before clouds
    // Pattern: space + optional intensity (-/+) + weather codes + space or end
    const weatherPattern = /\s([+-]?)([A-Z]{2,8})(?=\s|$)/g
    let match

    while ((match = weatherPattern.exec(rawOb)) !== null) {
      const intensityPrefix = match[1]
      const codeGroup = match[2]

      // Skip if this is a cloud group (FEW, SCT, BKN, OVC followed by digits)
      if (/^(FEW|SCT|BKN|OVC|SKC|CLR|NSC|NCD|VV)\d*$/.test(codeGroup)) {
        continue
      }

      // Skip runway visual range and other non-weather codes
      if (/^R\d/.test(codeGroup) || /^\d/.test(codeGroup)) {
        continue
      }

      // Determine intensity
      const intensity: PrecipitationIntensity = intensityPrefix === '-' ? 'light'
        : intensityPrefix === '+' ? 'heavy'
        : 'moderate'

      // Parse individual precipitation codes (handle combined like RASN, TSRA)
      // First strip TS if present since we handle it separately
      const precipCodes = codeGroup.replace('TS', '')

      for (let i = 0; i < precipCodes.length; i += 2) {
        const code = precipCodes.substring(i, i + 2)
        const precipType = METAR_PRECIP_CODES[code] as PrecipitationType | undefined

        if (precipType) {
          precipitations.push({
            type: precipType,
            intensity,
            code: `${intensityPrefix}${code}`
          })
        }
      }
    }

    return { precipitation: precipitations, hasThunderstorm }
  }

  /**
   * Parse wind from raw METAR string
   *
   * METAR wind format: DDDSSKT or DDDSSGSSGKT
   * Examples:
   * - "28009KT" = 280° at 9 knots
   * - "28009G15KT" = 280° at 9 knots gusting 15
   * - "VRB05KT" = variable at 5 knots
   * - "00000KT" = calm
   *
   * @param rawOb Raw METAR string
   * @returns WindState object
   */
  private parseWind(rawOb: string): WindState {
    // Default calm wind
    const defaultWind: WindState = {
      direction: 0,
      speed: 0,
      gustSpeed: null,
      isVariable: false
    }

    // Match wind group: direction (3 digits or VRB) + speed (2-3 digits) + optional gust + KT
    // Also handle MPS (meters per second) by converting
    const windPattern = /(VRB|\d{3})(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)/

    const match = rawOb.match(windPattern)
    if (!match) {
      return defaultWind
    }

    const [, dirStr, speedStr, gustStr, unit] = match

    // Parse direction
    const isVariable = dirStr === 'VRB'
    const direction = isVariable ? 0 : parseInt(dirStr, 10)

    // Parse speed (convert MPS to knots if needed)
    let speed = parseInt(speedStr, 10)
    if (unit === 'MPS') {
      speed = Math.round(speed * 1.94384) // MPS to knots
    }

    // Parse gust speed if present
    let gustSpeed: number | null = null
    if (gustStr) {
      gustSpeed = parseInt(gustStr, 10)
      if (unit === 'MPS') {
        gustSpeed = Math.round(gustSpeed * 1.94384)
      }
    }

    return {
      direction,
      speed,
      gustSpeed,
      isVariable
    }
  }

  /**
   * Get cached METAR without fetching
   */
  getCachedMetar(icao: string): MetarData | null {
    const cached = this.cache.get(icao.toUpperCase())
    return cached?.data ?? null
  }

  /**
   * Clear cache for an airport
   */
  clearCache(icao?: string): void {
    if (icao) {
      this.cache.delete(icao.toUpperCase())
    } else {
      this.cache.clear()
    }
  }
}

// Export singleton instance
export const metarService = new MetarService()
export default metarService
