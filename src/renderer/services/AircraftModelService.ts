/**
 * Aircraft Model Service
 *
 * Maps ICAO aircraft type codes to available 3D model files.
 * When a specific model exists, it's used at 1:1 scale.
 * When no model exists, finds the closest match by FAA dimensions and applies scaling.
 *
 * Models from Flightradar24/fr24-3d-models (GPL-2.0, originally from FlightGear)
 */

import { aircraftDimensionsService } from './AircraftDimensionsService'

// Available model files (lowercase, without extension)
// These correspond to .glb files in src/renderer/public/
const AVAILABLE_MODELS = new Set([
  'a318', 'a319', 'a320', 'a321',
  'a332', 'a333', 'a343', 'a346', 'a359', 'a380',
  'b736', 'b737', 'b738', 'b739',
  'b744', 'b748', 'b752', 'b753',
  'b762', 'b763', 'b764', 'b772', 'b773',
  'b788', 'b789',
  'atr42', 'bae146', 'crj700', 'crj900',
  'cs100', 'cs300', 'e170', 'e190', 'q400',
  'beluga', 'citation', 'heli', 'pa28', 'ask21'
])

// Map model file names to their ICAO type codes for FAA dimension lookup
// This allows us to get the actual dimensions of each model
const MODEL_TO_ICAO: Record<string, string> = {
  'a318': 'A318',
  'a319': 'A319',
  'a320': 'A320',
  'a321': 'A321',
  'a332': 'A332',
  'a333': 'A333',
  'a343': 'A343',
  'a346': 'A346',
  'a359': 'A359',
  'a380': 'A388',
  'b736': 'B736',
  'b737': 'B737',
  'b738': 'B738',
  'b739': 'B739',
  'b744': 'B744',
  'b748': 'B748',
  'b752': 'B752',
  'b753': 'B753',
  'b762': 'B762',
  'b763': 'B763',
  'b764': 'B764',
  'b772': 'B772',
  'b773': 'B773',
  'b788': 'B788',
  'b789': 'B789',
  'atr42': 'AT43',  // ATR 42
  'bae146': 'B461', // BAe 146-100
  'crj700': 'CRJ7',
  'crj900': 'CRJ9',
  'cs100': 'BCS1',
  'cs300': 'BCS3',
  'e170': 'E170',
  'e190': 'E190',
  'q400': 'DH8D',   // Dash 8 Q400
  'beluga': 'A332', // Beluga based on A330 dimensions (approx)
  'citation': 'C560', // Citation V as representative
  'heli': 'H135',   // Generic heli, use EC135 dimensions
  'pa28': 'P28A',
  'ask21': 'AS21',  // ASK 21 glider (may not be in FAA data)
}

