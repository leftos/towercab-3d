/**
 * User VMR Service
 *
 * Manages VMR (Visual Model Rules) files selected by the user in settings.
 * These VMR files define custom model matching rules that take priority
 * over built-in matching logic.
 *
 * Unlike CustomVMRService (which loads from mods/), this service loads
 * VMR files from user-specified absolute paths stored in globalSettingsStore.
 *
 * VMR files are processed in priority order (first file has highest priority).
 * Each rule maps:
 * - TypeCode: Aircraft ICAO type code (e.g., "B738")
 * - ModelName: Model folder name or MSFS model path (with // for alternatives)
 * - CallsignPrefix: Optional airline ICAO code for airline-specific liveries
 *
 * @see MSFSModelSettingsPanel - UI for selecting VMR files
 * @see globalSettingsStore.msfsModels.vmrFiles - Stores VMR file paths
 */

import { useGlobalSettingsStore } from '@/stores/globalSettingsStore'
import { isTauri, modApi } from '@/utils/tauriApi'

// =============================================================================
// Types
// =============================================================================

/** Parsed VMR rule */
export interface VMRRule {
  /** Aircraft ICAO type code (e.g., "B738") */
  typeCode: string
  /** Model names to try in order (alternatives separated by //) */
  modelNames: string[]
  /** Optional airline ICAO code for airline-specific rules */
  callsignPrefix?: string
}

/** Match result from VMR lookup */
export interface VMRMatch {
  /** First valid model name from the rule */
  modelName: string
  /** Aircraft type code from the rule */
  typeCode: string
  /** Airline code if airline-specific rule */
  airlineCode?: string
  /** Source VMR file path */
  sourceVmr: string
}

// =============================================================================
// Service Class
// =============================================================================

class UserVMRServiceClass {
  /** Default rules: typeCode -> rule with source */
  private defaultRules = new Map<string, { rule: VMRRule; sourceVmr: string }>()

  /** Airline rules: `${airline}_${type}` -> rule with source */
  private airlineRules = new Map<string, { rule: VMRRule; sourceVmr: string }>()

  /** Currently loaded VMR file paths */
  private loadedFiles: string[] = []

  /** Whether the service has been initialized */
  private initialized = false

  /** Current source priority for sorting model alternatives */
  private currentPriority: ('fsltl' | 'aig')[] = ['fsltl', 'aig']

  /** Unsubscribe function for settings listener */
  private unsubscribe?: () => void

  constructor() {
    // Subscribe to priority changes to re-sort alternatives
    this.unsubscribe = useGlobalSettingsStore.subscribe((state) => {
      const priority = state.msfsModels.priority
      if (JSON.stringify(priority) !== JSON.stringify(this.currentPriority)) {
        console.log('[UserVMRService] Priority changed, re-sorting alternatives:', priority)
        this.currentPriority = [...priority]
        this.sortAllAlternativesByPriority()
      }
    })
  }

  // ===========================================================================
  // PRIORITY SORTING
  // ===========================================================================

  /**
   * Determine which source a model name belongs to based on prefix
   */
  private getModelSource(name: string): 'fsltl' | 'aig' | 'unknown' {
    const upper = name.toUpperCase()
    if (upper.startsWith('FSLTL_') || upper.startsWith('FSLTL ')) return 'fsltl'
    if (upper.startsWith('AIGAIM_') || upper.startsWith('AIGAIM ')) return 'aig'
    return 'unknown'
  }

  /**
   * Sort model names array by current source priority
   */
  private sortModelNamesByPriority(modelNames: string[]): void {
    modelNames.sort((a, b) => {
      const sourceA = this.getModelSource(a)
      const sourceB = this.getModelSource(b)
      // Unknown sources go last
      const priorityA = sourceA === 'unknown' ? 999 : this.currentPriority.indexOf(sourceA)
      const priorityB = sourceB === 'unknown' ? 999 : this.currentPriority.indexOf(sourceB)
      return priorityA - priorityB
    })
  }

