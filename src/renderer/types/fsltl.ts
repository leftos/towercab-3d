/**
 * FSLTL (FS Live Traffic Liveries) Type Definitions
 *
 * Types for managing FSLTL aircraft model conversion, registry,
 * and matching based on airline callsign prefixes.
 */

/**
 * Texture downscaling options for conversion
 * - full: Original 4K textures (largest files)
 * - 2k: 2048px max dimension
 * - 1k: 1024px max dimension (recommended balance)
 * - 512: 512px max dimension (smallest files)
 */
export type TextureScale = 'full' | '2k' | '1k' | '512'

/**
 * Mapping from TextureScale to max pixel dimension
 */
export const TEXTURE_SCALE_PIXELS: Record<TextureScale, number | null> = {
  full: null,  // No downscaling
  '2k': 2048,
  '1k': 1024,
  '512': 512
}

/**
 * A converted FSLTL model ready for use
 */
export interface FSLTLModel {
  /** ICAO aircraft type code (e.g., "B738", "A20N") */
  aircraftType: string
  /** ICAO airline code (e.g., "AAL", "SWA"), null for base/generic livery */
  airlineCode: string | null
  /** Original FSLTL folder name (e.g., "FSLTL_B738_AAL") */
  modelName: string
  /** Path to converted GLB file */
  modelPath: string
  /** Texture resolution used during conversion */
  textureSize: TextureScale
  /** Whether the model has animations (landing gear, etc.) */
  hasAnimations: boolean
  /** File size in bytes */
  fileSize?: number
  /** Timestamp when converted */
  convertedAt?: number
}

/**
 * FSLTL settings stored in settingsStore
 */
export interface FSLTLSettings {
  /** Path to fsltl-traffic-base package folder */
  sourcePath: string | null
  /** Custom output path (null = use app mods folder) */
  outputPath: string | null
  /** Texture downscaling preference */
  textureScale: TextureScale
}

/**
 * Default FSLTL settings
 */
export const DEFAULT_FSLTL_SETTINGS: FSLTLSettings = {
  sourcePath: null,
  outputPath: null,
  textureScale: '1k'
}

/**
 * Metadata for a successfully converted model (from progress file)
 */
export interface ConvertedModelInfo {
  modelName: string
  modelPath: string
  aircraftType: string
  airlineCode: string | null
  textureSize: TextureScale
  hasAnimations: boolean
  fileSize: number
  convertedAt: number
}

/**
 * Conversion progress state
 */
export interface ConversionProgress {
  /** Current status */
  status: 'idle' | 'scanning' | 'converting' | 'complete' | 'error' | 'cancelled'
  /** Total models to convert */
  total: number
  /** Models converted so far */
  completed: number
  /** Currently converting model name */
  current: string | null
  /** List of error messages */
  errors: string[]
  /** List of successfully converted models with metadata */
  converted?: ConvertedModelInfo[]
}

/**
 * Default conversion progress state
 */
export const DEFAULT_CONVERSION_PROGRESS: ConversionProgress = {
  status: 'idle',
  total: 0,
  completed: 0,
  current: null,
  errors: [],
  converted: []
}

/**
 * A rule parsed from FSLTL_Rules.vmr
 *
 * Example VMR entries:
 * - `<ModelMatchRule TypeCode="B738" ModelName="FSLTL_B738_ZZZZ" />`
 * - `<ModelMatchRule CallsignPrefix="AAL" TypeCode="B738" ModelName="FSLTL_B738_AAL//FSLTL_B738_AAL_NC" />`
 */
export interface VMRRule {
  /** Callsign prefix (e.g., "AAL"), undefined for default/fallback rules */
  callsignPrefix?: string
  /** ICAO type code (e.g., "B738") */
  typeCode: string
  /** Model names, split by "//" for alternatives */
  modelNames: string[]
}

/**
 * Available FSLTL aircraft info (before conversion)
 * Used to populate the selection UI
 */
export interface FSLTLAircraftInfo {
  /** FSLTL folder name */
  modelName: string
  /** Parsed aircraft type code */
  aircraftType: string
  /** Parsed airline code (null for base models) */
  airlineCode: string | null
  /** Whether this is a base/generic livery (ends with _ZZZZ) */
  isBaseLivery: boolean
  /** Size on disk in bytes */
  sizeBytes: number
}

/**
 * Airline info for UI display
 */
