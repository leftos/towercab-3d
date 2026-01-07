/**
 * MSFS Model Conversion Service
 *
 * Handles on-the-fly conversion of FSLTL and AIG aircraft models from MSFS format
 * (GLTF + DDS textures) to standard GLB format that can be rendered by Cesium.
 *
 * ## Key Features
 * - Auto-detect FSLTL and AIG installations from Community folder
 * - Convert models on-demand when first needed (~1.5-2 seconds per model)
 * - Memory cache for converted model URLs (cleared on app close)
 * - Optional disk cache with configurable size limit and LRU eviction
 * - Parse aircraft.cfg to find model variants and texture directories
 *
 * ## Conversion Flow
 * 1. resolveSourceModel() - Find source GLTF + textures for a model
 * 2. convertModel() - Invoke Python converter via Tauri sidecar
 * 3. getCachedModel() - Get converted GLB path (memory or disk cache)
 *
 * @see AircraftModelService - Uses this for FSLTL/AIG model lookup
 * @see FSLTLService - Legacy service (being replaced)
 */

import type { MSFSModelSettings, MSFSModelSource } from '@/types'
import { useGlobalSettingsStore } from '@/stores/globalSettingsStore'
import { isTauri } from '@/utils/tauriApi'
import { aircraftDimensionsService } from './AircraftDimensionsService'

// =============================================================================
// Types
// =============================================================================

/** Information about a source model before conversion */
export interface SourceModelInfo {
  /** Source type (fsltl or aig) */
  source: MSFSModelSource
  /** Model name (e.g., "FSLTL_B738_AAL" or "AIGAIM_B738-MAX8") */
  modelName: string
  /** Path to the GLTF file */
  gltfPath: string
  /** Paths to texture directories */
  textureDirs: string[]
  /** Aircraft type code (e.g., "B738") */
  aircraftType: string
  /** Airline code (e.g., "AAL") or null for generic */
  airlineCode: string | null
}

/** Result of a model conversion */
export interface ConversionResult {
  /** Whether conversion succeeded */
  success: boolean
  /** Path to converted GLB file (if success) */
  glbPath?: string
  /** Object URL for the GLB (for in-memory cache) */
  blobUrl?: string
  /** Error message (if failed) */
  error?: string
  /** File size in bytes */
  fileSize?: number
}

/** Conversion status for tracking in-progress conversions */
export interface ConversionStatus {
  /** Model is currently being converted */
  converting: boolean
  /** Promise that resolves when conversion completes */
  promise?: Promise<ConversionResult>
  /** Timestamp when conversion started */
  startedAt?: number
}

/** Cache entry for converted models */
interface CacheEntry {
  /** Path or blob URL to the converted GLB */
  path: string
  /** File size in bytes */
  fileSize: number
  /** Last access time (for LRU eviction) */
  lastAccessed: number
  /** Whether this is a disk-cached file */
  isDiskCache: boolean
}

/** Detection result for MSFS installations */
export interface MSFSDetectionResult {
  /** FSLTL installation found */
  fsltlFound: boolean
  /** Path to FSLTL base folder */
  fsltlPath?: string
  /** Number of FSLTL models available */
  fsltlModelCount?: number
  /** AIG installation found */
  aigFound: boolean
  /** Path to AIG base folder */
  aigPath?: string
  /** Number of AIG models available */
  aigModelCount?: number
}

// =============================================================================
// Service Class
// =============================================================================

class MSFSModelConversionServiceClass {
  /** Memory cache: modelKey -> CacheEntry */
  private memoryCache = new Map<string, CacheEntry>()

  /** Conversion status per model (prevents duplicate conversions) */
  private conversionStatus = new Map<string, ConversionStatus>()

  /** Models that failed to convert (skip these on subsequent requests) */
  private failedConversions = new Set<string>()

  /** Total size of cached models in bytes */
  private totalCacheSize = 0

  /** Maximum concurrent conversions */
  private readonly MAX_CONCURRENT = 2

