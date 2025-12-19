// Mod types for custom aircraft and tower models

export interface AircraftModManifest {
  name: string
  author: string
  version: string
  description?: string
  modelFile: string  // relative path to .glb/.gltf file
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
  modelFile: string  // relative path to .glb/.gltf file
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
