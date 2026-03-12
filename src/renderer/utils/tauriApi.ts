/**
 * Tauri API wrapper for native functionality
 * Provides a unified interface for Tauri commands and plugins
 */

import { getVersion } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-shell'
import type { GlobalSettings } from '@/types'
import { getApiBaseUrl } from './remoteMode'

/**
 * Check if running in Tauri environment
 */
export function isTauri(): boolean {
  return '__TAURI__' in window || '__TAURI_INTERNALS__' in window
}

/**
 * Check if running in an inset iframe context
 * Insets should NOT write to global settings - they receive data via SharedWorker
 */
export function isInsetContext(): boolean {
  try {
    const params = new URLSearchParams(window.location.search)
    return params.has('viewportId') && params.has('parentOrigin')
  } catch {
    return false
  }
}

/**
 * Join path segments using the appropriate separator for the base path
 * Detects whether the base path uses Windows (backslash) or Unix (forward slash) separators
 * and joins segments accordingly
 *
 * @param basePath - The base path that determines the separator style
 * @param segments - Additional path segments to join
 * @returns Joined path with consistent separators
 */
export function joinPath(basePath: string, ...segments: string[]): string {
  const separator = basePath.includes('\\') ? '\\' : '/'
  let result = basePath
  for (const segment of segments) {
    // Remove leading/trailing separators from segment
    const cleanSegment = segment.replace(/^[/\\]+|[/\\]+$/g, '')
    if (cleanSegment) {
      // Ensure base has no trailing separator
      result = result.replace(/[/\\]+$/, '')
      result = `${result}${separator}${cleanSegment}`
    }
  }
  return result
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
 * Discovered mod info from recursive search
 */
export interface DiscoveredMod {
  /** Absolute path to the directory containing manifest.json */
  path: string
  /** Detected mod type: "aircraft" or "tower" */
  modType: 'aircraft' | 'tower'
  /** Whether this is inside a git repository */
  isGitRepo: boolean
  /** Name of the git repo folder (if applicable) */
  repoName: string | null
}

/**
 * Result of updating a single git repository
 */
export interface GitUpdateResult {
  repoName: string
  path: string
  success: boolean
  message: string
  updated: boolean
}

/**
 * Result of updating all git repositories
 */
export interface GitUpdateAllResult {
  results: GitUpdateResult[]
  total: number
  updated: number
  failed: number
}

/**
 * Mod system API
 * In Tauri mode, uses native commands. In browser mode, uses HTTP API.
 */
export const modApi = {
  /**
   * Recursively discover all mods in the mods directory
   * Finds manifest.json files at any depth, supporting git repos
   * Returns discovered mods with their paths and detected types
   */
  discoverAllMods: async (): Promise<DiscoveredMod[]> => {
    if (isTauri()) {
      return invoke<DiscoveredMod[]>('discover_all_mods')
    }
    // Fetch from HTTP API
    const response = await fetch('/api/mods/discover')
    if (!response.ok) return []
    return response.json()
  },

  /**
   * Update all git repositories in the mods folder
   * Runs git pull on each discovered git repo
   * Only available in Tauri mode (not remote browser)
   */
  updateModRepos: async (): Promise<GitUpdateAllResult> => {
    if (isTauri()) {
      return invoke<GitUpdateAllResult>('update_mod_repos')
    }
    // Not available in browser mode
    throw new Error('Git updates are only available in the desktop app')
  },

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
    return mods.map((m) => m.name)
  },

  /**
   * Read a mod manifest JSON file
   * In browser mode, converts absolute paths to API URLs
   */
  readModManifest: async <T = unknown>(path: string): Promise<T> => {
    if (isTauri()) {
      return invoke<T>('read_mod_manifest', { path })
    }
    // In browser mode, fetch from API
    // Path could be:
    // 1. Already an API path like /api/mods/aircraft/B738
    // 2. An absolute path from discoverAllMods that needs conversion
    let apiUrl: string
    if (path.startsWith('/api/')) {
      apiUrl = `${path}/manifest.json`
    } else {
      // Extract relative path from absolute path (after "mods/")
      const normalized = path.replace(/\\/g, '/')
      const modsMatch = normalized.match(/mods[/](.+)$/i)
      if (modsMatch) {
        apiUrl = `/api/mods/file/${modsMatch[1]}/manifest.json`
      } else {
        throw new Error(`Invalid mod path: ${path}`)
      }
    }
    const response = await fetch(apiUrl)
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
   * Parse VMR files and return rules with caching
   * Uses Rust backend for fast cached parsing
   * @param filePaths Array of absolute paths to VMR files
   * @returns Parsed VMR rules
   */
  parseVMRFiles: async (
    filePaths: string[],
  ): Promise<
    Array<{
      typeCode: string
      modelName: string
      callsignPrefix: string | null
      sourceVmr: string
    }>
  > => {
    if (isTauri()) {
      return invoke<
        Array<{
          typeCode: string
          modelName: string
          callsignPrefix: string | null
          sourceVmr: string
        }>
      >('parse_vmr_files', { filePaths })
    }
    // In browser mode, VMR rules come from HTTP API
    return []
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
   * Write a text file to disk (creates parent directories if needed)
   */
  writeTextFile: async (path: string, content: string): Promise<void> => {
    if (isTauri()) {
      return invoke<void>('write_text_file', { path, content })
    }
    // In browser mode, this is not supported
    throw new Error('writeTextFile is not supported in browser mode')
  },

  /**
   * Check if a directory path is writable
   */
  checkPathWritable: async (path: string): Promise<boolean> => {
    if (isTauri()) {
      return invoke<boolean>('check_path_writable', { path })
    }
    // In browser mode, assume not writable
    return false
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
   * Get list of user-custom tower position ICAOs (from mods/tower-positions/)
   * These are positions the user has added/modified, not bundled ones
   */
  getCustomTowerPositionIcaos: async (): Promise<string[]> => {
    if (isTauri()) {
      return invoke<string[]>('get_custom_tower_position_icaos')
    }
    // In browser mode, we don't have access to this - return empty
    return []
  },

  /**
   * Update a tower position in mods/tower-positions/{ICAO}.json
   * Creates the file if it doesn't exist
   * Preserves existing view settings when only updating one view
   * This is intended for Shift+Save Default to export shareable positions
   * In browser mode, sends to HTTP API
   */
  updateTowerPosition: async (
    icao: string,
    position: {
      view3d?: {
        lat: number
        lon: number
        height: number
        heading?: number
      }
      view2d?: {
        lat?: number
        lon?: number
        altitude: number
        heading?: number
      }
    },
  ): Promise<void> => {
    if (isTauri()) {
      return invoke<void>('update_tower_position', { icao, position })
    }
    // In browser mode, PUT to server API
    const response = await fetch(`/api/tower-positions/${encodeURIComponent(icao)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(position),
    })
    if (!response.ok) {
      throw new Error(`Failed to update tower position: ${response.status}`)
    }
  },
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
   * IMPORTANT: Inset iframes are blocked from writing to prevent settings corruption
   */
  write: async (settings: GlobalSettings): Promise<void> => {
    // Insets must NOT write to global settings - they receive data via SharedWorker
    // and writing would overwrite the main app's settings
    if (isInsetContext()) {
      console.log('[globalSettingsApi] Blocked write from inset context')
      return
    }

    if (isTauri()) {
      return invoke<void>('write_global_settings', { settings })
    }
    // In browser mode, POST to server API
    const response = await fetch('/api/global-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    })
    if (!response.ok) {
      throw new Error(`Failed to save global settings: ${response.status}`)
    }
  },
}

/**
 * HTTP Server status info
 */
export interface ServerStatus {
  running: boolean
  port: number
  localUrl: string | null
  lanUrls: string[]
}

/**
 * HTTP Server API for remote browser access
 */
export const httpServerApi = {
  /**
   * Start the HTTP server on the specified port
   */
  start: (port: number): Promise<ServerStatus> => invoke<ServerStatus>('start_http_server', { port }),

  /**
   * Stop the HTTP server
   */
  stop: (): Promise<void> => invoke<void>('stop_http_server'),

  /**
   * Get the current server status
   */
  getStatus: (): Promise<ServerStatus> => invoke<ServerStatus>('get_http_server_status'),

  /**
   * Set whether the app should minimize to tray instead of quitting.
   * When enabled, also shows the system tray icon.
   */
  setMinimizeToTray: (enabled: boolean): Promise<void> => invoke<void>('set_minimize_to_tray', { enabled }),
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
  },
}

/**
 * App info API
 */
export const appApi = {
  /**
   * Get the app version from Tauri config
   */
  getVersion,
}

/**
 * Convert a local file path to a URL that can be loaded in the app
 * In Tauri mode: uses Tauri's asset protocol (asset://localhost/path)
 * In browser mode: converts to HTTP API URL
 *
 * @param filePath - Absolute file path (e.g., "C:\\path\\to\\model.glb")
 * @param type - Type of asset: 'msfs' | 'aircraft' | 'towers'
 * @param relativePath - Optional relative path within the asset type folder
 */
export async function convertToAssetUrl(
  filePath: string,
  type: 'msfs' | 'aircraft' | 'towers' = 'msfs',
  relativePath?: string,
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
    const apiPath = type === 'msfs' ? `/api/msfs/${relativePath}` : `/api/mods/${type}/${relativePath}`
    return apiPath
  }

  // Try to extract relative path from absolute path
  // Paths look like: C:\...\msfs-cache\FSLTL_B738_AAL.glb
  // or: C:\...\mods\aircraft\B738\model.glb
  const normalized = filePath.replace(/\\/g, '/')

  // For MSFS models: extract just the filename (models are flat in cache dir)
  if (type === 'msfs') {
    // GLB files are stored as {model_name}.glb directly in cache directory
    const filename = normalized.split('/').pop() || 'model.glb'
    return `/api/msfs/${filename}`
  }

  // For mods: extract path after "mods/"
  // Supports both old structure (mods/aircraft/B738) and git repos (mods/my-repo/tower/KJFK)
  const modsMatch = normalized.match(/mods[/](.+)$/i)
  if (modsMatch) {
    return `/api/mods/file/${modsMatch[1]}`
  }

  // Last resort fallback
  const filename = normalized.split('/').pop() || 'model.glb'
  console.warn('[convertToAssetUrl] Could not parse path, using filename:', filename)
  return `/api/mods/${type}/${filename}`
}

/**
 * Synchronous version for cases where async isn't possible
 * In Tauri mode: uses asset protocol for direct file access
 * In browser mode: uses HTTP API URLs
 */
export function convertToAssetUrlSync(filePath: string): string {
  // If path is already an HTTP URL or asset URL, return as-is
  if (
    filePath.startsWith('/api/') ||
    filePath.startsWith('http://') ||
    filePath.startsWith('https://') ||
    filePath.startsWith('asset://')
  ) {
    return filePath
  }

  // In Tauri mode, use the internal convertFileSrc (it's synchronous)
  if (isTauri()) {
    const internals = (
      window as unknown as { __TAURI_INTERNALS__?: { convertFileSrc: (path: string, protocol?: string) => string } }
    ).__TAURI_INTERNALS__
    if (internals?.convertFileSrc) {
      return internals.convertFileSrc(filePath)
    }
  }

  // In browser/remote mode, use HTTP API URLs
  const normalized = filePath.replace(/\\/g, '/')
  const baseUrl = getApiBaseUrl()

  // For MSFS models: extract just the filename (models are flat in cache dir)
  // GLB files are stored as {model_name}.glb directly in cache directory
  const filename = normalized.split('/').pop() || 'model.glb'
  if (filename.endsWith('.glb')) {
    return `${baseUrl}/api/msfs/${filename}`
  }

  // For mods: extract path after "mods/"
  // Supports both old structure (mods/aircraft/B738) and git repos (mods/my-repo/tower/KJFK)
  const modsMatch = normalized.match(/mods[/](.+)$/i)
  if (modsMatch) {
    return `${baseUrl}/api/mods/file/${modsMatch[1]}`
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
  convertToAssetUrlSync,
}

export default tauriApi
