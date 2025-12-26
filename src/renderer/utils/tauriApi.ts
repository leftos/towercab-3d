/**
 * Tauri API wrapper for native functionality
 * Provides a unified interface for Tauri commands and plugins
 */

import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-shell'
import { getVersion } from '@tauri-apps/api/app'

/**
 * Check if running in Tauri environment
 */
export function isTauri(): boolean {
  return '__TAURI__' in window
}

/**
 * Mod system API
 */
export const modApi = {
  /**
   * Get the path to a mod type directory (aircraft or towers)
   */
  getModsPath: (modType: 'aircraft' | 'towers'): Promise<string> =>
    invoke<string>('get_mods_path', { modType }),

  /**
   * List all mod directories for a given type
   */
  listModDirectories: (modType: 'aircraft' | 'towers'): Promise<string[]> =>
    invoke<string[]>('list_mod_directories', { modType }),

  /**
   * Read a mod manifest JSON file
   */
  readModManifest: <T = unknown>(path: string): Promise<T> =>
    invoke<T>('read_mod_manifest', { path }),

  /**
   * List all VMR (Visual Model Rules) files in the mods directory
   * Scans both mods/ root and mods/aircraft/ for .vmr files
   */
  listVMRFiles: (): Promise<string[]> =>
    invoke<string[]>('list_vmr_files'),

  /**
   * Read a text file (used for reading VMR files)
   */
  readTextFile: (path: string): Promise<string> =>
    invoke<string>('read_text_file', { path }),

  /**
   * Load and parse a model manifest.json file
   * Returns manifest data or null if file doesn't exist or is invalid
   */
  loadModelManifest: <T = unknown>(modelPath: string): Promise<T | null> =>
    invoke<T | null>('load_model_manifest', { modelPath }),

  /**
   * Read custom tower positions from mods/tower-positions/*.json files
   * Falls back to legacy mods/tower-positions.json for backward compatibility
   * Returns an object mapping ICAO codes to position objects
   * Returns empty object if no files exist
   */
  readTowerPositions: (): Promise<Record<string, unknown>> =>
    invoke<Record<string, unknown>>('read_tower_positions'),

  /**
   * Update a tower position in mods/tower-positions/{ICAO}.json
   * Creates the file if it doesn't exist
   * Preserves existing view settings when only updating one view
   * This is intended for Shift+Save Default to export shareable positions
   */
  updateTowerPosition: (icao: string, position: {
    view3d?: {
      lat: number
      lon: number
      aglHeight: number
      heading?: number
      latOffsetMeters?: number
      lonOffsetMeters?: number
    }
    view2d?: {
      altitude: number
      heading?: number
      latOffsetMeters?: number
      lonOffsetMeters?: number
    }
  }): Promise<void> =>
    invoke<void>('update_tower_position', { icao, position })
}

/**
 * Shell/external link API
 */
export const shellApi = {
  /**
   * Open a URL in the system default browser
   */
  openExternal: (url: string): Promise<void> => open(url)
}

/**
 * App info API
 */
export const appApi = {
  /**
   * Get the app version from Tauri config
   */
  getVersion
}

/**
 * Combined API for easy access
 */
export const tauriApi = {
  mod: modApi,
  shell: shellApi,
  app: appApi,
  isTauri
}

export default tauriApi
