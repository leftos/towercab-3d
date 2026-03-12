/**
 * Global Settings Store
 *
 * Manages settings that are stored on the host file system and shared across
 * all browsers/devices. Unlike the regular settingsStore (which uses browser
 * localStorage), these settings persist on the host PC and are accessible
 * from remote browser connections (e.g., iPad Safari).
 *
 * Settings stored here:
 * - Cesium Ion token (shared across all devices)
 * - FSLTL configuration (file paths only make sense on host)
 * - Default airport
 * - Remote access server configuration
 *
 * @see settingsStore - Local settings (per-browser)
 * @see tauriApi.globalSettings - Tauri commands for file I/O
 */

import { create } from 'zustand'
import type {
  GlobalSettings,
  GlobalViewportSettings,
  GlobalDisplaySettings,
  GlobalDisplaySettingsUpdate,
  MSFSModelSettings,
  FSLTLTextureScale,
  DataSourceType,
  DatablockMode,
  DatablockDirection,
  MSFSModelSource,
  InsetDisplaySettings,
} from '@/types'
import {
  DEFAULT_GLOBAL_SETTINGS,
  DEFAULT_GLOBAL_DISPLAY_SETTINGS,
  DEFAULT_MSFS_MODEL_SETTINGS,
  MSFS_CACHE_LIMIT,
  DEFAULT_INSET_DISPLAY_SETTINGS,
} from '@/types'
import { globalSettingsApi, isTauri } from '@/utils/tauriApi'
import { listVmrFiles } from '@/services/fsltlApi'

// Key used to track if migration from localStorage has been done
const MIGRATION_KEY = 'globalSettingsMigrationDone'
// Migration key for display settings specifically (v2 migration)
const DISPLAY_MIGRATION_KEY = 'globalSettingsDisplayMigrationDone'

/**
 * Check if there are settings in localStorage that should be migrated
 * Returns the migrated settings or null if no migration needed
 */
function migrateFromLocalStorage(): Partial<GlobalSettings> | null {
  // Check if migration already done
  if (localStorage.getItem(MIGRATION_KEY)) {
    return null
  }

  try {
    // Read from the settings-store key (used by Zustand persist)
    const stored = localStorage.getItem('settings-store')
    if (!stored) {
      localStorage.setItem(MIGRATION_KEY, 'true')
      return null
    }

    const parsed = JSON.parse(stored)
    const state = parsed?.state

    if (!state) {
      localStorage.setItem(MIGRATION_KEY, 'true')
      return null
    }

    const migrated: Partial<GlobalSettings> = {}
    let hasMigration = false

    // Migrate cesiumIonToken
    if (state.cesium?.cesiumIonToken) {
      migrated.cesiumIonToken = state.cesium.cesiumIonToken
      hasMigration = true
      console.log('[GlobalSettings] Migrating cesiumIonToken from localStorage')
    }

    // Migrate FSLTL settings
    if (state.fsltl) {
      migrated.fsltl = {
        sourcePath: state.fsltl.sourcePath || null,
        outputPath: state.fsltl.outputPath || null,
        textureScale: state.fsltl.textureScale || '1k',
        enableFsltlModels: state.fsltl.enableFsltlModels ?? true,
      }
      if (state.fsltl.sourcePath || state.fsltl.outputPath) {
        hasMigration = true
        console.log('[GlobalSettings] Migrating FSLTL settings from localStorage')
      }
    }

    localStorage.setItem(MIGRATION_KEY, 'true')
    return hasMigration ? migrated : null
  } catch (error) {
    console.warn('[GlobalSettings] Migration from localStorage failed:', error)
    localStorage.setItem(MIGRATION_KEY, 'true')
    return null
  }
}

/**
 * Migrate display settings from local settingsStore to global settings
 * This handles the v2 migration where display settings become global
 */