  /**
   * Re-sort all loaded alternatives by current priority
   * Called when priority setting changes
   */
  private sortAllAlternativesByPriority(): void {
    for (const entry of this.defaultRules.values()) {
      this.sortModelNamesByPriority(entry.rule.modelNames)
    }
    for (const entry of this.airlineRules.values()) {
      this.sortModelNamesByPriority(entry.rule.modelNames)
    }
  }

  // ===========================================================================
  // INITIALIZATION
  // ===========================================================================

  /**
   * Load VMR files from user settings
   * Reloads all rules - call when vmrFiles setting changes
   * Uses Rust backend for cached parsing (much faster on subsequent loads)
   * @param onProgress Optional callback for progress (status, percentage 0-100)
   */
  async loadVMRFiles(onProgress?: (status: string, progress: number) => void): Promise<void> {
    // Clear existing rules
    this.defaultRules.clear()
    this.airlineRules.clear()
    this.loadedFiles = []

    if (!isTauri()) {
      // Browser mode - VMR files must be loaded via server API
      onProgress?.('Loading VMR rules from API...', 0)
      await this.loadFromAPI()
      this.initialized = true
      onProgress?.('VMR rules loaded', 100)
      return
    }

    const settings = useGlobalSettingsStore.getState().msfsModels
    const vmrPaths = settings.vmrFiles || []

    if (vmrPaths.length === 0) {
      onProgress?.('No VMR files configured', 100)
      this.initialized = true
      return
    }

    onProgress?.('Parsing VMR files...', 10)

    try {
      // Use Rust backend for cached VMR parsing
      const rules = await modApi.parseVMRFiles(vmrPaths)

      // Process parsed rules
      for (const apiRule of rules) {
        const typeCode = apiRule.typeCode.toUpperCase()
        const modelNames = apiRule.modelName.split('//').filter(n => n.trim())
        const callsignPrefix = apiRule.callsignPrefix?.toUpperCase()

        if (modelNames.length === 0) continue

        const rule: VMRRule = { typeCode, modelNames, callsignPrefix }

        if (callsignPrefix) {
          const key = `${callsignPrefix}_${typeCode}`
          // First rule wins (higher priority VMR files loaded first)
          if (!this.airlineRules.has(key)) {
            this.airlineRules.set(key, { rule, sourceVmr: apiRule.sourceVmr })
          }
        } else {
          if (!this.defaultRules.has(typeCode)) {
            this.defaultRules.set(typeCode, { rule, sourceVmr: apiRule.sourceVmr })
          }
        }
      }

      // Track which files were processed
      const uniqueFiles = new Set(rules.map(r => r.sourceVmr))
      this.loadedFiles = Array.from(uniqueFiles)

      // Update current priority and sort alternatives
      this.currentPriority = [...settings.priority]
      this.sortAllAlternativesByPriority()
    } catch (error) {
      console.warn('[UserVMRService] Failed to parse VMR files:', error)
    }

    onProgress?.(`Loaded ${this.loadedFiles.length} VMR file(s)`, 100)
    this.initialized = true

    if (this.defaultRules.size > 0 || this.airlineRules.size > 0) {
      // Log sample airline rules to help debug matching
      const sampleAirlineKeys = Array.from(this.airlineRules.keys()).slice(0, 10)
      console.log(
        `[UserVMRService] Loaded ${this.loadedFiles.length} VMR file(s), ` +
        `${this.defaultRules.size} default rules, ${this.airlineRules.size} airline rules`
      )
      console.log(`[UserVMRService] Sample airline rule keys: ${sampleAirlineKeys.join(', ')}`)
    } else {
      console.log(`[UserVMRService] No VMR rules loaded (vmrFiles: ${useGlobalSettingsStore.getState().msfsModels.vmrFiles?.length ?? 0})`)
    }
  }