// Map ICAO type codes to model files
// Direct mappings for types that don't match the filename exactly
const TYPE_TO_MODEL: Record<string, string> = {
  // Airbus A320 family
  'A318': 'a318',
  'A319': 'a319',
  'A19N': 'a319', // A319neo -> A319
  'A320': 'a320',
  'A20N': 'a320', // A320neo -> A320
  'A321': 'a321',
  'A21N': 'a321', // A321neo -> A321

  // Airbus A330
  'A332': 'a332',
  'A333': 'a333',
  'A337': 'a333', // A330-700 Beluga XL -> A333 (or beluga if preferred)
  'A338': 'a333', // A330-800neo -> A333
  'A339': 'a333', // A330-900neo -> A333

  // Airbus A340
  'A342': 'a343',
  'A343': 'a343',
  'A345': 'a346',
  'A346': 'a346',

  // Airbus A350
  'A359': 'a359',
  'A35K': 'a359', // A350-1000 -> A359

  // Airbus A380
  'A388': 'a380',
  'A380': 'a380',

  // Boeing 737 family
  'B736': 'b736',
  'B737': 'b737',
  'B738': 'b738',
  'B739': 'b739',
  'B37M': 'b738', // 737 MAX 7 -> B738
  'B38M': 'b738', // 737 MAX 8 -> B738
  'B39M': 'b739', // 737 MAX 9 -> B739

  // Boeing 747
  'B741': 'b744',
  'B742': 'b744',
  'B743': 'b744',
  'B744': 'b744',
  'B748': 'b748',
  'B74S': 'b744', // 747SP -> B744
  'BLCF': 'b748', // 747 Dreamlifter -> B748

  // Boeing 757
  'B752': 'b752',
  'B753': 'b753',

  // Boeing 767
  'B762': 'b762',
  'B763': 'b763',
  'B764': 'b764',

  // Boeing 777
  'B772': 'b772',
  'B773': 'b773',
  'B77L': 'b773', // 777-200LR -> B773
  'B77W': 'b773', // 777-300ER -> B773
  'B778': 'b773', // 777-8 -> B773
  'B779': 'b773', // 777-9 -> B773

  // Boeing 787
  'B788': 'b788',
  'B789': 'b789',
  'B78X': 'b789', // 787-10 -> B789

  // ATR
  'AT43': 'atr42',
  'AT44': 'atr42',
  'AT45': 'atr42',
  'AT46': 'atr42',
  'AT72': 'atr42', // ATR 72 -> ATR 42 (similar shape)
  'AT73': 'atr42',
  'AT75': 'atr42',
  'AT76': 'atr42',
  'ATR4': 'atr42',
  'ATR7': 'atr42',

  // BAe 146 / Avro RJ
  'B461': 'bae146',
  'B462': 'bae146',
  'B463': 'bae146',
  'RJ70': 'bae146',
  'RJ85': 'bae146',
  'RJ1H': 'bae146',

  // Bombardier CRJ
  'CRJ1': 'crj700',
  'CRJ2': 'crj700',
  'CRJ7': 'crj700',
  'CRJ9': 'crj900',
  'CRJX': 'crj900',

  // Bombardier/Airbus A220 (CS100/CS300)
  'BCS1': 'cs100',
  'BCS3': 'cs300',
  'CS10': 'cs100',
  'CS30': 'cs300',

  // Embraer E-Jets
  'E170': 'e170',
  'E175': 'e170',
  'E75S': 'e170',
  'E75L': 'e170',
  'E190': 'e190',
  'E195': 'e190',
  'E290': 'e190', // E190-E2 -> E190
  'E295': 'e190', // E195-E2 -> E190

  // De Havilland Canada Dash 8
  'DH8A': 'q400',
  'DH8B': 'q400',
  'DH8C': 'q400',
  'DH8D': 'q400',
  'DHC8': 'q400',
  'Q400': 'q400',

  // Beluga
  'BLGA': 'beluga',

  // Citation (generic bizjet)
  'C500': 'citation',
  'C501': 'citation',
  'C510': 'citation',
  'C525': 'citation',
  'C526': 'citation',
  'C550': 'citation',
  'C551': 'citation',
  'C55B': 'citation',
  'C560': 'citation',
  'C56X': 'citation',
  'C650': 'citation',
  'C680': 'citation',
  'C68A': 'citation',
  'C700': 'citation',
  'C750': 'citation',
  'C25A': 'citation',
  'C25B': 'citation',
  'C25C': 'citation',
  'C25M': 'citation',

  // Helicopters
  'H135': 'heli',
  'H145': 'heli',
  'H160': 'heli',
  'H175': 'heli',
  'EC35': 'heli',
  'EC45': 'heli',
  'AS50': 'heli',
  'AS55': 'heli',
  'AS65': 'heli',
  'B06': 'heli',
  'B105': 'heli',
  'B212': 'heli',
  'B407': 'heli',
  'B412': 'heli',
  'B429': 'heli',
  'BK17': 'heli',
  'S76': 'heli',
  'S92': 'heli',
  'R22': 'heli',
  'R44': 'heli',
  'R66': 'heli',

  // Piper PA-28
  'P28A': 'pa28',
  'P28B': 'pa28',
  'P28R': 'pa28',
  'P28T': 'pa28',
  'PA28': 'pa28',

  // Gliders
  'ASK2': 'ask21',
  'AS21': 'ask21',
  'GLID': 'ask21',
}

// Default fallback model when no dimensions available
const FALLBACK_MODEL = 'b738'

// Cache for model dimensions (populated on first use)
let modelDimensionsCache: Map<string, { wingspan: number; length: number }> | null = null

/**
 * Get dimensions for all available models
 */
function getModelDimensions(): Map<string, { wingspan: number; length: number }> {
  if (modelDimensionsCache) return modelDimensionsCache

  modelDimensionsCache = new Map()

  for (const model of AVAILABLE_MODELS) {
    const icao = MODEL_TO_ICAO[model]
    if (icao) {
      const dims = aircraftDimensionsService.getDimensions(icao)
      if (dims) {
        modelDimensionsCache.set(model, dims)
      }
    }
  }

  return modelDimensionsCache
}

