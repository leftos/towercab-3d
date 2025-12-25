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
    invoke<T | null>('load_model_manifest', { modelPath })
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
