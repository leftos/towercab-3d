/**
 * Viewport helper functions and factory functions
 * Extracted from viewportStore.ts for better modularity
 */

import type {
  ViewportLayout,
  ViewportCameraState,
  Viewport,
  AirportViewportConfig,
  ViewModeDefaults
} from '../../types'
import {
  HEADING_DEFAULT,
  PITCH_DEFAULT,
  FOV_DEFAULT,
  FOLLOW_ZOOM_DEFAULT,
  TOPDOWN_ALTITUDE_DEFAULT,
  ORBIT_DISTANCE_DEFAULT,
  ORBIT_HEADING_DEFAULT,
  ORBIT_PITCH_DEFAULT
} from '../../constants'

// Re-export types that were previously defined here
export type { AirportViewportConfig, ViewModeDefaults }

// =============================================================================
// Types
// =============================================================================

/**
 * Global orbit settings that persist across all airports (last used values)
 */
export interface GlobalOrbitSettings {
  distance: number
  heading: number
  pitch: number
}

// =============================================================================
// Constants
// =============================================================================

/** Main viewport always uses this fixed ID so CesiumViewer can find it */
export const MAIN_VIEWPORT_ID = 'main'

/** Generate unique IDs using native crypto API */
export const generateId = () => crypto.randomUUID()

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a default camera state with optional customization
 */
export const createDefaultCameraState = (
  customHeading?: number,
  globalOrbit?: GlobalOrbitSettings,
  topdownAltitude?: number
): ViewportCameraState => ({
  viewMode: '3d',
  heading: customHeading ?? HEADING_DEFAULT,
  pitch: PITCH_DEFAULT,
  fov: FOV_DEFAULT,
  positionOffsetX: 0,
  positionOffsetY: 0,
  positionOffsetZ: 0,
  topdownAltitude: topdownAltitude ?? TOPDOWN_ALTITUDE_DEFAULT,
  followingCallsign: null,
  followMode: 'tower',
  followZoom: FOLLOW_ZOOM_DEFAULT,
  preFollowState: null,
  orbitDistance: globalOrbit?.distance ?? ORBIT_DISTANCE_DEFAULT,
  orbitHeading: globalOrbit?.heading ?? ORBIT_HEADING_DEFAULT,
  orbitPitch: globalOrbit?.pitch ?? ORBIT_PITCH_DEFAULT,
  lookAtTarget: null
})

/**
 * Create main viewport (full screen)
 */
export const createMainViewport = (
  customHeading?: number,
  globalOrbit?: GlobalOrbitSettings,
  topdownAltitude?: number
): Viewport => ({
  id: MAIN_VIEWPORT_ID,
  layout: { x: 0, y: 0, width: 1, height: 1, zIndex: 0 },
  cameraState: createDefaultCameraState(customHeading, globalOrbit, topdownAltitude),
  label: 'Main'
})

// =============================================================================
// Normalization Functions
// =============================================================================

/**
 * Normalize viewports loaded from storage to ensure main viewport has fixed ID
 * This handles migration from old configs that used UUIDs for main viewport
 */
export const normalizeLoadedViewports = (
  viewports: Viewport[],
  activeViewportId: string
): { viewports: Viewport[]; activeViewportId: string } => {
  if (viewports.length === 0) {
    const main = createMainViewport()
    return { viewports: [main], activeViewportId: MAIN_VIEWPORT_ID }
  }

  // Get the old main viewport ID before normalization
  const oldMainId = viewports[0].id

  // Ensure first viewport (main) has the fixed ID
  const normalizedViewports = viewports.map((v, i) => {
    if (i === 0 && v.id !== MAIN_VIEWPORT_ID) {
      return { ...v, id: MAIN_VIEWPORT_ID }
    }
    return v
  })

  // Update activeViewportId if it was pointing to the old main ID
  const normalizedActiveId = activeViewportId === oldMainId
    ? MAIN_VIEWPORT_ID
    : activeViewportId

  return { viewports: normalizedViewports, activeViewportId: normalizedActiveId }
}

/**
 * Calculate smart default position for new insets
 */
export const getNextInsetPosition = (existingViewports: Viewport[]): ViewportLayout => {
  const defaultPositions = [
    { x: 0.74, y: 0.02, width: 0.24, height: 0.30 }, // Top-right
    { x: 0.02, y: 0.02, width: 0.24, height: 0.30 }, // Top-left
    { x: 0.74, y: 0.68, width: 0.24, height: 0.30 }, // Bottom-right
    { x: 0.02, y: 0.68, width: 0.24, height: 0.30 }, // Bottom-left
  ]

  const insets = existingViewports.filter(v => v.layout.width < 0.5)
  const usedPositions = insets.map(v => ({ x: v.layout.x, y: v.layout.y }))

  // Find first unused default position
  for (const pos of defaultPositions) {
    const isUsed = usedPositions.some(
      used => Math.abs(used.x - pos.x) < 0.1 && Math.abs(used.y - pos.y) < 0.1
    )
    if (!isUsed) {
      const maxZIndex = Math.max(0, ...existingViewports.map(v => v.layout.zIndex))
      return { ...pos, zIndex: maxZIndex + 1 }
    }
  }

  // All default positions used, offset from last inset
  const lastInset = insets[insets.length - 1]
  const maxZIndex = Math.max(0, ...existingViewports.map(v => v.layout.zIndex))
  if (lastInset) {
    return {
      x: Math.min(0.74, lastInset.layout.x + 0.02),
      y: Math.min(0.68, lastInset.layout.y + 0.02),
      width: 0.24,
      height: 0.30,
      zIndex: maxZIndex + 1
    }
  }

  return { ...defaultPositions[0], zIndex: maxZIndex + 1 }
}

// =============================================================================
// State Update Helpers
// =============================================================================

/**
 * Helper to update a viewport's camera state immutably
 */
export const updateViewportCameraState = (
  viewports: Viewport[],
  viewportId: string,
  updater: (state: ViewportCameraState) => Partial<ViewportCameraState>
): Viewport[] => {
  return viewports.map(viewport => {
    if (viewport.id !== viewportId) return viewport
    const updates = updater(viewport.cameraState)
    return {
      ...viewport,
      cameraState: { ...viewport.cameraState, ...updates }
    }
  })
}

// =============================================================================
// Debounce Utilities
// =============================================================================

/** Debounce timer for auto-save */
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null
const AUTO_SAVE_DELAY = 5000 // 5 seconds

/**
 * Schedule a debounced auto-save
 */
export const scheduleAutoSave = (saveFunc: () => void) => {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer)
  }
  autoSaveTimer = setTimeout(() => {
    saveFunc()
    autoSaveTimer = null
  }, AUTO_SAVE_DELAY)
}