/**
 * Find the closest model by dimensions using Euclidean distance
 * @param targetWingspan Target wingspan in meters
 * @param targetLength Target length in meters
 * @returns Best matching model name and scale factor
 */
function findClosestModel(
  targetWingspan: number,
  targetLength: number
): { model: string; scale: number } {
  const modelDims = getModelDimensions()

  let bestModel = FALLBACK_MODEL
  let bestDistance = Infinity
  let bestScale = 1.0

  for (const [model, dims] of modelDims) {
    // Calculate normalized Euclidean distance
    // Normalize by target dimensions to weight wingspan and length equally
    const wingspanDiff = (dims.wingspan - targetWingspan) / targetWingspan
    const lengthDiff = (dims.length - targetLength) / targetLength
    const distance = Math.sqrt(wingspanDiff * wingspanDiff + lengthDiff * lengthDiff)

    if (distance < bestDistance) {
      bestDistance = distance
      bestModel = model

      // Calculate scale factor: average of wingspan and length ratios
      const wingspanScale = targetWingspan / dims.wingspan
      const lengthScale = targetLength / dims.length
      bestScale = (wingspanScale + lengthScale) / 2
    }
  }

  return { model: bestModel, scale: bestScale }
}

export interface ModelInfo {
  modelUrl: string
  scale: number  // Scale factor to apply (1.0 for exact matches)
  matchType: 'exact' | 'mapped' | 'closest' | 'fallback'
  matchedModel?: string  // For debugging: which model was matched
}

/**
 * Airline livery information for future texture/color support
 * When we have proper liveries, this will include texture URLs
 */
export interface AirlineLivery {
  airlineCode: string       // ICAO airline code (e.g., "UAL", "SWA", "DAL")
  primaryColor: { r: number; g: number; b: number }  // RGB 0-1
  secondaryColor?: { r: number; g: number; b: number }
  name?: string             // Airline name for display
}

// Placeholder airline colors - will be expanded with proper liveries
// These are approximate brand colors for major airlines
const AIRLINE_COLORS: Record<string, AirlineLivery> = {
  'UAL': { airlineCode: 'UAL', primaryColor: { r: 0.0, g: 0.2, b: 0.5 }, name: 'United Airlines' },
  'DAL': { airlineCode: 'DAL', primaryColor: { r: 0.0, g: 0.15, b: 0.4 }, name: 'Delta Air Lines' },
  'AAL': { airlineCode: 'AAL', primaryColor: { r: 0.7, g: 0.7, b: 0.75 }, name: 'American Airlines' },
  'SWA': { airlineCode: 'SWA', primaryColor: { r: 0.9, g: 0.5, b: 0.1 }, name: 'Southwest Airlines' },
  'JBU': { airlineCode: 'JBU', primaryColor: { r: 0.0, g: 0.3, b: 0.6 }, name: 'JetBlue Airways' },
  'ASA': { airlineCode: 'ASA', primaryColor: { r: 0.0, g: 0.3, b: 0.4 }, name: 'Alaska Airlines' },
  'FDX': { airlineCode: 'FDX', primaryColor: { r: 0.3, g: 0.0, b: 0.5 }, name: 'FedEx Express' },
  'UPS': { airlineCode: 'UPS', primaryColor: { r: 0.4, g: 0.25, b: 0.1 }, name: 'UPS Airlines' },
  'BAW': { airlineCode: 'BAW', primaryColor: { r: 0.0, g: 0.1, b: 0.3 }, name: 'British Airways' },
  'DLH': { airlineCode: 'DLH', primaryColor: { r: 0.0, g: 0.15, b: 0.35 }, name: 'Lufthansa' },
  'AFR': { airlineCode: 'AFR', primaryColor: { r: 0.0, g: 0.2, b: 0.45 }, name: 'Air France' },
  'CPA': { airlineCode: 'CPA', primaryColor: { r: 0.0, g: 0.4, b: 0.35 }, name: 'Cathay Pacific' },
  'SIA': { airlineCode: 'SIA', primaryColor: { r: 0.9, g: 0.75, b: 0.3 }, name: 'Singapore Airlines' },
  'QFA': { airlineCode: 'QFA', primaryColor: { r: 0.8, g: 0.1, b: 0.1 }, name: 'Qantas' },
  'ANA': { airlineCode: 'ANA', primaryColor: { r: 0.0, g: 0.2, b: 0.5 }, name: 'All Nippon Airways' },
  'JAL': { airlineCode: 'JAL', primaryColor: { r: 0.8, g: 0.1, b: 0.2 }, name: 'Japan Airlines' },
  'EIN': { airlineCode: 'EIN', primaryColor: { r: 0.0, g: 0.5, b: 0.3 }, name: 'Aer Lingus' },
  'RYR': { airlineCode: 'RYR', primaryColor: { r: 0.0, g: 0.2, b: 0.5 }, name: 'Ryanair' },
  'EZY': { airlineCode: 'EZY', primaryColor: { r: 1.0, g: 0.5, b: 0.0 }, name: 'easyJet' },
}

