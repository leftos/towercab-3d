/**
 * URL Parameter Utilities for Remote Browser Access
 *
 * Allows bookmarking URLs like /?airport=KJFK&bookmark=3 so remote
 * browser users can save and share direct links to specific airports
 * and camera bookmarks.
 *
 * Each unique URL (airport+bookmark combo) persists its own camera state
 * in the browser's localStorage, so reopening the same URL restores
 * exactly where the user left off (heading, pitch, FOV, position).
 *
 * Only active in remote/browser mode - skips Tauri desktop and inset iframes.
 */

import { isRemoteMode } from './remoteMode'
// Inline inset check to avoid circular dependency with tauriApi
function isInsetContext(): boolean {
  try {
    const params = new URLSearchParams(window.location.search)
    return params.has('viewportId') && params.has('parentOrigin')
  } catch {
    return false
  }
}

/**
 * Check if URL param updates should be active.
 * Only in remote browser mode and not in inset iframes.
 */
function isUrlParamsActive(): boolean {
  return isRemoteMode() && !isInsetContext()
}

/**
 * Parse airport and bookmark from current URL query parameters.
 * Returns null values if params are not present.
 */
export function getUrlAirportParams(): { airport: string | null; bookmark: number | null } {
  if (!isUrlParamsActive()) {
    return { airport: null, bookmark: null }
  }

  try {
    const params = new URLSearchParams(window.location.search)
    const airport = params.get('airport')?.toUpperCase() || null
    const bookmarkStr = params.get('bookmark')
    const bookmark = bookmarkStr !== null ? parseInt(bookmarkStr, 10) : null

    return {
      airport,
      bookmark: bookmark !== null && !isNaN(bookmark) ? bookmark : null,
    }
  } catch {
    return { airport: null, bookmark: null }
  }
}

/**
 * Update URL query parameters via history.replaceState (no page navigation).
 * Pass null for airport to clear all params.
 */
export function updateUrlParams(airport: string | null, bookmark?: number): void {
  if (!isUrlParamsActive()) return

  try {
    const url = new URL(window.location.href)

    if (airport) {
      url.searchParams.set('airport', airport.toUpperCase())
      if (bookmark !== undefined && bookmark !== null) {
        url.searchParams.set('bookmark', String(bookmark))
      } else {
        url.searchParams.delete('bookmark')
      }
    } else {
      url.searchParams.delete('airport')
      url.searchParams.delete('bookmark')
    }

    history.replaceState(null, '', url.toString())
  } catch {
    // Ignore errors (e.g., in restricted contexts)
  }
}

// =============================================================================
// Per-URL Camera State Persistence
// =============================================================================

const URL_CAMERA_PREFIX = 'tc3d-url-cam:'
const URL_CAMERA_SAVE_DELAY = 2000 // 2s debounce

/** Camera properties persisted per URL in localStorage. */
export interface UrlCameraState {
  viewMode: string
  heading: number
  pitch: number
  fov: number
  positionOffsetX: number
  positionOffsetY: number
  positionOffsetZ: number
  topdownAltitude: number
}

function getUrlCameraKey(airport: string, bookmark?: number | null): string {
  return bookmark !== null && bookmark !== undefined
    ? `${URL_CAMERA_PREFIX}${airport}:${bookmark}`
    : `${URL_CAMERA_PREFIX}${airport}`
}

/**
 * Load the saved camera state for a specific airport+bookmark URL combo.
 * Returns null if no saved state or if not in remote browser mode.
 */
export function loadUrlCameraState(airport: string, bookmark?: number | null): UrlCameraState | null {
  if (!isUrlParamsActive()) return null
  try {
    const raw = localStorage.getItem(getUrlCameraKey(airport, bookmark))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed.heading !== 'number' || typeof parsed.fov !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

let urlCameraSaveTimer: ReturnType<typeof setTimeout> | null = null
let pendingUrlCameraSave: (() => void) | null = null

/**
 * Debounced save of camera state for the current URL params.
 * Reads the URL at save-time so it tracks airport/bookmark switches.
 */
export function scheduleSaveUrlCameraState(state: UrlCameraState): void {
  if (!isUrlParamsActive()) return

  const doSave = () => {
    const { airport, bookmark } = getUrlAirportParams()
    if (!airport) return
    try {
      localStorage.setItem(getUrlCameraKey(airport, bookmark), JSON.stringify(state))
    } catch {
      // localStorage full or unavailable
    }
  }

  pendingUrlCameraSave = doSave
  if (urlCameraSaveTimer) clearTimeout(urlCameraSaveTimer)
  urlCameraSaveTimer = setTimeout(() => {
    urlCameraSaveTimer = null
    if (pendingUrlCameraSave) {
      pendingUrlCameraSave()
      pendingUrlCameraSave = null
    }
  }, URL_CAMERA_SAVE_DELAY)
}

/**
 * Immediately flush any pending camera save (call before page unload).
 */
export function flushUrlCameraSave(): void {
  if (urlCameraSaveTimer) {
    clearTimeout(urlCameraSaveTimer)
    urlCameraSaveTimer = null
  }
  if (pendingUrlCameraSave) {
    pendingUrlCameraSave()
    pendingUrlCameraSave = null
  }
}
