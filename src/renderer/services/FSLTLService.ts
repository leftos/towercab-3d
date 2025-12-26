/**
 * FSLTL (FS Live Traffic Liveries) Service
 *
 * Manages FSLTL aircraft model discovery, conversion tracking, and model matching.
 *
 * ## Responsibilities
 * - Parse FSLTL_Rules.vmr for official model matching rules
 * - Maintain registry of converted models (persisted in IndexedDB)
 * - Find best matching model for aircraft type + airline combination
 * - Track conversion progress
 *
 * ## Model Matching Priority
 * 1. Exact match: Same aircraft type AND same airline code
 * 2. Type match with base livery: Same type, no specific airline (ZZZZ)
 * 3. Type fallback: Use built-in model if no FSLTL match
 *
 * ## VMR Rules Format
 * The FSLTL_Rules.vmr file contains XML rules like:
 * - `<ModelMatchRule TypeCode="B738" ModelName="FSLTL_B738_ZZZZ" />` (default)
 * - `<ModelMatchRule CallsignPrefix="AAL" TypeCode="B738" ModelName="FSLTL_B738_AAL" />` (airline-specific)
 *
 * @see AircraftModelService - Uses this service for FSLTL model lookup
 * @see FSLTLImportPanel - UI component for managing FSLTL imports
 */

import type {
  FSLTLModel,
  FSLTLRegistry,
  FSLTLRegistryJSON,
  VMRRule,
  ConversionProgress,
  FSLTLAirlineInfo,
  FSLTLTypeInfo
} from '../types/fsltl'
import { aircraftDimensionsService } from './AircraftDimensionsService'
import {
  createEmptyRegistry,
  registryFromJSON,
  registryToJSON,
  parseModelName,
  DEFAULT_CONVERSION_PROGRESS
} from '../types/fsltl'
import { useSettingsStore } from '../stores/settingsStore'
import { isTauri } from '../utils/tauriApi'

/** Model info returned from /api/fsltl/models endpoint */
interface ApiFsltlModel {
  modelName: string
  modelPath: string
  relativePath: string
  aircraftType: string
  airlineCode: string | null
  hasAnimations: boolean
  fileSize: number
}

// IndexedDB database name and store
const DB_NAME = 'towercab-fsltl'
const DB_VERSION = 1
const STORE_NAME = 'registry'

class FSLTLServiceClass {
  /** VMR rules indexed by typeCode (default rules) */
  private defaultRules = new Map<string, VMRRule>()

  /** VMR rules indexed by `${callsignPrefix}_${typeCode}` (airline-specific) */
  private airlineRules = new Map<string, VMRRule>()

  /** All unique callsign prefixes from VMR */
  private allAirlines = new Set<string>()

  /** All unique type codes from VMR */
  private allTypes = new Set<string>()

  /**
   * Type aliases extracted from VMR default rules
   * Maps ICAO type codes to FSLTL model types (e.g., B38M → B738)
   * Derived from ModelName in default rules: TypeCode="B38M" ModelName="FSLTL_B738_ZZZZ"
   */
  private typeAliases = new Map<string, string>()

  /** Registry of converted models */
  private registry: FSLTLRegistry = createEmptyRegistry()

  /** Whether VMR has been parsed */
  private vmrLoaded = false

  /** Whether registry has been loaded from IndexedDB */
  private registryLoaded = false

  /** Current conversion progress */
  private _conversionProgress: ConversionProgress = { ...DEFAULT_CONVERSION_PROGRESS }

  /** Event listeners for model updates */
  private updateListeners: Array<() => void> = []

  /** Last storage error (for UI feedback) */
  private _lastStorageError: string | null = null

  // ==========================================================================
  // INITIALIZATION
  // ==========================================================================

  /**
   * Initialize the service by loading the registry from IndexedDB
   */
  async initialize(): Promise<void> {
    if (this.registryLoaded) return
    await this.loadRegistry()
    this.registryLoaded = true
  }

