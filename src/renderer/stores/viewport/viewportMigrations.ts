/**
 * Viewport store data migrations
 * Handles one-time migrations from legacy data formats
 */

import type { CameraBookmark } from '../../types'
import type { AirportViewportConfig, GlobalOrbitSettings } from './viewportHelpers'
import { createMainViewport } from './viewportHelpers'
import { scheduleGlobalSync } from './globalSettingsSync'

// =============================================================================
// Migration: cameraStore bookmarks → viewportStore
// =============================================================================

/**
 * Migrate bookmarks from cameraStore to viewportStore (one-time migration)
 */
export const migrateCameraStoreBookmarks = (
  getState: () => {
    airportViewportConfigs: Record<string, AirportViewportConfig>
  },
  setState: (state: { airportViewportConfigs: Record<string, AirportViewportConfig> }) => void,
  syncToGlobalSettings: () => void
) => {
  const MIGRATION_KEY = 'viewport-store-bookmark-migration-v1'
  if (localStorage.getItem(MIGRATION_KEY)) {
    return // Already migrated
  }

  try {
    // Get cameraStore data from localStorage
    const cameraStoreRaw = localStorage.getItem('camera-store')
    if (!cameraStoreRaw) {
      localStorage.setItem(MIGRATION_KEY, 'done')
      return
    }

    const cameraStoreData = JSON.parse(cameraStoreRaw)
    const airportSettings = cameraStoreData?.state?.airportSettings
    if (!airportSettings || typeof airportSettings !== 'object') {
      localStorage.setItem(MIGRATION_KEY, 'done')
      return
    }

    // Copy bookmarks from cameraStore to viewportStore for each airport
    const state = getState()
    const updatedConfigs = { ...state.airportViewportConfigs }
    let hasMigrations = false

    for (const [icao, settings] of Object.entries(airportSettings)) {
      const cameraSettings = settings as { bookmarks?: Record<number, CameraBookmark> }
      if (!cameraSettings.bookmarks || Object.keys(cameraSettings.bookmarks).length === 0) {
        continue
      }

      // Ensure we have a config for this airport
      if (!updatedConfigs[icao]) {
        const mainViewport = createMainViewport()
        updatedConfigs[icao] = {
          viewports: [mainViewport],
          activeViewportId: mainViewport.id
        }
      }

      // Merge bookmarks (don't overwrite if viewportStore already has them)
      if (!updatedConfigs[icao].bookmarks) {
        updatedConfigs[icao].bookmarks = {}
      }

      for (const [slotStr, bookmark] of Object.entries(cameraSettings.bookmarks)) {
        const slot = parseInt(slotStr, 10)
        if (!updatedConfigs[icao].bookmarks![slot]) {
          updatedConfigs[icao].bookmarks![slot] = bookmark
          hasMigrations = true
        }
      }
    }

    if (hasMigrations) {
      setState({ airportViewportConfigs: updatedConfigs })
      console.log('[ViewportMigrations] Migrated bookmarks from cameraStore to viewportStore')
      // Sync to global settings
      scheduleGlobalSync(syncToGlobalSettings)
    }

    localStorage.setItem(MIGRATION_KEY, 'done')
  } catch (e) {
    console.error('[ViewportMigrations] Failed to migrate cameraStore bookmarks:', e)
    // Mark as done to avoid repeated failures
    localStorage.setItem(MIGRATION_KEY, 'done')
  }
}

// =============================================================================
// Migration: localStorage → globalSettingsStore
// =============================================================================

/**
 * Migrate viewport data from localStorage to global settings (one-time migration)
 * After migration, clears airportViewportConfigs from localStorage since all
 * viewport data should now be stored globally.
 */
export const migrateToGlobalSettings = (
  getGlobalSettingsState: () => {
    initialized: boolean
    viewports: { airportConfigs: Record<string, unknown> } | null
  },
  getViewportState: () => {
    airportViewportConfigs: Record<string, AirportViewportConfig>
    globalOrbitSettings: GlobalOrbitSettings
    currentAirportIcao: string | null
  },
  syncToGlobalSettings: () => void
) => {
  // v2 includes mainCamera which wasn't synced in v1
  const MIGRATION_KEY = 'viewport-store-global-migration-v2'
  if (localStorage.getItem(MIGRATION_KEY)) {
    return // Already migrated
  }

  const globalState = getGlobalSettingsState()
  if (!globalState.initialized) {
    // Global settings not ready yet, will be called again later
    return
  }

  // Get local viewport data
  const state = getViewportState()
  const localAirportCount = Object.keys(state.airportViewportConfigs).length

  // Migrate if local has data (sync will merge with existing global data)
  if (localAirportCount > 0) {
    console.log(`[ViewportMigrations] Migrating ${localAirportCount} airport configs to global settings...`)
    syncToGlobalSettings()
  }

  // Clear airportViewportConfigs from localStorage after migration
  // The data is now in global-settings.json and should be the source of truth
  try {
    const viewportStoreRaw = localStorage.getItem('viewport-store')
    if (viewportStoreRaw) {
      const viewportStoreData = JSON.parse(viewportStoreRaw)
      if (viewportStoreData?.state?.airportViewportConfigs) {
        // Keep only essential state, clear the per-airport configs
        viewportStoreData.state.airportViewportConfigs = {}
        localStorage.setItem('viewport-store', JSON.stringify(viewportStoreData))
        console.log('[ViewportMigrations] Cleared airportViewportConfigs from localStorage')
      }
    }
  } catch (e) {
    console.error('[ViewportMigrations] Failed to clear localStorage:', e)
  }

  localStorage.setItem(MIGRATION_KEY, 'done')
  console.log('[ViewportMigrations] Migration to global settings complete')
}
