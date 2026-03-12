// Mod loading service for custom aircraft and tower models

import { TOPDOWN_ALTITUDE_DEFAULT, VNAS_RANGE_TO_ALTITUDE_MULTIPLIER } from '../constants/camera'
import type {
  AircraftModManifest,
  CustomTowerPosition,
  LegacyTowerPosition,
  LoadedMod,
  ModRegistry,
  RawView3dPosition,
  ResolvedView2dPosition,
  TowerModManifest,
  View2dPosition,
  View3dPosition,
} from '../types/mod'
import {
  convertLegacyToNewFormat,
  getModelFormat,
  isLegacyTowerPosition,
  isSupportedModelFormat,
  SUPPORTED_MODEL_FORMATS,
} from '../types/mod'
import { joinPath, modApi } from '../utils/tauriApi'
import { customVMRService } from './CustomVMRService'

/**
 * Tower placement result with position source information
 */
export interface TowerPlacement {
  lat: number
  lon: number
  height: number // height offset above terrain in meters
  rotation: number // model rotation in degrees (0=north)
  source: 'manifest' | 'tower-positions' | 'airport-center'
}

/**
 * Get model position from manifest with backward compatibility
 * Handles both new modelPosition format and deprecated position/heightOffset fields
 */
function getModelPositionFromManifest(manifest: TowerModManifest): {
  lat: number
  lon: number
  height: number
  rotation: number
} | null {
  // New format: modelPosition
  if (manifest.modelPosition?.lat !== undefined && manifest.modelPosition?.lon !== undefined) {
    return {
      lat: manifest.modelPosition.lat,
      lon: manifest.modelPosition.lon,
      height: manifest.modelPosition.height ?? 0,
      rotation: manifest.modelPosition.rotation ?? 0,
    }
  }

  // Deprecated format: position + heightOffset
  if (manifest.position?.lat !== undefined && manifest.position?.lon !== undefined) {
    return {
      lat: manifest.position.lat,
      lon: manifest.position.lon,
      height: manifest.heightOffset ?? 0,
      rotation: 0,
    }
  }

  return null
}

/**
 * Get camera position from manifest with backward compatibility
 * Handles both new cameraPosition format and deprecated cabPosition/cabHeading fields
 */
export function getCameraPositionFromManifest(manifest: TowerModManifest): {
  lat: number
  lon: number
  height: number
  heading: number
} | null {
  // New format: cameraPosition with height
  if (
    manifest.cameraPosition?.lat !== undefined &&
    manifest.cameraPosition?.lon !== undefined &&
    manifest.cameraPosition?.height !== undefined
  ) {
    return {
      lat: manifest.cameraPosition.lat,
      lon: manifest.cameraPosition.lon,
      height: manifest.cameraPosition.height,
      heading: manifest.cameraPosition.heading ?? 0,
    }
  }

  // Deprecated format: cabPosition (with aglHeight) + cabHeading
  if (
    manifest.cabPosition?.lat !== undefined &&
    manifest.cabPosition?.lon !== undefined &&
    manifest.cabPosition?.aglHeight !== undefined
  ) {
    return {
      lat: manifest.cabPosition.lat,
      lon: manifest.cabPosition.lon,
      height: manifest.cabPosition.aglHeight,
      heading: manifest.cabHeading ?? 0,
    }
  }

  return null
}

/**
 * Mod loading error information
 */
export interface ModError {
  path: string
  error: string
  type: 'tower' | 'aircraft'
}

/**
 * Git repository info for mods loaded from git repos
 */
export interface ModGitInfo {
  isGitRepo: boolean
  repoName: string | null
}

/**
 * Tower mod information for the Mods UI
 */
export interface TowerModInfo {
  path: string
  icao: string
  manifest: TowerModManifest
  enabled: boolean
  placement: TowerPlacement | null
  gitInfo?: ModGitInfo
}

/**
 * Aircraft mod information for the Mods UI
 */
