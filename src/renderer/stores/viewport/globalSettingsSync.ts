/**
 * Global settings synchronization utilities
 * Handles conversion between local and global viewport settings formats
 * and bidirectional sync with globalSettingsStore
 */

import type {
  ViewMode,
  CameraBookmark,
  GlobalViewportSettings,
  GlobalAirportViewportConfig,
  GlobalCameraBookmark,
  GlobalViewModeDefaults,
  GlobalInsetViewport,
  Viewport
} from '../../types'
import { DEFAULT_GLOBAL_VIEWPORT_SETTINGS } from '../../types'
import { TOPDOWN_ALTITUDE_DEFAULT } from '../../constants'
import type { DatablockPosition } from '../datablockPositionStore'
import type { ViewModeDefaults, AirportViewportConfig, GlobalOrbitSettings } from './viewportHelpers'
import { createMainViewport } from './viewportHelpers'

// =============================================================================
// State and Timers
// =============================================================================

/** Debounce timer for syncing to global settings */
let globalSyncTimer: ReturnType<typeof setTimeout> | null = null
const GLOBAL_SYNC_DELAY = 2000 // 2 seconds

/**
 * Flag to prevent bidirectional sync loops
 * When true, changes originated from global settings and should not be synced back
 */
let isLoadingFromGlobal = false

/**
 * Check if currently loading from global (to prevent sync loops)
 */
export const getIsLoadingFromGlobal = () => isLoadingFromGlobal

/**
 * Set the loading from global flag
 */
export const setIsLoadingFromGlobal = (value: boolean) => {
  isLoadingFromGlobal = value
}

// =============================================================================
// Conversion Functions: Local → Global
// =============================================================================

/**
 * Convert local ViewModeDefaults to global format
 */
export const toGlobalViewModeDefaults = (local: ViewModeDefaults): GlobalViewModeDefaults => ({
  heading: local.heading,
  pitch: local.pitch,
  fov: local.fov,
  positionOffsetX: local.positionOffsetX,
  positionOffsetY: local.positionOffsetY,
  positionOffsetZ: local.positionOffsetZ,
  topdownAltitude: local.topdownAltitude
})

/**
 * Convert local CameraBookmark to global format
 */
export const toGlobalCameraBookmark = (local: CameraBookmark): GlobalCameraBookmark => ({
  name: local.name,
  heading: local.heading,
  pitch: local.pitch,
  fov: local.fov,
  positionOffsetX: local.positionOffsetX,
  positionOffsetY: local.positionOffsetY,
  positionOffsetZ: local.positionOffsetZ,
  viewMode: local.viewMode,
  topdownAltitude: local.topdownAltitude
})

/**
 * Convert local Viewport to global inset format
 * Only includes essential fields for persistence
 */
export const toGlobalInsetViewport = (local: Viewport): GlobalInsetViewport => ({
  id: local.id,
  label: local.label,
  layout: {
    x: local.layout.x,
    y: local.layout.y,
    width: local.layout.width,
    height: local.layout.height,
    zIndex: local.layout.zIndex
  },
  cameraState: {
    viewMode: local.cameraState.viewMode,
    heading: local.cameraState.heading,
    pitch: local.cameraState.pitch,
    fov: local.cameraState.fov,
    positionOffsetX: local.cameraState.positionOffsetX,
    positionOffsetY: local.cameraState.positionOffsetY,
    positionOffsetZ: local.cameraState.positionOffsetZ,
    topdownAltitude: local.cameraState.topdownAltitude,
    followMode: local.cameraState.followMode,
    followZoom: local.cameraState.followZoom,
    orbitDistance: local.cameraState.orbitDistance,
    orbitHeading: local.cameraState.orbitHeading,
    orbitPitch: local.cameraState.orbitPitch
  }
})

/**
 * Convert local AirportViewportConfig to global format
 * Exports defaults, bookmarks, datablockPosition, and inset viewport configs
 */
export const toGlobalAirportConfig = (local: AirportViewportConfig): GlobalAirportViewportConfig => {
  const global: GlobalAirportViewportConfig = {}

  if (local.default3d) {
    global.default3d = toGlobalViewModeDefaults(local.default3d)
  }
  if (local.default2d) {
    global.default2d = toGlobalViewModeDefaults(local.default2d)
  }
  if (local.bookmarks && Object.keys(local.bookmarks).length > 0) {
    global.bookmarks = {}
    for (const [slotStr, bookmark] of Object.entries(local.bookmarks)) {
      const slot = parseInt(slotStr, 10)
      if (!isNaN(slot)) {
        global.bookmarks[slot] = toGlobalCameraBookmark(bookmark)
      }
    }
  }
  if (local.datablockPosition !== undefined) {
    global.datablockPosition = local.datablockPosition
  }
  // Export inset viewports (all viewports except the first one which is main)
  if (local.viewports && local.viewports.length > 1) {
    global.insets = local.viewports.slice(1).map(toGlobalInsetViewport)
  }

  return global
}