  /** Current number of active conversions */
  private activeConversions = 0

  /** Queue of pending conversion requests */
  private conversionQueue: Array<{
    sourceInfo: SourceModelInfo
    resolve: (result: ConversionResult) => void
  }> = []

  /** Last detection result */
  private lastDetection: MSFSDetectionResult | null = null

  /** FSLTL model index: modelName -> SourceModelInfo */
  private fsltlModels = new Map<string, SourceModelInfo>()

  /** AIG model index: modelName -> SourceModelInfo */
  private aigModels = new Map<string, SourceModelInfo>()

  /** Whether the service has been initialized */
  private initialized = false

  // ===========================================================================
  // INITIALIZATION
  // ===========================================================================

  /**
   * Initialize the service by detecting MSFS installations
   * @param onProgress Optional callback to report progress during initialization (status, percentage 0-100)
   */
  async initialize(onProgress?: (status: string, progress?: number) => void): Promise<void> {
    if (this.initialized) return

    const settings = useGlobalSettingsStore.getState().msfsModels
    console.log('[MSFSConversion] Initialize settings:', {
      cacheDirectory: settings.cacheDirectory,
      communityPath: settings.communityPath
    })

    // First, load any pre-cached models from disk (makes them immediately available)
    // This phase is ~30% of MSFS init
    if (settings.cacheDirectory) {
      onProgress?.('Loading cached models...', 0)
      await this.loadCachedModels(settings.cacheDirectory, (status) => {
        onProgress?.(status, 15)
      })
      onProgress?.('Cached models loaded', 30)
    } else {
      console.log('[MSFSConversion] No cacheDirectory set, skipping cache load')
    }

    // Then detect MSFS installations for on-demand conversion
    // This phase is ~70% of MSFS init
    if (settings.communityPath) {
      await this.detectInstallations(settings.communityPath, (status, subProgress) => {
        // Map sub-progress (0-100) to 30-100 range
        const progress = 30 + Math.round((subProgress ?? 50) * 0.7)
        onProgress?.(status, progress)
      })
    }

    this.initialized = true
    console.log('[MSFSConversion] Service initialized')
  }

  /**
   * Load existing cached GLB models from disk into memory cache
   * This makes pre-converted models immediately available
   */
  private async loadCachedModels(
    cacheDir: string,
    onProgress?: (status: string) => void
  ): Promise<void> {
    if (!isTauri()) return

    try {
      const { invoke } = await import('@tauri-apps/api/core')

      const cachedModels = await invoke<Array<{
        path: string
        model_key: string
        file_size: number
      }>>('scan_cache_directory', { cacheDir })

      if (cachedModels.length === 0) {
        console.log('[MSFSConversion] No cached models found')
        return
      }

      onProgress?.(`Loading ${cachedModels.length} cached models...`)

      // Add each cached model to memory cache
      for (const cached of cachedModels) {
        this.memoryCache.set(cached.model_key, {
          path: cached.path,
          fileSize: cached.file_size,
          lastAccessed: Date.now(),
          isDiskCache: true
        })
        this.totalCacheSize += cached.file_size
      }

      console.log(`[MSFSConversion] Loaded ${cachedModels.length} cached models (${Math.round(this.totalCacheSize / 1024 / 1024)}MB)`)
    } catch (error) {
      console.warn('[MSFSConversion] Failed to load cached models:', error)
    }
  }

  /**
   * Get current MSFS model settings
   */
  private getSettings(): MSFSModelSettings {
    return useGlobalSettingsStore.getState().msfsModels
  }

  // ===========================================================================
  // DETECTION
  // ===========================================================================

