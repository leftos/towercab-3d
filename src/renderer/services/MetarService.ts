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

class MetarService {
  private cache: Map<string, CachedMetar> = new Map()
  private minFetchInterval = 60000 // 60 seconds minimum between fetches per ICAO

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