/**
 * Convert all local airport configs to global format
 */
export const toGlobalViewportSettings = (
  airportConfigs: Record<string, AirportViewportConfig>,
  orbitSettings: GlobalOrbitSettings,
  currentAirportIcao: string | null
): GlobalViewportSettings => ({
  airportConfigs: Object.fromEntries(
    Object.entries(airportConfigs)
      .map(([icao, config]) => [icao, toGlobalAirportConfig(config)])
      .filter(([, config]) => Object.keys(config as object).length > 0)
  ),
  orbitSettings,
  lastAirportIcao: currentAirportIcao
})

// =============================================================================
// Conversion Functions: Global → Local
// =============================================================================

/**
 * Validate and convert viewMode string to ViewMode type
 */
export const validateViewMode = (viewMode: string): ViewMode => {
  if (viewMode === '3d' || viewMode === 'topdown') {
    return viewMode
  }
  console.warn(`[GlobalSettingsSync] Invalid viewMode "${viewMode}", defaulting to "3d"`)
  return '3d'
}

/**
 * Convert global ViewModeDefaults to local format
 */
export const fromGlobalViewModeDefaults = (global: GlobalViewModeDefaults): ViewModeDefaults => ({
  heading: global.heading,
  pitch: global.pitch,
  fov: global.fov,
  positionOffsetX: global.positionOffsetX,
  positionOffsetY: global.positionOffsetY,
  positionOffsetZ: global.positionOffsetZ,
  topdownAltitude: global.topdownAltitude
})

/**
 * Convert global CameraBookmark to local format
 */
export const fromGlobalCameraBookmark = (global: GlobalCameraBookmark): CameraBookmark => ({
  name: global.name,
  heading: global.heading,
  pitch: global.pitch,
  fov: global.fov,
  positionOffsetX: global.positionOffsetX,
  positionOffsetY: global.positionOffsetY,
  positionOffsetZ: global.positionOffsetZ,
  viewMode: validateViewMode(global.viewMode),
  topdownAltitude: global.topdownAltitude ?? TOPDOWN_ALTITUDE_DEFAULT
})

/**
 * Validate and convert followMode string to FollowMode type
 */
const validateFollowMode = (followMode: string): 'tower' | 'orbit' => {
  if (followMode === 'tower' || followMode === 'orbit') {
    return followMode
  }
  return 'tower'
}

/**
 * Convert global inset viewport to local Viewport format
 */
export const fromGlobalInsetViewport = (global: GlobalInsetViewport): Viewport => ({
  id: global.id,
  label: global.label,
  layout: {
    x: global.layout.x,
    y: global.layout.y,
    width: global.layout.width,
    height: global.layout.height,
    zIndex: global.layout.zIndex
  },
  cameraState: {
    viewMode: validateViewMode(global.cameraState.viewMode),
    heading: global.cameraState.heading,
    pitch: global.cameraState.pitch,
    fov: global.cameraState.fov,
    positionOffsetX: global.cameraState.positionOffsetX,
    positionOffsetY: global.cameraState.positionOffsetY,
    positionOffsetZ: global.cameraState.positionOffsetZ,
    topdownAltitude: global.cameraState.topdownAltitude,
    followingCallsign: null,
    followMode: validateFollowMode(global.cameraState.followMode),
    followZoom: global.cameraState.followZoom,
    preFollowState: null,
    orbitDistance: global.cameraState.orbitDistance,
    orbitHeading: global.cameraState.orbitHeading,
    orbitPitch: global.cameraState.orbitPitch,
    lookAtTarget: null,
    pendingLookAtPosition: null,
    cameraVersion: 0
  }
})

/**
 * Merge global AirportViewportConfig into local config
 * Preserves local viewport state while updating persisted fields
 */
export const mergeGlobalAirportConfig = (
  local: AirportViewportConfig | undefined,
  global: GlobalAirportViewportConfig
): Partial<AirportViewportConfig> => {
  const updates: Partial<AirportViewportConfig> = {}

  if (global.default3d) {
    updates.default3d = fromGlobalViewModeDefaults(global.default3d)
  }
  if (global.default2d) {
    updates.default2d = fromGlobalViewModeDefaults(global.default2d)
  }
  if (global.bookmarks && Object.keys(global.bookmarks).length > 0) {
    updates.bookmarks = {}
    for (const [slot, bookmark] of Object.entries(global.bookmarks)) {
      const slotNum = parseInt(slot, 10)
      if (!isNaN(slotNum)) {
        updates.bookmarks[slotNum] = fromGlobalCameraBookmark(bookmark)
      }
    }
  }
  if (global.datablockPosition !== undefined) {
    updates.datablockPosition = global.datablockPosition as DatablockPosition
  }
  // Merge inset viewports from global - preserve existing local insets if global is empty
  if (global.insets && global.insets.length > 0) {
    // If we have local viewports, update insets (keeping main viewport from local)
    if (local?.viewports && local.viewports.length > 0) {
      const mainViewport = local.viewports[0]
      const insetViewports = global.insets.map(fromGlobalInsetViewport)
      updates.viewports = [mainViewport, ...insetViewports]
    }
  }

  return updates
}

