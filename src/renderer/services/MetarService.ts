// METAR weather service
// Handles fetching and parsing METAR data from Aviation Weather API

const METAR_API_URL = 'https://aviationweather.gov/api/data/metar'

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
      const response = await fetch(url)

      if (!response.ok) {
        console.warn(`METAR API error for ${normalizedIcao}: ${response.status}`)
        return cached?.data ?? null
      }

      const data = await response.json()

      // API returns an array, take the first (most recent) observation
      if (!Array.isArray(data) || data.length === 0) {
        console.warn(`No METAR data available for ${normalizedIcao}`)
        return null
      }

      const raw = data[0]

      // Parse the response into our format
      const metar: MetarData = {
        icaoId: raw.icaoId || normalizedIcao,
        visib: this.parseVisibility(raw.visib),
        clouds: this.parseClouds(raw.clouds),
        fltCat: raw.fltCat || 'VFR',
        obsTime: raw.obsTime ? new Date(raw.obsTime * 1000).getTime() : now,
        rawOb: raw.rawOb || ''
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

      const response = await fetch(url)

      if (!response.ok) {
        console.warn(`Nearest METAR API error: ${response.status}`)
        return this.nearestCache?.data ?? null
      }

      const data = await response.json()

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

      // Parse the response into our format
      const metar: MetarData = {
        icaoId: nearestStation.icaoId || 'UNKNOWN',
        visib: this.parseVisibility(nearestStation.visib),
        clouds: this.parseClouds(nearestStation.clouds),
        fltCat: nearestStation.fltCat || 'VFR',
        obsTime: nearestStation.obsTime ? new Date(nearestStation.obsTime * 1000).getTime() : now,
        rawOb: nearestStation.rawOb || ''
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

      console.log(`Found nearest METAR: ${metar.icaoId} (${nearestDistance.toFixed(1)}nm away)`)
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
