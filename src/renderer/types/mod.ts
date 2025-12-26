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
  heightOffset?: number  // additional height offset in meters (for 3D model)
  position?: {
    lat: number  // absolute latitude for 3D model position
    lon: number  // absolute longitude for 3D model position
  }
  // Camera/cab position override (optional) - allows specifying where the tower cab viewpoint should be
  cabPosition?: {
    lat: number  // latitude of camera position
    lon: number  // longitude of camera position
    aglHeight: number  // height above ground level in meters
  }
  cabHeading?: number  // default camera heading in degrees (0=north, 90=east)
}

/**
 * 3D view position settings for tower-positions
 *
 * Uses double-precision lat/lon for sub-meter accuracy.
 * JSON double-precision floats have ~15 significant digits, providing
 * sub-millimeter precision at any latitude.
 */
export interface View3dPosition {
  lat: number  // latitude of camera position (double precision)
  lon: number  // longitude of camera position (double precision)
  aglHeight: number  // height above ground level in meters
  heading?: number  // default camera heading in degrees (0=north, 90=east), defaults to 0
}

/**
 * 2D topdown view position settings for tower-positions (raw JSON format)
 *
 * Uses absolute lat/lon for position center.
 * Either `altitude` or `vNasRange` should be provided:
 * - `altitude`: Direct altitude in meters (for manual definitions)
 * - `vNasRange`: Raw vNAS defaultZoomRange value (converted to altitude at runtime)
 */
export interface View2dPosition {
  lat?: number  // latitude of view center (double precision)
  lon?: number  // longitude of view center (double precision)
  altitude?: number  // altitude above ground in meters (controls zoom level, 500-50000m)
  vNasRange?: number  // raw vNAS defaultZoomRange value (converted to altitude at runtime)
  heading?: number  // view rotation in degrees (0=north-up), defaults to 0
}

/**
 * Resolved 2D view position with guaranteed altitude
 *
 * This is the processed version returned by ModService.get2dPosition()
 * where altitude is always computed (from vNasRange or direct value).
 */
export interface ResolvedView2dPosition {
  lat?: number  // latitude of view center (double precision)
  lon?: number  // longitude of view center (double precision)
  altitude: number  // altitude above ground in meters (always computed)
  vNasRange?: number  // raw vNAS value if sourced from vNAS data
  heading?: number  // view rotation in degrees (0=north-up), defaults to 0
}

/**
 * Custom tower position from mods/tower-positions/{ICAO}.json
 * Supports separate 3D and 2D view defaults, both optional
 * If only 3D is provided, 2D uses the 3D position with default topdown altitude
 *
 * Note: view2d uses ResolvedView2dPosition because altitude is always
 * computed at load time (either from direct value or vNasRange conversion).
 */
export interface CustomTowerPosition {
  view3d?: View3dPosition  // 3D view camera position
  view2d?: ResolvedView2dPosition  // 2D topdown view settings (altitude always resolved)
}

/**
 * Legacy tower position format (single view, backward compatible)
 * Used for reading old tower-positions.json files
 * @deprecated Use CustomTowerPosition with view3d/view2d instead
 */
export interface LegacyTowerPosition {
  lat: number
  lon: number
  aglHeight: number
  heading?: number
}

/**
 * Map of ICAO codes to custom tower positions
 * Values can be either new format (CustomTowerPosition) or legacy format (LegacyTowerPosition)
 */
export type CustomTowerPositions = Record<string, CustomTowerPosition | LegacyTowerPosition>

/**
 * Check if a tower position is in legacy format
 */
export function isLegacyTowerPosition(pos: CustomTowerPosition | LegacyTowerPosition): pos is LegacyTowerPosition {
  return 'lat' in pos && 'lon' in pos && 'aglHeight' in pos
}

/**
 * Convert legacy tower position to new format (as 3D view only)
 */
export function convertLegacyToNewFormat(legacy: LegacyTowerPosition): CustomTowerPosition {
  return {
    view3d: {
      lat: legacy.lat,
      lon: legacy.lon,
      aglHeight: legacy.aglHeight,
      heading: legacy.heading
    }
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
  cabHeading: 0  // default to north
}
