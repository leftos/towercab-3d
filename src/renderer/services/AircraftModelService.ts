/**
 * Aircraft Model Service
 *
 * Maps ICAO aircraft type codes to available 3D model files.
 * When a specific model exists, it's used at 1:1 scale.
 * When no model exists, finds the closest match by FAA dimensions and applies scaling.
 *
 * Model Matching Priority:
 * 1. Custom VMR rules (user mods) - airline+type or type-only
 * 2. FSLTL models with exact airline+type match
 * 3. FSLTL closest airline model (scaled) - same airline, different but similar type
 * 4. FSLTL base livery for exact type (no airline-specific)
 * 5. FSLTL closest base model (scaled) - any FSLTL model close in size
 * 6. Built-in models with exact/mapped match
 * 7. Built-in models with direct lowercase match
 * 8. Built-in models with closest size match (scaled)
 * 9. FSLTL airline-specific fallback from common types
 * 10. FSLTL GA fallback (C172) for GA callsigns, or B738 for airlines
 * 11. Fallback to built-in PA28 for GA, or B738 for airlines
 *
 * GA Detection:
 * GA callsigns are detected by pattern (N-numbers, country registrations like C-XXXX,
 * G-XXXX, etc.) or by not matching the airline pattern (3 letters + digits).
 * GA aircraft use C172 (FSLTL) or PA28 (built-in) as fallback instead of B738.
 *
 * The goal is to prioritize visual similarity (shape + size) over generic fallbacks.
 * For airlines, we prefer a scaled version of their actual livery over a generic B738.
 * For GA aircraft, we prefer a scaled small aircraft over a giant airliner.
 *
 * Models from Flightradar24/fr24-3d-models (GPL-2.0, originally from FlightGear)
 */

import { convertToAssetUrlSync } from '../utils/tauriApi'
import { aircraftDimensionsService, type AircraftDimensions } from './AircraftDimensionsService'
import { customVMRService } from './CustomVMRService'
import { userVMRService } from './UserVMRService'
import { MSFSModelConversionService, type SourceModelInfo } from './MSFSModelConversionService'

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
// GA fallback for non-airline aircraft (small single-engine)
const GA_FALLBACK_MODEL = 'pa28'

/**
 * Extract base aircraft type code from FAA format strings
 * Handles formats like: "B738", "B738/L", "H/B738/L", "B738/G"
 * Returns the 2-4 character aircraft type code
 */
function extractBaseAircraftType(aircraftType: string): string {
  const trimmed = aircraftType.trim().toUpperCase()

  // If no slash, return as-is
  if (!trimmed.includes('/')) {
    return trimmed
  }

  // Split by slash and find the aircraft type part
  // Aircraft types are typically 2-4 alphanumeric characters
  const parts = trimmed.split('/')

  // Common patterns:
  // "B738/L" -> ["B738", "L"] -> return "B738"
  // "H/B738/L" -> ["H", "B738", "L"] -> return "B738"
  // The aircraft type is usually 3-4 chars, while prefix (H/M/L) and suffix are 1-2 chars

  for (const part of parts) {
    // Aircraft type codes are 2-4 characters and start with a letter
    if (part.length >= 2 && part.length <= 4 && /^[A-Z]/.test(part)) {
      // Exclude single-letter wake categories and short equipment codes
      if (part.length === 1) continue
      // This looks like an aircraft type
      return part
    }
  }

  // Fallback: return first part
  return parts[0]
}

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
 * @returns Best matching model name and non-uniform scale factors
 */