class AircraftModelServiceClass {
  /**
   * Get the model URL and scale for an aircraft type
   * @param aircraftType ICAO aircraft type code (e.g., "B738", "A320")
   * @returns Model URL, scale factor, and match type
   */
  getModelInfo(aircraftType: string | null | undefined): ModelInfo {
    if (!aircraftType) {
      return {
        modelUrl: `./${FALLBACK_MODEL}.glb`,
        scale: 1.0,
        matchType: 'fallback'
      }
    }

    const normalized = aircraftType.trim().toUpperCase()

    // Check explicit mapping first
    const mappedModel = TYPE_TO_MODEL[normalized]
    if (mappedModel && AVAILABLE_MODELS.has(mappedModel)) {
      return {
        modelUrl: `./${mappedModel}.glb`,
        scale: 1.0,
        matchType: normalized.toLowerCase() === mappedModel ? 'exact' : 'mapped'
      }
    }

    // Try direct match (lowercase)
    const directMatch = normalized.toLowerCase()
    if (AVAILABLE_MODELS.has(directMatch)) {
      return {
        modelUrl: `./${directMatch}.glb`,
        scale: 1.0,
        matchType: 'exact'
      }
    }

    // No direct model - try to find closest match by dimensions
    const targetDims = aircraftDimensionsService.getDimensions(normalized)
    if (targetDims && targetDims.wingspan && targetDims.length) {
      const { model, scale } = findClosestModel(targetDims.wingspan, targetDims.length)
      return {
        modelUrl: `./${model}.glb`,
        scale,
        matchType: 'closest',
        matchedModel: model
      }
    }

    // No dimensions available - use B738 fallback at 1:1 scale
    return {
      modelUrl: `./${FALLBACK_MODEL}.glb`,
      scale: 1.0,
      matchType: 'fallback'
    }
  }

  /**
   * Check if a specific model exists for an aircraft type (exact or mapped)
   */
  hasSpecificModel(aircraftType: string | null | undefined): boolean {
    const info = this.getModelInfo(aircraftType)
    return info.matchType === 'exact' || info.matchType === 'mapped'
  }

  /**
   * Get list of all available model types
   */
  getAvailableModels(): string[] {
    return [...AVAILABLE_MODELS]
  }

  /**
   * Extract airline ICAO code from callsign
   * Airline callsigns typically have 3-letter code followed by flight number
   * e.g., "UAL730" -> "UAL", "SWA3803" -> "SWA"
   * GA callsigns (N-numbers, etc.) return null
   */
  extractAirlineCode(callsign: string | null | undefined): string | null {
    if (!callsign) return null

    // Match pattern: 3 letters followed by digits (typical airline callsign)
    const match = callsign.match(/^([A-Z]{3})\d/)
    return match ? match[1] : null
  }

  /**
   * Get airline livery information for a callsign
   * Returns undefined if airline not recognized or GA flight
   *
   * TODO: This currently returns placeholder colors. When proper liveries
   * are implemented, this will return texture URLs and more detailed info.
   */
  getAirlineLivery(callsign: string | null | undefined): AirlineLivery | undefined {
    const airlineCode = this.extractAirlineCode(callsign)
    if (!airlineCode) return undefined

    return AIRLINE_COLORS[airlineCode]
  }

  /**
   * Check if an airline has livery information available
   */
  hasAirlineLivery(callsign: string | null | undefined): boolean {
    return this.getAirlineLivery(callsign) !== undefined
  }

  /**
   * Get all registered airline codes
   */
  getRegisteredAirlines(): string[] {
    return Object.keys(AIRLINE_COLORS)
  }
}

// Singleton instance
export const aircraftModelService = new AircraftModelServiceClass()
