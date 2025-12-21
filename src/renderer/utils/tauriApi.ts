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
    invoke<T>('read_mod_manifest', { path })
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