function findClosestModel(
  targetWingspan: number,
  targetLength: number
): { model: string; scale: { x: number; y: number; z: number } } {
  const modelDims = getModelDimensions()

  let bestModel = FALLBACK_MODEL
  let bestDistance = Infinity
  let bestScale = { x: 1, y: 1, z: 1 }

  for (const [model, dims] of modelDims) {
    // Calculate normalized Euclidean distance
    // Normalize by target dimensions to weight wingspan and length equally
    const wingspanDiff = (dims.wingspan - targetWingspan) / targetWingspan
    const lengthDiff = (dims.length - targetLength) / targetLength
    const distance = Math.sqrt(wingspanDiff * wingspanDiff + lengthDiff * lengthDiff)

    if (distance < bestDistance) {
      bestDistance = distance
      bestModel = model

      // Calculate non-uniform scale factors
      // X = wingspan (left-right), Z = length (fuselage), Y = average (height)
      const wingspanScale = targetWingspan / dims.wingspan
      const lengthScale = targetLength / dims.length
      bestScale = {
        x: wingspanScale,
        y: (wingspanScale + lengthScale) / 2,  // Average for proportional height
        z: lengthScale
      }
    }
  }

  return { model: bestModel, scale: bestScale }
}

export interface ModelInfo {
  modelUrl: string
  scale: { x: number; y: number; z: number }  // Non-uniform scale factors
  matchType: 'exact' | 'closest' | 'fallback' | 'pending'
  matchedModel?: string  // For debugging: which model was matched
  dimensions: AircraftDimensions  // Dimensions of the actual model being used
  /** Additional heading rotation in degrees (180 for FSLTL models, custom for mods) */
  rotationOffset?: number
  /** Whether the model has animations (landing gear, etc.) */
  hasAnimations?: boolean
  /** VMR variation name (e.g., "FSLTL_FAIB_B738_American") for FSLTL matches */
  vmrVariationName?: string
  /** Whether this is an FSLTL/VMR model with custom liveries (affects tinting behavior) */
  isFsltl?: boolean
  /** MSFS model source info - set when conversion is pending */
  pendingMsfsModel?: SourceModelInfo
  /** Whether an MSFS model is currently being converted */
  msfsConversionPending?: boolean
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
  /** Cache of ModelInfo results by cache key (type_airline) */
  private modelInfoCache = new Map<string, ModelInfo>()

  /** Keys with pending MSFS conversions - will be invalidated when conversion completes */
  private pendingConversions = new Set<string>()

  /** Callsigns already logged (to avoid spam - only log once per callsign per app run) */
  private loggedCallsigns = new Set<string>()

  /**
   * Log model matching details for a callsign (only once per callsign per app run)
   */
  private logModelMatch(
    callsign: string | null | undefined,
    aircraftType: string,
    airlineCode: string | null,
    step: string,
    result: string
  ): void {
    if (!callsign || this.loggedCallsigns.has(callsign)) return
    console.log(`[ModelMatch] ${callsign} (${aircraftType}/${airlineCode ?? 'no-airline'}): ${step} -> ${result}`)
  }

  /**
   * Mark a callsign as logged (prevents further logging for this callsign)
   */
  private markLogged(callsign: string | null | undefined): void {
    if (callsign) this.loggedCallsigns.add(callsign)
  }

  /**
   * Get cache key for a type+airline combination
   */
  private getCacheKey(aircraftType: string, airlineCode: string | null): string {
    return airlineCode ? `${aircraftType}_${airlineCode}` : aircraftType
  }

  /**
   * Invalidate cache entries when MSFS conversion completes
   * Called by MSFSModelConversionService after successful conversion
   */
  invalidateCacheForModel(modelName: string): void {
    // Remove all cache entries that might be affected by this model
    // We don't know exactly which type+airline combos map to this model,
    // so we clear entries that have pending conversions
    for (const key of this.pendingConversions) {
      this.modelInfoCache.delete(key)
    }
    this.pendingConversions.clear()
    console.log(`[AircraftModelService] Cache invalidated for model: ${modelName}`)

    // Notify UI components that model info has changed
    // This allows components like ModelMatchingModal to re-render with updated match types
    window.dispatchEvent(new CustomEvent('model-conversion-complete', { detail: { modelName } }))
  }