export interface AircraftModInfo {
  path: string
  aircraftTypes: string[]
  manifest: AircraftModManifest
  enabled: boolean
  gitInfo?: ModGitInfo
}

/**
 * Complete mod loading result for the Mods UI
 */
export interface ModLoadingResult {
  towers: TowerModInfo[]
  aircraft: AircraftModInfo[]
  vmrFiles: string[]
  towerPositions: {
    builtin: number
    custom: string[] // ICAO codes with custom positions
  }
  errors: ModError[]
}

class ModService {
  private registry: ModRegistry = {
    aircraft: new Map(),
    towers: new Map(),
  }
  private customTowerPositions: Map<string, CustomTowerPosition> = new Map()
  private loaded = false
  private loading = false // Guard against React StrictMode double-mount

  // Track loading results for Mods UI
  private loadingResult: ModLoadingResult = {
    towers: [],
    aircraft: [],
    vmrFiles: [],
    towerPositions: { builtin: 0, custom: [] },
    errors: [],
  }

  // Track disabled mods (paths)
  private disabledMods: Set<string> = new Set()

  /**
   * Initialize mod loading
   * Scans the mods directory and loads all valid mods
   * @param disabledModPaths - Array of mod paths that should be skipped
   */
  async loadMods(disabledModPaths: string[] = []): Promise<void> {
    if (this.loaded || this.loading) return
    this.loading = true // Set immediately to prevent React StrictMode double-mount

    // Store disabled mods for checking
    this.disabledMods = new Set(disabledModPaths.map((p) => p.toLowerCase()))

    // Reset loading result
    this.loadingResult = {
      towers: [],
      aircraft: [],
      vmrFiles: [],
      towerPositions: { builtin: 0, custom: [] },
      errors: [],
    }

    try {
      // Load custom VMR files first (highest priority for model matching)
      await customVMRService.loadVMRFiles()
      const vmrStats = customVMRService.getStats()
      this.loadingResult.vmrFiles = customVMRService.getLoadedFiles()
      if (vmrStats.vmrFiles > 0) {
        console.log(`[ModService] Loaded ${vmrStats.vmrFiles} VMR file(s)`)
      }

      // Load custom tower positions FIRST (needed for tower mod placement fallback)
      await this.loadCustomTowerPositions()
      const view3dCount = [...this.customTowerPositions.values()].filter((p) => p.view3d).length
      const view2dCount = [...this.customTowerPositions.values()].filter((p) => p.view2d).length

      // Get list of user-custom tower positions (not bundled)
      const customIcaos = await modApi.getCustomTowerPositionIcaos()

      this.loadingResult.towerPositions = {
        builtin: this.customTowerPositions.size,
        custom: customIcaos,
      }
      console.log(
        `[ModService] Loaded ${this.customTowerPositions.size} tower position(s) (view3d: ${view3dCount}, view2d: ${view2dCount})`,
      )

      // Discover and load all mods recursively (supports git repos at any depth)
      await this.loadAllDiscoveredMods()

      // Log results
      if (this.loadingResult.aircraft.length > 0) {
        console.log(`[ModService] Loaded ${this.loadingResult.aircraft.length} aircraft mod(s)`)
      }
      if (this.loadingResult.towers.length > 0) {
        const towerDetails = this.loadingResult.towers
          .map((t) => {
            const placementInfo = t.placement
              ? `position: ${t.placement.lat.toFixed(4)}, ${t.placement.lon.toFixed(4)}, height: ${t.placement.height}m, rotation: ${t.placement.rotation}° from ${t.placement.source}`
              : 'no position'
            return `  - ${t.icao}: ${t.manifest.name} (${placementInfo})`
          })
          .join('\n')
        console.log(`[ModService] Loaded ${this.loadingResult.towers.length} tower mod(s):\n${towerDetails}`)
      }

      // Log any errors
      if (this.loadingResult.errors.length > 0) {
        console.warn(`[ModService] ${this.loadingResult.errors.length} mod loading error(s):`)
        for (const err of this.loadingResult.errors) {
          console.warn(`  - ${err.path}: ${err.error}`)
        }
      }

      this.loaded = true
      this.loading = false
    } catch (error) {
      console.error('[ModService] Failed to load mods:', error)
      this.loaded = true // Mark as loaded even on error to prevent retry loops
      this.loading = false
    }
  }

