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
import type { GlobalSettings, GlobalViewportSettings, FSLTLTextureScale, DataSourceType } from '@/types'
import { DEFAULT_GLOBAL_SETTINGS } from '@/types'
import { globalSettingsApi, isTauri } from '@/utils/tauriApi'

// Key used to track if migration from localStorage has been done
const MIGRATION_KEY = 'globalSettingsMigrationDone'

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
        enableFsltlModels: state.fsltl.enableFsltlModels ?? true
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

  /** Update FSLTL configuration */
  updateFsltl: (updates: Partial<GlobalSettings['fsltl']>) => Promise<void>

  /** Update airport configuration */
  updateAirports: (updates: Partial<GlobalSettings['airports']>) => Promise<void>

  /** Update server configuration */
  updateServer: (updates: Partial<GlobalSettings['server']>) => Promise<void>

  /** Update viewport settings (camera positions, bookmarks) */
  updateViewports: (updates: Partial<GlobalViewportSettings>) => Promise<void>

  /** Set entire viewport settings (for bulk updates from viewportStore) */
  setViewports: (viewports: GlobalViewportSettings) => Promise<void>

  /** Update RealTraffic settings (data source, license key, radius) */
  updateRealTraffic: (updates: Partial<GlobalSettings['realtraffic']>) => Promise<void>

  /** Reset to default settings */
  resetToDefaults: () => Promise<void>

  /** Get current settings (without actions) */
  getSettings: () => GlobalSettings
}

/**
 * Save settings to disk via Tauri
 */
