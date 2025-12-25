// Mod types for custom aircraft and tower models

// Supported 3D model formats
// - GLB/GLTF: Recommended, best performance
// - OBJ: Widely supported, good for SketchUp exports
// - DAE: Collada format, native SketchUp export format
// - STL: Simple geometry only (no textures/materials)
export const SUPPORTED_MODEL_FORMATS = ['.glb', '.gltf', '.obj', '.dae', '.stl'] as const
export type SupportedModelFormat = (typeof SUPPORTED_MODEL_FORMATS)[number]

export function isSupportedModelFormat(filename: string): boolean {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'))
  return SUPPORTED_MODEL_FORMATS.includes(ext as SupportedModelFormat)
}

export function getModelFormat(filename: string): SupportedModelFormat | null {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.')) as SupportedModelFormat
  return SUPPORTED_MODEL_FORMATS.includes(ext) ? ext : null
}

export interface AircraftModManifest {
  name: string
  author: string
  version: string
  description?: string
  modelFile: string  // relative path to model file (.glb, .gltf, .obj, .dae, .stl)
  aircraftTypes: string[]  // ICAO type codes this model applies to, e.g., ["B738", "B737"]
  scale: number  // scale factor for the model
  rotationOffset?: {
    x: number  // pitch offset in degrees
    y: number  // yaw offset in degrees
    z: number  // roll offset in degrees
  }
}

export interface TowerModManifest {
  name: string
  author: string
  version: string
  description?: string
  modelFile: string  // relative path to model file (.glb, .gltf, .obj, .dae, .stl)
  airports: string[]  // ICAO codes this tower applies to, e.g., ["KJFK", "KLAX"]
  scale: number  // scale factor for the model
  heightOffset?: number  // additional height offset in meters
  positionOffset?: {
    lat: number  // offset in degrees
    lon: number  // offset in degrees
  }
}

export interface LoadedMod<T extends AircraftModManifest | TowerModManifest> {
  manifest: T
  modelUrl: string  // URL to the loaded model
  basePath: string  // base path of the mod folder
}

export interface ModRegistry {
  aircraft: Map<string, LoadedMod<AircraftModManifest>>  // keyed by aircraft type code
  towers: Map<string, LoadedMod<TowerModManifest>>  // keyed by airport ICAO
}

// =============================================================================
// VMR (Visual Model Rules) Types
// =============================================================================

/**
 * A rule parsed from a custom VMR file in the mods folder
 *
 * VMR files use XML format compatible with MSFS:
 * ```xml
 * <ModelMatchRule TypeCode="B738" ModelName="MyB738_Base" />
 * <ModelMatchRule CallsignPrefix="AAL" TypeCode="B738" ModelName="MyB738_American" />
 * ```
 */
export interface CustomVMRRule {
  /** ICAO type code (e.g., "B738", "A320") */
  typeCode: string
  /** Model folder name(s) relative to mods/aircraft/, alternatives separated by "//" in VMR */
  modelNames: string[]
  /** Callsign prefix for airline-specific rules (e.g., "AAL"), undefined for default rules */
  callsignPrefix?: string
}

/**
 * A matched model from custom VMR rules
 */
export interface CustomVMRMatch {
  /** Path to the model file (Tauri asset URL) */
  modelPath: string
  /** Original VMR model name (folder name) */
  modelName: string
  /** Aircraft type from VMR rule */
  aircraftType: string
  /** Airline code if airline-specific, null for base livery */
  airlineCode: string | null
  /** Scale factor (from manifest if present, else 1.0) */
  scale: number
  /** Rotation offset in degrees (from manifest if present) */
  rotationOffset?: { x: number; y: number; z: number }
}

// Default mod manifest templates
export const DEFAULT_AIRCRAFT_MOD: Partial<AircraftModManifest> = {
  scale: 1.0,
  rotationOffset: { x: 0, y: 0, z: 0 }
}

export const DEFAULT_TOWER_MOD: Partial<TowerModManifest> = {
  scale: 1.0,
  heightOffset: 0,
  positionOffset: { lat: 0, lon: 0 }
}