  /**
   * Load VMR rules from server API (browser mode)
   */
  private async loadFromAPI(): Promise<void> {
    try {
      const response = await fetch('/api/user-vmr-rules')
      if (!response.ok) {
        if (response.status !== 404) {
          console.warn('[UserVMRService] Failed to fetch from API:', response.status)
        }
        return
      }

      const rules: Array<{
        typeCode: string
        modelName: string
        callsignPrefix?: string
        sourceVmr: string
      }> = await response.json()

      for (const apiRule of rules) {
        const typeCode = apiRule.typeCode.toUpperCase()
        const modelNames = apiRule.modelName.split('//').filter(n => n.trim())
        const callsignPrefix = apiRule.callsignPrefix?.toUpperCase()

        if (modelNames.length === 0) continue

        const rule: VMRRule = { typeCode, modelNames, callsignPrefix }

        if (callsignPrefix) {
          const key = `${callsignPrefix}_${typeCode}`
          if (!this.airlineRules.has(key)) {
            this.airlineRules.set(key, { rule, sourceVmr: apiRule.sourceVmr })
          }
        } else {
          if (!this.defaultRules.has(typeCode)) {
            this.defaultRules.set(typeCode, { rule, sourceVmr: apiRule.sourceVmr })
          }
        }
      }

      this.loadedFiles.push('(HTTP API)')

      // Update current priority and sort alternatives
      const settings = useGlobalSettingsStore.getState().msfsModels
      this.currentPriority = [...settings.priority]
      this.sortAllAlternativesByPriority()
    } catch (error) {
      console.warn('[UserVMRService] Error loading from API:', error)
    }
  }

  // ===========================================================================
  // VMR PARSING
  // ===========================================================================

  /**
   * Parse VMR XML content
   */
  private parseVMRContent(content: string, sourcePath: string): void {
    const parser = new DOMParser()
    const doc = parser.parseFromString(content, 'text/xml')

    const parseError = doc.querySelector('parsererror')
    if (parseError) {
      console.warn(`[UserVMRService] XML parse error in ${sourcePath}, using regex fallback`)
      this.parseVMRContentFallback(content, sourcePath)
      return
    }

    const rules = doc.querySelectorAll('ModelMatchRule')

    for (const ruleEl of rules) {
      const typeCode = ruleEl.getAttribute('TypeCode')?.toUpperCase()
      const modelName = ruleEl.getAttribute('ModelName')
      const callsignPrefix = ruleEl.getAttribute('CallsignPrefix')?.toUpperCase()

      if (!typeCode || !modelName) continue

      const modelNames = modelName.split('//').filter(name => name.trim())
      if (modelNames.length === 0) continue

      const rule: VMRRule = { typeCode, modelNames, callsignPrefix }

      if (callsignPrefix) {
        const key = `${callsignPrefix}_${typeCode}`
        // First rule wins (higher priority VMR files loaded first)
        if (!this.airlineRules.has(key)) {
          this.airlineRules.set(key, { rule, sourceVmr: sourcePath })
        }
      } else {
        if (!this.defaultRules.has(typeCode)) {
          this.defaultRules.set(typeCode, { rule, sourceVmr: sourcePath })
        }
      }
    }
  }