  /**
   * Check if FSLTL models are enabled in settings
   */
  private isEnabled(): boolean {
    return useSettingsStore.getState().fsltl.enableFsltlModels
  }

  // ==========================================================================
  // VMR PARSING
  // ==========================================================================

  /**
   * Parse FSLTL_Rules.vmr file content
   *
   * The VMR file is XML with rules like:
   * ```xml
   * <ModelMatchRule TypeCode="B738" ModelName="FSLTL_B738_ZZZZ" />
   * <ModelMatchRule CallsignPrefix="AAL" TypeCode="B738" ModelName="FSLTL_B738_AAL//FSLTL_B738_AAL_NC" />
   * ```
   *
   * @param vmrContent - XML content of FSLTL_Rules.vmr
   */
  parseVMRContent(vmrContent: string): void {
    this.defaultRules.clear()
    this.airlineRules.clear()
    this.allAirlines.clear()
    this.allTypes.clear()
    this.typeAliases.clear()

    // Parse XML using DOMParser for robust handling of edge cases
    const parser = new DOMParser()
    const doc = parser.parseFromString(vmrContent, 'text/xml')

    // Check for parsing errors
    const parseError = doc.querySelector('parsererror')
    if (parseError) {
      console.error('[FSLTLService] XML parsing error:', parseError.textContent)
      // Fall back to regex for malformed XML
      this.parseVMRContentFallback(vmrContent)
      return
    }

    const rules = doc.querySelectorAll('ModelMatchRule')

    for (const ruleEl of rules) {
      const typeCode = ruleEl.getAttribute('TypeCode')?.toUpperCase()
      const modelName = ruleEl.getAttribute('ModelName')
      const callsignPrefix = ruleEl.getAttribute('CallsignPrefix')?.toUpperCase()

      if (!typeCode || !modelName) continue

      const modelNames = modelName.split('//')

      const rule: VMRRule = {
        typeCode,
        modelNames,
        callsignPrefix: callsignPrefix || undefined
      }

      this.allTypes.add(typeCode)

      if (callsignPrefix) {
        // Airline-specific rule
        this.allAirlines.add(callsignPrefix)
        const key = `${callsignPrefix}_${typeCode}`
        this.airlineRules.set(key, rule)
      } else {
        // Default rule (no callsign prefix)
        this.defaultRules.set(typeCode, rule)

        // Extract type alias from default rule
        // E.g., TypeCode="B38M" ModelName="FSLTL_B738_ZZZZ" → B38M → B738
        const firstModelName = modelNames[0]
        const { aircraftType: modelType } = parseModelName(firstModelName)
        if (modelType && modelType !== typeCode) {
          this.typeAliases.set(typeCode, modelType)
        }
      }
    }

    this.vmrLoaded = true
    console.log(`[FSLTLService] Parsed VMR: ${this.defaultRules.size} default rules, ${this.airlineRules.size} airline rules, ${this.allAirlines.size} airlines, ${this.allTypes.size} types, ${this.typeAliases.size} type aliases`)
  }