  /**
   * Discover and load all mods recursively
   * Supports git repos at any folder depth within the mods directory
   */
  private async loadAllDiscoveredMods(): Promise<void> {
    try {
      // Use recursive discovery to find all mods
      const discovered = await modApi.discoverAllMods()

      for (const modInfo of discovered) {
        const normalizedPath = modInfo.path.toLowerCase().replace(/\\/g, '/')

        // Check if this mod is disabled
        if (this.disabledMods.has(normalizedPath)) {
          continue
        }

        // Extract git info
        const gitInfo: ModGitInfo = {
          isGitRepo: modInfo.isGitRepo,
          repoName: modInfo.repoName,
        }

        try {
          const manifest = await modApi.readModManifest(modInfo.path)

          if (modInfo.modType === 'aircraft') {
            await this.loadAircraftMod(manifest as AircraftModManifest, modInfo.path, gitInfo)
          } else if (modInfo.modType === 'tower') {
            await this.loadTowerMod(manifest as TowerModManifest, modInfo.path, gitInfo)
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error)
          this.loadingResult.errors.push({
            path: modInfo.path,
            error: errorMsg.includes('manifest') ? 'Missing or invalid manifest.json' : errorMsg,
            type: modInfo.modType === 'aircraft' ? 'aircraft' : 'tower',
          })
        }
      }
    } catch (error) {
      console.warn('Failed to discover mods:', error)
    }
  }

  /**
   * Load and register an aircraft mod
   */
  private async loadAircraftMod(manifest: AircraftModManifest, basePath: string, gitInfo?: ModGitInfo): Promise<void> {
    if (!manifest.modelFile || !this.validateModelFile(manifest.modelFile)) {
      this.loadingResult.errors.push({
        path: basePath,
        error: 'Invalid or missing model file',
        type: 'aircraft',
      })
      return
    }

    // Use joinPath to handle OS-specific separators for Tauri asset protocol
    const modelUrl = joinPath(basePath, manifest.modelFile)
    this.registerAircraftMod(manifest, modelUrl, basePath)

    // Track for Mods UI
    this.loadingResult.aircraft.push({
      path: basePath,
      aircraftTypes: manifest.aircraftTypes || [],
      manifest,
      enabled: true,
      gitInfo,
    })
  }

  /**
   * Load and register a tower mod
   */
  private async loadTowerMod(manifest: TowerModManifest, basePath: string, gitInfo?: ModGitInfo): Promise<void> {
    if (!manifest.modelFile || !this.validateModelFile(manifest.modelFile)) {
      this.loadingResult.errors.push({
        path: basePath,
        error: 'Invalid or missing model file',
        type: 'tower',
      })
      return
    }

    // Use joinPath to handle OS-specific separators for Tauri asset protocol
    const modelUrl = joinPath(basePath, manifest.modelFile)
    this.registerTowerMod(manifest, modelUrl, basePath)

    // Get the ICAO from the manifest's airports array (first one for display)
    // Fall back to folder name if airports array is empty
    const icao =
      manifest.airports?.[0]?.toUpperCase() || basePath.replace(/\\/g, '/').split('/').pop()?.toUpperCase() || 'UNKNOWN'

    // Compute placement for logging
    const placement = this.computeTowerPlacement(manifest, icao)

    // Track for Mods UI
    this.loadingResult.towers.push({
      path: basePath,
      icao,
      manifest,
      enabled: true,
      placement,
      gitInfo,
    })
  }

