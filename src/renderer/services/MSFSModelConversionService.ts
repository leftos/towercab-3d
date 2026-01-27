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
  /** Model name - display name from aircraft.cfg title */
  modelName: string
  /** Folder name - actual folder name (e.g., "FSLTL_A320_BAW_IAE") */
  folderName: string
  /** Full path to the aircraft folder (e.g., C:\...\SimObjects\Airplanes\FSLTL_A320_BAW_IAE) */
  aircraftFolderPath: string
  /** Path to the GLTF file */
  gltfPath: string
  /** Paths to texture directories */
  textureDirs: string[]
  /** Aircraft type code (e.g., "B738") - ICAO type designator */
  aircraftType: string
  /** Airline code (e.g., "AAL"), "ZZZZ" for generic white livery, or null for private aircraft */
  airlineCode: string | null
  /** Aircraft registration (e.g., "N100VE") - for private aircraft matching by exact callsign */
  atcId: string | null
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
// Constants
// =============================================================================

/**
 * Converter version - must match CONVERTER_VERSION in convert_fsltl_batch.py
 * and CONVERTER_VERSION in msfs.rs
 * Increment this when converter logic changes to invalidate old cached GLB files
 * Version history:
 *   1: Initial version with source metadata embedding
 *   2: Added animation baking for MSFS models (fixes misaligned flaps, slats, gear, etc.)
 *   3: Fixed steering animations by using identity quaternion frame instead of frame 0
 *   4: Fixed model.cfg parsing to read GLTF filename from XML (fixes wrong engine variant textures)
 *   5: Fixed base_container resolution for FSLTL freighter variants (e.g., B77LF, B744F)
 *   6: Added --no-discovery mode; Rust now handles model.cfg parsing (fixes wrong engine variant for liveries)
 *   7: FROST materials (MSFS 2024 GeoDecalFrosted) made fully transparent instead of magenta
 */
