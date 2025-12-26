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
import type { GlobalSettings, FSLTLTextureScale } from '@/types'
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
    const state = get()
    const newSettings: GlobalSettings = {
      cesiumIonToken: token,
      fsltl: state.fsltl,
      airports: state.airports,
      server: state.server
    }

    set({ cesiumIonToken: token })
    await saveSettings(newSettings)
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

    const newSettings: GlobalSettings = {
      cesiumIonToken: state.cesiumIonToken,
      fsltl: newFsltl,
      airports: state.airports,
      server: state.server
    }

    set({ fsltl: newFsltl })
    await saveSettings(newSettings)
  },

  updateAirports: async (updates: Partial<GlobalSettings['airports']>) => {
    const state = get()
    const newAirports = { ...state.airports, ...updates }

    const newSettings: GlobalSettings = {
      cesiumIonToken: state.cesiumIonToken,
      fsltl: state.fsltl,
      airports: newAirports,
      server: state.server
    }

    set({ airports: newAirports })
    await saveSettings(newSettings)
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

    const newSettings: GlobalSettings = {
      cesiumIonToken: state.cesiumIonToken,
      fsltl: state.fsltl,
      airports: state.airports,
      server: newServer
    }

    set({ server: newServer })
    await saveSettings(newSettings)
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
      server: state.server
    }
  }
}))

/**
 * Initialize global settings store
 * Should be called early in app startup
 */
export async function initializeGlobalSettings(): Promise<void> {
  await useGlobalSettingsStore.getState().initialize()
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