  /**
   * Clear all cached model info (call when settings change)
   */
  clearCache(): void {
    this.modelInfoCache.clear()
    this.pendingConversions.clear()
  }

  /**
   * Get dimensions for a model file
   * @param modelName Model file name (without extension, e.g., "b738")
   * @returns Dimensions of the model, or B738 fallback if not found
   */
  private getModelDimensions(modelName: string): AircraftDimensions {
    const icao = MODEL_TO_ICAO[modelName]
    if (icao) {
      const dims = aircraftDimensionsService.getDimensions(icao)
      if (dims) return dims
    }
    // Fallback to B738 dimensions
    return { wingspan: 35.78, length: 39.47 }
  }

  /**
   * Check for MSFS model match
   * Tries VMR rules first, then falls back to type+airline and type-only matches
   *
   * @param cacheKey Cache key for tracking pending conversions
   * @param callsign Optional callsign for logging
   * @returns Model info with converted GLB, or null if no MSFS model available
   */
  private checkMsfsModel(
    aircraftType: string,
    airlineCode: string | null,
    cacheKey: string,
    callsign?: string | null
  ): ModelInfo | null {
    const log = (step: string, result: string) => {
      this.logModelMatch(callsign, aircraftType, airlineCode, step, result)
    }
    const targetDims = aircraftDimensionsService.getDimensions(aircraftType)
    const defaultDims = { wingspan: 35.78, length: 39.47 }
    const uniformScale = { x: 1, y: 1, z: 1 }

    // Helper to create result for exact match (scale 1:1)
    const createExactResult = (
      cachedPath: string,
      modelName: string
    ): ModelInfo => ({
      modelUrl: convertToAssetUrlSync(cachedPath),
      scale: uniformScale,
      matchType: 'exact',
      matchedModel: modelName,
      dimensions: targetDims ?? defaultDims,
      rotationOffset: 180,
      isFsltl: true
    })

    // Helper to create result for closest match (with scaling)
    const createClosestResult = (
      cachedPath: string,
      modelName: string,
      scale: { x: number; y: number; z: number }
    ): ModelInfo => ({
      modelUrl: convertToAssetUrlSync(cachedPath),
      scale,
      matchType: 'closest',
      matchedModel: modelName,
      dimensions: targetDims ?? defaultDims,
      rotationOffset: 180,
      isFsltl: true
    })

    // Helper to create pending result (used when conversion is in progress)
    const createPendingResult = (
      modelName: string,
      sourceInfo: SourceModelInfo,
      scale: { x: number; y: number; z: number } = uniformScale
    ): ModelInfo => ({
      modelUrl: '', // No URL yet - conversion pending
      scale,
      matchType: 'pending',
      matchedModel: modelName,
      dimensions: targetDims ?? defaultDims,
      rotationOffset: 180,
      isFsltl: true,
      pendingMsfsModel: sourceInfo,
      msfsConversionPending: true
    })

    // Helper to start conversion and return pending result
    const startConversionAndReturnPending = (
      sourceInfo: SourceModelInfo,
      scale: { x: number; y: number; z: number } = uniformScale
    ): ModelInfo => {
      this.pendingConversions.add(cacheKey)
      console.log(`[ModelMatch] Starting conversion for ${sourceInfo.modelName}, cacheKey=${cacheKey}`)
      MSFSModelConversionService.convertModel(sourceInfo)
        .then((result) => {
          console.log(`[ModelMatch] Conversion completed for ${sourceInfo.modelName}:`, result.success ? 'success' : 'failed', result.glbPath || result.error)
          this.invalidateCacheForModel(sourceInfo.modelName)
        })
        .catch((err) => {
          console.error(`[ModelMatch] Conversion error for ${sourceInfo.modelName}:`, err)
          this.invalidateCacheForModel(sourceInfo.modelName)
        })
      return createPendingResult(sourceInfo.modelName, sourceInfo, scale)
    }

    // Helper to try a source model (cached, converting, or start conversion)
    const trySourceModel = (
      sourceInfo: SourceModelInfo,
      scale: { x: number; y: number; z: number } = uniformScale
    ): ModelInfo | null => {
      // Skip if previously failed
      if (MSFSModelConversionService.hasConversionFailed(sourceInfo.modelName, sourceInfo.source)) {
        return null
      }

      // Check if cached
      const cachedPath = MSFSModelConversionService.getCachedModel(sourceInfo.modelName, sourceInfo.source)
      if (cachedPath) {
        log('trySourceModel', `cache HIT for ${sourceInfo.modelName} -> ${cachedPath}`)
        return scale === uniformScale
          ? createExactResult(cachedPath, sourceInfo.modelName)
          : createClosestResult(cachedPath, sourceInfo.modelName, scale)
      }

      // Already converting - return pending and track the cache key
      if (MSFSModelConversionService.isConverting(sourceInfo.modelName, sourceInfo.source)) {
        this.pendingConversions.add(cacheKey)
        return createPendingResult(sourceInfo.modelName, sourceInfo, scale)
      }

      // Start conversion
      return startConversionAndReturnPending(sourceInfo, scale)
    }

    // 1. Try VMR rules first (highest priority)
    // Get settings to respect source priority and enabled state
    const msfsSettings = MSFSModelConversionService.getSettings()
    const alternatives = userVMRService.getAlternatives(aircraftType, airlineCode)
    if (alternatives.length > 0) {
      log('1. VMR rules', `found ${alternatives.length} alternatives: ${alternatives.join(', ')}`)
    } else if (!userVMRService.hasRules()) {
      log('1. VMR rules', 'no VMR files configured')
    } else {
      log('1. VMR rules', `no rule for ${aircraftType}/${airlineCode}`)
    }
    for (const modelName of alternatives) {
      // Check if model is already cached (pre-converted)
      // IMPORTANT: Use priority order and only check enabled sources
      for (const source of msfsSettings.priority) {
        const isEnabled = source === 'fsltl' ? msfsSettings.enableFsltl : msfsSettings.enableAig
        if (!isEnabled) continue

        const cachedPath = MSFSModelConversionService.getCachedModel(modelName, source)
        if (cachedPath) {
          log('1. VMR rules', `MATCH cached ${source}:${modelName}`)
          return createExactResult(cachedPath, modelName)
        }
      }

      // Try to find source model for on-demand conversion
      // resolveSourceModel already respects priority and enabled state
      const sourceInfo = MSFSModelConversionService.resolveSourceModel(modelName)
      if (sourceInfo) {
        const result = trySourceModel(sourceInfo)
        if (result) {
          log('1. VMR rules', `MATCH ${result.matchType} ${modelName}`)
          return result
        }
      }
      // No source for this alternative - continue to next
    }

    // 2. Try type+airline exact match from indexed models
    if (airlineCode) {
      const typeAirlineSource = MSFSModelConversionService.findModelByTypeAndAirline(aircraftType, airlineCode)
      if (typeAirlineSource) {
        const result = trySourceModel(typeAirlineSource)
        if (result) {
          log('2. type+airline', `MATCH ${result.matchType} ${typeAirlineSource.modelName}`)
          return result
        }
      } else {
        log('2. type+airline', `no match for ${aircraftType}+${airlineCode}`)
      }
    }

    // 3. Try closest airline model (scaled) - same airline, different but similar type
    if (airlineCode) {
      const closestAirline = MSFSModelConversionService.findClosestModelForAirline(aircraftType, airlineCode)
      if (closestAirline) {
        const result = trySourceModel(closestAirline.model, closestAirline.scale)
        if (result) {
          log('3. closest airline', `MATCH ${result.matchType} ${closestAirline.model.modelName} (dist=${closestAirline.distance.toFixed(3)})`)
          return result
        }
      } else {
        log('3. closest airline', `no similar model for airline ${airlineCode}`)
      }
    }

    // 4. Try type-only match (base livery)
    const typeOnlySource = MSFSModelConversionService.findModelByTypeAndAirline(aircraftType, null)
    if (typeOnlySource) {
      const result = trySourceModel(typeOnlySource)
      if (result) {
        log('4. type-only base', `MATCH ${result.matchType} ${typeOnlySource.modelName}`)
        return result
      }
    } else {
      log('4. type-only base', `no base livery for ${aircraftType}`)
    }

    // 5. Try closest any model (scaled) - any MSFS model close in size
    const closestAny = MSFSModelConversionService.findClosestModel(aircraftType)
    if (closestAny) {
      const result = trySourceModel(closestAny.model, closestAny.scale)
      if (result) {
        log('5. closest any', `MATCH ${result.matchType} ${closestAny.model.modelName} (dist=${closestAny.distance.toFixed(3)})`)
        return result
      }
    } else {
      log('5. closest any', `no similar model found`)
    }

    // No MSFS model available (will fall back to built-in)
    log('MSFS', 'no match, falling back to built-in')
    return null
  }