  /**
   * Detect FSLTL and AIG installations from Community folder path
   * @param onProgress Optional callback to report progress (status, percentage 0-100)
   */
  async detectInstallations(
    communityPath: string,
    onProgress?: (status: string, progress?: number) => void
  ): Promise<MSFSDetectionResult> {
    if (!isTauri()) {
      // In browser mode, we can't access the file system directly
      return { fsltlFound: false, aigFound: false }
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core')

      onProgress?.('Scanning Community folder...', 0)
      const result = await invoke<MSFSDetectionResult>('detect_msfs_installations', {
        communityPath
      })

      this.lastDetection = result
      console.log('[MSFSConversion] Detection result:', result)
      onProgress?.('Community folder scanned', 20)

      // Calculate progress ranges based on what's found
      const hasFsltl = result.fsltlFound && result.fsltlPath
      const hasAig = result.aigFound && result.aigPath

      // Allocate 20-100% range: split evenly if both present
      let fsltlEnd = 100
      let aigStart = 20

      if (hasFsltl && hasAig) {
        fsltlEnd = 60 // 20-60 for FSLTL
        aigStart = 60 // 60-100 for AIG
      }

      // Build model indexes if found
      if (hasFsltl) {
        await this.buildFsltlIndex(result.fsltlPath!, (status, subPct) => {
          const pct = 20 + Math.round((subPct / 100) * (fsltlEnd - 20))
          onProgress?.(status, pct)
        })
        onProgress?.('FSLTL models indexed', fsltlEnd)
      }

      if (hasAig) {
        await this.buildAigIndex(result.aigPath!, (status, subPct) => {
          const pct = aigStart + Math.round((subPct / 100) * (100 - aigStart))
          onProgress?.(status, pct)
        })
        onProgress?.('AIG models indexed', 100)
      }

      return result
    } catch (error) {
      console.error('[MSFSConversion] Detection failed:', error)
      return { fsltlFound: false, aigFound: false }
    }
  }

  /**
   * Get last detection result
   */
  getDetectionResult(): MSFSDetectionResult | null {
    return this.lastDetection
  }

  // ===========================================================================
  // MODEL INDEXING
  // ===========================================================================

  /**
   * Build index of available FSLTL models
   */
  private async buildFsltlIndex(
    fsltlPath: string,
    onProgress?: (status: string, progress: number) => void
  ): Promise<void> {
    if (!isTauri()) return

    try {
      const { invoke } = await import('@tauri-apps/api/core')

      onProgress?.('Indexing FSLTL models...', 10)

      const models = await invoke<SourceModelInfo[]>('list_fsltl_models', {
        basePath: fsltlPath
      })

      this.fsltlModels.clear()
      for (const model of models) {
        this.fsltlModels.set(model.modelName, model)
      }

      onProgress?.(`Indexed ${models.length.toLocaleString()} FSLTL models`, 100)

      // Log sample model names to help debug matching
      const sampleNames = Array.from(this.fsltlModels.keys()).slice(0, 10)
      console.log(`[MSFSConversion] Indexed ${this.fsltlModels.size} FSLTL models, samples: ${sampleNames.join(', ')}`)
    } catch (error) {
      console.error('[MSFSConversion] Failed to index FSLTL models:', error)
    }
  }

  /**
   * Build index of available AIG models
   */
  private async buildAigIndex(
    aigPath: string,
    onProgress?: (status: string, progress: number) => void
  ): Promise<void> {
    if (!isTauri()) return

    try {
      const { invoke } = await import('@tauri-apps/api/core')

      onProgress?.('Indexing AIG models...', 10)

      const models = await invoke<SourceModelInfo[]>('list_aig_models', {
        basePath: aigPath
      })

      this.aigModels.clear()
      for (const model of models) {
        this.aigModels.set(model.modelName, model)
      }

      onProgress?.(`Indexed ${models.length.toLocaleString()} AIG models`, 100)

      console.log(`[MSFSConversion] Indexed ${this.aigModels.size} AIG models`)
    } catch (error) {
      console.error('[MSFSConversion] Failed to index AIG models:', error)
    }
  }

  // ===========================================================================
  // MODEL RESOLUTION
  // ===========================================================================

