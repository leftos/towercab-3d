/**
 * Aircraft Dimensions Service
 *
 * Provides wingspan and length data for aircraft types based on ICAO codes.
 * Used to scale 3D aircraft models to realistic relative sizes.
 *
 * Data source: FAA Aircraft Characteristics Database
 * https://www.faa.gov/airports/engineering/aircraft_char_database
 */

export interface AircraftDimensions {
  wingspan: number // meters
  length: number // meters
}

// Reference aircraft for default scaling (B738 - common medium jet)
const REF_WINGSPAN = 35.78 // B738 wingspan in meters
const REF_LENGTH = 39.47 // B738 length in meters

class AircraftDimensionsServiceClass {
  private dimensions: Map<string, AircraftDimensions> = new Map()
  private loaded = false
  private loading: Promise<void> | null = null

  /**
   * Load aircraft dimensions data from JSON file
   */
  async load(): Promise<void> {
    if (this.loaded) return
    if (this.loading) return this.loading

    this.loading = this.doLoad()
    return this.loading
  }

  private async doLoad(): Promise<void> {
    try {
      const response = await fetch('./aircraft-dimensions.json')
      if (!response.ok) {
        console.warn('Failed to load aircraft dimensions data:', response.status)
        return
      }

      const data = (await response.json()) as Record<string, AircraftDimensions>

      for (const [code, dims] of Object.entries(data)) {
        this.dimensions.set(code.toUpperCase(), dims)
      }

      this.loaded = true
    } catch (error) {
      console.warn('Error loading aircraft dimensions:', error)
    }
  }

  /**
   * Get dimensions for an aircraft type
   * @param aircraftType ICAO aircraft type code (e.g., "B738", "A320")
   * @returns Dimensions or null if not found
   */
  getDimensions(aircraftType: string | null | undefined): AircraftDimensions | null {
    if (!aircraftType) return null

    // Normalize the type code
    const normalized = aircraftType.trim().toUpperCase()

    // Direct lookup
    const dims = this.dimensions.get(normalized)
    if (dims) return dims

    // Try stripping freighter suffix (B738F -> B738, A306F -> A306)
    // Freighter variants have same dimensions as passenger versions
    if (normalized.endsWith('F') && normalized.length >= 4) {
      const passengerVariant = normalized.slice(0, -1)
      const freighterDims = this.dimensions.get(passengerVariant)
      if (freighterDims) return freighterDims
    }

    // Try without trailing numbers (e.g., "B7378" -> "B737")
    // Some flight plans include variant suffixes
    if (normalized.length > 4) {
      const shortened = normalized.slice(0, 4)
      const shortDims = this.dimensions.get(shortened)
      if (shortDims) return shortDims
    }

    return null
  }

  /**
   * Get scale factors for an aircraft type relative to reference aircraft (B738)
   * @param aircraftType ICAO aircraft type code
   * @returns Scale factors for X (wingspan) and Z (length), or 1.0 for unknown types
   */
  getScaleFactors(aircraftType: string | null | undefined): { scaleX: number; scaleZ: number } {
    const dims = this.getDimensions(aircraftType)

    if (!dims) {
      return { scaleX: 1.0, scaleZ: 1.0 }
    }

    return {
      scaleX: dims.wingspan / REF_WINGSPAN,
      scaleZ: dims.length / REF_LENGTH
    }
  }

  /**
   * Get a uniform scale factor (average of wingspan and length ratios)
   * Useful for models that should scale uniformly
   * @param aircraftType ICAO aircraft type code
   * @returns Uniform scale factor, or 1.0 for unknown types
   */
  getUniformScale(aircraftType: string | null | undefined): number {
    const { scaleX, scaleZ } = this.getScaleFactors(aircraftType)
    return (scaleX + scaleZ) / 2
  }

  /**
   * Check if data is loaded
   */
  isLoaded(): boolean {
    return this.loaded
  }

  /**
   * Get count of loaded aircraft types
   */
  getCount(): number {
    return this.dimensions.size
  }
}

// Singleton instance
export const aircraftDimensionsService = new AircraftDimensionsServiceClass()
