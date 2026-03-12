/**
 * Custom VMR Service
 *
 * Manages VMR (Visual Model Rules) files placed in the mods folder for custom
 * model matching rules. Works alongside ModService and FSLTLService.
 *
 * VMR files allow users to define:
 * - Base liveries for aircraft types (TypeCode + ModelName)
 * - Airline-specific liveries (CallsignPrefix + TypeCode + ModelName)
 * - Type aliases (e.g., B38M -> B738)
 *
 * Example VMR file:
 * ```xml
 * <?xml version="1.0" encoding="utf-8"?>
 * <ModelMatchRuleSet>
 *   <ModelMatchRule TypeCode="B738" ModelName="MyB738_Base" />
 *   <ModelMatchRule CallsignPrefix="AAL" TypeCode="B738" ModelName="MyB738_American" />
 * </ModelMatchRuleSet>
 * ```
 */

import { convertToAssetUrlSync, modApi, isTauri } from '../utils/tauriApi'
import type { CustomVMRRule, CustomVMRMatch } from '../types/mod'
import {
  type ParsedApiRule,
  type VMRRule,
  processApiRules,
  getUniqueSourceFiles,
  findRuleMatch
} from './vmrUtils'

/** Rule entry with base path for model resolution */
interface CustomRuleEntry {
  rule: VMRRule
  sourceVmr: string
  basePath: string
}

/** Cached manifest data for a model folder */
interface ManifestCache {
  scale?: number
  rotationOffset?: { x: number; y: number; z: number }
  fileExists: boolean
}

class CustomVMRServiceClass {
  /** Combined default rules from all VMR files (keyed by typeCode) */
  private defaultRules = new Map<string, CustomRuleEntry>()

  /** Combined airline rules from all VMR files (keyed by `${callsignPrefix}_${typeCode}`) */
  private airlineRules = new Map<string, CustomRuleEntry>()

  /** VMR files that were loaded (for debugging) */
  private loadedFiles: string[] = []

  /** Whether VMR files have been loaded */
  private loaded = false

  /** Cached manifest data for model folders (keyed by model folder path) */
  private manifestCache = new Map<string, ManifestCache>()

  /**
   * Initialize by loading all VMR files from mods folder
   * Uses Rust backend for cached parsing (much faster on subsequent loads)
   */
  async loadVMRFiles(): Promise<void> {
    if (this.loaded) return

    try {
      if (isTauri()) {
        // Tauri mode: use Rust backend for cached VMR parsing
        const vmrPaths = await modApi.listVMRFiles()

        if (vmrPaths.length > 0) {
          // Parse all VMR files using Rust backend (with caching)
          const rules = await modApi.parseVMRFiles(vmrPaths)

          // Process parsed rules using shared utility with custom entry creation
          processApiRules(
            rules as ParsedApiRule[],
            this.defaultRules,
            this.airlineRules,
            (rule, sourceVmr) => ({
              rule,
              sourceVmr,
              basePath: this.getBasePath(sourceVmr)
            })
          )

          // Track which files were processed
          this.loadedFiles = getUniqueSourceFiles(rules as ParsedApiRule[])

          // Pre-load manifests for all models
          for (const vmrPath of this.loadedFiles) {
            const basePath = this.getBasePath(vmrPath)
            await this.preloadManifestsForVMR(basePath)
          }
        }
      } else {
        // Browser mode: fetch pre-parsed VMR rules from HTTP API
        await this.loadVMRRulesFromAPI()
      }

      this.loaded = true
      if (this.defaultRules.size > 0 || this.airlineRules.size > 0) {
        console.log(
          `[CustomVMRService] Loaded ${this.loadedFiles.length} VMR file(s), ` +
          `${this.defaultRules.size} default rules, ${this.airlineRules.size} airline rules`
        )
      }
    } catch (error) {
      console.error('[CustomVMRService] Failed to load VMR files:', error)
      this.loaded = true
    }
  }

