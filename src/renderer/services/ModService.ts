// Mod loading service for custom aircraft and tower models

import type {
  AircraftModManifest,
  TowerModManifest,
  LoadedMod,
  ModRegistry
} from '../types/mod'
import { isSupportedModelFormat, getModelFormat, SUPPORTED_MODEL_FORMATS } from '../types/mod'

class ModService {
  private registry: ModRegistry = {
    aircraft: new Map(),
    towers: new Map()
  }
  private loaded = false

  /**
   * Initialize mod loading
   * In Electron, this would scan the mods directory
   * For now, this is a placeholder for the mod loading logic
   */
  async loadMods(): Promise<void> {
    if (this.loaded) return

    try {
      // In a full implementation, this would:
      // 1. Use IPC to communicate with main process
      // 2. Scan mods/aircraft and mods/towers directories
      // 3. Load and validate manifest.json files
      // 4. Register models in the registry

      // For now, we'll just mark as loaded
      this.loaded = true
      console.log('Mod service initialized (no mods loaded)')
    } catch (error) {
      console.error('Failed to load mods:', error)
    }
  }

  /**
   * Get aircraft model for a specific aircraft type
   */
  getAircraftModel(aircraftType: string): LoadedMod<AircraftModManifest> | undefined {
    return this.registry.aircraft.get(aircraftType.toUpperCase())
  }

  /**
   * Get tower model for a specific airport
   */
  getTowerModel(icao: string): LoadedMod<TowerModManifest> | undefined {
    return this.registry.towers.get(icao.toUpperCase())
  }

  /**
   * Register an aircraft mod
   */
  registerAircraftMod(
    manifest: AircraftModManifest,
    modelUrl: string,
    basePath: string
  ): void {
    const loadedMod: LoadedMod<AircraftModManifest> = {
      manifest,
      modelUrl,
      basePath
    }

    // Register for each aircraft type
    for (const aircraftType of manifest.aircraftTypes) {
      this.registry.aircraft.set(aircraftType.toUpperCase(), loadedMod)
    }
  }

  /**
   * Register a tower mod
   */
  registerTowerMod(
    manifest: TowerModManifest,
    modelUrl: string,
    basePath: string
  ): void {
    const loadedMod: LoadedMod<TowerModManifest> = {
      manifest,
      modelUrl,
      basePath
    }

    // Register for each airport
    for (const airport of manifest.airports) {
      this.registry.towers.set(airport.toUpperCase(), loadedMod)
    }
  }

  /**
   * Get all loaded aircraft mods
   */
  getAllAircraftMods(): Map<string, LoadedMod<AircraftModManifest>> {
    return this.registry.aircraft
  }

  /**
   * Get all loaded tower mods
   */
  getAllTowerMods(): Map<string, LoadedMod<TowerModManifest>> {
    return this.registry.towers
  }

  /**
   * Check if mods are loaded
   */
  isLoaded(): boolean {
    return this.loaded
  }

  /**
   * Get mod statistics
   */
  getStats(): { aircraftModels: number; towerModels: number } {
    return {
      aircraftModels: this.registry.aircraft.size,
      towerModels: this.registry.towers.size
    }
  }

  /**
   * Validate a model file path
   * Returns true if the file has a supported format
   */
  validateModelFile(modelFile: string): boolean {
    return isSupportedModelFormat(modelFile)
  }

  /**
   * Get the format of a model file
   */
  getModelFormat(modelFile: string): string | null {
    return getModelFormat(modelFile)
  }

  /**
   * Get list of supported model formats
   */
  getSupportedFormats(): readonly string[] {
    return SUPPORTED_MODEL_FORMATS
  }
}

// Export singleton instance
export const modService = new ModService()
export default modService
