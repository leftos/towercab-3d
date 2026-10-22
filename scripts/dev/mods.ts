import { execFileSync } from 'node:child_process'
import { type Dirent, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'

/** A mod folder as `GET /api/mods/discover` lists it (the shape of mods.rs `DiscoveredMod`). */
export interface DiscoveredMod {
  /** `path` lowercased: how `disabledMods` names the mod. */
  id: string
  /** `mods/` and the folder's path under the mods root, with `/` separators. */
  path: string
  modType: 'aircraft' | 'tower'
  isGitRepo: boolean
  repoName: string | null
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingEntry(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** The resolved folder (the mods root, a subfolder of it, the bundled positions), or null when it is unset or does not exist. */
export function realFolder(folder: string | null): string | null {
  if (!folder) return null
  try {
    const real = realpathSync.native(folder)
    return statSync(real).isDirectory() ? real : null
  } catch (error) {
    if (isMissingEntry(error)) return null
    throw error
  }
}

/** Whether the resolved `realPath` lies strictly inside the resolved folder `realRoot` (a drive root included). */
export function isInside(realPath: string, realRoot: string): boolean {
  return realPath.startsWith(join(realRoot, sep))
}

/** Where an entry leads through links and junctions, when that is inside `realRoot`; else null. */
function realPathInside(path: string, realRoot: string): string | null {
  let real: string
  try {
    real = realpathSync.native(path)
  } catch (error) {
    if (isMissingEntry(error)) return null
    throw error
  }
  return isInside(real, realRoot) ? real : null
}

/** The resolved folder an entry leads to, when it is a folder inside `realRoot`; links are followed. */
function folderInside(path: string, realRoot: string): string | null {
  const real = realPathInside(path, realRoot)
  return real && statSync(real).isDirectory() ? real : null
}

/** The resolved file an entry leads to, when it is a file inside `realRoot`; links are followed. */
function fileInside(path: string, realRoot: string): string | null {
  const real = realPathInside(path, realRoot)
  return real && statSync(real).isFile() ? real : null
}

function modType(manifest: Json): DiscoveredMod['modType'] | null {
  if (manifest.type === 'aircraft' || manifest.type === 'tower') return manifest.type
  if (manifest.type !== undefined) return null
  if ('aircraftTypes' in manifest) return 'aircraft'
  if ('airports' in manifest) return 'tower'
  return null
}

/** The git repository folder holding `dir`, looked for from `dir` up to (not including) the root. */
function gitRepoName(dir: string, realRoot: string): string | null {
  for (let current = dir; isInside(current, realRoot); current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return basename(current)
  }
  return null
}

function readDiscoveredMod(dir: string, realRoot: string): DiscoveredMod | null {
  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) return null
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    // The desktop app skips a mod whose manifest does not parse; so does the dev server.
    return null
  }
  const type = isObject(manifest) ? modType(manifest) : null
  if (!type) return null
  const repoName = gitRepoName(dir, realRoot)
  const path = `mods/${relative(realRoot, dir).split(sep).join('/')}`
  return {
    id: path.toLowerCase(),
    path,
    modType: type,
    isGitRepo: repoName !== null,
    repoName,
  }
}

function discoverUnder(dir: string, realRoot: string, visited: Set<string>, found: DiscoveredMod[]): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    // The desktop app skips a folder it cannot list; so does the dev server.
    if (isMissingEntry(error) || (error as NodeJS.ErrnoException).code === 'EACCES') return
    throw error
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'tower-positions') continue
    const child = join(dir, entry.name)
    const real = folderInside(child, realRoot)
    if (!real || visited.has(real)) continue
    visited.add(real)
    const mod = readDiscoveredMod(child, realRoot)
    if (mod) found.push(mod)
    discoverUnder(child, realRoot, visited, found)
  }
}

/**
 * Every folder under the mods root holding a `manifest.json`, as mods.rs `discover_all_mods` finds
 * them: dot-folders and `tower-positions` skipped, the type taken from the manifest's `type`, else
 * `aircraftTypes`, else `airports`. Links and junctions are followed only to folders inside the root,
 * and paths are given relative to it, so no host path leaves the server.
 */
export function discoverMods(modsRoot: string | null): DiscoveredMod[] {
  const realRoot = realFolder(modsRoot)
  if (!realRoot) return []
  const found: DiscoveredMod[] = []
  discoverUnder(realRoot, realRoot, new Set([realRoot]), found)
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // The desktop app skips a position file that does not read or parse; so does the dev server.
    return undefined
  }
}

/** The `*.json` positions in `dir`, reading only files whose links lead inside `realRoot`. */
function readPositionsDir(dir: string, realRoot: string): Json {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (error) {
    if (isMissingEntry(error)) return {}
    throw error
  }
  const positions: Json = {}
  for (const name of names) {
    if (extname(name).toLowerCase() !== '.json') continue
    const file = fileInside(join(dir, name), realRoot)
    const position = file ? readJsonFile(file) : undefined
    if (position !== undefined) positions[basename(name, extname(name)).toUpperCase()] = position
  }
  return positions
}

/**
 * The tower positions as mods.rs `read_tower_positions` merges them, later sources winning: the
 * bundled `tower-positions/*.json`, the legacy `mods/tower-positions.json`, then the user's
 * `mods/tower-positions/*.json`; keys upper-cased. A file is read only when it resolves, through
 * any link or junction, inside its source folder (the bundled folder or the mods root).
 */
export function readTowerPositions(bundledDir: string, modsRoot: string | null): Json {
  const realBundled = realFolder(bundledDir)
  const positions = realBundled ? readPositionsDir(realBundled, realBundled) : {}
  const realRoot = realFolder(modsRoot)
  if (!realRoot) return positions
  const legacyFile = fileInside(join(realRoot, 'tower-positions.json'), realRoot)
  const legacy = legacyFile ? readJsonFile(legacyFile) : undefined
  if (isObject(legacy)) {
    for (const [icao, position] of Object.entries(legacy)) positions[icao.toUpperCase()] = position
  }
  return { ...positions, ...readPositionsDir(join(realRoot, 'tower-positions'), realRoot) }
}

/**
 * The mods folder the dev server reads: `TC3D_MODS_DIR` when set, else the desktop dev build's
 * `src-tauri/target/debug/mods` in the main checkout (found through git, so a worktree reads the
 * same mods), or null outside a git checkout.
 */
export function devModsRoot(env: NodeJS.ProcessEnv, repoRoot: string): string | null {
  if (env.TC3D_MODS_DIR) return resolve(env.TC3D_MODS_DIR)
  let commonDir: string
  try {
    commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    // Not a git checkout (or no git): there is no main checkout to take the dev build's mods from.
    return null
  }
  return join(dirname(commonDir), 'src-tauri', 'target', 'debug', 'mods')
}