  /**
   * Fallback regex parsing for malformed XML
   */
  private parseVMRContentFallback(content: string, sourcePath: string): void {
    // Match both self-closing and open/close tags
    const selfClosingRegex = /<ModelMatchRule\s+([^>]+)\s*\/>/g
    const openCloseRegex = /<ModelMatchRule\s+([^>]+)>[\s\S]*?<\/ModelMatchRule>/g

    const allMatches: string[] = []

    let match: RegExpExecArray | null
    while ((match = selfClosingRegex.exec(content)) !== null) {
      allMatches.push(match[1])
    }
    while ((match = openCloseRegex.exec(content)) !== null) {
      allMatches.push(match[1])
    }

    for (const attrs of allMatches) {
      const typeCodeMatch = attrs.match(/TypeCode\s*=\s*"([^"]+)"/)
      const modelNameMatch = attrs.match(/ModelName\s*=\s*"([^"]+)"/)
      const callsignMatch = attrs.match(/CallsignPrefix\s*=\s*"([^"]+)"/)

      if (!typeCodeMatch || !modelNameMatch) continue

      const typeCode = typeCodeMatch[1].toUpperCase()
      const modelNames = modelNameMatch[1].split('//').filter(name => name.trim())
      const callsignPrefix = callsignMatch?.[1]?.toUpperCase()

      if (modelNames.length === 0) continue

      const rule: VMRRule = { typeCode, modelNames, callsignPrefix }

      if (callsignPrefix) {
        const key = `${callsignPrefix}_${typeCode}`
        if (!this.airlineRules.has(key)) {
          this.airlineRules.set(key, { rule, sourceVmr: sourcePath })
        }
      } else {
        if (!this.defaultRules.has(typeCode)) {
          this.defaultRules.set(typeCode, { rule, sourceVmr: sourcePath })
        }
      }
    }
  }

  // ===========================================================================
  // MODEL MATCHING
  // ===========================================================================

  /**
   * Find a VMR match for an aircraft type and optional airline
   *
   * @param aircraftType ICAO aircraft type code (e.g., "B738")
   * @param airlineCode Optional airline ICAO code (e.g., "AAL")
   * @returns Match info or null if no rule matches
   */
  findMatch(aircraftType: string | null, airlineCode: string | null): VMRMatch | null {
    if (!aircraftType || !this.initialized) return null

    const normalizedType = aircraftType.toUpperCase()
    const normalizedAirline = airlineCode?.toUpperCase()

    // 1. Try airline-specific rule
    if (normalizedAirline) {
      const airlineKey = `${normalizedAirline}_${normalizedType}`
      const entry = this.airlineRules.get(airlineKey)
      if (entry) {
        const modelName = entry.rule.modelNames[0] // First alternative
        return {
          modelName,
          typeCode: entry.rule.typeCode,
          airlineCode: normalizedAirline,
          sourceVmr: entry.sourceVmr
        }
      }
    }

    // 2. Try default rule for type
    const defaultEntry = this.defaultRules.get(normalizedType)
    if (defaultEntry) {
      const modelName = defaultEntry.rule.modelNames[0]
      return {
        modelName,
        typeCode: defaultEntry.rule.typeCode,
        sourceVmr: defaultEntry.sourceVmr
      }
    }

    return null
  }

  /**
   * Get all model name alternatives for a VMR match
   * Useful for fallback when first model doesn't exist
   */
  getAlternatives(aircraftType: string, airlineCode: string | null): string[] {
    const normalizedType = aircraftType.toUpperCase()
    const normalizedAirline = airlineCode?.toUpperCase()

    // Check airline-specific first
    if (normalizedAirline) {
      const airlineKey = `${normalizedAirline}_${normalizedType}`
      const entry = this.airlineRules.get(airlineKey)
      if (entry) {
        return [...entry.rule.modelNames]
      }
    }

    // Check default
    const defaultEntry = this.defaultRules.get(normalizedType)
    if (defaultEntry) {
      return [...defaultEntry.rule.modelNames]
    }

    return []
  }

  // ===========================================================================
  // UTILITIES
  // ===========================================================================

  /** Check if service has been initialized */
  isInitialized(): boolean {
    return this.initialized
  }

  /** Check if there are any rules loaded */
  hasRules(): boolean {
    return this.defaultRules.size > 0 || this.airlineRules.size > 0
  }

  /** Get statistics about loaded rules */
  getStats(): { vmrFiles: number; defaultRules: number; airlineRules: number } {
    return {
      vmrFiles: this.loadedFiles.length,
      defaultRules: this.defaultRules.size,
      airlineRules: this.airlineRules.size
    }
  }

  /** Get list of loaded VMR file paths */
  getLoadedFiles(): string[] {
    return [...this.loadedFiles]
  }

  /** Force reload (call when settings change) */
  async reload(): Promise<void> {
    this.initialized = false
    await this.loadVMRFiles()
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

export const userVMRService = new UserVMRServiceClass()