  /**
   * Load VMR rules from HTTP API (browser mode)
   * The server returns pre-parsed rules from all VMR files
   */
  private async loadVMRRulesFromAPI(): Promise<void> {
    try {
      const response = await fetch('/api/vmr-rules')
      if (!response.ok) {
        console.warn('[CustomVMRService] Failed to fetch VMR rules from API:', response.status)
        return
      }

      const rules: ParsedApiRule[] = await response.json()
      // Base path for models served via HTTP API
      const basePath = '/api/mods/aircraft'

      // Process parsed rules using shared utility
      processApiRules(
        rules,
        this.defaultRules,
        this.airlineRules,
        (rule, sourceVmr) => ({ rule, sourceVmr, basePath })
      )

      // Pre-load manifests for all models
      if (rules.length > 0) {
        await this.preloadManifestsForVMR(basePath)
        this.loadedFiles.push('(HTTP API)')
      }
    } catch (error) {
      console.warn('[CustomVMRService] Error fetching VMR rules from API:', error)
    }
  }

  /**
   * Get the base path for model resolution from VMR file path
   * Models are resolved relative to mods/aircraft/
   */
  private getBasePath(vmrPath: string): string {
    // Normalize path separators
    const normalized = vmrPath.replace(/\\/g, '/')
    const modsIndex = normalized.lastIndexOf('/mods/')
    if (modsIndex >= 0) {
      return normalized.substring(0, modsIndex) + '/mods/aircraft'
    }
    // Fallback: use parent directory of VMR file
    const lastSlash = normalized.lastIndexOf('/')
    return lastSlash >= 0 ? normalized.substring(0, lastSlash) : normalized
  }

  /**
   * Pre-load manifests for all models referenced in a set of rules
   * This is called during VMR file loading to cache manifest data
   * so that subsequent findBestModel calls are fast and synchronous
   *
   * @param basePath Base path for models (mods/aircraft/)
   */
  private async preloadManifestsForVMR(basePath: string): Promise<void> {
    const allRules = new Set<string>()

    // Collect all unique model names from both default and airline rules
    this.defaultRules.forEach(entry => {
      entry.rule.modelNames.forEach(name => allRules.add(name))
    })
    this.airlineRules.forEach(entry => {
      entry.rule.modelNames.forEach(name => allRules.add(name))
    })

    // Pre-load manifest for each model
    for (const modelName of allRules) {
      const trimmedName = modelName.trim()
      if (!trimmedName) continue

      const modelFolderPath = `${basePath}/${trimmedName}`
      // Skip if already cached
      if (this.manifestCache.has(modelFolderPath)) continue

      await this.loadManifestIntoCache(modelFolderPath)
    }
  }

  /**
   * Load a manifest file and store it in the cache
   * Handles missing files and parse errors gracefully
   *
   * @param modelFolderPath Path to model folder (e.g., mods/aircraft/MyModel or /api/mods/aircraft/MyModel)
   */
  private async loadManifestIntoCache(modelFolderPath: string): Promise<void> {
    try {
      let manifest: Record<string, unknown> | null = null

      if (modelFolderPath.startsWith('/api/')) {
        // Browser mode: fetch manifest via HTTP
        const manifestUrl = `${modelFolderPath}/manifest.json`
        const response = await fetch(manifestUrl)
        if (response.ok) {
          manifest = await response.json()
        }
      } else {
        // Tauri mode: use modApi
        manifest = await modApi.loadModelManifest<Record<string, unknown>>(modelFolderPath)
      }

      if (!manifest) {
        // No manifest found - but model.glb might still exist
        // Check if model exists via HTTP in browser mode
        if (modelFolderPath.startsWith('/api/')) {
          const modelUrl = `${modelFolderPath}/model.glb`
          const modelCheck = await fetch(modelUrl, { method: 'HEAD' })
          this.manifestCache.set(modelFolderPath, {
            fileExists: modelCheck.ok
          })
        } else {
          this.manifestCache.set(modelFolderPath, { fileExists: false })
        }
        return
      }

      // Validate manifest structure
      // Using 'as any' is necessary here because manifest is untyped JSON
      // biome-ignore lint/suspicious/noExplicitAny: dynamic VMR parsing
      const scale = typeof (manifest as any)?.scale === 'number' ? (manifest as any).scale : undefined
      // biome-ignore lint/suspicious/noExplicitAny: dynamic VMR parsing
      const rawRotation = (manifest as any)?.rotationOffset
      const rotationOffset = rawRotation && typeof rawRotation === 'object'
        ? {
            // biome-ignore lint/suspicious/noExplicitAny: dynamic VMR parsing
            x: typeof (rawRotation as any).x === 'number' ? (rawRotation as any).x : 0,
            // biome-ignore lint/suspicious/noExplicitAny: dynamic VMR parsing
            y: typeof (rawRotation as any).y === 'number' ? (rawRotation as any).y : 0,
            // biome-ignore lint/suspicious/noExplicitAny: dynamic VMR parsing
            z: typeof (rawRotation as any).z === 'number' ? (rawRotation as any).z : 0
          }
        : undefined

      this.manifestCache.set(modelFolderPath, {
        scale,
        rotationOffset,
        fileExists: true
      })
    } catch {
      // File doesn't exist or can't be parsed - mark as invalid
      this.manifestCache.set(modelFolderPath, {
        fileExists: false
      })
    }
  }