// =============================================================================
// Sync Functions
// =============================================================================

/**
 * Schedule a debounced sync to globalSettingsStore
 */
export const scheduleGlobalSync = (syncFunc: () => void) => {
  // Don't schedule sync if we're currently loading from global (prevents sync loops)
  if (isLoadingFromGlobal) {
    return
  }
  if (globalSyncTimer) {
    clearTimeout(globalSyncTimer)
  }
  globalSyncTimer = setTimeout(() => {
    syncFunc()
    globalSyncTimer = null
  }, GLOBAL_SYNC_DELAY)
}

/**
 * Sync viewportStore state to globalSettingsStore
 * This is called by the main store and requires the store getter
 */
export const createSyncToGlobalSettings = (
  getState: () => {
    airportViewportConfigs: Record<string, AirportViewportConfig>
    globalOrbitSettings: GlobalOrbitSettings
    currentAirportIcao: string | null
  },
  getGlobalSettingsStore: () => {
    setViewports: (settings: GlobalViewportSettings) => Promise<void>
  }
) => {
  return () => {
    const state = getState()
    const globalSettings = toGlobalViewportSettings(
      state.airportViewportConfigs,
      state.globalOrbitSettings,
      state.currentAirportIcao
    )

    getGlobalSettingsStore().setViewports(globalSettings).catch(err => {
      console.error('[GlobalSettingsSync] Failed to sync to global settings:', err)
    })
  }
}

/**
 * Load viewport settings from globalSettingsStore and merge into viewportStore
 */
export const createLoadFromGlobalSettings = (
  getGlobalSettingsStore: () => {
    initialized: boolean
    viewports: GlobalViewportSettings | null
  },
  getViewportState: () => {
    airportViewportConfigs: Record<string, AirportViewportConfig>
    globalOrbitSettings: GlobalOrbitSettings
  },
  setViewportState: (state: {
    airportViewportConfigs: Record<string, AirportViewportConfig>
    globalOrbitSettings: GlobalOrbitSettings
  }) => void
) => {
  return () => {
    const globalState = getGlobalSettingsStore()

    // Only proceed if global settings are initialized
    if (!globalState.initialized) {
      console.log('[GlobalSettingsSync] Global settings not initialized yet, skipping load')
      return
    }

    try {
      // Set flag to prevent sync loop
      isLoadingFromGlobal = true

      const globalViewports = globalState.viewports || DEFAULT_GLOBAL_VIEWPORT_SETTINGS

      // Validate that airportConfigs is an object
      if (!globalViewports.airportConfigs || typeof globalViewports.airportConfigs !== 'object') {
        console.warn('[GlobalSettingsSync] Global settings has invalid airportConfigs, skipping load')
        return
      }

      const state = getViewportState()
      const updatedConfigs = { ...state.airportViewportConfigs }

      // Merge global configs into local configs
      for (const [icao, globalConfig] of Object.entries(globalViewports.airportConfigs)) {
        // Validate that globalConfig is an object
        if (!globalConfig || typeof globalConfig !== 'object') {
          console.warn(`[GlobalSettingsSync] Invalid config for ${icao}, skipping`)
          continue
        }

        const localConfig = updatedConfigs[icao]
        const mergedUpdates = mergeGlobalAirportConfig(localConfig, globalConfig)

        if (localConfig) {
          // Merge into existing config
          updatedConfigs[icao] = { ...localConfig, ...mergedUpdates }
        } else {
          // Create new config with just the global data
          const orbitSettings = globalViewports.orbitSettings && typeof globalViewports.orbitSettings === 'object'
            ? globalViewports.orbitSettings
            : undefined
          const mainViewport = createMainViewport(undefined, orbitSettings)
          updatedConfigs[icao] = {
            viewports: [mainViewport],
            activeViewportId: mainViewport.id,
            ...mergedUpdates
          }
        }
      }

      // Validate orbitSettings before using
      const orbitSettings = globalViewports.orbitSettings && typeof globalViewports.orbitSettings === 'object'
        ? globalViewports.orbitSettings
        : state.globalOrbitSettings

      // Update state
      setViewportState({
        airportViewportConfigs: updatedConfigs,
        globalOrbitSettings: orbitSettings
      })

      console.log('[GlobalSettingsSync] Loaded from global settings')
    } catch (error) {
      console.error('[GlobalSettingsSync] Failed to load from global settings:', error)
    } finally {
      // Always clear the flag, even if an error occurred
      isLoadingFromGlobal = false
    }
  }
}