function migrateDisplaySettings(): Partial<GlobalDisplaySettings> | null {
  // Check if migration already done
  if (localStorage.getItem(DISPLAY_MIGRATION_KEY)) {
    return null
  }

  try {
    const stored = localStorage.getItem('settings-store')
    if (!stored) {
      localStorage.setItem(DISPLAY_MIGRATION_KEY, 'true')
      return null
    }

    const parsed = JSON.parse(stored)
    const state = parsed?.state

    if (!state?.aircraft) {
      localStorage.setItem(DISPLAY_MIGRATION_KEY, 'true')
      return null
    }

    const aircraft = state.aircraft
    const migrated: Partial<GlobalDisplaySettings> = {}
    let hasMigration = false

    // Migrate display-related aircraft settings
    if (aircraft.leaderDistance !== undefined) {
      migrated.leaderDistance = aircraft.leaderDistance
      hasMigration = true
    }
    if (aircraft.defaultDatablockDirection !== undefined) {
      migrated.defaultDatablockDirection = aircraft.defaultDatablockDirection
      hasMigration = true
    }
    if (aircraft.datablockMode !== undefined) {
      migrated.datablockMode = aircraft.datablockMode
      hasMigration = true
    }
    if (aircraft.labelVisibilityDistance !== undefined) {
      migrated.labelVisibilityDistance = aircraft.labelVisibilityDistance
      hasMigration = true
    }
    if (aircraft.showGroundTraffic !== undefined) {
      migrated.showGroundTraffic = aircraft.showGroundTraffic
      hasMigration = true
    }
    if (aircraft.showAirborneTraffic !== undefined) {
      migrated.showAirborneTraffic = aircraft.showAirborneTraffic
      hasMigration = true
    }
    if (aircraft.autoAvoidOverlaps !== undefined) {
      migrated.autoAvoidOverlaps = aircraft.autoAvoidOverlaps
      hasMigration = true
    }

    if (hasMigration) {
      console.log('[GlobalSettings] Migrating display settings from localStorage:', Object.keys(migrated))
    }

    localStorage.setItem(DISPLAY_MIGRATION_KEY, 'true')
    return hasMigration ? migrated : null
  } catch (error) {
    console.warn('[GlobalSettings] Display migration from localStorage failed:', error)
    localStorage.setItem(DISPLAY_MIGRATION_KEY, 'true')
    return null
  }
}

// Migration key for FSLTL to MSFS settings (v3 migration)
const MSFS_MIGRATION_KEY = 'globalSettingsMsfsMigrationDone'

/**
 * Migrate old FSLTL settings to new MSFS model settings
 * - Copies outputPath from fsltl to msfsModels.cacheDirectory
 * - Auto-detects VMR files in the cache directory and adds to vmrFiles
 *
 * This enables smooth transition from batch-converted FSLTL models
 * to the new on-demand conversion system.
 */
async function migrateFsltlToMsfs(settings: GlobalSettings): Promise<Partial<MSFSModelSettings> | null> {
  // Skip in browser mode (MSFS features are host-only)
  if (!isTauri()) {
    return null
  }

  // Check if migration already done
  if (localStorage.getItem(MSFS_MIGRATION_KEY)) {
    return null
  }

  try {
    const updates: Partial<MSFSModelSettings> = {}
    let hasMigration = false

    // Migrate outputPath from deprecated fsltl to new msfsModels.cacheDirectory
    // Only if cacheDirectory isn't already set
    if (!settings.msfsModels.cacheDirectory && settings.fsltl.outputPath) {
      updates.cacheDirectory = settings.fsltl.outputPath
      hasMigration = true
      console.log('[GlobalSettings] Migrating FSLTL outputPath to MSFS cacheDirectory:', settings.fsltl.outputPath)
    }

    // Determine which directory to scan for VMR files
    const scanDir = updates.cacheDirectory || settings.msfsModels.cacheDirectory || settings.fsltl.outputPath

    // Auto-detect VMR files in the cache directory
    if (scanDir) {
      const vmrFiles = await listVmrFiles(scanDir)
      if (vmrFiles.length > 0) {
        // Merge with existing vmrFiles (avoid duplicates)
        const existingVmrFiles = new Set(settings.msfsModels.vmrFiles || [])
        const newVmrFiles = vmrFiles.filter((f) => !existingVmrFiles.has(f))

        if (newVmrFiles.length > 0) {
          updates.vmrFiles = [...(settings.msfsModels.vmrFiles || []), ...newVmrFiles]
          hasMigration = true
          console.log('[GlobalSettings] Auto-detected VMR files:', newVmrFiles)
        }
      }
    }

    localStorage.setItem(MSFS_MIGRATION_KEY, 'true')
    return hasMigration ? updates : null
  } catch (error) {
    console.warn('[GlobalSettings] FSLTL to MSFS migration failed:', error)
    localStorage.setItem(MSFS_MIGRATION_KEY, 'true')
    return null
  }
}

interface GlobalSettingsState extends GlobalSettings {
  /** Whether the store has been initialized (loaded from disk) */
  initialized: boolean

  /** Whether we're currently loading settings */
  loading: boolean

  /** Error message if loading failed */
  error: string | null

  /** Path to the global settings file (for diagnostics) */
  settingsFilePath: string | null

  // Actions
  /** Initialize the store by loading settings from disk */
  initialize: () => Promise<void>

