// Mod loading service for custom aircraft and tower models

import type {
  AircraftModManifest,
  TowerModManifest,
  LoadedMod,
  ModRegistry,
  CustomTowerPosition
} from '../types/mod'
import { isSupportedModelFormat, getModelFormat, SUPPORTED_MODEL_FORMATS } from '../types/mod'
import { modApi, isTauri } from '../utils/tauriApi'
import { customVMRService } from './CustomVMRService'

class ModService {
  private registry: ModRegistry = {
    aircraft: new Map(),
    towers: new Map()
  }
  private customTowerPositions: Map<string, CustomTowerPosition> = new Map()
  private loaded = false

  /**
   * Initialize mod loading
   * Scans the mods directory and loads all valid mods
   */
  async loadMods(): Promise<void> {
    if (this.loaded) return

    // Only load mods in Tauri environment
    if (!isTauri()) {
      this.loaded = true
      return
    }

    try {
      // Load custom VMR files first (highest priority for model matching)
      await customVMRService.loadVMRFiles()

      // Load aircraft mods (manifest.json based)
      await this.loadModsOfType('aircraft')

      // Load tower mods
      await this.loadModsOfType('towers')

      // Load custom tower positions from tower-positions.json
      await this.loadCustomTowerPositions()

      this.loaded = true
    } catch (error) {
      console.error('Failed to load mods:', error)
      this.loaded = true // Mark as loaded even on error to prevent retry loops
    }
  }

  /**
   * Load all mods of a specific type
   */
  private async loadModsOfType(modType: 'aircraft' | 'towers'): Promise<void> {
    try {
      const modsPath = await modApi.getModsPath(modType)
      const modDirs = await modApi.listModDirectories(modType)

      for (const modDir of modDirs) {
        const modPath = `${modsPath}/${modDir}`
        try {
          const manifest = await modApi.readModManifest(modPath)

          if (modType === 'aircraft') {
            await this.loadAircraftMod(manifest as AircraftModManifest, modPath)
          } else {
            await this.loadTowerMod(manifest as TowerModManifest, modPath)
          }
        } catch (error) {
          console.warn(`Failed to load mod at ${modPath}:`, error)
        }
      }
    } catch (error) {
      console.warn(`Failed to list ${modType} mods:`, error)
    }
  }

  /**
   * Load and register an aircraft mod
   */
  private async loadAircraftMod(manifest: AircraftModManifest, basePath: string): Promise<void> {
    if (!manifest.modelFile || !this.validateModelFile(manifest.modelFile)) {
      console.warn(`Invalid model file in aircraft mod: ${basePath}`)
      return
    }

    const modelUrl = `${basePath}/${manifest.modelFile}`
    this.registerAircraftMod(manifest, modelUrl, basePath)
  }

  /**
   * Load and register a tower mod
   */
  private async loadTowerMod(manifest: TowerModManifest, basePath: string): Promise<void> {
    if (!manifest.modelFile || !this.validateModelFile(manifest.modelFile)) {
      console.warn(`Invalid model file in tower mod: ${basePath}`)
      return
    }

    const modelUrl = `${basePath}/${manifest.modelFile}`
    this.registerTowerMod(manifest, modelUrl, basePath)
  }

  /**
   * Load custom tower positions from tower-positions.json
   */
  private async loadCustomTowerPositions(): Promise<void> {
    try {
      const json = await modApi.readTowerPositions()

      // json is an object mapping ICAO codes to CustomTowerPosition objects
      for (const [icao, position] of Object.entries(json)) {
        const customPos = position as CustomTowerPosition

        // Validate required fields
        if (typeof customPos.lat === 'number' &&
            typeof customPos.lon === 'number' &&
            typeof customPos.aglHeight === 'number') {
          const position: CustomTowerPosition = {
            lat: customPos.lat,
            lon: customPos.lon,
            aglHeight: customPos.aglHeight,
            heading: customPos.heading ?? 0  // Default to 0 if not specified
          }

          // Validate and preserve optional positionOffset
          if (customPos.positionOffset) {
            if (typeof customPos.positionOffset.latMeters === 'number' &&
                typeof customPos.positionOffset.lonMeters === 'number') {
              position.positionOffset = {
                latMeters: customPos.positionOffset.latMeters,
                lonMeters: customPos.positionOffset.lonMeters
              }
            } else {
              console.warn(`Invalid positionOffset for ${icao}: latMeters and lonMeters must be numbers`)
            }
          }

          this.customTowerPositions.set(icao.toUpperCase(), position)
        } else {
          console.warn(`Invalid tower position for ${icao}: missing required fields (lat, lon, aglHeight)`)
        }
      }

      const count = this.customTowerPositions.size
      if (count > 0) {
        console.log(`Loaded ${count} custom tower positions from tower-positions.json`)
      }
    } catch (error) {
      console.warn('Failed to load tower-positions.json:', error)
      // Not a fatal error - app continues with defaults
    }
  }

  /**
   * Get custom tower position for a specific airport
   */
  getCustomTowerPosition(icao: string): CustomTowerPosition | undefined {
    return this.customTowerPositions.get(icao.toUpperCase())
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