  /**
   * Fallback regex-based parsing for malformed XML
   */
  private parseVMRContentFallback(vmrContent: string): void {
    const ruleRegex = /<ModelMatchRule\s+([^>]+)\s*\/>/g
    let match: RegExpExecArray | null

    while ((match = ruleRegex.exec(vmrContent)) !== null) {
      const attrs = match[1]

      const typeCodeMatch = attrs.match(/TypeCode\s*=\s*"([^"]+)"/)
      const modelNameMatch = attrs.match(/ModelName\s*=\s*"([^"]+)"/)
      const callsignMatch = attrs.match(/CallsignPrefix\s*=\s*"([^"]+)"/)

      if (!typeCodeMatch || !modelNameMatch) continue

      const typeCode = typeCodeMatch[1].toUpperCase()
      const modelNames = modelNameMatch[1].split('//')
      const callsignPrefix = callsignMatch?.[1]?.toUpperCase()

      const rule: VMRRule = {
        typeCode,
        modelNames,
        callsignPrefix
      }

      this.allTypes.add(typeCode)

      if (callsignPrefix) {
        this.allAirlines.add(callsignPrefix)
        const key = `${callsignPrefix}_${typeCode}`
        this.airlineRules.set(key, rule)
      } else {
        this.defaultRules.set(typeCode, rule)

        // Extract type alias from default rule
        const firstModelName = modelNames[0]
        const { aircraftType: modelType } = parseModelName(firstModelName)
        if (modelType && modelType !== typeCode) {
          this.typeAliases.set(typeCode, modelType)
        }
      }
    }

    this.vmrLoaded = true
    console.log(`[FSLTLService] Parsed VMR (fallback): ${this.defaultRules.size} default rules, ${this.airlineRules.size} airline rules, ${this.typeAliases.size} type aliases`)
  }

  /**
   * Load and parse VMR file from path (via Tauri)
   */
  async loadVMRFile(vmrPath: string): Promise<void> {
    try {
      // In Tauri, we'll use the readTextFile command
      // For now, this is a placeholder - will be called from UI with content
      const response = await fetch(vmrPath)
      const content = await response.text()
      this.parseVMRContent(content)
    } catch (error) {
      console.error('[FSLTLService] Failed to load VMR file:', error)
      throw error
    }
  }

  // ==========================================================================
  // AIRLINE & TYPE QUERIES
  // ==========================================================================

  /**
   * Get all airlines from VMR with their available types
   */
  getAvailableAirlines(): FSLTLAirlineInfo[] {
    const airlinesMap = new Map<string, FSLTLAirlineInfo>()

    for (const [_key, rule] of this.airlineRules) {
      const prefix = rule.callsignPrefix!
      if (!airlinesMap.has(prefix)) {
        airlinesMap.set(prefix, {
          code: prefix,
          availableTypes: [],
          variantCount: 0
        })
      }
      const info = airlinesMap.get(prefix)!
      if (!info.availableTypes.includes(rule.typeCode)) {
        info.availableTypes.push(rule.typeCode)
      }
      info.variantCount += rule.modelNames.length
    }

    return Array.from(airlinesMap.values()).sort((a, b) => a.code.localeCompare(b.code))
  }

  /**
   * Get all aircraft types from VMR with airline info
   */
  getAvailableTypes(): FSLTLTypeInfo[] {
    const typesMap = new Map<string, FSLTLTypeInfo>()

    // Add default types (base liveries)
    for (const [typeCode] of this.defaultRules) {
      typesMap.set(typeCode, {
        typeCode,
        airlines: [],
        hasBaseLivery: true
      })
    }

    // Add airline-specific types
    for (const [_key, rule] of this.airlineRules) {
      if (!typesMap.has(rule.typeCode)) {
        typesMap.set(rule.typeCode, {
          typeCode: rule.typeCode,
          airlines: [],
          hasBaseLivery: false
        })
      }
      const info = typesMap.get(rule.typeCode)!
      if (rule.callsignPrefix && !info.airlines.includes(rule.callsignPrefix)) {
        info.airlines.push(rule.callsignPrefix)
      }
    }

    return Array.from(typesMap.values()).sort((a, b) => a.typeCode.localeCompare(b.typeCode))
  }

  /**
   * Get model names that need to be converted for given airlines/types
   */
  getModelsToConvert(airlines: string[], types: string[]): string[] {
    const models = new Set<string>()

    // Add base liveries for selected types
    for (const type of types) {
      const rule = this.defaultRules.get(type)
      if (rule) {
        for (const modelName of rule.modelNames) {
          models.add(modelName)
        }
      }
    }

    // Add airline-specific liveries
    for (const airline of airlines) {
      for (const type of types) {
        const key = `${airline}_${type}`
        const rule = this.airlineRules.get(key)
        if (rule) {
          for (const modelName of rule.modelNames) {
            models.add(modelName)
          }
        }
      }
    }

    return Array.from(models)
  }

  // ==========================================================================
  // MODEL MATCHING
  // ==========================================================================

  /**
   * Result from findBestModel including variation name for display
   */
  public lastMatchVariationName: string | null = null

  /**
   * Find best matching FSLTL model for aircraft type and airline
   *
   * Uses VMR rules to determine if a match exists, then looks up
   * converted models in the registry by aircraft type + airline code.
   *
   * Priority:
   * 1. VMR airline-specific rule: exact airline + type match (uses type aliasing)
   * 2. VMR default rule: type match with base livery (uses type aliasing)
   * 3. Direct registry lookup: if no VMR rules, check registry directly
   * 4. null: no FSLTL model available
   *
   * @param aircraftType - ICAO aircraft type code (e.g., "B738", "B38M")
   * @param airlineCode - ICAO airline code from callsign (e.g., "AAL"), or null
   * @returns Best matching FSLTLModel or null
   */
  findBestModel(aircraftType: string | null, airlineCode: string | null): FSLTLModel | null {
    if (!aircraftType || !this.isEnabled()) return null

    this.lastMatchVariationName = null

    const normalizedType = aircraftType.toUpperCase()
    const normalizedAirline = airlineCode?.toUpperCase()

    // Apply type aliasing (e.g., B38M → B738)
    const baseType = this.typeAliases.get(normalizedType) ?? normalizedType

    // Get all models for this base aircraft type
    // If aliased, also check original type since models may be registered under either
    let modelsForType = this.registry.byAircraftType.get(baseType)
    if (!modelsForType && baseType !== normalizedType) {
      modelsForType = this.registry.byAircraftType.get(normalizedType)
    }

    // 1. Try VMR airline-specific rule first
    if (normalizedAirline) {
      const airlineRuleKey = `${normalizedAirline}_${normalizedType}`
      const airlineRule = this.airlineRules.get(airlineRuleKey)
      if (airlineRule) {
        // VMR says this airline has a livery for this type
        // Look up by type + airline in registry
        if (modelsForType) {
          const airlineMatch = modelsForType.find(m => m.airlineCode === normalizedAirline)
          if (airlineMatch) {
            // Store the VMR variation name for display
            this.lastMatchVariationName = airlineRule.modelNames[0]
            return airlineMatch
          }
        }
      }
    }

    // 2. Try VMR default rule (base livery for this type)
    // BUT: If an airline code was provided, skip base livery here - let the caller
    // try closest-match first to find an airline-specific model of similar size
    // (e.g., FDX flying B738 should try FDX's B738F before falling back to generic B738)
    if (!normalizedAirline) {
      const defaultRule = this.defaultRules.get(normalizedType)
      if (defaultRule) {
        // Look up base livery in registry
        if (modelsForType) {
          const baseMatch = modelsForType.find(m => !m.airlineCode)
          if (baseMatch) {
            this.lastMatchVariationName = defaultRule.modelNames[0]
            return baseMatch
          }
        }
      }
    }

    // 3. Fallback: Direct registry lookup by type (only when no airline specified)
    // This handles cases where models exist but VMR wasn't loaded
    // or VMR doesn't have rules for this exact combination
    if (!normalizedAirline && modelsForType) {
      // Try base livery
      const baseMatch = modelsForType.find(m => !m.airlineCode)
      if (baseMatch) {
        return baseMatch
      }

      // Finally, return any model for this type
      if (modelsForType.length > 0) {
        return modelsForType[0]
      }
    }

    // 4. No match - let caller try closest-match or other fallbacks
    return null
  }

  /**
   * Find any FSLTL model for an airline, regardless of aircraft type.
   * Used as a last-resort fallback when aircraft type is unknown but airline is known.
   *
   * @param airlineCode - ICAO airline code (e.g., "AAL")
   * @returns Any FSLTLModel for this airline, or null
   */
  findModelByAirline(airlineCode: string | null): FSLTLModel | null {
    if (!airlineCode || !this.isEnabled()) return null

    const normalizedAirline = airlineCode.toUpperCase()
    const modelsForAirline = this.registry.byAirline.get(normalizedAirline)

    if (modelsForAirline && modelsForAirline.length > 0) {
      // Return the first available model for this airline
      return modelsForAirline[0]
    }

    return null
  }

  /**
   * Get the FSLTL B738 base livery model for generic fallback.
   * B738 is the most common aircraft type and works well as a universal fallback.
   *
   * @returns FSLTL B738 base model, or null if not available
   */
  getB738Fallback(): FSLTLModel | null {
    if (!this.isEnabled()) return null

    // Look for B738 base livery (no airline code)
    const b738Models = this.registry.byAircraftType.get('B738')
    if (b738Models) {
      const baseModel = b738Models.find(m => !m.airlineCode)
      if (baseModel) return baseModel
    }
    return null
  }

  /**
   * Find the closest FSLTL model for an airline by dimensions.
   * When an airline doesn't have the exact aircraft type, this finds the
   * most similar model they DO have and returns scale factors to match.
   *
   * @param targetType - The requested aircraft type (e.g., "B753")
   * @param airlineCode - The airline code (e.g., "AAL")
   * @param maxSizeDifference - Maximum allowed size difference ratio (default 0.5 = 50%)
   * @returns Closest model with scale factors, or null if no suitable match
   */
  findClosestModelForAirline(
    targetType: string,
    airlineCode: string,
    maxSizeDifference = 0.5
  ): { model: FSLTLModel; scale: { x: number; y: number; z: number }; distance: number } | null {
    if (!this.isEnabled()) return null

    const normalizedAirline = airlineCode.toUpperCase()
    const modelsForAirline = this.registry.byAirline.get(normalizedAirline)

    if (!modelsForAirline || modelsForAirline.length === 0) return null

    // Get target dimensions
    const targetDims = aircraftDimensionsService.getDimensions(targetType)
    if (!targetDims || !targetDims.wingspan || !targetDims.length) return null

    let bestMatch: FSLTLModel | null = null
    let bestDistance = Infinity
    let bestScale = { x: 1, y: 1, z: 1 }

    for (const model of modelsForAirline) {
      // Get dimensions for this model's aircraft type
      const modelDims = aircraftDimensionsService.getDimensions(model.aircraftType)
      if (!modelDims || !modelDims.wingspan || !modelDims.length) continue

      // Calculate normalized Euclidean distance
      const wingspanDiff = (modelDims.wingspan - targetDims.wingspan) / targetDims.wingspan
      const lengthDiff = (modelDims.length - targetDims.length) / targetDims.length
      const distance = Math.sqrt(wingspanDiff * wingspanDiff + lengthDiff * lengthDiff)

      if (distance < bestDistance) {
        bestDistance = distance
        bestMatch = model

        // Calculate non-uniform scale factors
        const wingspanScale = targetDims.wingspan / modelDims.wingspan
        const lengthScale = targetDims.length / modelDims.length
        bestScale = {
          x: wingspanScale,
          y: (wingspanScale + lengthScale) / 2,
          z: lengthScale
        }
      }
    }

    // Check if the best match is within acceptable size difference
    if (bestMatch && bestDistance <= maxSizeDifference) {
      return { model: bestMatch, scale: bestScale, distance: bestDistance }
    }

    return null
  }

  /**
   * Find the closest FSLTL model across ALL available models by dimensions.
   * Used as a fallback when no airline-specific match exists.
   *
   * @param targetType - The requested aircraft type
   * @param maxSizeDifference - Maximum allowed size difference ratio (default 0.5 = 50%)
   * @returns Closest model with scale factors, or null if no suitable match
   */
  findClosestModel(
    targetType: string,
    maxSizeDifference = 0.5
  ): { model: FSLTLModel; scale: { x: number; y: number; z: number }; distance: number } | null {
    if (!this.isEnabled()) return null

    // Get target dimensions
    const targetDims = aircraftDimensionsService.getDimensions(targetType)
    if (!targetDims || !targetDims.wingspan || !targetDims.length) return null

    let bestMatch: FSLTLModel | null = null
    let bestDistance = Infinity
    let bestScale = { x: 1, y: 1, z: 1 }

    // Iterate through all registered models
    for (const model of this.registry.models.values()) {
      // Prefer base liveries over airline-specific for generic matching
      // Skip airline-specific models in this pass
      if (model.airlineCode) continue

      const modelDims = aircraftDimensionsService.getDimensions(model.aircraftType)
      if (!modelDims || !modelDims.wingspan || !modelDims.length) continue

      const wingspanDiff = (modelDims.wingspan - targetDims.wingspan) / targetDims.wingspan
      const lengthDiff = (modelDims.length - targetDims.length) / targetDims.length
      const distance = Math.sqrt(wingspanDiff * wingspanDiff + lengthDiff * lengthDiff)

      if (distance < bestDistance) {
        bestDistance = distance
        bestMatch = model

        const wingspanScale = targetDims.wingspan / modelDims.wingspan
        const lengthScale = targetDims.length / modelDims.length
        bestScale = {
          x: wingspanScale,
          y: (wingspanScale + lengthScale) / 2,
          z: lengthScale
        }
      }
    }

    if (bestMatch && bestDistance <= maxSizeDifference) {
      return { model: bestMatch, scale: bestScale, distance: bestDistance }
    }

    return null
  }

  /**
   * Check if any FSLTL models are installed
   */
  hasModels(): boolean {
    return this.registry.models.size > 0
  }

  /**
   * Check if VMR has a rule for this airline + type combo
   * (even if not converted yet)
   */
  hasVMRRule(aircraftType: string, airlineCode: string | null): boolean {
    const normalizedType = aircraftType.toUpperCase()

    if (airlineCode) {
      const key = `${airlineCode.toUpperCase()}_${normalizedType}`
      if (this.airlineRules.has(key)) return true
    }

    return this.defaultRules.has(normalizedType)
  }

  // ==========================================================================
  // REGISTRY MANAGEMENT
  // ==========================================================================

  /**
   * Register a newly converted model
   */
  registerModel(model: FSLTLModel): void {
    this.registry.models.set(model.modelName, model)

    // Update type index
    const typeList = this.registry.byAircraftType.get(model.aircraftType) ?? []
    if (!typeList.find(m => m.modelName === model.modelName)) {
      typeList.push(model)
      this.registry.byAircraftType.set(model.aircraftType, typeList)
    }

    // Update airline index
    if (model.airlineCode) {
      const airlineList = this.registry.byAirline.get(model.airlineCode) ?? []
      if (!airlineList.find(m => m.modelName === model.modelName)) {
        airlineList.push(model)
        this.registry.byAirline.set(model.airlineCode, airlineList)
      }
    }

    this.registry.lastUpdated = Date.now()
  }

  /**
   * Register multiple converted models at once
   */
  registerModels(models: FSLTLModel[]): void {
    for (const model of models) {
      this.registerModel(model)
    }
    // Save after bulk registration
    this.saveRegistry()
  }

  /**
   * Clear all registered models
   */
  clearRegistry(): void {
    this.registry = createEmptyRegistry()
    this.saveRegistry()
  }

  /**
   * Get all registered models
   */
  getRegisteredModels(): FSLTLModel[] {
    return Array.from(this.registry.models.values())
  }

  /**
   * Get count of registered models
   */
  getModelCount(): number {
    return this.registry.models.size
  }

  /**
   * Check if a specific model is registered
   */
  isModelRegistered(modelName: string): boolean {
    return this.registry.models.has(modelName)
  }

  // ==========================================================================
  // INDEXEDDB PERSISTENCE
  // ==========================================================================

  /**
   * Open IndexedDB connection
   */
  private async openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME)
        }
      }
    })
  }

  /**
   * Load registry from IndexedDB (Tauri mode) or HTTP API (browser mode)
   */
  async loadRegistry(): Promise<void> {
    // In browser mode, fetch from HTTP API instead of IndexedDB
    if (!isTauri()) {
      await this.loadRegistryFromAPI()
      return
    }

    try {
      const db = await this.openDB()
      const transaction = db.transaction(STORE_NAME, 'readonly')
      const store = transaction.objectStore(STORE_NAME)

      return new Promise((resolve, reject) => {
        const request = store.get('registry')

        request.onerror = () => {
          db.close()
          reject(request.error)
        }

        request.onsuccess = () => {
          db.close()
          if (request.result) {
            try {
              this.registry = registryFromJSON(request.result as FSLTLRegistryJSON)
              console.log(`[FSLTLService] Loaded ${this.registry.models.size} models from IndexedDB`)
            } catch (e) {
              console.error('[FSLTLService] Failed to parse registry, resetting:', e)
              this.registry = createEmptyRegistry()
            }
          } else {
            this.registry = createEmptyRegistry()
          }
          resolve()
        }
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown storage error'
      console.error('[FSLTLService] Failed to load registry:', error)
      this._lastStorageError = `Failed to load converted models: ${errorMsg}`
      this.registry = createEmptyRegistry()
    }
  }

  /**
   * Load models from HTTP API (browser mode only)
   * Fetches the list of FSLTL models from the host and registers them
   */
  private async loadRegistryFromAPI(): Promise<void> {
    try {
      const response = await fetch('/api/fsltl/models')
      if (!response.ok) {
        console.warn('[FSLTLService] Failed to fetch FSLTL models from API:', response.status)
        this.registry = createEmptyRegistry()
        return
      }

      const apiModels: ApiFsltlModel[] = await response.json()
      this.registry = createEmptyRegistry()

      for (const apiModel of apiModels) {
        // Convert API model to internal FSLTLModel format
        // Use relativePath to construct HTTP URL for the model
        const model: FSLTLModel = {
          aircraftType: apiModel.aircraftType,
          airlineCode: apiModel.airlineCode, // Already string | null
          modelName: apiModel.modelName,
          // Use HTTP path for browser mode - served by /api/fsltl/*
          modelPath: `/api/fsltl/${apiModel.relativePath}`,
          textureSize: '1k', // Default, not tracked in API
          hasAnimations: apiModel.hasAnimations,
          fileSize: apiModel.fileSize,
          convertedAt: Date.now()
        }

        this.registerModel(model)
      }

      console.log(`[FSLTLService] Loaded ${this.registry.models.size} models from HTTP API`)
    } catch (error) {
      console.error('[FSLTLService] Error fetching FSLTL models from API:', error)
      this.registry = createEmptyRegistry()
    }
  }

  /**
   * Save registry to IndexedDB
   */
  async saveRegistry(): Promise<void> {
    try {
      const db = await this.openDB()
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)

      return new Promise((resolve, reject) => {
        const json = registryToJSON(this.registry)
        const request = store.put(json, 'registry')

        request.onerror = () => {
          db.close()
          reject(request.error)
        }

        request.onsuccess = () => {
          db.close()
          this._lastStorageError = null  // Clear error on success
          console.log(`[FSLTLService] Saved ${this.registry.models.size} models to IndexedDB`)
          resolve()
        }
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown storage error'
      console.error('[FSLTLService] Failed to save registry:', error)
      this._lastStorageError = `Failed to save converted models: ${errorMsg}`
    }
  }

  /**
   * Get last storage error (null if no error)
   */
  getLastStorageError(): string | null {
    return this._lastStorageError
  }

  /**
   * Clear last storage error
   */
  clearStorageError(): void {
    this._lastStorageError = null
  }

  // ==========================================================================
  // CONVERSION PROGRESS
  // ==========================================================================

  /**
   * Get current conversion progress
   */
  get conversionProgress(): ConversionProgress {
    return { ...this._conversionProgress }
  }

  /**
   * Update conversion progress
   */
  updateProgress(progress: Partial<ConversionProgress>): void {
    this._conversionProgress = {
      ...this._conversionProgress,
      ...progress
    }
  }

  /**
   * Reset conversion progress to idle
   */
  resetProgress(): void {
    this._conversionProgress = { ...DEFAULT_CONVERSION_PROGRESS }
  }

  // ==========================================================================
  // MODEL REFRESH
  // ==========================================================================

  /**
   * Subscribe to model update events
   */
  onModelsUpdated(callback: () => void): () => void {
    this.updateListeners.push(callback)
    return () => {
      this.updateListeners = this.updateListeners.filter(cb => cb !== callback)
    }
  }

  /**
   * Trigger model refresh after conversion completes
   * This notifies all subscribers that models have changed
   */
  triggerModelRefresh(): void {
    console.log('[FSLTLService] Triggering model refresh')
    for (const callback of this.updateListeners) {
      callback()
    }
    // Also dispatch a global event
    window.dispatchEvent(new CustomEvent('fsltl-models-updated'))
  }

  // ==========================================================================
  // MODEL SCANNING
  // ==========================================================================

  /**
   * Scan an output directory for existing converted models and rebuild the registry.
   * This allows picking up models that were converted externally or with a different output path.
   *
   * @param outputPath - Path to scan for model.glb files
   * @returns Number of models found and registered
   */
  async scanAndRebuildRegistry(outputPath: string): Promise<number> {
    // Dynamic import to avoid circular dependency issues
    const { scanFsltlModels } = await import('./fsltlApi')

    try {
      console.log(`[FSLTLService] Scanning ${outputPath} for existing models...`)

      const scannedModels = await scanFsltlModels(outputPath)

      if (scannedModels.length === 0) {
        console.log('[FSLTLService] No models found in output directory')
        return 0
      }

      // Clear existing registry and rebuild from scanned models
      this.registry = createEmptyRegistry()

      for (const scanned of scannedModels) {
        const model: FSLTLModel = {
          aircraftType: scanned.aircraftType,
          airlineCode: scanned.airlineCode,
          modelName: scanned.modelName,
          modelPath: scanned.modelPath,
          textureSize: '1k', // Default, we don't know the original size
          hasAnimations: scanned.hasAnimations,
          fileSize: scanned.fileSize,
          convertedAt: Date.now() // Use current time since we don't know original
        }

        this.registerModel(model)
      }

      // Save the rebuilt registry to IndexedDB
      await this.saveRegistry()

      console.log(`[FSLTLService] Rebuilt registry with ${scannedModels.length} models from disk`)

      // Notify listeners that models have changed
      this.triggerModelRefresh()

      return scannedModels.length
    } catch (error) {
      console.error('[FSLTLService] Failed to scan models:', error)
      throw error
    }
  }

  // ==========================================================================
  // UTILITY
  // ==========================================================================

  /**
   * Check if VMR has been loaded
   */
  get isVMRLoaded(): boolean {
    return this.vmrLoaded
  }

  /**
   * Check if registry has been loaded
   */
  get isRegistryLoaded(): boolean {
    return this.registryLoaded
  }

  /**
   * Get model path for a model name
   * Returns the expected path in the mods folder
   */
  getModelPath(modelName: string, outputPath: string): string {
    const { aircraftType, airlineCode } = parseModelName(modelName)
    const subfolder = airlineCode ? `${aircraftType}/${airlineCode}` : `${aircraftType}/base`
    return `${outputPath}/${subfolder}/model.glb`
  }
}

// Singleton instance
export const fsltlService = new FSLTLServiceClass()
