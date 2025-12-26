/**
 * Data loader utility for fetching external data with bundled fallback
 *
 * Tries to fetch fresh data from URLs, falls back to bundled resources if offline
 * or if fetch fails. This ensures the app works without internet access.
 *
 * In remote browser mode (non-Tauri), bundled fallback fetches from the HTTP server.
 */

import { isTauri } from './tauriApi'

/** Timeout for fetch requests in milliseconds */
const FETCH_TIMEOUT = 10000

/** Dynamic import of Tauri APIs (only available in Tauri mode) */
async function getTauriApis() {
  const [pathModule, fsModule] = await Promise.all([
    import('@tauri-apps/api/path'),
    import('@tauri-apps/plugin-fs')
  ])
  return {
    resolveResource: pathModule.resolveResource,
    readTextFile: fsModule.readTextFile
  }
}

/**
 * Fetch data with timeout
 */
async function fetchWithTimeout(url: string, timeout: number): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(url, { signal: controller.signal })
    clearTimeout(timeoutId)
    return response
  } catch (error) {
    clearTimeout(timeoutId)
    throw error
  }
}

/**
 * Load data from a URL with fallback to bundled resource file
 *
 * @param url - URL to fetch fresh data from
 * @param bundledFileName - Name of the bundled file in resources/ (e.g., "airports.json")
 * @returns The data as a string
 */
export async function loadDataWithFallback(
  url: string,
  bundledFileName: string
): Promise<string> {
  // Try fetching fresh data first
  try {
    console.log(`[DataLoader] Fetching fresh data from ${url}...`)
    const response = await fetchWithTimeout(url, FETCH_TIMEOUT)

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const data = await response.text()
    console.log(`[DataLoader] Successfully fetched fresh data (${(data.length / 1024).toFixed(1)} KB)`)
    return data
  } catch (error) {
    console.warn(`[DataLoader] Failed to fetch from ${url}:`, error)
    console.log(`[DataLoader] Falling back to bundled ${bundledFileName}...`)
  }

  // Fall back to bundled resource
  try {
    if (isTauri()) {
      // In Tauri mode, read from bundled resources
      const { resolveResource, readTextFile } = await getTauriApis()
      const resourcePath = await resolveResource(bundledFileName)
      const data = await readTextFile(resourcePath)
      console.log(`[DataLoader] Loaded bundled ${bundledFileName} (${(data.length / 1024).toFixed(1)} KB)`)
      return data
    } else {
      // In browser mode, fetch from the server's bundled resources
      // The bundled files should be served at the root (e.g., /airports.json)
      const bundledUrl = `/${bundledFileName}`
      console.log(`[DataLoader] Fetching bundled ${bundledFileName} from server...`)
      const response = await fetchWithTimeout(bundledUrl, FETCH_TIMEOUT)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const data = await response.text()
      console.log(`[DataLoader] Loaded ${bundledFileName} from server (${(data.length / 1024).toFixed(1)} KB)`)
      return data
    }
  } catch (error) {
    console.error(`[DataLoader] Failed to load bundled ${bundledFileName}:`, error)
    throw new Error(`Failed to load data: could not fetch from ${url} or load bundled ${bundledFileName}`)
  }
}

/**
 * Load JSON data from a URL with fallback to bundled resource
 */
export async function loadJsonWithFallback<T>(
  url: string,
  bundledFileName: string
): Promise<T> {
  const data = await loadDataWithFallback(url, bundledFileName)
  return JSON.parse(data) as T
}
