/**
 * Types for the Export/Import Settings Wizard
 *
 * Supports a hierarchical tree view with tri-state checkboxes for
 * selective export/import of settings categories and per-airport data.
 */

/**
 * Checkbox state for tree nodes
 * - 'checked': All children are selected
 * - 'unchecked': No children are selected
 * - 'indeterminate': Some children are selected
 */
export type CheckState = 'checked' | 'unchecked' | 'indeterminate'

/**
 * Tree node data for the settings tree view
 */
export interface TreeNodeData {
  /** Unique path identifier, e.g., 'local.graphics.shadows' */
  id: string

  /** Display label, e.g., 'Shadows' */
  label: string

  /** Child nodes (if any) */
  children?: TreeNodeData[]

  /** True if this is a leaf node (no children) */
  isLeaf: boolean

  /** Optional description/hint for the setting */
  description?: string

  /** Number of individual settings in this group (for display) */
  settingCount?: number

  /** Additional info to display (e.g., "5 bookmarks") */
  badge?: string
}

/**
 * Mapping of setting keys to their property names
 * Used for selective export/import
 */
export interface SettingMapping {
  /** The tree node ID path */
  id: string

  /** The setting category (cesium, graphics, camera, etc.) */
  category: string

  /** The sub-category within the setting group */
  subCategory?: string

  /** The individual setting property names */
  properties: string[]
}

/**
 * Selective export data format (version 3)
 * Extends the base ExportData with selective settings
 */
export interface SelectiveExportData {
  version: 3
  exportDate: string
  appVersion: string

  /** Selected local settings by category */
  localSettings?: {
    cesium?: Record<string, unknown>
    graphics?: Record<string, unknown>
    camera?: Record<string, unknown>
    weather?: Record<string, unknown>
    memory?: Record<string, unknown>
    aircraft?: Record<string, unknown>
    ui?: Record<string, unknown>
    fsltl?: Record<string, unknown>
  }

  /** Selected global settings */
  globalSettings?: {
    cesiumIonToken?: string
    fsltl?: Record<string, unknown>
    airports?: Record<string, unknown>
    server?: Record<string, unknown>
  }

  /** Per-airport data */
  airports: Record<string, {
    /** All viewports for this airport (main + insets with geometry/camera) */
    viewports?: unknown[]
    /** Currently active viewport ID */
    activeViewportId?: string
    /** Saved default viewport configuration */
    defaultConfig?: {
      viewports: unknown[]
      activeViewportId: string
    }
    /** 3D view mode camera defaults */
    default3d?: Record<string, unknown>
    /** 2D/topdown view mode camera defaults */
    default2d?: Record<string, unknown>
    /** Camera bookmarks (0-99 slots) */
    bookmarks?: Record<number, unknown>
    /** Datablock position (numpad style) */
    datablockPosition?: number
  }>

  /** List of selected IDs for reference during import */
  exportedPaths: string[]
}