async function saveSettings(settings: GlobalSettings): Promise<void> {
  if (!isTauri()) {
    console.warn('[GlobalSettings] Cannot save - not in Tauri environment')
    return
  }

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
        fsltl: { ...DEFAULT_GLOBAL_SETTINGS.fsltl, ...settings.fsltl },
        airports: { ...DEFAULT_GLOBAL_SETTINGS.airports, ...settings.airports },
        server: { ...DEFAULT_GLOBAL_SETTINGS.server, ...settings.server },
        realtraffic: { ...DEFAULT_GLOBAL_SETTINGS.realtraffic, ...settings.realtraffic },
        viewports: {
          ...DEFAULT_GLOBAL_SETTINGS.viewports,
          ...settings.viewports,
          // Preserve nested viewport objects
          airportConfigs: settings.viewports?.airportConfigs ?? DEFAULT_GLOBAL_SETTINGS.viewports.airportConfigs,
          orbitSettings: settings.viewports?.orbitSettings ?? DEFAULT_GLOBAL_SETTINGS.viewports.orbitSettings
        }
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
              fsltl: migrated.fsltl || settings.fsltl
            }
            // Save the migrated settings to disk
            await globalSettingsApi.write(settings)
            console.log('[GlobalSettings] Migration complete, saved to disk')
          }
        }
      }

      set({
        ...settings,
        initialized: true,
        loading: false,
        error: null,
        settingsFilePath
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
        error: message
      })
    }
  },

  setCesiumIonToken: async (token: string) => {
    // Update state first, then read full current state for save
    // This ensures concurrent updates from other functions are included
    set({ cesiumIonToken: token })
    const currentState = get()
    await saveSettings({
      cesiumIonToken: currentState.cesiumIonToken,
      fsltl: currentState.fsltl,
      airports: currentState.airports,
      server: currentState.server,
      realtraffic: currentState.realtraffic,
      viewports: currentState.viewports
    })
  },

  updateFsltl: async (updates: Partial<GlobalSettings['fsltl']>) => {
    const state = get()
    const newFsltl = {
      ...state.fsltl,
      ...updates,
      // Validate texture scale
      textureScale: (updates.textureScale && ['full', '2k', '1k', '512'].includes(updates.textureScale)
        ? updates.textureScale
        : state.fsltl.textureScale) as FSLTLTextureScale
    }

    // Update state first, then read full current state for save
    set({ fsltl: newFsltl })
    const currentState = get()
    await saveSettings({
      cesiumIonToken: currentState.cesiumIonToken,
      fsltl: currentState.fsltl,
      airports: currentState.airports,
      server: currentState.server,
      realtraffic: currentState.realtraffic,
      viewports: currentState.viewports
    })
  },

  updateAirports: async (updates: Partial<GlobalSettings['airports']>) => {
    const state = get()
    const newAirports = { ...state.airports, ...updates }

    // Update state first, then read full current state for save
    set({ airports: newAirports })
    const currentState = get()
    await saveSettings({
      cesiumIonToken: currentState.cesiumIonToken,
      fsltl: currentState.fsltl,
      airports: currentState.airports,
      server: currentState.server,
      realtraffic: currentState.realtraffic,
      viewports: currentState.viewports
    })
  },

  updateServer: async (updates: Partial<GlobalSettings['server']>) => {
    const state = get()
    const newServer = {
      ...state.server,
      ...updates,
      // Validate port range
      port: updates.port !== undefined
        ? Math.max(1024, Math.min(65535, updates.port))
        : state.server.port
    }

    // Update state first, then read full current state for save
    set({ server: newServer })
    const currentState = get()
    await saveSettings({
      cesiumIonToken: currentState.cesiumIonToken,
      fsltl: currentState.fsltl,
      airports: currentState.airports,
      server: currentState.server,
      realtraffic: currentState.realtraffic,
      viewports: currentState.viewports
    })
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
        : state.viewports.orbitSettings
    }

    // Update state first, then read full current state for save
    set({ viewports: newViewports })
    const currentState = get()
    await saveSettings({
      cesiumIonToken: currentState.cesiumIonToken,
      fsltl: currentState.fsltl,
      airports: currentState.airports,
      server: currentState.server,
      realtraffic: currentState.realtraffic,
      viewports: currentState.viewports
    })
  },

  setViewports: async (viewports: GlobalViewportSettings) => {
    // Update state first, then read full current state for save
    set({ viewports })
    const currentState = get()
    await saveSettings({
      cesiumIonToken: currentState.cesiumIonToken,
      fsltl: currentState.fsltl,
      airports: currentState.airports,
      server: currentState.server,
      realtraffic: currentState.realtraffic,
      viewports: currentState.viewports
    })
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
      radiusNm: updates.radiusNm !== undefined
        ? Math.max(10, Math.min(200, updates.radiusNm))
        : state.realtraffic.radiusNm,
      // Validate maxParkedAircraft (0-200)
      maxParkedAircraft: updates.maxParkedAircraft !== undefined
        ? Math.max(0, Math.min(200, updates.maxParkedAircraft))
        : state.realtraffic.maxParkedAircraft
    }

    // Update state first, then read full current state for save
    set({ realtraffic: newRealTraffic })
    const currentState = get()
    await saveSettings({
      cesiumIonToken: currentState.cesiumIonToken,
      fsltl: currentState.fsltl,
      airports: currentState.airports,
      server: currentState.server,
      realtraffic: currentState.realtraffic,
      viewports: currentState.viewports
    })
  },

  resetToDefaults: async () => {
    set({ ...DEFAULT_GLOBAL_SETTINGS })
    await saveSettings(DEFAULT_GLOBAL_SETTINGS)
  },

  getSettings: (): GlobalSettings => {
    const state = get()
    return {
      cesiumIonToken: state.cesiumIonToken,
      fsltl: state.fsltl,
      airports: state.airports,
      server: state.server,
      realtraffic: state.realtraffic,
      viewports: state.viewports
    }
  }
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
 * Hook to get just the FSLTL settings
 */
export function useFsltlSettings(): GlobalSettings['fsltl'] {
  return useGlobalSettingsStore((state) => state.fsltl)
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
      'viewport-store-bookmark-migration-v1',
      'viewport-store-global-migration-v1'
    ]
    migrationKeys.forEach(key => localStorage.removeItem(key))
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
                enableFsltlModels: state.fsltl.enableFsltlModels ?? true
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
          recovered.push(`Viewport configs for ${Object.keys(state.airportViewportConfigs).length} airports (pending sync)`)
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
