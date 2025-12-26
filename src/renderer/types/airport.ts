// Airport data types
// Source: github.com/mwgg/Airports (basic airport data)
// Source: ourairports.com (runway data)

// ============================================================================
// RUNWAY TYPES
// ============================================================================

/**
 * Runway threshold/end point data
 * Each runway has two ends (low and high, based on heading number)
 */
export interface RunwayEnd {
  /** Runway designator (e.g., "09L", "27R", "04") */
  ident: string
  /** Latitude in degrees */
  lat: number
  /** Longitude in degrees */
  lon: number
  /** True heading in degrees (0-360) */
  headingTrue: number
  /** Elevation in feet MSL */
  elevationFt: number
  /** Displaced threshold distance in feet (0 if none) */
  displacedThresholdFt: number
}

/**
 * Complete runway data for smart sort calculations
 */
export interface Runway {
  /** Combined runway designator (e.g., "09L/27R") */
  ident: string
  /** Low-numbered end (e.g., 09L for 09L/27R) */
  lowEnd: RunwayEnd
  /** High-numbered end (e.g., 27R for 09L/27R) */
  highEnd: RunwayEnd
  /** Runway length in feet */
  lengthFt: number
  /** Runway width in feet */
  widthFt: number
  /** Surface type (ASPH, CONC, GRVL, TURF, etc.) */
  surface: string
  /** Whether the runway is lighted */
  lighted: boolean
  /** Whether the runway is closed */
  closed: boolean
}

/**
 * Raw runway data from OurAirports CSV
 * @internal Used during parsing only
 */
export interface RawRunwayCSV {
  id: string
  airport_ref: string
  airport_ident: string
  length_ft: string
  width_ft: string
  surface: string
  lighted: string
  closed: string
  le_ident: string
  le_latitude_deg: string
  le_longitude_deg: string
  le_elevation_ft: string
  le_heading_degT: string
  le_displaced_threshold_ft: string
  he_ident: string
  he_latitude_deg: string
  he_longitude_deg: string
  he_elevation_ft: string
  he_heading_degT: string
  he_displaced_threshold_ft: string
}

// ============================================================================
// AIRPORT TYPES
// ============================================================================

export interface Airport {
  icao: string
  iata: string
  name: string
  city: string
  state: string
  country: string
  elevation: number  // feet
  lat: number
  lon: number
  tz: string  // timezone
}

export interface AirportDatabase {
  [icao: string]: Airport
}

// Tower configuration for specific airports
export interface TowerConfig {
  icao: string
  height: number  // meters above airport elevation
  offsetLat?: number  // offset from airport center in degrees
  offsetLon?: number  // offset from airport center in degrees
  defaultHeading?: number  // default view heading in degrees
}

// Known tower heights for major airports (in meters)
export const KNOWN_TOWER_HEIGHTS: Record<string, number> = {
  // United States
  'KJFK': 97,   // JFK - 321 ft
  'KLAX': 84,   // LAX - 277 ft
  'KORD': 60,   // Chicago O'Hare
  'KATL': 121,  // Atlanta - 398 ft
  'KSFO': 67,   // San Francisco
  'KMIA': 79,   // Miami
  'KDFW': 58,   // Dallas/Fort Worth
  'KDEN': 99,   // Denver
  'KLAS': 76,   // Las Vegas
  'KSEA': 70,   // Seattle
  'KBOS': 60,   // Boston Logan
  'KPHX': 70,   // Phoenix

  // Europe
  'EGLL': 87,   // London Heathrow
  'LFPG': 52,   // Paris CDG
  'EDDF': 70,   // Frankfurt
  'EHAM': 101,  // Amsterdam Schiphol
  'LEMD': 60,   // Madrid
  'LIRF': 52,   // Rome Fiumicino
  'EGKK': 48,   // London Gatwick
  'LFPO': 45,   // Paris Orly
  'LEBL': 40,   // Barcelona
  'LSZH': 55,   // Zurich
  'LOWW': 85,   // Vienna

  // Asia Pacific
  'RJTT': 116,  // Tokyo Haneda
  'RJAA': 65,   // Tokyo Narita
  'VHHH': 88,   // Hong Kong
  'WSSS': 70,   // Singapore Changi
  'ZBAA': 90,   // Beijing Capital
  'YSSY': 67,   // Sydney
  'NZAA': 50,   // Auckland

  // Middle East
  'OMDB': 87,   // Dubai
  'OEJN': 70,   // Jeddah
  'LLBG': 45,   // Tel Aviv
}

// Airport type classification for height estimation
export type AirportType = 'major_international' | 'large_domestic' | 'regional' | 'small' | 'unknown'

export function classifyAirport(airport: Airport): AirportType {
  // Simple heuristics based on airport characteristics
  const icao = airport.icao.toUpperCase()

  // Major international hubs (known by ICAO code patterns and name)
  const majorPrefixes = ['KJFK', 'KLAX', 'KORD', 'EGLL', 'LFPG', 'EDDF', 'EHAM', 'RJTT', 'VHHH']
  if (majorPrefixes.includes(icao)) {
    return 'major_international'
  }

  // Large domestic (has international in name or major US airports)
  if (airport.name.toLowerCase().includes('international')) {
    return 'large_domestic'
  }

  // Regional airports (has regional in name or shorter runways implied by elevation)
  if (airport.name.toLowerCase().includes('regional') ||
      airport.name.toLowerCase().includes('municipal')) {
    return 'regional'
  }

  // Small airports
  if (airport.name.toLowerCase().includes('field') ||
      airport.name.toLowerCase().includes('airpark') ||
      airport.name.toLowerCase().includes('airstrip')) {
    return 'small'
  }

  return 'unknown'
}

// Get estimated tower height based on airport type
export function getEstimatedTowerHeight(airport: Airport): number {
  // Check known heights first
  const knownHeight = KNOWN_TOWER_HEIGHTS[airport.icao.toUpperCase()]
  if (knownHeight !== undefined) {
    return knownHeight
  }

  // Estimate based on airport type
  const airportType = classifyAirport(airport)
  switch (airportType) {
    case 'major_international':
      return 75  // meters
    case 'large_domestic':
      return 50
    case 'regional':
      return 30
    case 'small':
      return 15
    default:
      return 35  // default height
  }
}