  /**
   * Compute the final tower placement from manifest position or tower-positions fallback
   * Note: This method can be called before tower positions are loaded,
   * so it checks both the manifest and falls back to tower-positions
   */
  private computeTowerPlacement(manifest: TowerModManifest, icao: string): TowerPlacement | null {
    // First priority: manifest modelPosition (or deprecated position/heightOffset)
    const modelPos = getModelPositionFromManifest(manifest)
    if (modelPos) {
      return {
        lat: modelPos.lat,
        lon: modelPos.lon,
        height: modelPos.height,
        rotation: modelPos.rotation,
        source: 'manifest',
      }
    }

    // Second priority: tower-positions data (if loaded)
    // Note: tower-positions provides camera position, we use lat/lon for model placement
    // but height should be 0 (model at ground level) since aglHeight is for camera
    const customPos = this.customTowerPositions.get(icao.toUpperCase())
    if (customPos?.view3d) {
      return {
        lat: customPos.view3d.lat,
        lon: customPos.view3d.lon,
        height: 0, // Model at ground level, not at camera height
        rotation: 0,
        source: 'tower-positions',
      }
    }

    // No position available
    return null
  }

  /**
   * Load custom tower positions from mods/tower-positions/*.json files
   * Also reads legacy mods/tower-positions.json for backward compatibility
   */
  private async loadCustomTowerPositions(): Promise<void> {
    try {
      const json = await modApi.readTowerPositions()

      // json is an object mapping ICAO codes to position objects (new or legacy format)
      for (const [icao, rawPosition] of Object.entries(json)) {
        const parsed = rawPosition as CustomTowerPosition | LegacyTowerPosition

        // Check if it's legacy format (has lat/lon/aglHeight at top level)
        if (isLegacyTowerPosition(parsed)) {
          // Convert legacy format to new format
          const converted = convertLegacyToNewFormat(parsed)
          this.customTowerPositions.set(icao.toUpperCase(), converted)
        } else {
          // New format with view3d/view2d
          const position: CustomTowerPosition = {}

          // Validate and store view3d if present
          if (parsed.view3d) {
            const v3d = parsed.view3d as RawView3dPosition
            // Support both 'height' (new) and 'aglHeight' (deprecated) field names
            const height = v3d.height ?? v3d.aglHeight
            if (typeof v3d.lat === 'number' && typeof v3d.lon === 'number' && typeof height === 'number') {
              position.view3d = {
                lat: v3d.lat,
                lon: v3d.lon,
                height: height,
                heading: v3d.heading,
              }
            } else {
              console.warn(`Invalid view3d for ${icao}: missing required fields (lat, lon, height)`)
            }
          }

          // Validate and store view2d if present
          if (parsed.view2d) {
            const v2d = parsed.view2d as View2dPosition
            // Compute altitude: use direct altitude if provided, otherwise convert from vNasRange
            let altitude: number | undefined
            if (typeof v2d.altitude === 'number') {
              altitude = v2d.altitude
            } else if (typeof v2d.vNasRange === 'number') {
              altitude = v2d.vNasRange * VNAS_RANGE_TO_ALTITUDE_MULTIPLIER
            }

            if (altitude !== undefined) {
              position.view2d = {
                lat: v2d.lat,
                lon: v2d.lon,
                altitude,
                vNasRange: v2d.vNasRange, // Preserve raw value for reference
                heading: v2d.heading,
              }
            } else {
              // view2d exists but has no altitude info - use heading only with default altitude
              if (typeof v2d.heading === 'number') {
                position.view2d = {
                  altitude: TOPDOWN_ALTITUDE_DEFAULT,
                  heading: v2d.heading,
                }
              }
            }
          }

          // Only add if we have at least one valid view
          if (position.view3d || position.view2d) {
            this.customTowerPositions.set(icao.toUpperCase(), position)
          } else {
            console.warn(`Invalid tower position for ${icao}: no valid view3d or view2d settings`)
          }
        }
      }
    } catch (error) {
      console.warn('Failed to load tower positions:', error)
      // Not a fatal error - app continues with defaults
    }
  }

