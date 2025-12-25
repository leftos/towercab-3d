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

import { convertFileSrc } from '@tauri-apps/api/core'
import { modApi, isTauri } from '../utils/tauriApi'
import type { CustomVMRRule, CustomVMRMatch } from '../types/mod'

/** Rule entry with base path for model resolution */
interface RuleEntry {
  rule: CustomVMRRule
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
  private defaultRules = new Map<string, RuleEntry>()

  /** Combined airline rules from all VMR files (keyed by `${callsignPrefix}_${typeCode}`) */
  private airlineRules = new Map<string, RuleEntry>()

  /** VMR files that were loaded (for debugging) */
  private loadedFiles: string[] = []

  /** Whether VMR files have been loaded */
  private loaded = false

  /** Cached manifest data for model folders (keyed by model folder path) */
  private manifestCache = new Map<string, ManifestCache>()

  /**
   * Initialize by loading all VMR files from mods folder
   */
  async loadVMRFiles(): Promise<void> {
    if (this.loaded) return
    if (!isTauri()) {
      this.loaded = true
      return
    }

    try {
      const vmrPaths = await modApi.listVMRFiles()

      for (const vmrPath of vmrPaths) {
        try {
          const content = await modApi.readTextFile(vmrPath)
          const basePath = this.getBasePath(vmrPath)
          this.parseVMRContent(content, vmrPath, basePath)
          // Pre-load manifests for all models in this VMR file
          await this.preloadManifestsForVMR(basePath)
          this.loadedFiles.push(vmrPath)
        } catch (error) {
          console.warn(`[CustomVMRService] Failed to load VMR: ${vmrPath}`, error)
        }
      }

      this.loaded = true
      if (this.loadedFiles.length > 0) {
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
   * Parse VMR XML content
   */
  private parseVMRContent(content: string, sourcePath: string, basePath: string): void {
    const parser = new DOMParser()
    const doc = parser.parseFromString(content, 'text/xml')

    const parseError = doc.querySelector('parsererror')
    if (parseError) {
      console.warn(`[CustomVMRService] XML parse error in ${sourcePath}, using regex fallback`)
      this.parseVMRContentFallback(content, basePath)
      return
    }

    const rules = doc.querySelectorAll('ModelMatchRule')

    for (const ruleEl of rules) {
      const typeCode = ruleEl.getAttribute('TypeCode')?.toUpperCase()
      const modelName = ruleEl.getAttribute('ModelName')
      const callsignPrefix = ruleEl.getAttribute('CallsignPrefix')?.toUpperCase()

      if (!typeCode || !modelName) continue

      // Split alternatives (e.g., "Model1//Model2") and filter empty strings
      const modelNames = modelName.split('//').filter(name => name.trim())

      // Warn if all model names are empty
      if (modelNames.length === 0) {
        console.warn(`[CustomVMRService] VMR rule for ${typeCode} has no valid model names`)
        continue
      }

      const rule: CustomVMRRule = {
        typeCode,
        modelNames,
        callsignPrefix: callsignPrefix || undefined
      }

      if (callsignPrefix) {
        const key = `${callsignPrefix}_${typeCode}`
        // First rule wins for conflicts
        if (!this.airlineRules.has(key)) {
          this.airlineRules.set(key, { rule, basePath })
        }
      } else {
        // First rule wins for conflicts
        if (!this.defaultRules.has(typeCode)) {
          this.defaultRules.set(typeCode, { rule, basePath })
        }
      }
    }
  }

  /**
   * Fallback regex parsing for malformed XML
   * Matches both self-closing (<ModelMatchRule ... />) and open/close (<ModelMatchRule ...></ModelMatchRule>) tags
   */
  private parseVMRContentFallback(content: string, basePath: string): void {
    // Match self-closing tags: <ModelMatchRule ... />
    const selfClosingRegex = /<ModelMatchRule\s+([^>]+)\s*\/>/g
    // Match open/close tags: <ModelMatchRule ...>...</ModelMatchRule>
    const openCloseRegex = /<ModelMatchRule\s+([^>]+)>[\s\S]*?<\/ModelMatchRule>/g

    const allMatches: Array<{ attrs: string }> = []

    let match: RegExpExecArray | null
    while ((match = selfClosingRegex.exec(content)) !== null) {
      allMatches.push({ attrs: match[1] })
    }

    while ((match = openCloseRegex.exec(content)) !== null) {
      allMatches.push({ attrs: match[1] })
    }

    for (const { attrs } of allMatches) {
      const typeCodeMatch = attrs.match(/TypeCode\s*=\s*"([^"]+)"/)
      const modelNameMatch = attrs.match(/ModelName\s*=\s*"([^"]+)"/)
      const callsignMatch = attrs.match(/CallsignPrefix\s*=\s*"([^"]+)"/)

      if (!typeCodeMatch || !modelNameMatch) continue

      const typeCode = typeCodeMatch[1].toUpperCase()
      const modelNames = modelNameMatch[1].split('//').filter(name => name.trim())
      const callsignPrefix = callsignMatch?.[1]?.toUpperCase()

      // Warn if all model names are empty
      if (modelNames.length === 0) {
        console.warn(`[CustomVMRService] VMR rule for ${typeCode} has no valid model names`)
        continue
      }

      const rule: CustomVMRRule = {
        typeCode,
        modelNames,
        callsignPrefix
      }

      if (callsignPrefix) {
        const key = `${callsignPrefix}_${typeCode}`
        if (!this.airlineRules.has(key)) {
          this.airlineRules.set(key, { rule, basePath })
        }
      } else {
        if (!this.defaultRules.has(typeCode)) {
          this.defaultRules.set(typeCode, { rule, basePath })
        }
      }
    }
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
   * @param modelFolderPath Path to model folder (e.g., mods/aircraft/MyModel)
   */
  private async loadManifestIntoCache(modelFolderPath: string): Promise<void> {
    try {
      const manifest = await modApi.loadModelManifest<Record<string, unknown>>(modelFolderPath)

      // Validate manifest structure
      // Using 'as any' is necessary here because loadModelManifest returns untyped JSON
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const scale = typeof (manifest as any)?.scale === 'number' ? (manifest as any).scale : undefined
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawRotation = (manifest as any)?.rotationOffset
      const rotationOffset = rawRotation && typeof rawRotation === 'object'
        ? {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            x: typeof (rawRotation as any).x === 'number' ? (rawRotation as any).x : 0,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            y: typeof (rawRotation as any).y === 'number' ? (rawRotation as any).y : 0,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    const normalizedType = aircraftType.toUpperCase()
    const normalizedAirline = airlineCode?.toUpperCase()

    // 1. Try airline-specific rule
    if (normalizedAirline) {
      const airlineKey = `${normalizedAirline}_${normalizedType}`
      const airlineEntry = this.airlineRules.get(airlineKey)
      if (airlineEntry) {
        const match = this.resolveModelPath(airlineEntry.rule, airlineEntry.basePath)
        if (match) {
          match.airlineCode = normalizedAirline
          return match
        }
      }
    }

    // 2. Try default rule for this type
    const defaultEntry = this.defaultRules.get(normalizedType)
    if (defaultEntry) {
      const match = this.resolveModelPath(defaultEntry.rule, defaultEntry.basePath)
      if (match) {
        return match
      }
    }

    return null
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
  private resolveModelPath(rule: CustomVMRRule, basePath: string): CustomVMRMatch | null {
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

      return {
        modelPath: convertFileSrc(modelPath),
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