export interface FSLTLAirlineInfo {
  /** ICAO airline code */
  code: string
  /** Friendly name (if available from VMR) */
  name?: string
  /** Aircraft types available for this airline */
  availableTypes: string[]
  /** Number of liveries/variants */
  variantCount: number
}

/**
 * Aircraft type info for UI display
 */
export interface FSLTLTypeInfo {
  /** ICAO type code */
  typeCode: string
  /** Airlines with liveries for this type */
  airlines: string[]
  /** Whether a base/generic livery exists */
  hasBaseLivery: boolean
}

/**
 * FSLTL registry stored in IndexedDB
 */
export interface FSLTLRegistry {
  /** All converted models, keyed by modelName */
  models: Map<string, FSLTLModel>
  /** Index by aircraft type for quick lookup */
  byAircraftType: Map<string, FSLTLModel[]>
  /** Index by airline code for quick lookup */
  byAirline: Map<string, FSLTLModel[]>
  /** Registry format version for migrations */
  version: number
  /** Last update timestamp */
  lastUpdated: number
}

/**
 * Serializable form of FSLTLRegistry for IndexedDB storage
 */
export interface FSLTLRegistryJSON {
  models: [string, FSLTLModel][]
  version: number
  lastUpdated: number
}

/**
 * Convert registry to JSON-serializable format
 */
export function registryToJSON(registry: FSLTLRegistry): FSLTLRegistryJSON {
  return {
    models: Array.from(registry.models.entries()),
    version: registry.version,
    lastUpdated: registry.lastUpdated
  }
}

/**
 * Parse registry from JSON format
 */
export function registryFromJSON(json: FSLTLRegistryJSON): FSLTLRegistry {
  const models = new Map<string, FSLTLModel>(json.models)

  // Rebuild indices
  const byAircraftType = new Map<string, FSLTLModel[]>()
  const byAirline = new Map<string, FSLTLModel[]>()

  for (const model of models.values()) {
    // Index by aircraft type
    const typeList = byAircraftType.get(model.aircraftType) ?? []
    typeList.push(model)
    byAircraftType.set(model.aircraftType, typeList)

    // Index by airline (only if has airline code)
    if (model.airlineCode) {
      const airlineList = byAirline.get(model.airlineCode) ?? []
      airlineList.push(model)
      byAirline.set(model.airlineCode, airlineList)
    }
  }

  return {
    models,
    byAircraftType,
    byAirline,
    version: json.version,
    lastUpdated: json.lastUpdated
  }
}

/**
 * Create empty registry
 */
export function createEmptyRegistry(): FSLTLRegistry {
  return {
    models: new Map(),
    byAircraftType: new Map(),
    byAirline: new Map(),
    version: 1,
    lastUpdated: Date.now()
  }
}

/**
 * Parse model name to extract aircraft type and airline code
 *
 * Examples:
 * - "FSLTL_B738_ZZZZ" -> { type: "B738", airline: null, isBase: true }
 * - "FSLTL_B738_AAL" -> { type: "B738", airline: "AAL", isBase: false }
 * - "FSLTL_B738_AAL_NC" -> { type: "B738", airline: "AAL", isBase: false }
 * - "FSLTL_FAIB_A320_UAL-United" -> { type: "A320", airline: "UAL", isBase: false }
 */
export function parseModelName(modelName: string): {
  aircraftType: string
  airlineCode: string | null
  isBaseLivery: boolean
} {
  // Remove FSLTL_ prefix and optional FAIB_ prefix
  const name = modelName.replace(/^FSLTL_/, '').replace(/^FAIB_/, '')

  // Check for ZZZZ (generic livery marker)
  const isBaseLivery = name.includes('_ZZZZ') || name.endsWith('_ZZZ')

  // Split by underscore
  const parts = name.split('_')

  if (parts.length === 0) {
    return { aircraftType: 'UNKN', airlineCode: null, isBaseLivery: true }
  }

  // First part is usually aircraft type (B738, A320, etc.)
  const aircraftType = parts[0]

  // Second part is usually airline code or ZZZZ
  let airlineCode: string | null = null
  if (parts.length > 1) {
    const second = parts[1]
    // ZZZZ or ZZZ means no specific airline
    if (second !== 'ZZZZ' && second !== 'ZZZ') {
      // Could be airline code or part of a longer name like "UAL-United"
      airlineCode = second.split('-')[0]  // Take code before any dash
    }
  }

  return { aircraftType, airlineCode, isBaseLivery }
}