  /**
   * Get the model URL and scale for an aircraft type
   * @param aircraftType ICAO aircraft type code (e.g., "B738", "A320")
   * @param callsign Optional callsign for airline-specific model matching
   * @returns Model URL, scale factor, and match type
   */
  getModelInfo(aircraftType: string | null | undefined, callsign?: string | null): ModelInfo {
    const uniformScale = { x: 1, y: 1, z: 1 }
    const b738Dims = { wingspan: 35.78, length: 39.47 }
    const isGA = this.isGACallsign(callsign)
    const airlineCode = this.extractAirlineCode(callsign)

    // No aircraft type - try airline-specific narrowbody fallback, then generic
    if (!aircraftType) {
      // For airline callsigns, try to find an airline-specific narrowbody model
      if (airlineCode && !isGA) {
        const airlineFallback = MSFSModelConversionService.findAirlineFallbackModel(airlineCode)
        if (airlineFallback) {
          // Check cache first (use a special cache key for unknown type)
          const cacheKey = `_UNKNOWN_${airlineCode}`
          const cached = this.modelInfoCache.get(cacheKey)
          if (cached) {
            return cached
          }

          // Try to get or convert the model
          const cachedPath = MSFSModelConversionService.getCachedModel(airlineFallback.modelName, airlineFallback.source)
          if (cachedPath) {
            const result: ModelInfo = {
              modelUrl: convertToAssetUrlSync(cachedPath),
              scale: uniformScale,
              matchType: 'fallback',
              matchedModel: airlineFallback.modelName,
              dimensions: b738Dims,
              rotationOffset: 180,
              isFsltl: true
            }
            this.modelInfoCache.set(cacheKey, result)
            this.logModelMatch(callsign, 'N/A', airlineCode, 'airline-fallback', `MATCH ${airlineFallback.modelName}`)
            this.markLogged(callsign)
            return result
          }

          // Not cached - start conversion if not already converting
          if (!MSFSModelConversionService.isConverting(airlineFallback.modelName, airlineFallback.source) &&
              !MSFSModelConversionService.hasConversionFailed(airlineFallback.modelName, airlineFallback.source)) {
            MSFSModelConversionService.convertModel(airlineFallback)
              .then(() => {
                this.modelInfoCache.delete(cacheKey)
                window.dispatchEvent(new CustomEvent('model-conversion-complete', { detail: { modelName: airlineFallback.modelName } }))
              })
              .catch(() => {
                this.modelInfoCache.delete(cacheKey)
              })
          }

          // Return pending result
          const pendingResult: ModelInfo = {
            modelUrl: '',
            scale: uniformScale,
            matchType: 'pending',
            matchedModel: airlineFallback.modelName,
            dimensions: b738Dims,
            rotationOffset: 180,
            isFsltl: true,
            pendingMsfsModel: airlineFallback,
            msfsConversionPending: true
          }
          this.modelInfoCache.set(cacheKey, pendingResult)
          this.logModelMatch(callsign, 'N/A', airlineCode, 'airline-fallback', `PENDING ${airlineFallback.modelName}`)
          this.markLogged(callsign)
          return pendingResult
        }
      }

      // Fall back to generic model (PA28 for GA, B738 otherwise)
      const fallbackModel = isGA ? GA_FALLBACK_MODEL : FALLBACK_MODEL
      const fallbackDims = this.getModelDimensions(fallbackModel)
      return {
        modelUrl: `./${fallbackModel}.glb`,
        scale: uniformScale,
        matchType: 'fallback',
        dimensions: fallbackDims
      }
    }

    // Extract base aircraft type (strips equipment suffixes like "/L" from "B738/L")
    const normalized = extractBaseAircraftType(aircraftType)
    const cacheKey = this.getCacheKey(normalized, airlineCode)

    // Check cache first - avoids expensive lookups every frame
    const cached = this.modelInfoCache.get(cacheKey)
    if (cached) {
      return cached
    }

    // Helper for final logging
    const logFinal = (step: string, result: ModelInfo) => {
      this.logModelMatch(callsign, normalized, airlineCode, step, `${result.matchType} -> ${result.matchedModel ?? result.modelUrl}`)
      this.markLogged(callsign)
    }

    // 1. Check MSFS models (highest priority - handles VMR rules + on-demand conversion)
    const msfsModel = this.checkMsfsModel(normalized, airlineCode, cacheKey, callsign)
    if (msfsModel) {
      this.modelInfoCache.set(cacheKey, msfsModel)
      logFinal('FINAL', msfsModel)
      return msfsModel
    }

    // 2. Check custom VMR rules from mods folder
    const customVMRMatch = customVMRService.findBestModel(normalized, airlineCode)
    if (customVMRMatch) {
      const targetDims = aircraftDimensionsService.getDimensions(normalized)
      const result: ModelInfo = {
        modelUrl: customVMRMatch.modelPath,
        scale: {
          x: customVMRMatch.scale,
          y: customVMRMatch.scale,
          z: customVMRMatch.scale
        },
        matchType: 'exact',
        matchedModel: customVMRMatch.modelName,
        dimensions: targetDims ?? b738Dims,
        rotationOffset: customVMRMatch.rotationOffset?.y,
        isFsltl: true
      }
      this.modelInfoCache.set(cacheKey, result)
      logFinal('custom VMR', result)
      return result
    }

    // 3. Check explicit mapping for built-in models
    const mappedModel = TYPE_TO_MODEL[normalized]
    if (mappedModel && AVAILABLE_MODELS.has(mappedModel)) {
      const modelDims = this.getModelDimensions(mappedModel)
      const result: ModelInfo = {
        modelUrl: `./${mappedModel}.glb`,
        scale: uniformScale,
        matchType: 'exact',
        matchedModel: mappedModel,
        dimensions: modelDims
      }
      this.modelInfoCache.set(cacheKey, result)
      logFinal('built-in map', result)
      return result
    }

    // 4. Try direct match (lowercase)
    const directMatch = normalized.toLowerCase()
    if (AVAILABLE_MODELS.has(directMatch)) {
      const directDims = this.getModelDimensions(directMatch)
      const result: ModelInfo = {
        modelUrl: `./${directMatch}.glb`,
        scale: uniformScale,
        matchType: 'exact',
        matchedModel: directMatch,
        dimensions: directDims
      }
      this.modelInfoCache.set(cacheKey, result)
      logFinal('built-in direct', result)
      return result
    }

    // 5. No direct built-in model - try to find closest built-in match by dimensions
    const targetDims = aircraftDimensionsService.getDimensions(normalized)
    if (targetDims && targetDims.wingspan && targetDims.length) {
      const { model, scale } = findClosestModel(targetDims.wingspan, targetDims.length)
      const closestDims = this.getModelDimensions(model)
      const result: ModelInfo = {
        modelUrl: `./${model}.glb`,
        scale,
        matchType: 'closest',
        matchedModel: model,
        dimensions: closestDims
      }
      this.modelInfoCache.set(cacheKey, result)
      logFinal('built-in closest', result)
      return result
    }

    // 6. Final fallback - use built-in model (PA28 for GA, B738 otherwise)
    const fallbackModel = isGA ? GA_FALLBACK_MODEL : FALLBACK_MODEL
    const finalFallbackDims = this.getModelDimensions(fallbackModel)
    const result: ModelInfo = {
      modelUrl: `./${fallbackModel}.glb`,
      scale: uniformScale,
      matchType: 'fallback',
      matchedModel: fallbackModel,
      dimensions: finalFallbackDims
    }
    this.modelInfoCache.set(cacheKey, result)
    logFinal('built-in fallback', result)
    return result
  }

