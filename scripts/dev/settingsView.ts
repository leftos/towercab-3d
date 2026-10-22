import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * The Cesium ion token the dev server hands the browser in place of the real one. The browser's ion
 * calls come back to the dev server, which swaps in the real token (`devApi.ts`); the client branch in
 * `src/renderer/utils/devIonServer.ts` recognises this value.
 */
export const ION_PLACEHOLDER = 'tc3d-dev-api-ion-placeholder'

/** The bundle identifier `pnpm run dev` stores its app data under (src-tauri/tauri.dev.conf.json). */
const DEV_IDENTIFIER = 'com.towercab.viewer.dev'

type Json = Record<string, unknown>

/** The settings file does not have the types the desktop app's settings struct requires. */
export class SettingsShapeError extends Error {}

// Top-level settings blocks that hold no secret and no host path, passed to the view whole.
const PUBLIC_BLOCKS = ['renderingBackend', 'airports', 'server', 'viewports', 'display', 'disabledMods'] as const
const PUBLIC_IMAGERY_FIELDS = ['provider', 'cesiumAdjustments', 'googleAdjustments'] as const
const PUBLIC_FSLTL_FIELDS = ['textureScale', 'enableFsltlModels'] as const
const PUBLIC_MSFS_MODELS_FIELDS = [
  'enableFsltl',
  'enableAig',
  'priority',
  'cacheLimitMB',
  'textureScale',
  'skipGenericVmrMatches',
] as const
const PUBLIC_REALTRAFFIC_FIELDS = ['dataSource', 'radiusNm', 'maxParkedAircraft'] as const

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalObject(parent: Json, key: string): Json | undefined {
  const value = parent[key]
  if (value === undefined) return undefined
  if (!isObject(value)) throw new SettingsShapeError(`${key} is not an object`)
  return value
}

function optionalString(parent: Json, key: string): string {
  const value = parent[key]
  if (value === undefined) return ''
  if (typeof value !== 'string') throw new SettingsShapeError(`${key} is not a string`)
  return value
}

function pick(source: Json, keys: readonly string[]): Json {
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]))
}

/**
 * The Node port of the desktop server's `remote_view` (src-tauri/src/settings.rs), built by picking
 * the fields a remote client may see: the ion token, every public block, the imagery and
 * RealTraffic blocks with their secrets blank (the Google Maps key kept while Google is the imagery
 * provider), and the `fsltl` and `msfsModels` blocks picked down to their public fields with their
 * host paths blank. `vnasTokens` and unknown keys are left out. tests/fixtures/remote-view.json,
 * written by the Rust tests, pins it to the Rust function.
 *
 * Raises:
 *     SettingsShapeError: A field the view reads has the wrong type.
 */
export function remoteView(stored: unknown): Json {
  if (!isObject(stored)) throw new SettingsShapeError('the settings are not an object')
  const view: Json = { cesiumIonToken: optionalString(stored, 'cesiumIonToken'), ...pick(stored, PUBLIC_BLOCKS) }

  const imagery = optionalObject(stored, 'imagery')
  if (imagery) {
    const provider = imagery.provider
    if (provider !== undefined && typeof provider !== 'string') throw new SettingsShapeError('provider is not a string')
    const googleKey = optionalString(imagery, 'googleMapsApiKey')
    view.imagery = { ...pick(imagery, PUBLIC_IMAGERY_FIELDS), googleMapsApiKey: provider === 'google' ? googleKey : '' }
  }

  const realtraffic = optionalObject(stored, 'realtraffic')
  if (realtraffic) {
    optionalString(realtraffic, 'licenseKey')
    view.realtraffic = { ...pick(realtraffic, PUBLIC_REALTRAFFIC_FIELDS), licenseKey: '' }
  }

  // Each block is picked down to its public fields and its host-private paths (FieldClass::HostPrivate
  // in settings.rs) blanked, so a field added to the stored block later stays on the host.
  const fsltl = optionalObject(stored, 'fsltl')
  if (fsltl) {
    view.fsltl = { ...pick(fsltl, PUBLIC_FSLTL_FIELDS), sourcePath: null, outputPath: null }
  }
  const msfsModels = optionalObject(stored, 'msfsModels')
  if (msfsModels) {
    view.msfsModels = {
      ...pick(msfsModels, PUBLIC_MSFS_MODELS_FIELDS),
      communityPath: null,
      cacheDirectory: null,
      vmrFiles: [],
    }
  }
  return view
}

/** A remote view with the ion token swapped for `ION_PLACEHOLDER`, or blank when there is none. */
export function withIonPlaceholder(view: Json): Json {
  return { ...view, cesiumIonToken: view.cesiumIonToken ? ION_PLACEHOLDER : '' }
}

/** What the dev server answers `GET /api/global-settings` with for these stored settings. */
export function devSettingsView(stored: unknown): Json {
  return withIonPlaceholder(remoteView(stored))
}

/** The settings file as the dev server sees it, read fresh for each request. */
export type StoredSettings =
  | { status: 'found'; view: Json; ionToken: string }
  | { status: 'missing' }
  | { status: 'unreadable' }

/**
 * Reads the settings file and builds its remote view. A file that cannot be read, is not JSON, or
 * has a wrong type is `unreadable`; the reason is dropped on purpose, since a parser message quotes
 * the file's text and the ion token is its first field.
 */
export function loadSettings(settingsFile: string): StoredSettings {
  let text: string
  try {
    text = readFileSync(settingsFile, 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'missing' } : { status: 'unreadable' }
  }
  let stored: unknown
  try {
    stored = JSON.parse(text)
  } catch {
    return { status: 'unreadable' }
  }
  try {
    const view = remoteView(stored)
    return { status: 'found', view, ionToken: view.cesiumIonToken as string }
  } catch (error) {
    if (error instanceof SettingsShapeError) return { status: 'unreadable' }
    throw error
  }
}

/**
 * The settings file the dev server reads: `TC3D_SETTINGS_FILE` when set, else the file the desktop
 * app's dev build keeps in its app data folder (`%APPDATA%\com.towercab.viewer.dev\global-settings.json`
 * on Windows).
 */
export function devSettingsFile(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (env.TC3D_SETTINGS_FILE) return resolve(env.TC3D_SETTINGS_FILE)
  const home = homedir()
  const dataDir =
    platform === 'win32'
      ? (env.APPDATA ?? join(home, 'AppData', 'Roaming'))
      : platform === 'darwin'
        ? join(home, 'Library', 'Application Support')
        : (env.XDG_DATA_HOME ?? join(home, '.local', 'share'))
  return join(dataDir, DEV_IDENTIFIER, 'global-settings.json')
}