  /** Update Cesium Ion token */
  setCesiumIonToken: (token: string) => Promise<void>

  /** Update FSLTL configuration (deprecated, use updateMsfsModels) */
  updateFsltl: (updates: Partial<GlobalSettings['fsltl']>) => Promise<void>

  /** Update MSFS model configuration (on-the-fly conversion) */
  updateMsfsModels: (updates: Partial<MSFSModelSettings>) => Promise<void>

  /** Update airport configuration */
  updateAirports: (updates: Partial<GlobalSettings['airports']>) => Promise<void>

  /** Add an airport to favorites for the specified data source */
  addFavorite: (icao: string, source: DataSourceType) => Promise<void>

  /** Remove an airport from favorites for the specified data source */
  removeFavorite: (icao: string, source: DataSourceType) => Promise<void>

  /** Update server configuration */
  updateServer: (updates: Partial<GlobalSettings['server']>) => Promise<void>

  /** Update viewport settings (camera positions, bookmarks) */
  updateViewports: (updates: Partial<GlobalViewportSettings>) => Promise<void>

  /** Set entire viewport settings (for bulk updates from viewportStore) */
  setViewports: (viewports: GlobalViewportSettings) => Promise<void>

  /** Update RealTraffic settings (data source, license key, radius) */
  updateRealTraffic: (updates: Partial<GlobalSettings['realtraffic']>) => Promise<void>

  /** Update imagery provider settings */
  updateImagery: (updates: Partial<GlobalSettings['imagery']>) => Promise<void>

  /** Update display settings (datablocks, labels, filtering - synced across devices) */
  updateDisplay: (updates: GlobalDisplaySettingsUpdate) => Promise<void>

  /** Update disabled mods list */
  updateDisabledMods: (disabledMods: string[]) => Promise<void>

  /** Reset to default settings */
  resetToDefaults: () => Promise<void>

  /** Get current settings (without actions) */
  getSettings: () => GlobalSettings

  /** Refresh settings from disk/server (used for sync) */
  refresh: () => Promise<void>
}

/**
 * Save settings to disk via Tauri or HTTP API
 * In remote browser mode, saves via HTTP which updates the host settings
 */
async function saveSettings(settings: GlobalSettings): Promise<void> {
  try {
    await globalSettingsApi.write(settings)
  } catch (error) {
    console.error('[GlobalSettings] Failed to save settings:', error)
    throw error
  }
}