const CONVERTER_VERSION = 7

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
    aircraftPosition?: { lat: number; lon: number }
  }> = []

  /** Current camera position for distance-based queue prioritization */
  private cameraPosition: { lat: number; lon: number } | null = null

  /** Last detection result */
  private lastDetection: MSFSDetectionResult | null = null

  /** FSLTL model index: modelName -> SourceModelInfo */
  private fsltlModels = new Map<string, SourceModelInfo>()

  /** AIG model index: modelName -> SourceModelInfo */
  private aigModels = new Map<string, SourceModelInfo>()


  /** Initialization promise - allows multiple callers to await the same initialization */
  private initPromise: Promise<void> | null = null

  /** Whether initialization has completed (for stats/diagnostics) */
  private initCompleted = false

  // ===========================================================================
  // INITIALIZATION
  // ===========================================================================

  /**
   * Initialize the service by detecting MSFS installations
   * @param onProgress Optional callback to report progress during initialization (status, percentage 0-100)
   */
  async initialize(onProgress?: (status: string, progress?: number) => void): Promise<void> {
    // If initialization already started, return the existing promise
    // This ensures React StrictMode double-invocations await the same initialization
    if (this.initPromise) {
      return this.initPromise
    }

    // Create and store the initialization promise
    this.initPromise = this.doInitialize(onProgress)
    return this.initPromise
  }

  /**
   * Internal initialization logic
   */
  private async doInitialize(onProgress?: (status: string, progress?: number) => void): Promise<void> {

    const settings = useGlobalSettingsStore.getState().msfsModels
    console.log('[MSFSConversion] Initialize settings:', {
      cacheDirectory: settings.cacheDirectory,
      communityPath: settings.communityPath,
      isTauri: isTauri()
    })

    // In remote browser mode, fetch model index from host
    if (!isTauri()) {
      onProgress?.('Fetching model index from host...', 0)
      await this.fetchRemoteModelIndex()
      onProgress?.('Model index loaded', 100)
      console.log('[MSFSConversion] Service initialized (remote mode)')
      return
    }

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
    // Only index enabled sources to avoid unnecessary scanning
    if (settings.communityPath) {
      await this.detectInstallationsSelective(
        settings.communityPath,
        settings.enableFsltl,
        settings.enableAig,
        (status, subProgress) => {
          // Map sub-progress (0-100) to 30-100 range
          const progress = 30 + Math.round((subProgress ?? 50) * 0.7)
          onProgress?.(status, progress)
        }
      )
    }

    this.initCompleted = true
    console.log('[MSFSConversion] Service initialized')
  }

  /**
   * Fetch model index and already-converted models from remote host (for browser mode)
   */
  private async fetchRemoteModelIndex(): Promise<void> {
    // Fetch source model index (for on-demand conversion)
    try {
      const response = await fetch('/api/msfs/index')
      if (!response.ok) {
        console.warn('[MSFSConversion] Failed to fetch model index:', response.status)
      } else {
        // Rust serializes with camelCase (serde rename_all = "camelCase")
        const data = await response.json() as {
          fsltl: Array<{
            source: string
            modelName: string
            folderName: string
            aircraftFolderPath: string
            gltfPath: string
            textureDirs: string[]
            aircraftType: string
            airlineCode: string | null
            atcId: string | null
          }>
          aig: Array<{
            source: string
            modelName: string
            folderName: string
            aircraftFolderPath: string
            gltfPath: string
            textureDirs: string[]
            aircraftType: string
            airlineCode: string | null
            atcId: string | null
          }>
          totalCount: number
        }

        // Populate model maps from remote index
        for (const model of data.fsltl) {
          this.fsltlModels.set(model.modelName, {
            source: 'fsltl',
            modelName: model.modelName,
            folderName: model.folderName,
            aircraftFolderPath: model.aircraftFolderPath,
            gltfPath: model.gltfPath,
            textureDirs: model.textureDirs,
            aircraftType: model.aircraftType,
            airlineCode: model.airlineCode,
            atcId: model.atcId
          })
        }

        for (const model of data.aig) {
          this.aigModels.set(model.modelName, {
            source: 'aig',
            modelName: model.modelName,
            folderName: model.folderName,
            aircraftFolderPath: model.aircraftFolderPath,
            gltfPath: model.gltfPath,
            textureDirs: model.textureDirs,
            aircraftType: model.aircraftType,
            airlineCode: model.airlineCode,
            atcId: model.atcId
          })
        }

        console.log(`[MSFSConversion] Loaded ${data.totalCount} models from remote (${data.fsltl.length} FSLTL, ${data.aig.length} AIG)`)
      }
    } catch (error) {
      console.warn('[MSFSConversion] Failed to fetch model index:', error)
    }

    // Fetch already-converted models (to populate memory cache)
    // Response format from scan_cache_directory: { model_key, path, file_size, converter_version }
    try {
      const modelsResponse = await fetch('/api/msfs/models')
      if (!modelsResponse.ok) {
        console.warn('[MSFSConversion] Failed to fetch converted models list:', modelsResponse.status)
        return
      }

      const convertedModels = await modelsResponse.json() as Array<{
        model_key: string    // Cache key like "fsltl_FSLTL_FAIB_B738_American"
        path: string         // Full path on host (not used for URL)
        file_size: number
        converter_version: number | null
      }>

      // Filter out outdated models (same as host does during loadCachedModels)
      let loadedCount = 0
      let skippedCount = 0
      for (const model of convertedModels) {
        if (model.converter_version !== CONVERTER_VERSION) {
          skippedCount++
          continue
        }

        // Build URL to serve the model from the cache
        // Files are flat in cache dir, named {model_key}.glb
        // URL-encode the model key to handle spaces and special characters in filenames
        const modelUrl = `/api/msfs/${encodeURIComponent(model.model_key)}.glb`

        // model_key is already in the correct format (e.g., "fsltl_FSLTL_FAIB_B738_American")
        this.memoryCache.set(model.model_key, {
          path: modelUrl,
          fileSize: model.file_size,
          lastAccessed: Date.now(),
          isDiskCache: true
        })
        loadedCount++
      }

      // Count FSLTL vs AIG models for debugging
      const fsltlCount = Array.from(this.memoryCache.keys()).filter(k => k.startsWith('fsltl_')).length
      const aigCount = Array.from(this.memoryCache.keys()).filter(k => k.startsWith('aig_')).length
      console.log(`[MSFSConversion] Loaded ${loadedCount} pre-converted models from host cache (${fsltlCount} FSLTL, ${aigCount} AIG)${skippedCount > 0 ? `, skipped ${skippedCount} outdated` : ''}`)
    } catch (error) {
      console.warn('[MSFSConversion] Failed to fetch converted models:', error)
    }
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
        converter_version: number | null
      }>>('scan_cache_directory', { cacheDir })

      if (cachedModels.length === 0) {
        console.log('[MSFSConversion] No cached models found')
        return
      }

      onProgress?.(`Loading ${cachedModels.length} cached models...`)

      // Add each cached model to memory cache (delete outdated versions)
      let loadedCount = 0
      let deletedCount = 0
      for (const cached of cachedModels) {
        // Delete models with old/missing converter versions
        if (cached.converter_version !== CONVERTER_VERSION) {
          console.log(`[MSFSConversion] Deleting outdated model ${cached.model_key} (version ${cached.converter_version ?? 'unknown'}, need ${CONVERTER_VERSION})`)
          try {
            await invoke<void>('delete_cache_file', { path: cached.path })
          } catch (e) {
            console.warn(`[MSFSConversion] Failed to delete outdated model ${cached.model_key}:`, e)
          }
          deletedCount++
          continue
        }

        this.memoryCache.set(cached.model_key, {
          path: cached.path,
          fileSize: cached.file_size,
          lastAccessed: Date.now(),
          isDiskCache: true
        })
        this.totalCacheSize += cached.file_size
        loadedCount++
      }

      console.log(`[MSFSConversion] Loaded ${loadedCount} cached models (${Math.round(this.totalCacheSize / 1024 / 1024)}MB)${deletedCount > 0 ? `, deleted ${deletedCount} outdated` : ''}`)
    } catch (error) {
      console.warn('[MSFSConversion] Failed to load cached models:', error)
    }
  }

  /**
   * Get current MSFS model settings
   */
  getSettings(): MSFSModelSettings {
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
   * Detect FSLTL and AIG installations, but only index enabled sources
   * Used at startup to avoid scanning disabled sources
   * @param onProgress Optional callback to report progress (status, percentage 0-100)
   */
  async detectInstallationsSelective(
    communityPath: string,
    enableFsltl: boolean,
    enableAig: boolean,
    onProgress?: (status: string, progress?: number) => void
  ): Promise<MSFSDetectionResult> {
    if (!isTauri()) {
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

      // Only index enabled sources
      const willIndexFsltl = enableFsltl && result.fsltlFound && result.fsltlPath
      const willIndexAig = enableAig && result.aigFound && result.aigPath

      // Allocate 20-100% range: split evenly if both will be indexed
      let fsltlEnd = 100
      let aigStart = 20

      if (willIndexFsltl && willIndexAig) {
        fsltlEnd = 60 // 20-60 for FSLTL
        aigStart = 60 // 60-100 for AIG
      }

      // Build model indexes only if enabled
      if (willIndexFsltl) {
        await this.buildFsltlIndex(result.fsltlPath!, (status, subPct) => {
          const pct = 20 + Math.round((subPct / 100) * (fsltlEnd - 20))
          onProgress?.(status, pct)
        })
        onProgress?.('FSLTL models indexed', fsltlEnd)
      } else if (!enableFsltl && result.fsltlFound) {
        onProgress?.('FSLTL disabled, skipping index', fsltlEnd)
      }

      if (willIndexAig) {
        await this.buildAigIndex(result.aigPath!, (status, subPct) => {
          const pct = aigStart + Math.round((subPct / 100) * (100 - aigStart))
          onProgress?.(status, pct)
        })
        onProgress?.('AIG models indexed', 100)
      } else if (!enableAig && result.aigFound) {
        onProgress?.('AIG disabled, skipping index', 100)
      }

      return result
    } catch (error) {
      console.error('[MSFSConversion] Detection failed:', error)
      return { fsltlFound: false, aigFound: false }
    }
  }

  /**
   * Index a source on-demand (when user enables it in settings)
   * Call this after user enables FSLTL or AIG in settings
   * @param source - 'fsltl' or 'aig'
   * @param onProgress Optional callback to report progress (progress: 0-100, status: string)
   */
  async indexSourceOnDemand(
    source: MSFSModelSource,
    onProgress?: (progress: number, status: string) => void
  ): Promise<boolean> {
    if (!this.lastDetection) {
      console.warn('[MSFSConversion] Cannot index on-demand: detection not yet complete')
      return false
    }

    try {
      if (source === 'fsltl' && this.lastDetection.fsltlFound && this.lastDetection.fsltlPath) {
        onProgress?.(10, 'Scanning FSLTL models...')
        await this.buildFsltlIndex(this.lastDetection.fsltlPath, (status, progress) => {
          // Map buildFsltlIndex progress (0-100) to our overall progress (10-95)
          const overallProgress = 10 + (progress ?? 50) * 0.85
          onProgress?.(overallProgress, status)
        })
        onProgress?.(100, 'FSLTL models indexed')
        console.log('[MSFSConversion] FSLTL indexed on-demand')
        return true
      } else if (source === 'aig' && this.lastDetection.aigFound && this.lastDetection.aigPath) {
        onProgress?.(10, 'Scanning AIG models...')
        await this.buildAigIndex(this.lastDetection.aigPath, (status, progress) => {
          // Map buildAigIndex progress (0-100) to our overall progress (10-95)
          const overallProgress = 10 + (progress ?? 50) * 0.85
          onProgress?.(overallProgress, status)
        })
        onProgress?.(100, 'AIG models indexed')
        console.log('[MSFSConversion] AIG indexed on-demand')
        return true
      } else {
        console.warn(`[MSFSConversion] Source ${source} not available for on-demand indexing`)
        return false
      }
    } catch (error) {
      console.error(`[MSFSConversion] Failed to index ${source} on-demand:`, error)
      return false
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
      const { listen } = await import('@tauri-apps/api/event')

      onProgress?.('Indexing FSLTL models...', 0)

      // Listen for progress events from Rust backend
      const unlisten = await listen<{ progress: number; processed: number; total: number }>(
        'msfs-indexing-progress',
        (event) => {
          const { progress, processed, total } = event.payload
          onProgress?.(`Indexing FSLTL models (${processed}/${total})...`, progress)
        }
      )

      try {
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
      } finally {
        unlisten()
      }
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
      const { listen } = await import('@tauri-apps/api/event')

      onProgress?.('Indexing AIG models...', 0)

      // Listen for progress events from Rust backend
      const unlisten = await listen<{ progress: number; processed: number; total: number }>(
        'msfs-indexing-progress',
        (event) => {
          const { progress, processed, total } = event.payload
          onProgress?.(`Indexing AIG models (${processed}/${total})...`, progress)
        }
      )

      try {
        const models = await invoke<SourceModelInfo[]>('list_aig_models', {
          basePath: aigPath
        })

        this.aigModels.clear()
        for (const model of models) {
          this.aigModels.set(model.modelName, model)
        }

        onProgress?.(`Indexed ${models.length.toLocaleString()} AIG models`, 100)

        console.log(`[MSFSConversion] Indexed ${this.aigModels.size} AIG models`)
      } finally {
        unlisten()
      }
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
   *
   * Matching logic:
   * 1. Exact airline match: aircraftType + airlineCode
   * 2. Generic fallback: aircraftType + airlineCode="ZZZZ" (guaranteed white livery)
   *
   * Note: Models with null airlineCode are private aircraft (e.g., N100VE) and should
   * only be matched via findModelByCallsign() with exact registration match.
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

      // Only try exact match (type + airline) - no ZZZZ fallback here
      // ZZZZ fallback is handled separately in findGenericModel()
      if (airlineCode) {
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
   * Find generic (ZZZZ) model for an aircraft type
   * Used as last-resort fallback when no airline-specific match exists
   *
   * @param aircraftType - ICAO aircraft type code
   * @returns Generic model info, or null if no ZZZZ model exists
   */
  findGenericModel(aircraftType: string): SourceModelInfo | null {
    const settings = this.getSettings()

    for (const source of settings.priority) {
      const models = source === 'fsltl' ? this.fsltlModels : this.aigModels
      const enabled = source === 'fsltl' ? settings.enableFsltl : settings.enableAig

      if (!enabled) continue

      for (const model of models.values()) {
        if (model.aircraftType === aircraftType && model.airlineCode === 'ZZZZ') {
          return model
        }
      }
    }

    return null
  }

  /**
   * Find model by aircraft type and exact callsign (for private aircraft)
   * Used when callsign matches aircraft registration (atc_id)
   *
   * Private aircraft (models with null airlineCode) should only be matched
   * when the callsign exactly matches the atc_id (e.g., "N100VE")
   */
  findModelByCallsign(
    aircraftType: string,
    callsign: string
  ): SourceModelInfo | null {
    const settings = this.getSettings()
    const callsignUpper = callsign.toUpperCase()

    // Search in priority order
    for (const source of settings.priority) {
      const models = source === 'fsltl' ? this.fsltlModels : this.aigModels
      const enabled = source === 'fsltl' ? settings.enableFsltl : settings.enableAig

      if (!enabled) continue

      // Find private aircraft (null airlineCode) where atc_id matches callsign exactly
      for (const model of models.values()) {
        if (
          model.aircraftType === aircraftType &&
          model.airlineCode === null &&
          model.atcId?.toUpperCase() === callsignUpper
        ) {
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
  // CAMERA POSITION (for distance-based queue prioritization)
  // ===========================================================================

  /**
   * Set the current camera position for distance-based queue prioritization.
   * Call this from a hook when the camera moves to ensure conversions are
   * prioritized for aircraft closest to the camera.
   */
  setCameraPosition(lat: number, lon: number): void {
    this.cameraPosition = { lat, lon }
  }

  /**
   * Calculate great-circle distance between two points in nautical miles.
   * Uses Haversine formula for accuracy.
   */
  private calculateDistanceNM(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
  ): number {
    const R = 3440.065 // Earth's radius in nautical miles
    const dLat = (lat2 - lat1) * Math.PI / 180
    const dLon = (lon2 - lon1) * Math.PI / 180
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2)
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    return R * c
  }

  // ===========================================================================
  // CONVERSION
  // ===========================================================================

  /**
   * Convert a model on-demand
   * Returns immediately if model is already cached
   * @param sourceInfo Source model information
   * @param aircraftPosition Optional position of the aircraft needing this model (for queue prioritization)
   */
  async convertModel(
    sourceInfo: SourceModelInfo,
    aircraftPosition?: { lat: number; lon: number }
  ): Promise<ConversionResult> {
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
    return this.queueConversion(sourceInfo, aircraftPosition)
  }

  /**
   * Queue a conversion request
   * @param sourceInfo Source model information
   * @param aircraftPosition Optional position of the aircraft needing this model
   */
  private queueConversion(
    sourceInfo: SourceModelInfo,
    aircraftPosition?: { lat: number; lon: number }
  ): Promise<ConversionResult> {
    const modelKey = this.getModelKey(sourceInfo)

    const promise = new Promise<ConversionResult>((resolve) => {
      // Always queue first, then let processQueue() sort by distance and start
      // This ensures closer aircraft are prioritized even when there's capacity
      this.conversionQueue.push({ sourceInfo, resolve, aircraftPosition })
    })

    // Track conversion status
    this.conversionStatus.set(modelKey, {
      converting: true,
      promise,
      startedAt: Date.now()
    })

    // Trigger queue processing (will sort by distance and start if capacity available)
    this.processQueue()

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
      // In remote browser mode, use HTTP API
      if (!isTauri()) {
        await this.executeRemoteConversion(sourceInfo, resolve, modelKey)
        return
      }

      const { invoke } = await import('@tauri-apps/api/core')
      const settings = this.getSettings()

      // Pass output DIRECTORY to Python converter (not a file path)
      // Python will create: {outputDir}/{source}_{liveryTitle}.glb
      const outputDir = settings.cacheDirectory || await this.getTempOutputDir()

      // Determine source path - use specific aircraft folder, not the entire FSLTL/AIG folder
      let sourcePath: string
      if (sourceInfo.aircraftFolderPath) {
        // Use the full path if available
        sourcePath = sourceInfo.aircraftFolderPath
      } else {
        // Reconstruct from gltfPath by getting the aircraft folder
        // gltfPath is like: .../SimObjects/Airplanes/FSLTL_A320/model/model.gltf
        // We want: .../SimObjects/Airplanes/FSLTL_A320
        const parts = sourceInfo.gltfPath.split(/[/\\]/)
        parts.pop() // Remove 'model.gltf'
        parts.pop() // Remove 'model' folder
        sourcePath = parts.join('\\') // Use backslashes for Windows
      }

      if (!sourcePath) {
        throw new Error(`Cannot determine source path for model conversion`)
      }

      const result = await invoke<{
        success: boolean
        outputPath?: string
        error?: string
        durationMs: number
      }>('convert_msfs_model', {
        sourcePath,
        folderName: sourceInfo.folderName,
        outputDir,  // Changed: pass directory, not full file path
        textureScale: settings.textureScale,
        // Pass the specific livery title to convert only this livery
        liveryTitle: sourceInfo.modelName,
        // Pass explicit GLTF path (critical for AIG shared models where GLTF
        // is in a different folder than the livery aircraft.cfg)
        gltfPath: sourceInfo.gltfPath,
        // Pass explicit texture directories from indexing (critical for AIG models
        // where multiple liveries share the same base model folder)
        textureDirs: sourceInfo.textureDirs
      })

      if (result.success && result.outputPath) {
        console.log(`[MSFSConversion] Converted ${modelKey} in ${result.durationMs}ms`)

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
        console.warn(`[MSFSConversion] Conversion failed for ${modelKey} (${result.durationMs}ms): ${result.error || 'No output file'}`)
        console.warn(`[MSFSConversion] Source: ${sourcePath}, Output dir: ${outputDir}`)
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
   * Execute model conversion via remote HTTP API (for browser mode)
   */
  private async executeRemoteConversion(
    sourceInfo: SourceModelInfo,
    resolve: (result: ConversionResult) => void,
    modelKey: string
  ): Promise<void> {
    try {
      const settings = this.getSettings()

      const response = await fetch('/api/msfs/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model_name: sourceInfo.modelName,
          texture_scale: settings.textureScale
        })
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const result = await response.json() as {
        success: boolean
        output_path?: string
        error?: string
      }

      if (result.success && result.output_path) {
        console.log(`[MSFSConversion] Remote conversion succeeded for ${modelKey}`)

        // Build URL to the converted model (URL-encode to handle spaces and special characters)
        const modelUrl = `/api/msfs/${encodeURIComponent(result.output_path)}`

        // Add to cache (remote files don't have local size info)
        this.memoryCache.set(modelKey, {
          path: modelUrl,
          fileSize: 0,
          lastAccessed: Date.now(),
          isDiskCache: true
        })

        resolve({
          success: true,
          glbPath: modelUrl
        })
      } else {
        this.failedConversions.add(modelKey)
        console.warn(`[MSFSConversion] Remote conversion failed for ${modelKey}: ${result.error}`)
        resolve({
          success: false,
          error: result.error || 'Unknown conversion error'
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[MSFSConversion] Remote conversion failed for ${modelKey}:`, message)
      this.failedConversions.add(modelKey)
      resolve({ success: false, error: message })
    } finally {
      this.activeConversions--
      this.conversionStatus.set(modelKey, { converting: false })
      this.processQueue()
    }
  }

  /**
   * Process items in the conversion queue.
   * Prioritizes aircraft closest to the camera when position data is available.
   * Continues processing while there's capacity and items in queue.
   */
  private processQueue(): void {
    // Sort queue by distance before processing (closest first)
    if (this.cameraPosition && this.conversionQueue.length > 1) {
      this.conversionQueue.sort((a, b) => {
        // Items without position go to the end
        if (!a.aircraftPosition && !b.aircraftPosition) return 0
        if (!a.aircraftPosition) return 1
        if (!b.aircraftPosition) return -1

        const distA = this.calculateDistanceNM(
          this.cameraPosition!.lat,
          this.cameraPosition!.lon,
          a.aircraftPosition.lat,
          a.aircraftPosition.lon
        )
        const distB = this.calculateDistanceNM(
          this.cameraPosition!.lat,
          this.cameraPosition!.lon,
          b.aircraftPosition.lat,
          b.aircraftPosition.lon
        )
        return distA - distB
      })
    }

    // Start conversions while we have capacity
    while (this.activeConversions < this.MAX_CONCURRENT && this.conversionQueue.length > 0) {
      const next = this.conversionQueue.shift()
      if (next) {
        this.executeConversion(next.sourceInfo, next.resolve)
      }
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
   * Get a temporary output directory for models when no cache directory is set
   * (Returns the directory path, not a file path - converter creates subdirectories)
   */
  private async getTempOutputDir(): Promise<string> {
    if (!isTauri()) {
      return 'msfs_cache'
    }

    try {
      const { appDataDir, join } = await import('@tauri-apps/api/path')
      const appData = await appDataDir()
      // Use join for proper path handling on all platforms
      const cacheDir = await join(appData, 'msfs_cache')
      console.log(`[MSFSConversion] Cache directory: ${cacheDir}`)
      return cacheDir
    } catch (e) {
      console.warn('[MSFSConversion] Failed to get app data dir, using relative path:', e)
      return 'msfs_cache'
    }
  }

  /**
   * Get a temporary output path for models when no cache directory is set
   * (Returns a file path - for backwards compatibility)
   */
  private async getTempOutputPath(modelKey: string): Promise<string> {
    const dir = await this.getTempOutputDir()
    return `${dir}/${modelKey}.glb`
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

  /**
   * Get combined service statistics
   */
  getStats(): {
    fsltlCount: number
    aigCount: number
    cacheCount: number
    isInitialized: boolean
  } {
    return {
      fsltlCount: this.fsltlModels.size,
      aigCount: this.aigModels.size,
      cacheCount: this.memoryCache.size,
      isInitialized: this.initCompleted
    }
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

export const MSFSModelConversionService = new MSFSModelConversionServiceClass()