  /**
   * Find source model info for a given model name
   * Checks enabled sources in priority order
   */
  resolveSourceModel(modelName: string): SourceModelInfo | null {
    const settings = this.getSettings()

    // Check sources in priority order
    for (const source of settings.priority) {
      if (source === 'fsltl' && settings.enableFsltl) {
        const model = this.fsltlModels.get(modelName)
        if (model) return model
      }
      if (source === 'aig' && settings.enableAig) {
        const model = this.aigModels.get(modelName)
        if (model) return model
      }
    }

    return null
  }

  /**
   * Find model by aircraft type and airline code
   * Used for model matching when exact model name is not known
   */
  findModelByTypeAndAirline(
    aircraftType: string,
    airlineCode: string | null
  ): SourceModelInfo | null {
    const settings = this.getSettings()

    // Search in priority order
    for (const source of settings.priority) {
      const models = source === 'fsltl' ? this.fsltlModels : this.aigModels
      const enabled = source === 'fsltl' ? settings.enableFsltl : settings.enableAig

      if (!enabled) continue

      // First try exact match (type + airline)
      if (airlineCode) {
        for (const model of models.values()) {
          if (model.aircraftType === aircraftType && model.airlineCode === airlineCode) {
            return model
          }
        }
      }

      // Fall back to generic model (no airline)
      for (const model of models.values()) {
        if (model.aircraftType === aircraftType && !model.airlineCode) {
          return model
        }
      }
    }

    return null
  }

