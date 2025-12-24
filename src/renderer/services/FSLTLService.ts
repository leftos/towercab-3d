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
import {
  createEmptyRegistry,
  registryFromJSON,
  registryToJSON,
  parseModelName,
  DEFAULT_CONVERSION_PROGRESS
} from '../types/fsltl'

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

    // Parse XML using regex (avoid full XML parser for performance)
    const ruleRegex = /<ModelMatchRule\s+([^>]+)\s*\/>/g
    let match: RegExpExecArray | null

    while ((match = ruleRegex.exec(vmrContent)) !== null) {
      const attrs = match[1]

      // Extract attributes
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
        // Airline-specific rule
        this.allAirlines.add(callsignPrefix)
        const key = `${callsignPrefix}_${typeCode}`
        this.airlineRules.set(key, rule)
      } else {
        // Default rule (no callsign prefix)
        this.defaultRules.set(typeCode, rule)
      }
    }

    this.vmrLoaded = true
    console.log(`[FSLTLService] Parsed VMR: ${this.defaultRules.size} default rules, ${this.airlineRules.size} airline rules, ${this.allAirlines.size} airlines, ${this.allTypes.size} types`)
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
   * Find best matching FSLTL model for aircraft type and airline
   *
   * Priority:
   * 1. Exact airline + type match (converted)
   * 2. Base type match (converted, _ZZZZ suffix)
   * 3. null (no FSLTL model available)
   *
   * @param aircraftType - ICAO aircraft type code (e.g., "B738")
   * @param airlineCode - ICAO airline code from callsign (e.g., "AAL"), or null
   * @returns Best matching FSLTLModel or null
   */
  findBestModel(aircraftType: string | null, airlineCode: string | null): FSLTLModel | null {
    if (!aircraftType) return null

    const normalizedType = aircraftType.toUpperCase()
    const normalizedAirline = airlineCode?.toUpperCase()

    // 1. Try exact airline + type match
    if (normalizedAirline) {
      // Check if we have a converted model for this airline + type
      const models = this.registry.byAircraftType.get(normalizedType)
      if (models) {
        const airlineMatch = models.find(m => m.airlineCode === normalizedAirline)
        if (airlineMatch) return airlineMatch
      }
    }

    // 2. Try base type match (no specific airline)
    const baseModels = this.registry.byAircraftType.get(normalizedType)
    if (baseModels) {
      const baseMatch = baseModels.find(m => !m.airlineCode)
      if (baseMatch) return baseMatch
    }

    // 3. No match
    return null
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
   * Load registry from IndexedDB
   */
  async loadRegistry(): Promise<void> {
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
      console.error('[FSLTLService] Failed to load registry:', error)
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
          console.log(`[FSLTLService] Saved ${this.registry.models.size} models to IndexedDB`)
          resolve()
        }
      })
    } catch (error) {
      console.error('[FSLTLService] Failed to save registry:', error)
    }
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
