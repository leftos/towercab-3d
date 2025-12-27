/**
 * Tauri API wrapper for native functionality
 * Provides a unified interface for Tauri commands and plugins
 */

import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-shell'
import { getVersion } from '@tauri-apps/api/app'
import type { GlobalSettings } from '@/types'

/**
 * Check if running in Tauri environment
 */
export function isTauri(): boolean {
  return '__TAURI__' in window || '__TAURI_INTERNALS__' in window
}

/**
 * Mod info returned from API
 */
interface ModInfo {
  name: string
  path: string
  manifest: unknown | null
}

/**
 * Mod system API
 * In Tauri mode, uses native commands. In browser mode, uses HTTP API.
 */
export const modApi = {
  /**
   * Get the path to a mod type directory (aircraft or towers)
   * In browser mode, returns a virtual path that maps to API endpoints
   */
  getModsPath: async (modType: 'aircraft' | 'towers'): Promise<string> => {
    if (isTauri()) {
      return invoke<string>('get_mods_path', { modType })
    }
    // In browser mode, return virtual path that the server understands
    return `/api/mods/${modType}`
  },

  /**
   * List all mod directories for a given type
   */
  listModDirectories: async (modType: 'aircraft' | 'towers'): Promise<string[]> => {
    if (isTauri()) {
      return invoke<string[]>('list_mod_directories', { modType })
    }
    // Fetch from HTTP API
    const response = await fetch(`/api/mods/${modType}`)
    if (!response.ok) return []
    const mods: ModInfo[] = await response.json()
    return mods.map(m => m.name)
  },

  /**
   * Read a mod manifest JSON file
   */
  readModManifest: async <T = unknown>(path: string): Promise<T> => {
    if (isTauri()) {
      return invoke<T>('read_mod_manifest', { path })
    }
    // In browser mode, fetch from API
    // Path is like /api/mods/aircraft/B738, we need to get the manifest
    const response = await fetch(`${path}/manifest.json`)
    if (!response.ok) throw new Error(`Failed to load manifest: ${response.status}`)
    return response.json()
  },

  /**
   * List all VMR (Visual Model Rules) files in the mods directory
   * Scans both mods/ root and mods/aircraft/ for .vmr files
   */
  listVMRFiles: async (): Promise<string[]> => {
    if (isTauri()) {
      return invoke<string[]>('list_vmr_files')
    }
    // In browser mode, VMR files are returned as parsed rules from the API
    return [] // Empty - VMR rules will be fetched separately
  },

  /**
   * Read a text file (used for reading VMR files)
   */
  readTextFile: async (path: string): Promise<string> => {
    if (isTauri()) {
      return invoke<string>('read_text_file', { path })
    }
    // In browser mode, fetch from server
    const response = await fetch(path)
    if (!response.ok) throw new Error(`Failed to read file: ${response.status}`)
    return response.text()
  },

  /**
   * Load and parse a model manifest.json file
   * Returns manifest data or null if file doesn't exist or is invalid
   */
  loadModelManifest: async <T = unknown>(modelPath: string): Promise<T | null> => {
    if (isTauri()) {
      return invoke<T | null>('load_model_manifest', { modelPath })
    }
    try {
      const response = await fetch(`${modelPath}/manifest.json`)
      if (!response.ok) return null
      return response.json()
    } catch {
      return null
    }
  },

  /**
   * Read custom tower positions from mods/tower-positions/*.json files
   * Falls back to legacy mods/tower-positions.json for backward compatibility
   * Returns an object mapping ICAO codes to position objects
   * Returns empty object if no files exist
   */
  readTowerPositions: async (): Promise<Record<string, unknown>> => {
    if (isTauri()) {
      return invoke<Record<string, unknown>>('read_tower_positions')
    }
    const response = await fetch('/api/tower-positions')
    if (!response.ok) return {}
    return response.json()
  },

  /**
   * Update a tower position in mods/tower-positions/{ICAO}.json
   * Creates the file if it doesn't exist
   * Preserves existing view settings when only updating one view
   * This is intended for Shift+Save Default to export shareable positions
   * In browser mode, sends to HTTP API
   */
  updateTowerPosition: async (icao: string, position: {
    view3d?: {
      lat: number
      lon: number
      aglHeight: number
      heading?: number
    }
    view2d?: {
      lat?: number
      lon?: number
      altitude: number
      heading?: number
    }
  }): Promise<void> => {
    if (isTauri()) {
      return invoke<void>('update_tower_position', { icao, position })
    }
    // In browser mode, PUT to server API
    const response = await fetch(`/api/tower-positions/${encodeURIComponent(icao)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(position)
    })
    if (!response.ok) {
      throw new Error(`Failed to update tower position: ${response.status}`)
    }
  }
}

/**
 * Global Settings API
 * Settings stored on host file system, shared across all browsers/devices
 * In browser mode, reads from HTTP API (write operations are disabled)
 */
export const globalSettingsApi = {
  /**
   * Get the path to the global settings file (for diagnostics)
   */
  getPath: async (): Promise<string> => {
    if (isTauri()) {
      return invoke<string>('get_global_settings_path')
    }
    return '(remote browser - settings on host)'
  },

  /**
   * Read global settings from disk
   * Returns default settings if file doesn't exist
   */
  read: async (): Promise<GlobalSettings> => {
    if (isTauri()) {
      return invoke<GlobalSettings>('read_global_settings')
    }
    // Fetch from HTTP API
    const response = await fetch('/api/global-settings')
    if (!response.ok) {
      throw new Error(`Failed to load global settings: ${response.status}`)
    }
    return response.json()
  },

  /**
   * Write global settings to disk
   * In browser mode, sends to HTTP API
   */
  write: async (settings: GlobalSettings): Promise<void> => {
    if (isTauri()) {
      return invoke<void>('write_global_settings', { settings })
    }
    // In browser mode, POST to server API
    const response = await fetch('/api/global-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    })
    if (!response.ok) {
      throw new Error(`Failed to save global settings: ${response.status}`)
    }
  }
}

/**
 * HTTP Server status info
 */
export interface ServerStatus {
  running: boolean
  port: number
  localUrl: string | null
  lanUrl: string | null
}

/**
 * HTTP Server API for remote browser access
 */
export const httpServerApi = {
  /**
   * Start the HTTP server on the specified port
   */
  start: (port: number): Promise<ServerStatus> =>
    invoke<ServerStatus>('start_http_server', { port }),

  /**
   * Stop the HTTP server
   */
  stop: (): Promise<void> =>
    invoke<void>('stop_http_server'),

  /**
   * Get the current server status
   */
  getStatus: (): Promise<ServerStatus> =>
    invoke<ServerStatus>('get_http_server_status')
}

/**
 * Shell/external link API
 */
export const shellApi = {
  /**
   * Open a URL in the system default browser
   * In browser mode, uses window.open as fallback
   */
  openExternal: async (url: string): Promise<void> => {
    if (isTauri()) {
      return open(url)
    }
    // In browser mode, use window.open
    window.open(url, '_blank', 'noopener,noreferrer')
  }
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
 * Convert a local file path to a URL that can be loaded in the app
 * In Tauri mode: uses Tauri's asset protocol (asset://localhost/path)
 * In browser mode: converts to HTTP API URL
 *
 * @param filePath - Absolute file path (e.g., "C:\\path\\to\\model.glb")
 * @param type - Type of asset: 'fsltl' | 'aircraft' | 'towers'
 * @param relativePath - Optional relative path within the asset type folder
 */
export async function convertToAssetUrl(
  filePath: string,
  type: 'fsltl' | 'aircraft' | 'towers' = 'fsltl',
  relativePath?: string
): Promise<string> {
  // If path is already an HTTP URL, return as-is
  if (filePath.startsWith('/api/') || filePath.startsWith('http://') || filePath.startsWith('https://')) {
    return filePath
  }

  if (isTauri()) {
    // In Tauri mode, use the Tauri asset protocol
    const { convertFileSrc } = await import('@tauri-apps/api/core')
    return convertFileSrc(filePath)
  }

  // In browser mode, convert to HTTP API URL
  // Extract the relative path from the file path or use the provided one
  if (relativePath) {
    const apiPath = type === 'fsltl'
      ? `/api/fsltl/${relativePath}`
      : `/api/mods/${type}/${relativePath}`
    return apiPath
  }

  // Try to extract relative path from absolute path
  // Paths look like: C:\...\fsltl-output\B738\AAL\model.glb
  // or: C:\...\mods\aircraft\B738\model.glb
  const normalized = filePath.replace(/\\/g, '/')

  // For FSLTL: look for pattern after common FSLTL output folder patterns
  if (type === 'fsltl') {
    // Try to find the type/airline/model.glb structure
    const fsltlMatch = normalized.match(/[/\\]([A-Z0-9]{3,4})[/\\]([A-Z0-9_]+)[/\\](model\.glb)$/i)
    if (fsltlMatch) {
      return `/api/fsltl/${fsltlMatch[1]}/${fsltlMatch[2]}/${fsltlMatch[3]}`
    }
    // Fallback: use just the filename
    const filename = normalized.split('/').pop() || 'model.glb'
    console.warn('[convertToAssetUrl] Could not parse FSLTL path, using filename:', filename)
    return `/api/fsltl/${filename}`
  }

  // For mods: extract path after mods/aircraft or mods/towers
  const modsMatch = normalized.match(/mods[/\\](aircraft|towers)[/\\](.+)$/i)
  if (modsMatch) {
    return `/api/mods/${modsMatch[1]}/${modsMatch[2]}`
  }

  // Last resort fallback
  const filename = normalized.split('/').pop() || 'model.glb'
  console.warn('[convertToAssetUrl] Could not parse path, using filename:', filename)
  return `/api/mods/${type}/${filename}`
}

/**
 * Synchronous version for cases where async isn't possible
 * In browser mode, this just returns the path as-is (won't work for loading)
 * Use the async version when possible
 */
export function convertToAssetUrlSync(filePath: string): string {
  // If path is already an HTTP URL, return as-is
  if (filePath.startsWith('/api/') || filePath.startsWith('http://') || filePath.startsWith('https://')) {
    return filePath
  }

  if (isTauri()) {
    // In Tauri mode, manually construct the asset URL
    // This is what convertFileSrc does internally
    const encoded = encodeURIComponent(filePath.replace(/\\/g, '/'))
    return `asset://localhost/${encoded}`
  }

  // In browser mode, we need the model type to construct the URL
  // Try to detect from the path
  const normalized = filePath.replace(/\\/g, '/')

  // For FSLTL
  const fsltlMatch = normalized.match(/[/\\]([A-Z0-9]{3,4})[/\\]([A-Z0-9_]+)[/\\](model\.glb)$/i)
  if (fsltlMatch) {
    return `/api/fsltl/${fsltlMatch[1]}/${fsltlMatch[2]}/${fsltlMatch[3]}`
  }

  // For mods
  const modsMatch = normalized.match(/mods[/\\](aircraft|towers)[/\\](.+)$/i)
  if (modsMatch) {
    return `/api/mods/${modsMatch[1]}/${modsMatch[2]}`
  }

  // Fallback: return path as-is
  console.warn('[convertToAssetUrlSync] Could not parse path, returning as-is:', filePath)
  return filePath
}

/**
 * Combined API for easy access
 */
export const tauriApi = {
  mod: modApi,
  globalSettings: globalSettingsApi,
  httpServer: httpServerApi,
  shell: shellApi,
  app: appApi,
  isTauri,
  convertToAssetUrl,
  convertToAssetUrlSync
}

export default tauriApi
