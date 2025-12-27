/**
 * Viewport-related type definitions
 *
 * This file centralizes all viewport layout and configuration types.
 * The viewport system supports multiple simultaneous camera views:
 * - One main viewport (full-screen, always present)
 * - Multiple inset viewports (draggable/resizable overlays)
 *
 * Each viewport has independent camera state and can follow different aircraft.
 *
 * @see viewportStore - Main store for viewport management
 * @see ViewportManager - React component that renders all viewports
 * @see docs/architecture.md - Multi-viewport architecture documentation
 */

import type { ViewportCameraState } from './camera'

/**
 * Viewport position and size
 *
 * Uses normalized coordinates (0-1) relative to the container.
 * This allows responsive positioning that works at any screen size.
 *
 * Coordinate system:
 * - (0, 0) = top-left corner of container
 * - (1, 1) = bottom-right corner of container
 * - x increases rightward, y increases downward
 *
 * @example
 * // Full-screen main viewport
 * const mainLayout: ViewportLayout = {
 *   x: 0,
 *   y: 0,
 *   width: 1,
 *   height: 1,
 *   zIndex: 0
 * }
 *
 * @example
 * // Top-right inset (24% width, 30% height)
 * const insetLayout: ViewportLayout = {
 *   x: 0.74,  // Start at 74% from left
 *   y: 0.02,  // Start at 2% from top
 *   width: 0.24,  // 24% wide
 *   height: 0.30,  // 30% tall
 *   zIndex: 1
 * }
 */
export interface ViewportLayout {
  /** Left edge position (0 = left of container, 1 = right of container) */
  x: number
  /** Top edge position (0 = top of container, 1 = bottom of container) */
  y: number
  /** Width as fraction of container (0-1) */
  width: number
  /** Height as fraction of container (0-1) */
  height: number
  /**
   * Stacking order for overlapping viewports
   * Higher values appear on top
   * Main viewport always uses zIndex: 0
   */
  zIndex: number
}

/**
 * Complete viewport definition
 *
 * A viewport combines layout (position/size) with camera state.
 * Each viewport has a unique ID and optional user-defined label.
 *
 * Viewport types:
 * - Main viewport: Always present, full-screen, uses fixed ID 'main'
 * - Inset viewports: Draggable/resizable overlays, use UUID IDs
 *
 * Active viewport:
 * - Only one viewport can be active at a time (receives keyboard/mouse input)
 * - Active viewport is indicated by cyan border in UI
 * - Click on a viewport to make it active
 *
 * @example
 * // Main viewport
 * const mainViewport: Viewport = {
 *   id: 'main',
 *   layout: { x: 0, y: 0, width: 1, height: 1, zIndex: 0 },
 *   cameraState: {
 *     viewMode: '3d',
 *     heading: 0,
 *     pitch: -15,
 *     fov: 60,
 *     // ... other camera properties
 *   },
 *   label: 'Main'
 * }
 *
 * @example
 * // Inset viewport following an aircraft
 * const insetViewport: Viewport = {
 *   id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
 *   layout: { x: 0.74, y: 0.02, width: 0.24, height: 0.30, zIndex: 1 },
 *   cameraState: {
 *     viewMode: '3d',
 *     heading: 180,
 *     pitch: -10,
 *     fov: 45,
 *     followingCallsign: 'AAL123',
 *     followMode: 'orbit',
 *     orbitDistance: 500,
 *     orbitHeading: 315,
 *     orbitPitch: -20,
 *     // ... other camera properties
 *   },
 *   label: 'Runway 27 Arrivals'
 * }
 */
export interface Viewport {
  /**
   * Unique identifier for this viewport
   * - Main viewport always uses 'main'
   * - Inset viewports use crypto.randomUUID()
   */
  id: string

  /**
   * Position and size of viewport
   * Normalized coordinates (0-1) relative to container
   */
  layout: ViewportLayout

  /**
   * Camera state for this viewport
   * Each viewport has independent camera control
   */
  cameraState: ViewportCameraState

  /**
   * Optional user-defined label shown in UI
   * Examples: "Main", "Runway 27 Arrivals", "Tower View"
   */
  label?: string
}

/**
 * Per-airport viewport configuration (persisted to localStorage)
 *
 * Each airport can have a saved viewport layout that is restored
 * when switching back to that airport.
 *
 * @internal Used by viewportStore for persistence
 */
/**
 * Camera defaults for a specific view mode (3D or 2D/topdown)
 */
export interface ViewModeDefaults {
  heading: number
  pitch: number
  fov: number
  positionOffsetX: number
  positionOffsetY: number
  positionOffsetZ: number
  topdownAltitude?: number  // Only for 2D mode
}

export interface AirportViewportConfig {
  /** All viewports for this airport */
  viewports: Viewport[]

  /** ID of the currently active viewport */
  activeViewportId: string

  /**
   * Optional saved default configuration (legacy, kept for migration)
   * Set by "Save as Default" button, restored by "Reset to Default"
   */
  defaultConfig?: {
    viewports: Viewport[]
    activeViewportId: string
  }

  /** Defaults for 3D view mode */
  default3d?: ViewModeDefaults

  /** Defaults for 2D/topdown view mode */
  default2d?: ViewModeDefaults

  /**
   * Camera bookmarks (0-99 slots)
   * Shared across all viewports for this airport
   * Saved/loaded via .XX. syntax in CommandInput
   */
  bookmarks?: { [slot: number]: import('./camera').CameraBookmark }

  /** Global datablock position (numpad style, excludes 5 which is center/reset) */
  datablockPosition?: 1 | 2 | 3 | 4 | 6 | 7 | 8 | 9
}
