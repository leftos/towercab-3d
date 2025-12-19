// Airport database service
// Loads and manages airport data

import type { Airport, AirportDatabase } from '../types/airport'

const AIRPORTS_URL = 'https://raw.githubusercontent.com/mwgg/Airports/master/airports.json'

class AirportService {
  private airports: Map<string, Airport> = new Map()
  private loaded = false
  private loading = false

  /**
   * Load airports from the remote database
   */
  async loadAirports(): Promise<Map<string, Airport>> {
    if (this.loaded) return this.airports
    if (this.loading) {
      // Wait for loading to complete
      await new Promise<void>((resolve) => {
        const checkLoaded = setInterval(() => {
          if (this.loaded) {
            clearInterval(checkLoaded)
            resolve()
          }
        }, 100)
      })
      return this.airports
    }

    this.loading = true

    try {
      const response = await fetch(AIRPORTS_URL)
      if (!response.ok) {
        throw new Error(`Failed to fetch airports: ${response.status}`)
      }

      const data: AirportDatabase = await response.json()

      for (const [icao, airport] of Object.entries(data)) {
        // Normalize the data
        const normalizedAirport: Airport = {
          icao: icao.toUpperCase(),
          iata: airport.iata || '',
          name: airport.name || '',
          city: airport.city || '',
          state: airport.state || '',
          country: airport.country || '',
          elevation: airport.elevation || 0,
          lat: airport.lat || 0,
          lon: airport.lon || 0,
          tz: airport.tz || ''
        }

        // Only include airports with valid coordinates
        if (normalizedAirport.lat !== 0 && normalizedAirport.lon !== 0) {
          this.airports.set(normalizedAirport.icao, normalizedAirport)
        }
      }

      this.loaded = true
      console.log(`Loaded ${this.airports.size} airports`)

      return this.airports
    } catch (error) {
      console.error('Failed to load airports:', error)
      throw error
    } finally {
      this.loading = false
    }
  }

  /**
   * Get an airport by ICAO code
   */
  getAirport(icao: string): Airport | undefined {
    return this.airports.get(icao.toUpperCase())
  }

  /**
   * Search airports by query string
   */
  search(query: string, limit = 50): Airport[] {
    if (!query.trim()) return []

    const normalizedQuery = query.toLowerCase().trim()
    const results: Airport[] = []

    for (const airport of this.airports.values()) {
      const matchScore = this.calculateMatchScore(airport, normalizedQuery)
      if (matchScore > 0) {
        results.push(airport)
      }

      if (results.length >= limit * 2) break // Get more than needed for sorting
    }

    // Sort by relevance
    return results
      .sort((a, b) => {
        const scoreA = this.calculateMatchScore(a, normalizedQuery)
        const scoreB = this.calculateMatchScore(b, normalizedQuery)
        return scoreB - scoreA
      })
      .slice(0, limit)
  }

  /**
   * Calculate match score for an airport
   */
  private calculateMatchScore(airport: Airport, query: string): number {
    let score = 0

    // Exact ICAO match
    if (airport.icao.toLowerCase() === query) {
      score += 100
    } else if (airport.icao.toLowerCase().startsWith(query)) {
      score += 50
    } else if (airport.icao.toLowerCase().includes(query)) {
      score += 20
    }

    // Exact IATA match
    if (airport.iata && airport.iata.toLowerCase() === query) {
      score += 90
    } else if (airport.iata && airport.iata.toLowerCase().startsWith(query)) {
      score += 40
    }

    // Name match
    if (airport.name.toLowerCase().includes(query)) {
      score += 15
    }

    // City match
    if (airport.city.toLowerCase().includes(query)) {
      score += 10
    }

    return score
  }

  /**
   * Get all airports as a Map
   */
  getAllAirports(): Map<string, Airport> {
    return this.airports
  }

  /**
   * Check if airports are loaded
   */
  isLoaded(): boolean {
    return this.loaded
  }
}

// Export singleton instance
export const airportService = new AirportService()
export default airportService
