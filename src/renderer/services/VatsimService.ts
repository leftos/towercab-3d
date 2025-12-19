// VATSIM data service
// Handles fetching and parsing VATSIM network data

import type { VatsimData, PilotData } from '../types/vatsim'

const VATSIM_DATA_URL = 'https://data.vatsim.net/v3/vatsim-data.json'

class VatsimService {
  private lastData: VatsimData | null = null
  private lastFetchTime: number = 0
  private minFetchInterval = 15000 // 15 seconds minimum between fetches

  /**
   * Fetch current VATSIM data
   */
  async fetchData(): Promise<VatsimData> {
    const now = Date.now()

    // Rate limiting
    if (this.lastData && now - this.lastFetchTime < this.minFetchInterval) {
      return this.lastData
    }

    const response = await fetch(VATSIM_DATA_URL)
    if (!response.ok) {
      throw new Error(`VATSIM API error: ${response.status} ${response.statusText}`)
    }

    const data: VatsimData = await response.json()
    this.lastData = data
    this.lastFetchTime = now

    return data
  }

  /**
   * Get pilots only
   */
  async getPilots(): Promise<PilotData[]> {
    const data = await this.fetchData()
    return data.pilots
  }

  /**
   * Get pilots near a location
   */
  async getPilotsNear(
    latitude: number,
    longitude: number,
    radiusNm: number
  ): Promise<PilotData[]> {
    const pilots = await this.getPilots()
    return pilots.filter((pilot) => {
      const distance = this.calculateDistanceNm(
        latitude,
        longitude,
        pilot.latitude,
        pilot.longitude
      )
      return distance <= radiusNm
    })
  }

  /**
   * Get pilots by departure/arrival airport
   */
  async getPilotsByAirport(icao: string): Promise<{
    departing: PilotData[]
    arriving: PilotData[]
  }> {
    const pilots = await this.getPilots()
    const normalizedIcao = icao.toUpperCase()

    return {
      departing: pilots.filter(
        (p) => p.flight_plan?.departure?.toUpperCase() === normalizedIcao
      ),
      arriving: pilots.filter(
        (p) => p.flight_plan?.arrival?.toUpperCase() === normalizedIcao
      )
    }
  }

  /**
   * Calculate distance between two coordinates in nautical miles
   */
  private calculateDistanceNm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
  ): number {
    const R = 3440.065 // Earth radius in nautical miles

    const dLat = ((lat2 - lat1) * Math.PI) / 180
    const dLon = ((lon2 - lon1) * Math.PI) / 180

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2)

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

    return R * c
  }

  /**
   * Get the last fetch time
   */
  getLastFetchTime(): number {
    return this.lastFetchTime
  }

  /**
   * Get cached data without fetching
   */
  getCachedData(): VatsimData | null {
    return this.lastData
  }
}

// Export singleton instance
export const vatsimService = new VatsimService()
export default vatsimService