  /**
   * Find closest model for an airline by dimensions
   * Used when exact type match doesn't exist but airline-specific model of similar size does
   *
   * @param targetType - Requested aircraft type
   * @param airlineCode - Airline code to search for
   * @param maxSizeDifference - Maximum normalized size difference (default 0.5 = 50%)
   * @returns Closest model with scale factors, or null
   */
  findClosestModelForAirline(
    targetType: string,
    airlineCode: string,
    maxSizeDifference = 0.5
  ): { model: SourceModelInfo; scale: { x: number; y: number; z: number }; distance: number } | null {
    const settings = this.getSettings()

    // Get target dimensions
    const targetDims = aircraftDimensionsService.getDimensions(targetType)
    if (!targetDims?.wingspan || !targetDims?.length) return null

    let bestMatch: SourceModelInfo | null = null
    let bestDistance = Infinity
    let bestScale = { x: 1, y: 1, z: 1 }

    // Search all sources
    for (const source of settings.priority) {
      const models = source === 'fsltl' ? this.fsltlModels : this.aigModels
      const enabled = source === 'fsltl' ? settings.enableFsltl : settings.enableAig
      if (!enabled) continue

      for (const model of models.values()) {
        // Only consider models for this airline
        if (model.airlineCode !== airlineCode) continue

        // Get dimensions for this model's aircraft type
        const modelDims = aircraftDimensionsService.getDimensions(model.aircraftType)
        if (!modelDims?.wingspan || !modelDims?.length) continue

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
    }

    if (bestMatch && bestDistance <= maxSizeDifference) {
      return { model: bestMatch, scale: bestScale, distance: bestDistance }
    }

    return null
  }

  /**
   * Find an airline-specific fallback model from common narrowbody types
   * Used when aircraft type is unknown but airline is known
   *
   * Searches through common narrowbody types in order of preference:
   * B738, A320, A321, B739, A319, B737, A20N, A21N, A19N, B38M, B39M
   *
   * @param airlineCode - Airline code to search for
   * @returns First matching model info, or null if no airline model found
   */
  findAirlineFallbackModel(airlineCode: string): SourceModelInfo | null {
    const settings = this.getSettings()

    // Common narrowbody types to try, in order of preference
    const narrowbodyTypes = [
      'B738', 'A320', 'A321', 'B739', 'A319', 'B737',
      'A20N', 'A21N', 'A19N', 'B38M', 'B39M', 'B73X'
    ]

    // Search in source priority order
    for (const source of settings.priority) {
      const models = source === 'fsltl' ? this.fsltlModels : this.aigModels
      const enabled = source === 'fsltl' ? settings.enableFsltl : settings.enableAig
      if (!enabled) continue

      // Try each narrowbody type
      for (const aircraftType of narrowbodyTypes) {
        for (const model of models.values()) {
          if (model.aircraftType === aircraftType && model.airlineCode === airlineCode) {
            return model
          }
        }
      }
    }

    return null
  }

  /**
   * Find closest model across ALL available models by dimensions
   * Used as fallback when no airline-specific match exists
   *
   * @param targetType - Requested aircraft type
   * @param maxSizeDifference - Maximum normalized size difference (default 0.5 = 50%)
   * @returns Closest model with scale factors, or null
   */
  findClosestModel(
    targetType: string,
    maxSizeDifference = 0.5
  ): { model: SourceModelInfo; scale: { x: number; y: number; z: number }; distance: number } | null {
    const settings = this.getSettings()

    // Get target dimensions
    const targetDims = aircraftDimensionsService.getDimensions(targetType)
    if (!targetDims?.wingspan || !targetDims?.length) return null

    let bestMatch: SourceModelInfo | null = null
    let bestDistance = Infinity
    let bestScale = { x: 1, y: 1, z: 1 }

    // Search all sources
    for (const source of settings.priority) {
      const models = source === 'fsltl' ? this.fsltlModels : this.aigModels
      const enabled = source === 'fsltl' ? settings.enableFsltl : settings.enableAig
      if (!enabled) continue

      for (const model of models.values()) {
        // Get dimensions for this model's aircraft type
        const modelDims = aircraftDimensionsService.getDimensions(model.aircraftType)
        if (!modelDims?.wingspan || !modelDims?.length) continue

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
    }

    if (bestMatch && bestDistance <= maxSizeDifference) {
      return { model: bestMatch, scale: bestScale, distance: bestDistance }
    }

    return null
  }

  // ===========================================================================
  // CONVERSION
  // ===========================================================================

  /**
   * Convert a model on-demand
   * Returns immediately if model is already cached
   */
  async convertModel(sourceInfo: SourceModelInfo): Promise<ConversionResult> {
    const modelKey = this.getModelKey(sourceInfo)

    // Check memory cache first
    const cached = this.memoryCache.get(modelKey)
    if (cached) {
      cached.lastAccessed = Date.now()
      return { success: true, glbPath: cached.path, fileSize: cached.fileSize }
    }

    // Check if conversion is already in progress
    const status = this.conversionStatus.get(modelKey)
    if (status?.converting && status.promise) {
      return status.promise
    }

    // Check disk cache (if enabled)
    const settings = this.getSettings()
    if (settings.cacheDirectory) {
      const diskPath = await this.checkDiskCache(modelKey, settings.cacheDirectory)
      if (diskPath) {
        return { success: true, glbPath: diskPath }
      }
    }

    // Start new conversion (or queue if at max concurrent)
    return this.queueConversion(sourceInfo)
  }

  /**
   * Queue a conversion request
   */
  private queueConversion(sourceInfo: SourceModelInfo): Promise<ConversionResult> {
    const modelKey = this.getModelKey(sourceInfo)

    const promise = new Promise<ConversionResult>((resolve) => {
      if (this.activeConversions < this.MAX_CONCURRENT) {
        this.executeConversion(sourceInfo, resolve)
      } else {
        this.conversionQueue.push({ sourceInfo, resolve })
      }
    })

    // Track conversion status
    this.conversionStatus.set(modelKey, {
      converting: true,
      promise,
      startedAt: Date.now()
    })

    return promise
  }

  /**
   * Execute a model conversion
   */
  private async executeConversion(
    sourceInfo: SourceModelInfo,
    resolve: (result: ConversionResult) => void
  ): Promise<void> {
    this.activeConversions++
    const modelKey = this.getModelKey(sourceInfo)

    try {
      if (!isTauri()) {
        throw new Error('Model conversion requires Tauri desktop mode')
      }

      const { invoke } = await import('@tauri-apps/api/core')
      const settings = this.getSettings()

      // Determine output path
      const outputPath = settings.cacheDirectory
        ? `${settings.cacheDirectory}/${modelKey}.glb`
        : null // Will return blob data

      // Always need an output path - use cache directory or temp location
      const finalOutputPath = outputPath || await this.getTempOutputPath(modelKey)

      const result = await invoke<{
        success: boolean
        outputPath?: string
        error?: string
        durationMs: number
      }>('convert_msfs_model', {
        gltfPath: sourceInfo.gltfPath,
        outputPath: finalOutputPath,
        textureDirs: sourceInfo.textureDirs,
        textureScale: settings.textureScale
      })

      console.log(`[MSFSConversion] Converted ${modelKey} in ${result.durationMs}ms`)

      if (result.success && result.outputPath) {
        // Get file size from disk
        const fileSize = await invoke<number>('get_file_size', { path: result.outputPath })

        // Add to cache
        this.addToCacheEntry(modelKey, result.outputPath, fileSize, true)

        resolve({
          success: true,
          glbPath: result.outputPath,
          fileSize
        })
      } else {
        // Track as failed so we skip it on subsequent requests
        this.failedConversions.add(modelKey)
        console.warn(`[MSFSConversion] Marking ${modelKey} as failed: ${result.error || 'No output file'}`)
        console.warn(`[MSFSConversion] Output path was: ${finalOutputPath}`)
        resolve({
          success: false,
          error: result.error || 'Unknown conversion error'
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[MSFSConversion] Failed to convert ${modelKey}:`, message)
      // Track as failed so we skip it on subsequent requests
      this.failedConversions.add(modelKey)
      resolve({ success: false, error: message })
    } finally {
      this.activeConversions--
      this.conversionStatus.set(modelKey, { converting: false })

      // Process next queued conversion
      this.processQueue()
    }
  }

  /**
   * Process the next item in the conversion queue
   */
  private processQueue(): void {
    if (this.activeConversions >= this.MAX_CONCURRENT) return
    if (this.conversionQueue.length === 0) return

    const next = this.conversionQueue.shift()
    if (next) {
      this.executeConversion(next.sourceInfo, next.resolve)
    }
  }

  // ===========================================================================
  // CACHING
  // ===========================================================================

  /**
   * Get model key for cache lookups
   */
  private getModelKey(sourceInfo: SourceModelInfo): string {
    return `${sourceInfo.source}_${sourceInfo.modelName}`
  }

  /**
   * Get a temporary output path for models when no cache directory is set
   */
  private async getTempOutputPath(modelKey: string): Promise<string> {
    if (!isTauri()) {
      return `temp_${modelKey}.glb`
    }

    try {
      const { appDataDir, join } = await import('@tauri-apps/api/path')
      const appData = await appDataDir()
      // Use join for proper path handling on all platforms
      const cachePath = await join(appData, 'msfs_cache', `${modelKey}.glb`)
      console.log(`[MSFSConversion] Output path: ${cachePath}`)
      return cachePath
    } catch (e) {
      console.warn('[MSFSConversion] Failed to get app data dir, using relative path:', e)
      return `msfs_cache/${modelKey}.glb`
    }
  }

  /**
   * Add entry to cache, evicting LRU entries if over limit
   */
  private addToCacheEntry(
    modelKey: string,
    path: string,
    fileSize: number,
    isDiskCache: boolean
  ): void {
    const entry: CacheEntry = {
      path,
      fileSize,
      lastAccessed: Date.now(),
      isDiskCache
    }

    this.memoryCache.set(modelKey, entry)
    this.totalCacheSize += fileSize

    // Check if we need to evict entries (disk cache only)
    if (isDiskCache) {
      this.enforceLimit()
    }
  }

  /**
   * Enforce cache size limit using LRU eviction
   */
  private async enforceLimit(): Promise<void> {
    const settings = this.getSettings()
    if (settings.cacheLimitMB === null) return // Unlimited

    const limitBytes = settings.cacheLimitMB * 1024 * 1024

    // Get disk cache entries sorted by last access (oldest first)
    const diskEntries = Array.from(this.memoryCache.entries())
      .filter(([, entry]) => entry.isDiskCache)
      .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed)

    // Evict oldest entries until under limit
    let currentSize = diskEntries.reduce((sum, [, e]) => sum + e.fileSize, 0)

    for (const [key, entry] of diskEntries) {
      if (currentSize <= limitBytes) break

      // Delete from disk
      try {
        if (isTauri()) {
          const { invoke } = await import('@tauri-apps/api/core')
          await invoke('delete_cache_file', { path: entry.path })
        }
      } catch {
        console.warn(`[MSFSConversion] Failed to delete cache file: ${entry.path}`)
      }

      // Remove from memory cache
      this.memoryCache.delete(key)
      currentSize -= entry.fileSize
      this.totalCacheSize -= entry.fileSize

      console.log(`[MSFSConversion] Evicted ${key} from cache (LRU)`)
    }
  }

  /**
   * Check if model is in disk cache
   */
  private async checkDiskCache(
    modelKey: string,
    cacheDir: string
  ): Promise<string | null> {
    if (!isTauri()) return null

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const path = `${cacheDir}/${modelKey}.glb`

      const exists = await invoke<boolean>('file_exists', { path })
      if (exists) {
        // Get file size and add to memory cache
        const fileSize = await invoke<number>('get_file_size', { path })
        this.addToCacheEntry(modelKey, path, fileSize, true)
        return path
      }
    } catch {
      // File doesn't exist or error checking
    }

    return null
  }

  /**
   * Get cached model path (returns null if not cached)
   */
  getCachedModel(modelName: string, source: MSFSModelSource): string | null {
    const modelKey = `${source}_${modelName}`
    const entry = this.memoryCache.get(modelKey)
    if (entry) {
      entry.lastAccessed = Date.now()
      return entry.path
    }
    return null
  }

  /**
   * Check if a model is being converted
   */
  isConverting(modelName: string, source: MSFSModelSource): boolean {
    const modelKey = `${source}_${modelName}`
    return this.conversionStatus.get(modelKey)?.converting ?? false
  }

  /**
   * Check if a model conversion has previously failed
   * Used to skip failed models and try next alternatives
   */
  hasConversionFailed(modelName: string, source: MSFSModelSource): boolean {
    const modelKey = `${source}_${modelName}`
    return this.failedConversions.has(modelKey)
  }

  /**
   * Clear all cached models
   */
  async clearCache(): Promise<void> {
    // Revoke blob URLs for memory-only cache
    for (const [, entry] of this.memoryCache) {
      if (!entry.isDiskCache && entry.path.startsWith('blob:')) {
        URL.revokeObjectURL(entry.path)
      }
    }

    // Delete disk cache files
    const settings = this.getSettings()
    if (settings.cacheDirectory && isTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('clear_cache_directory', { path: settings.cacheDirectory })
      } catch (error) {
        console.error('[MSFSConversion] Failed to clear disk cache:', error)
      }
    }

    this.memoryCache.clear()
    this.totalCacheSize = 0
    console.log('[MSFSConversion] Cache cleared')
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    entryCount: number
    totalSizeMB: number
    limitMB: number | null
  } {
    const settings = this.getSettings()
    return {
      entryCount: this.memoryCache.size,
      totalSizeMB: Math.round(this.totalCacheSize / 1024 / 1024 * 100) / 100,
      limitMB: settings.cacheLimitMB
    }
  }

  // ===========================================================================
  // MODEL LISTING
  // ===========================================================================

  /**
   * Get list of available models for a source
   */
  getAvailableModels(source: MSFSModelSource): SourceModelInfo[] {
    const models = source === 'fsltl' ? this.fsltlModels : this.aigModels
    return Array.from(models.values())
  }

  /**
   * Get count of available models
   */
  getModelCounts(): { fsltl: number; aig: number } {
    return {
      fsltl: this.fsltlModels.size,
      aig: this.aigModels.size
    }
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

export const MSFSModelConversionService = new MSFSModelConversionServiceClass()