  /**
   * Find best matching model from custom VMR rules
   *
   * Tries airline-specific rules first, then defaults.
   * Uses pre-cached manifest data, so this is fast and synchronous.
   *
   * @param aircraftType ICAO aircraft type code (e.g., "B738")
   * @param airlineCode Optional airline ICAO code (e.g., "AAL")
   * @returns Matched model info or null if no match
   */
  findBestModel(aircraftType: string | null, airlineCode: string | null): CustomVMRMatch | null {
    if (!aircraftType || !this.loaded) return null

    const result = findRuleMatch(
      aircraftType,
      airlineCode,
      this.defaultRules,
      this.airlineRules
    )

    if (!result) return null

    const { entry, isAirlineSpecific } = result
    const match = this.resolveModelPath(entry.rule, entry.basePath)
    if (match && isAirlineSpecific) {
      match.airlineCode = airlineCode?.toUpperCase() ?? null
    }
    return match
  }

  /**
   * Resolve a VMR rule to an actual model path using cached manifest data
   * Returns the first model with an existing .glb file
   *
   * All manifests should be pre-loaded during VMR loading,
   * so this is fast and synchronous.
   *
   * @param rule VMR rule with model names to try
   * @param basePath Base path for model resolution (mods/aircraft/)
   * @returns Matched model info or null if no valid model found
   */
  private resolveModelPath(rule: CustomVMRRule | VMRRule, basePath: string): CustomVMRMatch | null {
    // Try each model name alternative until we find a non-empty one with existing file
    for (const modelName of rule.modelNames) {
      const trimmedName = modelName.trim()
      if (!trimmedName) continue

      // Model folder expected at: basePath/{modelName}/model.glb
      const modelFolderPath = `${basePath}/${trimmedName}`
      const modelPath = `${modelFolderPath}/model.glb`

      // Check cached manifest data
      const cachedManifest = this.manifestCache.get(modelFolderPath)
      if (!cachedManifest?.fileExists) {
        continue // File doesn't exist, try next
      }

      // In browser mode, basePath is already an HTTP path (/api/mods/aircraft)
      // In Tauri mode, convert file path to asset URL
      const finalModelPath = basePath.startsWith('/api/')
        ? modelPath
        : convertToAssetUrlSync(modelPath)

      return {
        modelPath: finalModelPath,
        modelName: trimmedName,
        aircraftType: rule.typeCode,
        airlineCode: null,  // Set by caller if airline-specific
        scale: cachedManifest.scale ?? 1.0,
        rotationOffset: cachedManifest.rotationOffset
      }
    }

    return null
  }

  /**
   * Check if custom VMR rules have been loaded from disk
   *
   * @returns true if loadVMRFiles() has completed (successfully or with errors)
   */
  isLoaded(): boolean {
    return this.loaded
  }

  /**
   * Check if there are any custom VMR rules currently loaded
   *
   * @returns true if any default or airline-specific rules are available
   */
  hasRules(): boolean {
    return this.defaultRules.size > 0 || this.airlineRules.size > 0
  }

  /**
   * Get statistics about loaded VMR rules
   *
   * Useful for debugging and diagnostics.
   *
   * @returns Object with counts of loaded VMR files and rules
   */
  getStats(): { vmrFiles: number; defaultRules: number; airlineRules: number } {
    return {
      vmrFiles: this.loadedFiles.length,
      defaultRules: this.defaultRules.size,
      airlineRules: this.airlineRules.size
    }
  }

  /**
   * Get list of successfully loaded VMR file paths
   *
   * Useful for debugging to verify which VMR files were recognized and loaded.
   *
   * @returns Copy of loaded VMR file paths
   */
  getLoadedFiles(): string[] {
    return [...this.loadedFiles]
  }
}

// Singleton instance
export const customVMRService = new CustomVMRServiceClass()
export default customVMRService
