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
  const MIGRATION_KEY = 'viewport-store-global-migration-v1'
  if (localStorage.getItem(MIGRATION_KEY)) {
    return // Already migrated
  }

  const globalState = getGlobalSettingsState()
  if (!globalState.initialized) {
    // Global settings not ready yet, will be called again later
    return
  }

  // Check if global settings already has viewport data
  const hasGlobalData = globalState.viewports &&
    Object.keys(globalState.viewports.airportConfigs).length > 0

  if (hasGlobalData) {
    // Global settings already has data, don't overwrite
    localStorage.setItem(MIGRATION_KEY, 'done')
    console.log('[ViewportMigrations] Global settings already has viewport data, skipping migration')
    return
  }

  // Get local viewport data
  const state = getViewportState()
  const hasLocalData = Object.keys(state.airportViewportConfigs).length > 0

  if (hasLocalData) {
    console.log('[ViewportMigrations] Migrating viewport data to global settings...')
    syncToGlobalSettings()
  }

  localStorage.setItem(MIGRATION_KEY, 'done')
  console.log('[ViewportMigrations] Migration to global settings complete')
}