export const useGlobalSettingsStore = create<GlobalSettingsState>()((set, get) => ({
  // Initial state (will be overwritten by initialize)
  ...DEFAULT_GLOBAL_SETTINGS,
  initialized: false,
  loading: false,
  error: null,
  settingsFilePath: null,

  initialize: async () => {
    if (get().initialized) {
      return // Already initialized
    }

    set({ loading: true, error: null })

    try {
      // Get settings file path for diagnostics
      const settingsFilePath = await globalSettingsApi.getPath()

      // Load settings from disk (or HTTP API in browser mode)
      let settings = await globalSettingsApi.read()

      // Merge with defaults to handle new fields added in updates
      // This ensures existing users get default values for new settings
      settings = {
        ...DEFAULT_GLOBAL_SETTINGS,
        ...settings,
        // Deep merge nested objects to preserve existing values while adding new fields
        imagery: {
          ...DEFAULT_GLOBAL_SETTINGS.imagery,
          ...settings.imagery,
          // Deep merge per-provider adjustments
          cesiumAdjustments: {
            ...DEFAULT_GLOBAL_SETTINGS.imagery.cesiumAdjustments,
            ...settings.imagery?.cesiumAdjustments,
          },
          googleAdjustments: {
            ...DEFAULT_GLOBAL_SETTINGS.imagery.googleAdjustments,
            ...settings.imagery?.googleAdjustments,
          },
        },
        msfsModels: { ...DEFAULT_MSFS_MODEL_SETTINGS, ...settings.msfsModels },
        fsltl: { ...DEFAULT_GLOBAL_SETTINGS.fsltl, ...settings.fsltl },
        airports: { ...DEFAULT_GLOBAL_SETTINGS.airports, ...settings.airports },
        server: { ...DEFAULT_GLOBAL_SETTINGS.server, ...settings.server },
        realtraffic: { ...DEFAULT_GLOBAL_SETTINGS.realtraffic, ...settings.realtraffic },
        viewports: {
          ...DEFAULT_GLOBAL_SETTINGS.viewports,
          ...settings.viewports,
          // Preserve nested viewport objects
          airportConfigs: settings.viewports?.airportConfigs ?? DEFAULT_GLOBAL_SETTINGS.viewports.airportConfigs,
          orbitSettings: settings.viewports?.orbitSettings ?? DEFAULT_GLOBAL_SETTINGS.viewports.orbitSettings,
        },
        display: { ...DEFAULT_GLOBAL_DISPLAY_SETTINGS, ...settings.display },
      }

      // Check if we need to migrate from localStorage (one-time migration)
      // This only happens in Tauri mode when global settings file is new/empty
      if (isTauri()) {
        const needsMigration = !settings.cesiumIonToken && !settings.fsltl.sourcePath
        if (needsMigration) {
          const migrated = migrateFromLocalStorage()
          if (migrated) {
            // Merge migrated values with loaded settings
            settings = {
              ...settings,
              cesiumIonToken: migrated.cesiumIonToken || settings.cesiumIonToken,
              fsltl: migrated.fsltl || settings.fsltl,
            }
            // Save the migrated settings to disk
            await globalSettingsApi.write(settings)
            console.log('[GlobalSettings] Migration complete, saved to disk')
          }
        }
      }

      // Migrate display settings from localStorage (v2 migration)
      // This runs for both Tauri and remote browser modes to pick up local preferences
      const displayMigrated = migrateDisplaySettings()
      if (displayMigrated) {
        settings = {
          ...settings,
          display: { ...settings.display, ...displayMigrated },
        }
        // Save the migrated display settings
        await globalSettingsApi.write(settings)
        console.log('[GlobalSettings] Display settings migration complete')
      }

      // Migrate FSLTL settings to new MSFS system (v3 migration)
      // - Copies outputPath to cacheDirectory for pre-converted model reuse
      // - Auto-detects VMR files in the cache directory
      const msfsMigrated = await migrateFsltlToMsfs(settings)
      if (msfsMigrated) {
        settings = {
          ...settings,
          msfsModels: { ...settings.msfsModels, ...msfsMigrated },
        }
        // Save the migrated MSFS settings
        await globalSettingsApi.write(settings)
        console.log('[GlobalSettings] FSLTL to MSFS migration complete')
      }

      set({
        ...settings,
        initialized: true,
        loading: false,
        error: null,
        settingsFilePath,
      })

      console.log('[GlobalSettings] Loaded from:', settingsFilePath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[GlobalSettings] Failed to load:', message)

      // Fall back to defaults
      set({
        ...DEFAULT_GLOBAL_SETTINGS,
        initialized: true,
        loading: false,
        error: message,
      })
    }
  },

  setCesiumIonToken: async (token: string) => {
    // Update state first, then save all current state
    set({ cesiumIonToken: token })
    await saveSettings(get().getSettings())
  },

  updateFsltl: async (updates: Partial<GlobalSettings['fsltl']>) => {
    const state = get()
    const newFsltl = {
      ...state.fsltl,
      ...updates,
      // Validate texture scale
      textureScale: (updates.textureScale && ['full', '2k', '1k', '512'].includes(updates.textureScale)
        ? updates.textureScale
        : state.fsltl.textureScale) as FSLTLTextureScale,
    }
    set({ fsltl: newFsltl })
    await saveSettings(get().getSettings())
  },

  updateMsfsModels: async (updates: Partial<MSFSModelSettings>) => {
    const state = get()
    const newMsfsModels: MSFSModelSettings = {
      ...state.msfsModels,
      ...updates,
      // Validate texture scale
      textureScale: (updates.textureScale && ['full', '2k', '1k', '512'].includes(updates.textureScale)
        ? updates.textureScale
        : state.msfsModels.textureScale) as FSLTLTextureScale,
      // Validate priority array
      priority: updates.priority
        ? updates.priority.filter((s): s is MSFSModelSource => s === 'fsltl' || s === 'aig')
        : state.msfsModels.priority,
      // Validate cache limit (null for unlimited, or 500-20480 MB)
      cacheLimitMB:
        updates.cacheLimitMB === null
          ? null
          : updates.cacheLimitMB !== undefined
            ? Math.max(MSFS_CACHE_LIMIT.MIN_MB, Math.min(MSFS_CACHE_LIMIT.MAX_MB, updates.cacheLimitMB))
            : state.msfsModels.cacheLimitMB,
      // Ensure vmrFiles is always an array
      vmrFiles: updates.vmrFiles ?? state.msfsModels.vmrFiles,
    }
    set({ msfsModels: newMsfsModels })
    await saveSettings(get().getSettings())

    // Invalidate aircraft model cache when MSFS settings change
    // This ensures aircraft are re-matched with the new settings
    const { aircraftModelService } = await import('@/services/AircraftModelService')
    aircraftModelService.clearCache()

    // Trigger on-demand indexing if a source is being enabled
    const { MSFSModelConversionService } = await import('@/services/MSFSModelConversionService')
    const { useIndexingStore } = await import('@/stores/indexingStore')

    if (updates.enableFsltl === true && state.msfsModels.enableFsltl === false) {
      // FSLTL being enabled - index it if not already indexed
      console.log('[GlobalSettings] FSLTL enabled, indexing on-demand')
      const indexingStore = useIndexingStore.getState()
      indexingStore.startIndexing('fsltl')

      MSFSModelConversionService.indexSourceOnDemand('fsltl', (progress, status) => {
        useIndexingStore.getState().updateProgress(progress, status)
        console.log('[GlobalSettings] FSLTL indexing:', `${Math.round(progress)}%`, status)
      })
        .then((success) => {
          if (success) {
            useIndexingStore.getState().finishIndexing()
          } else {
            useIndexingStore.getState().cancel()
          }
        })
        .catch((err) => {
          console.error('[GlobalSettings] Failed to index FSLTL on-demand:', err)
          useIndexingStore.getState().cancel()
        })
    }

    if (updates.enableAig === true && state.msfsModels.enableAig === false) {
      // AIG being enabled - index it if not already indexed
      console.log('[GlobalSettings] AIG enabled, indexing on-demand')
      const indexingStore = useIndexingStore.getState()
      indexingStore.startIndexing('aig')

      MSFSModelConversionService.indexSourceOnDemand('aig', (progress, status) => {
        useIndexingStore.getState().updateProgress(progress, status)
        console.log('[GlobalSettings] AIG indexing:', `${Math.round(progress)}%`, status)
      })
        .then((success) => {
          if (success) {
            useIndexingStore.getState().finishIndexing()
          } else {
            useIndexingStore.getState().cancel()
          }
        })
        .catch((err) => {
          console.error('[GlobalSettings] Failed to index AIG on-demand:', err)
          useIndexingStore.getState().cancel()
        })
    }

    // Dispatch event so useAircraftModels hook can clear model pool URLs
    window.dispatchEvent(
      new CustomEvent('msfs-settings-changed', {
        detail: { newMsfsModels, previousMsfsModels: state.msfsModels },
      }),
    )
  },

  updateAirports: async (updates: Partial<GlobalSettings['airports']>) => {
    const state = get()
    const newAirports = { ...state.airports, ...updates }
    set({ airports: newAirports })
    await saveSettings(get().getSettings())
  },

  addFavorite: async (icao: string, source: DataSourceType) => {
    const state = get()
    const currentFavorites =
      source === 'vatsim' ? (state.airports.vatsimFavorites ?? []) : (state.airports.realtrafficFavorites ?? [])

    // Avoid duplicates
    if (currentFavorites.includes(icao)) return

    const newFavorites = [...currentFavorites, icao]
    const newAirports =
      source === 'vatsim'
        ? { ...state.airports, vatsimFavorites: newFavorites }
        : { ...state.airports, realtrafficFavorites: newFavorites }
    set({ airports: newAirports })
    await saveSettings(get().getSettings())
  },

  removeFavorite: async (icao: string, source: DataSourceType) => {
    const state = get()
    const currentFavorites =
      source === 'vatsim' ? (state.airports.vatsimFavorites ?? []) : (state.airports.realtrafficFavorites ?? [])

    const newFavorites = currentFavorites.filter((f) => f !== icao)
    const newAirports =
      source === 'vatsim'
        ? { ...state.airports, vatsimFavorites: newFavorites }
        : { ...state.airports, realtrafficFavorites: newFavorites }
    set({ airports: newAirports })
    await saveSettings(get().getSettings())
  },

  updateServer: async (updates: Partial<GlobalSettings['server']>) => {
    const state = get()
    const newServer = {
      ...state.server,
      ...updates,
      // Validate port range
      port: updates.port !== undefined ? Math.max(1024, Math.min(65535, updates.port)) : state.server.port,
    }
    set({ server: newServer })
    await saveSettings(get().getSettings())
  },

  updateViewports: async (updates: Partial<GlobalViewportSettings>) => {
    const state = get()
    const newViewports: GlobalViewportSettings = {
      ...state.viewports,
      ...updates,
      // Deep merge airportConfigs if provided
      airportConfigs: updates.airportConfigs
        ? { ...state.viewports.airportConfigs, ...updates.airportConfigs }
        : state.viewports.airportConfigs,
      // Deep merge orbitSettings if provided
      orbitSettings: updates.orbitSettings
        ? { ...state.viewports.orbitSettings, ...updates.orbitSettings }
        : state.viewports.orbitSettings,
    }
    set({ viewports: newViewports })
    await saveSettings(get().getSettings())
  },

  setViewports: async (viewports: GlobalViewportSettings) => {
    set({ viewports })
    await saveSettings(get().getSettings())
  },

  updateRealTraffic: async (updates: Partial<GlobalSettings['realtraffic']>) => {
    const state = get()
    const newRealTraffic = {
      ...state.realtraffic,
      ...updates,
      // Validate dataSource
      dataSource: (updates.dataSource && ['vatsim', 'realtraffic'].includes(updates.dataSource)
        ? updates.dataSource
        : state.realtraffic.dataSource) as DataSourceType,
      // Validate radiusNm (10-200)
      radiusNm:
        updates.radiusNm !== undefined ? Math.max(10, Math.min(200, updates.radiusNm)) : state.realtraffic.radiusNm,
      // Validate maxParkedAircraft (0-200)
      maxParkedAircraft:
        updates.maxParkedAircraft !== undefined
          ? Math.max(0, Math.min(200, updates.maxParkedAircraft))
          : state.realtraffic.maxParkedAircraft,
    }
    set({ realtraffic: newRealTraffic })
    await saveSettings(get().getSettings())
  },

  updateImagery: async (updates: Partial<GlobalSettings['imagery']>) => {
    const state = get()
    const newImagery = {
      ...state.imagery,
      ...updates,
      // Validate provider
      provider: (updates.provider && ['cesium', 'google'].includes(updates.provider)
        ? updates.provider
        : state.imagery.provider) as GlobalSettings['imagery']['provider'],
      // Deep merge adjustments if provided
      cesiumAdjustments: updates.cesiumAdjustments
        ? { ...state.imagery.cesiumAdjustments, ...updates.cesiumAdjustments }
        : state.imagery.cesiumAdjustments,
      googleAdjustments: updates.googleAdjustments
        ? { ...state.imagery.googleAdjustments, ...updates.googleAdjustments }
        : state.imagery.googleAdjustments,
    }
    set({ imagery: newImagery })
    await saveSettings(get().getSettings())
  },

  updateDisplay: async (updates: GlobalDisplaySettingsUpdate) => {
    const state = get()
    // Handle nested inset object - merge instead of replace
    const currentInset = state.display.inset ?? DEFAULT_INSET_DISPLAY_SETTINGS
    const updatedInset: InsetDisplaySettings = updates.inset
      ? {
          ...currentInset,
          ...updates.inset,
          // Validate visibilityMargin (0.0-0.3)
          visibilityMargin:
            updates.inset.visibilityMargin !== undefined
              ? Math.max(0, Math.min(0.3, updates.inset.visibilityMargin))
              : currentInset.visibilityMargin,
        }
      : currentInset

    const newDisplay: GlobalDisplaySettings = {
      ...state.display,
      ...updates,
      // Validate leaderDistance (0.5-5)
      leaderDistance:
        updates.leaderDistance !== undefined
          ? Math.max(0.5, Math.min(5, updates.leaderDistance))
          : state.display.leaderDistance,
      // Validate defaultDatablockDirection (1-9, excluding 5)
      defaultDatablockDirection:
        updates.defaultDatablockDirection !== undefined
          ? updates.defaultDatablockDirection >= 1 && updates.defaultDatablockDirection <= 9
            ? (updates.defaultDatablockDirection as DatablockDirection)
            : state.display.defaultDatablockDirection
          : state.display.defaultDatablockDirection,
      // Validate datablockMode
      datablockMode:
        updates.datablockMode && ['full', 'airline', 'none'].includes(updates.datablockMode)
          ? (updates.datablockMode as DatablockMode)
          : state.display.datablockMode,
      // Validate labelVisibilityDistance (1-100)
      labelVisibilityDistance:
        updates.labelVisibilityDistance !== undefined
          ? Math.max(1, Math.min(100, updates.labelVisibilityDistance))
          : state.display.labelVisibilityDistance,
      // Use properly merged inset settings
      inset: updatedInset,
    }
    set({ display: newDisplay })
    await saveSettings(get().getSettings())
  },

  updateDisabledMods: async (disabledMods: string[]) => {
    set({ disabledMods })
    await saveSettings(get().getSettings())
  },

  resetToDefaults: async () => {
    set({ ...DEFAULT_GLOBAL_SETTINGS })
    await saveSettings(DEFAULT_GLOBAL_SETTINGS)
  },

  getSettings: (): GlobalSettings => {
    const state = get()
    return {
      cesiumIonToken: state.cesiumIonToken,
      imagery: state.imagery,
      msfsModels: state.msfsModels,
      fsltl: state.fsltl,
      airports: state.airports,
      server: state.server,
      realtraffic: state.realtraffic,
      viewports: state.viewports,
      display: state.display,
      disabledMods: state.disabledMods,
      vnasTokens: state.vnasTokens,
    }
  },

  refresh: async () => {
    try {
      // Reload settings from disk/server
      const settings = await globalSettingsApi.read()
      // Merge with defaults for any missing fields
      const mergedSettings = {
        ...DEFAULT_GLOBAL_SETTINGS,
        ...settings,
        imagery: {
          ...DEFAULT_GLOBAL_SETTINGS.imagery,
          ...settings.imagery,
          cesiumAdjustments: {
            ...DEFAULT_GLOBAL_SETTINGS.imagery.cesiumAdjustments,
            ...settings.imagery?.cesiumAdjustments,
          },
          googleAdjustments: {
            ...DEFAULT_GLOBAL_SETTINGS.imagery.googleAdjustments,
            ...settings.imagery?.googleAdjustments,
          },
        },
        msfsModels: { ...DEFAULT_MSFS_MODEL_SETTINGS, ...settings.msfsModels },
        fsltl: { ...DEFAULT_GLOBAL_SETTINGS.fsltl, ...settings.fsltl },
        airports: { ...DEFAULT_GLOBAL_SETTINGS.airports, ...settings.airports },
        server: { ...DEFAULT_GLOBAL_SETTINGS.server, ...settings.server },
        realtraffic: { ...DEFAULT_GLOBAL_SETTINGS.realtraffic, ...settings.realtraffic },
        viewports: {
          ...DEFAULT_GLOBAL_SETTINGS.viewports,
          ...settings.viewports,
          airportConfigs: settings.viewports?.airportConfigs ?? DEFAULT_GLOBAL_SETTINGS.viewports.airportConfigs,
          orbitSettings: settings.viewports?.orbitSettings ?? DEFAULT_GLOBAL_SETTINGS.viewports.orbitSettings,
        },
        display: { ...DEFAULT_GLOBAL_DISPLAY_SETTINGS, ...settings.display },
      }
      set(mergedSettings)
      console.log('[GlobalSettings] Refreshed from server')
    } catch (error) {
      console.error('[GlobalSettings] Failed to refresh:', error)
    }
  },
}))

/**
 * Hook to get RealTraffic settings
 */
export function useRealTrafficSettings(): GlobalSettings['realtraffic'] {
  return useGlobalSettingsStore((state) => state.realtraffic)
}

/**
 * Initialize global settings store
 * Should be called early in app startup
 */
export async function initializeGlobalSettings(): Promise<void> {
  await useGlobalSettingsStore.getState().initialize()

  // Automatically attempt to recover any settings that may have been
  // lost during previous upgrades. This is safe to run because it only
  // recovers data when current values are empty/missing.
  const result = await repairSettingsMigration()
  if (result.recovered.length > 0) {
    console.log('[GlobalSettings] Auto-recovered settings:', result.recovered)
  }
}

/**
 * Hook to get just the Cesium Ion token
 * Convenient for components that only need the token
 */
export function useCesiumIonToken(): string {
  return useGlobalSettingsStore((state) => state.cesiumIonToken)
}

/**
 * Hook to get just the FSLTL settings (deprecated, use useMsfsModelSettings)
 */
export function useFsltlSettings(): GlobalSettings['fsltl'] {
  return useGlobalSettingsStore((state) => state.fsltl)
}

/**
 * Hook to get MSFS model settings (on-the-fly conversion)
 */
export function useMsfsModelSettings(): MSFSModelSettings {
  return useGlobalSettingsStore((state) => state.msfsModels)
}

/**
 * Hook to check if global settings are initialized
 */
export function useGlobalSettingsInitialized(): boolean {
  return useGlobalSettingsStore((state) => state.initialized)
}

/**
 * Hook to get viewport settings
 */
export function useViewportSettings(): GlobalViewportSettings {
  return useGlobalSettingsStore((state) => state.viewports)
}

/**
 * Repair settings by re-running migrations
 *
 * This clears migration flags and attempts to recover settings from localStorage
 * that may not have been properly migrated to global settings.
 *
 * Call this if settings were lost during an upgrade.
 * Returns a summary of what was recovered.
 */
export async function repairSettingsMigration(): Promise<{
  recovered: string[]
  errors: string[]
}> {
  const recovered: string[] = []
  const errors: string[] = []

  console.log('[RepairSettings] Starting settings repair...')

  try {
    // Clear migration keys
    const migrationKeys = [
      'globalSettingsMigrationDone',
      'globalSettingsDisplayMigrationDone',
      'globalSettingsMsfsMigrationDone',
      'viewport-store-bookmark-migration-v1',
      'viewport-store-global-migration-v1',
    ]
    migrationKeys.forEach((key) => localStorage.removeItem(key))
    console.log('[RepairSettings] Cleared migration keys')

    // Read settings from localStorage
    const settingsStoreRaw = localStorage.getItem('settings-store')
    if (settingsStoreRaw) {
      try {
        const parsed = JSON.parse(settingsStoreRaw)
        const state = parsed?.state

        if (state) {
          const store = useGlobalSettingsStore.getState()

          // Recover Cesium Ion token (only if current is empty)
          if (state.cesium?.cesiumIonToken && !store.cesiumIonToken) {
            await store.setCesiumIonToken(state.cesium.cesiumIonToken)
            recovered.push('Cesium Ion token')
          }

          // Recover FSLTL settings (only if current paths are empty)
          if (state.fsltl) {
            const localHasPath = state.fsltl.sourcePath || state.fsltl.outputPath
            const storeHasPath = store.fsltl.sourcePath || store.fsltl.outputPath
            if (localHasPath && !storeHasPath) {
              await store.updateFsltl({
                sourcePath: state.fsltl.sourcePath || null,
                outputPath: state.fsltl.outputPath || null,
                textureScale: state.fsltl.textureScale || '1k',
                enableFsltlModels: state.fsltl.enableFsltlModels ?? true,
              })
              recovered.push('FSLTL paths')
            }
          }
        }
      } catch (e) {
        errors.push(`Failed to parse settings-store: ${e}`)
      }
    }

    // Read camera bookmarks from old cameraStore
    const cameraStoreRaw = localStorage.getItem('camera-store')
    if (cameraStoreRaw) {
      try {
        const parsed = JSON.parse(cameraStoreRaw)
        const airportSettings = parsed?.state?.airportSettings

        if (airportSettings && Object.keys(airportSettings).length > 0) {
          // The viewport migration will pick this up now that keys are cleared
          recovered.push(`Camera bookmarks for ${Object.keys(airportSettings).length} airports (pending sync)`)
        }
      } catch (e) {
        errors.push(`Failed to parse camera-store: ${e}`)
      }
    }

    // Read viewport store
    const viewportStoreRaw = localStorage.getItem('viewport-store')
    if (viewportStoreRaw) {
      try {
        const parsed = JSON.parse(viewportStoreRaw)
        const state = parsed?.state

        if (state?.airportViewportConfigs && Object.keys(state.airportViewportConfigs).length > 0) {
          recovered.push(
            `Viewport configs for ${Object.keys(state.airportViewportConfigs).length} airports (pending sync)`,
          )
        }
      } catch (e) {
        errors.push(`Failed to parse viewport-store: ${e}`)
      }
    }

    if (recovered.length === 0) {
      console.log('[RepairSettings] No settings found to recover in localStorage')
    } else {
      console.log('[RepairSettings] Recovered:', recovered)
    }

    if (errors.length > 0) {
      console.error('[RepairSettings] Errors:', errors)
    }
  } catch (e) {
    errors.push(`Repair failed: ${e}`)
    console.error('[RepairSettings] Failed:', e)
  }

  return { recovered, errors }
}

/**
 * Hook to get display settings (synced across devices)
 */
export function useDisplaySettings(): GlobalDisplaySettings {
  return useGlobalSettingsStore((state) => state.display)
}

/**
 * Hook to get specific display setting values
 * More efficient than useDisplaySettings when only one value is needed
 */
export function useLeaderDistance(): number {
  return useGlobalSettingsStore((state) => state.display.leaderDistance)
}

export function useDatablockMode(): DatablockMode {
  return useGlobalSettingsStore((state) => state.display.datablockMode)
}

export function useLabelVisibilityDistance(): number {
  return useGlobalSettingsStore((state) => state.display.labelVisibilityDistance)
}

export function useShowGroundTraffic(): boolean {
  return useGlobalSettingsStore((state) => state.display.showGroundTraffic)
}

export function useShowAirborneTraffic(): boolean {
  return useGlobalSettingsStore((state) => state.display.showAirborneTraffic)
}

export function useAutoAvoidOverlaps(): boolean {
  return useGlobalSettingsStore((state) => state.display.autoAvoidOverlaps)
}

export function useDefaultDatablockDirection(): DatablockDirection {
  return useGlobalSettingsStore((state) => state.display.defaultDatablockDirection)
}
