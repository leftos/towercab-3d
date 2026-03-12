/**
 * Viewport store module
 * Re-exports all viewport-related utilities and types
 */

// Global settings sync
export {
  createLoadFromGlobalSettings,
  createSyncToGlobalSettings,
  flushPendingGlobalSync,
  fromGlobalCameraBookmark,
  fromGlobalViewModeDefaults,
  getIsLoadingFromGlobal,
  mergeGlobalAirportConfig,
  scheduleGlobalSync,
  setIsLoadingFromGlobal,
  toGlobalAirportConfig,
  toGlobalCameraBookmark,
  toGlobalViewModeDefaults,
  toGlobalViewportSettings,
  validateViewMode,
} from './globalSettingsSync'
// Types and helpers
export {
  type AirportViewportConfig,
  createDefaultCameraState,
  createMainViewport,
  type GlobalOrbitSettings,
  generateId,
  getNextInsetPosition,
  MAIN_VIEWPORT_ID,
  normalizeLoadedViewports,
  scheduleAutoSave,
  updateViewportCameraState,
  type ViewModeDefaults,
} from './viewportHelpers'

// Migrations
export {
  migrateCameraStoreBookmarks,
  migrateToGlobalSettings,
} from './viewportMigrations'