  /**
   * Check if a specific model exists for an aircraft type (exact or mapped)
   */
  hasSpecificModel(aircraftType: string | null | undefined): boolean {
    const info = this.getModelInfo(aircraftType)
    return info.matchType === 'exact'
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
   * Check if a callsign appears to be a GA/private aircraft registration
   * rather than an airline callsign.
   *
   * GA callsigns are typically:
   * - N-numbers: N123AB, N1234A, N12345 (US)
   * - C-XXXX: C-FABC (Canada)
   * - G-XXXX: G-ABCD (UK)
   * - VH-XXX: VH-ABC (Australia)
   * - D-XXXX: D-ABCD (Germany)
   * - F-XXXX: F-ABCD (France)
   * - Or any callsign that doesn't match the airline pattern (3 letters + digits)
   *
   * @param callsign The aircraft callsign
   * @returns true if this appears to be a GA registration
   */
  isGACallsign(callsign: string | null | undefined): boolean {
    if (!callsign) return false

    const upper = callsign.toUpperCase()

    // Common registration patterns that are definitely GA
    // N-numbers (US): N followed by 1-5 alphanumeric
    if (/^N[0-9][0-9A-Z]{0,4}$/.test(upper)) return true

    // Country prefixes with hyphen: C-XXXX, G-XXXX, D-XXXX, F-XXXX, VH-XXX, etc.
    if (/^[A-Z]{1,2}-[A-Z0-9]{2,5}$/.test(upper)) return true

    // If it's not an airline callsign (3 letters + digits), treat as GA
    // This catches other registration formats
    return this.extractAirlineCode(callsign) === null
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

  /**
   * Wait for a model conversion to complete
   * Useful for ensuring a model is ready before trying to load it
   *
   * @param aircraftType - Aircraft type code (e.g., "B738")
   * @param callsign - Optional callsign to help with model matching
   * @returns Conversion result when complete
   */
  async waitForConversion(
    aircraftType: string | null | undefined,
    callsign?: string | null
  ): Promise<{ success: boolean; glbPath?: string; error?: string }> {
    // Poll for conversion completion every 100ms
    const maxWaitTime = 30000 // 30 second timeout
    const pollInterval = 100
    const startTime = Date.now()

    while (Date.now() - startTime < maxWaitTime) {
      const modelInfo = this.getModelInfo(aircraftType, callsign)

      // If model is ready (not pending), return success
      if (modelInfo.matchType !== 'pending') {
        return {
          success: true,
          glbPath: modelInfo.modelUrl
        }
      }

      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, pollInterval))
    }

    return {
      success: false,
      error: 'Model conversion timed out after 30 seconds'
    }
  }
}

// Singleton instance
export const aircraftModelService = new AircraftModelServiceClass()
