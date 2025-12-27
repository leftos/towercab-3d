/**
 * Viewport store module
 * Re-exports all viewport-related utilities and types
 */

// Types and helpers
export {
  type GlobalOrbitSettings,
  type ViewModeDefaults,
  type AirportViewportConfig,
  MAIN_VIEWPORT_ID,
  generateId,
  createDefaultCameraState,
  createMainViewport,
  normalizeLoadedViewports,
  getNextInsetPosition,
  updateViewportCameraState,
  scheduleAutoSave
} from './viewportHelpers'

// Global settings sync
export {
  getIsLoadingFromGlobal,
  setIsLoadingFromGlobal,
  toGlobalViewModeDefaults,
  toGlobalCameraBookmark,
  toGlobalAirportConfig,
  toGlobalViewportSettings,
  validateViewMode,
  fromGlobalViewModeDefaults,
  fromGlobalCameraBookmark,
  mergeGlobalAirportConfig,
  scheduleGlobalSync,
  createSyncToGlobalSettings,
  createLoadFromGlobalSettings
} from './globalSettingsSync'

// Migrations
export {
  migrateCameraStoreBookmarks,
  migrateToGlobalSettings
} from './viewportMigrations'