  /**
   * Get custom tower position for a specific airport (full object with both views)
   */
  getCustomTowerPosition(icao: string): CustomTowerPosition | undefined {
    return this.customTowerPositions.get(icao.toUpperCase())
  }

  /**
   * Get 3D view position for a specific airport
   * Returns undefined if no 3D position is defined
   */
  get3dPosition(icao: string): View3dPosition | undefined {
    return this.customTowerPositions.get(icao.toUpperCase())?.view3d
  }

  /**
   * Get 2D view position for a specific airport
   * Returns undefined if no 2D position is defined
   * Note: altitude is always resolved (from direct value or vNasRange conversion)
   */
  get2dPosition(icao: string): ResolvedView2dPosition | undefined {
    return this.customTowerPositions.get(icao.toUpperCase())?.view2d
  }

  /**
   * Check if an airport has a custom tower position defined
   * @param viewType - Optional: check for specific view ('3d' or '2d'), or 'any' for either
   */
  hasCustomPosition(icao: string, viewType: '3d' | '2d' | 'any' = 'any'): boolean {
    const position = this.customTowerPositions.get(icao.toUpperCase())
    if (!position) return false

    switch (viewType) {
      case '3d':
        return position.view3d !== undefined
      case '2d':
        return position.view2d !== undefined
      default:
        return position.view3d !== undefined || position.view2d !== undefined
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
  registerAircraftMod(manifest: AircraftModManifest, modelUrl: string, basePath: string): void {
    const loadedMod: LoadedMod<AircraftModManifest> = {
      manifest,
      modelUrl,
      basePath,
    }

    // Register for each aircraft type
    for (const aircraftType of manifest.aircraftTypes) {
      this.registry.aircraft.set(aircraftType.toUpperCase(), loadedMod)
    }
  }

  /**
   * Register a tower mod
   */
  registerTowerMod(manifest: TowerModManifest, modelUrl: string, basePath: string): void {
    const loadedMod: LoadedMod<TowerModManifest> = {
      manifest,
      modelUrl,
      basePath,
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
      towerModels: this.registry.towers.size,
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

  /**
   * Get the final tower placement for rendering a tower model
   * Uses the fallback chain: manifest.modelPosition -> tower-positions -> null
   *
   * @param icao Airport ICAO code
   * @returns TowerPlacement with lat/lon/height/rotation and source, or null if no position available
   */
  getTowerPlacement(icao: string): TowerPlacement | null {
    const towerMod = this.registry.towers.get(icao.toUpperCase())
    if (!towerMod) return null

    const manifest = towerMod.manifest

    // First priority: manifest modelPosition (or deprecated position/heightOffset)
    const modelPos = getModelPositionFromManifest(manifest)
    if (modelPos) {
      return {
        lat: modelPos.lat,
        lon: modelPos.lon,
        height: modelPos.height,
        rotation: modelPos.rotation,
        source: 'manifest',
      }
    }

    // Second priority: tower-positions data
    // Note: tower-positions provides camera position, we use lat/lon for model placement
    // but height should be 0 (model at ground level) since aglHeight is for camera
    const customPos = this.customTowerPositions.get(icao.toUpperCase())
    if (customPos?.view3d) {
      return {
        lat: customPos.view3d.lat,
        lon: customPos.view3d.lon,
        height: 0, // Model at ground level, not at camera height
        rotation: 0,
        source: 'tower-positions',
      }
    }

    // No position available
    return null
  }

  /**
   * Get the mod loading result for the Mods management UI
   * Contains information about all loaded mods, VMR files, tower positions, and errors
   */
  getModLoadingResult(): ModLoadingResult {
    return this.loadingResult
  }

  /**
   * Set the list of disabled mod paths
   * This should be called before loadMods() or will require a reload
   */
  setDisabledMods(paths: string[]): void {
    this.disabledMods = new Set(paths.map((p) => p.toLowerCase().replace(/\\/g, '/')))
  }
}

// Export singleton instance
export const modService = new ModService()
export default modService
