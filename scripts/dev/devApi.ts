import { createReadStream, existsSync, realpathSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BlockList, isIPv4, isIPv6 } from 'node:net'
import { join, resolve, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { pipeline } from 'node:stream'
import { createGunzip } from 'node:zlib'
import type { Plugin } from 'vite'
import { devModsRoot, discoverMods, isInside, readTowerPositions, realFolder } from './mods'
import { resolveUnderRoot } from './safePath'
import { devSettingsFile, loadSettings, withIonPlaceholder } from './settingsView'
import { fetchCapped, metarTarget } from './upstream'

/**
 * The Vite mode that turns the dev API on (`pnpm run vite:headless`). A dev server started in any
 * other mode, and every build, leaves `/api/*` alone.
 */
export const DEV_API_MODE = 'headless'
export const DEV_API_PLUGIN_NAME = 'tc3d-dev-api'

/** Where the dev API's messages go; it never logs a request's URL, headers or body. */
export interface DevApiLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** What the dev API reads and calls. */
export interface DevApiOptions {
  /** The desktop app's global settings file, read fresh on every request and never written. */
  settingsFile: string
  /** The mods folder, or null for none. */
  modsRoot: string | null
  /** The bundled `tower-positions` folder (src-tauri/resources/tower-positions). */
  bundledTowerPositionsDir: string
  /** The bundled `airport-surfaces.json.gz`. */
  airportSurfacesFile: string
  /** How upstream calls (METAR, Cesium ion) are made. */
  fetch: typeof fetch
  logger: DevApiLogger
}

/** A connect-style handler; the promise settles once the reply has been started. */
export type DevApiHandler = (req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<void>

const LOOPBACK = new BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK.addAddress('::1', 'ipv6')

const ION_SERVER = 'https://api.cesium.com'
const ION_ENDPOINT_ROUTE = /^\/api\/ion\/v1\/assets\/(\d+)\/endpoint$/
const MOD_FILE_ROUTES: [prefix: string, subfolder: string][] = [
  ['/api/mods/file/', ''],
  ['/api/mods/aircraft/', 'aircraft'],
  ['/api/mods/towers/', 'towers'],
]
const MOD_FILE_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ktx2': 'image/ktx2',
}
const MOD_FILE_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(MOD_FILE_TYPES))
const METAR_LIMITS = { timeoutMs: 15_000, maxBytes: 5 * 1024 * 1024 }
const ION_LIMITS = { timeoutMs: 15_000, maxBytes: 1024 * 1024 }
const SETTINGS_UNREADABLE = { error: 'The dev settings file could not be read' }

/**
 * Whether a socket address is loopback: `127.0.0.0/8`, `::1`, or IPv4-mapped `::ffff:127.*`. The
 * desktop server also admits private LAN ranges; the dev API does not.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  if (isIPv4(address)) return LOOPBACK.check(address, 'ipv4')
  return isIPv6(address) && LOOPBACK.check(address, 'ipv6')
}

/**
 * Why a request to `/api/*` is refused, or null: it must come from a loopback socket (forwarding
 * headers are ignored), name this server as `localhost`, `127.0.0.1` or `[::1]` with the port it
 * arrived on (refusing DNS-rebound pages whatever Vite's own Host check allows), carry no
 * `Origin` but this server's own, and not be marked by the browser as a navigation
 * (`Sec-Fetch-Mode: navigate`) or another site's request (`Sec-Fetch-Site: cross-site`). A request
 * without fetch metadata (Node, curl) passes that last check.
 */
export function requestRefusal(req: IncomingMessage): string | null {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return 'The dev API answers loopback clients only'
  if (req.headers['sec-fetch-mode'] === 'navigate' || req.headers['sec-fetch-site'] === 'cross-site') {
    return 'The dev API answers the page’s own script calls only, not navigations or other sites'
  }
  const host = req.headers.host?.toLowerCase()
  const port = req.socket.localPort
  if (!host || ![`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(host)) {
    return 'The Host header does not name this dev server'
  }
  const origin = req.headers.origin
  if (origin !== undefined && origin.toLowerCase() !== `http://${host}`) return 'Requests from other origins are refused'
  return null
}

/** Whether the browser marks a request as this page's own script call (not a navigation or another site). */
function isSameOriginCall(req: IncomingMessage): boolean {
  const mode = req.headers['sec-fetch-mode']
  return req.headers['sec-fetch-site'] === 'same-origin' && mode !== undefined && mode !== 'navigate'
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.statusCode = status
  res.setHeader('Content-Type', contentType)
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

/**
 * Reads the request body to its end and drops it, unparsed. Answering before the body is read
 * would leave the connection to be reset under the client's next request. Rejects when the stream
 * fails or closes before its end.
 */
function discardBody(req: IncomingMessage): Promise<void> {
  if (req.readableEnded) return Promise.resolve()
  return new Promise((done, fail) => {
    req.once('error', fail)
    req.once('end', done)
    req.once('close', () => {
      if (!req.readableEnded) fail(new Error('the request closed before its body ended'))
    })
    req.resume()
  })
}

/** Answers 204 once the request body has been read and dropped. */
async function drainAndAccept(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await discardBody(req)
  res.statusCode = 204
  res.setHeader('Cache-Control', 'no-store')
  res.end()
}

/** Streams a file (gunzipped when asked), logging a fixed line if the stream fails midway. */
function streamFile(res: ServerResponse, path: string, contentType: string, logger: DevApiLogger, gunzip: boolean): void {
  res.statusCode = 200
  res.setHeader('Content-Type', contentType)
  res.setHeader('Cache-Control', 'no-store')
  const onDone = (error: Error | null) => {
    if (error) logger.error('[dev-api] streaming a file failed')
  }
  if (gunzip) pipeline(createReadStream(path), createGunzip(), res, onDone)
  else pipeline(createReadStream(path), res, onDone)
}

/**
 * The dev API's request handler. It answers `/api/*` (except `/api/realtraffic/*`, passed on to
 * Vite's proxy once the request is admitted) and hands every other path to `next`. Nothing it does
 * writes to disk, and no error it meets reaches Vite's error page, logger or HMR channel with
 * anything but a fixed message.
 */
export function createDevApiHandler(options: DevApiOptions): DevApiHandler {
  const { logger } = options

  function serveSettings(res: ServerResponse): void {
    const settings = loadSettings(options.settingsFile)
    if (settings.status === 'unreadable') {
      logger.warn('[dev-api] the dev settings file could not be read')
      sendJson(res, 500, SETTINGS_UNREADABLE)
      return
    }
    sendJson(res, 200, settings.status === 'found' ? withIonPlaceholder(settings.view) : { cesiumIonToken: '' })
  }

  function serveHealth(res: ServerResponse): void {
    const settings = loadSettings(options.settingsFile)
    sendJson(res, 200, {
      settings: settings.status,
      ionToken: settings.status === 'found' && settings.ionToken !== '',
      modsRoot: realFolder(options.modsRoot) ? 'found' : 'missing',
    })
  }

  function serveModFile(res: ServerResponse, subfolder: string, encodedPath: string): void {
    const root = realFolder(options.modsRoot)
    if (!root) {
      sendJson(res, 404, { error: 'File not found' })
      return
    }
    // A subfolder route serves only that subfolder, and only while it resolves inside the mods root.
    const folder = join(root, subfolder)
    const base = realFolder(folder)
    if (base && base !== root && !isInside(base, root)) {
      sendJson(res, 403, { error: 'Access denied' })
      return
    }
    const resolved = resolveUnderRoot(base ?? folder, encodedPath, MOD_FILE_EXTENSIONS)
    if (resolved.kind === 'refused') {
      sendJson(res, 403, { error: 'Access denied' })
      return
    }
    if (resolved.kind === 'missing') {
      sendJson(res, 404, { error: 'File not found' })
      return
    }
    const extension = resolved.path.slice(resolved.path.lastIndexOf('.')).toLowerCase()
    streamFile(res, resolved.path, MOD_FILE_TYPES[extension], logger, false)
  }

  function serveAirportSurfaces(res: ServerResponse): void {
    if (!existsSync(options.airportSurfacesFile)) {
      sendJson(res, 404, { error: 'Airport surfaces data not found' })
      return
    }
    streamFile(res, options.airportSurfacesFile, 'application/json', logger, true)
  }

  async function proxyMetar(res: ServerResponse, query: URLSearchParams): Promise<void> {
    const raw = query.get('url')
    if (raw === null) {
      sendJson(res, 400, { error: 'The url query parameter is missing' })
      return
    }
    const target = metarTarget(raw)
    if (!target) {
      sendJson(res, 403, { error: 'Only the aviationweather.gov METAR API is proxied' })
      return
    }
    try {
      const reply = await fetchCapped(options.fetch, target, { Accept: 'application/json' }, METAR_LIMITS)
      // Whatever type upstream claims, the browser is told JSON and not to sniff, so the reply never runs as a page.
      res.setHeader('X-Content-Type-Options', 'nosniff')
      sendBytes(res, reply.status, 'application/json; charset=utf-8', reply.body)
    } catch {
      logger.warn('[dev-api] the METAR API gave no usable reply')
      sendJson(res, 502, { error: 'The METAR API gave no usable reply' })
    }
  }

  async function forwardIonEndpoint(res: ServerResponse, assetId: string, query: URLSearchParams): Promise<void> {
    const settings = loadSettings(options.settingsFile)
    if (settings.status === 'unreadable') {
      logger.warn('[dev-api] the dev settings file could not be read')
      sendJson(res, 500, SETTINGS_UNREADABLE)
      return
    }
    const token = settings.status === 'found' ? settings.ionToken : ''
    if (!token) {
      sendJson(res, 401, { error: 'The dev settings file holds no Cesium ion token' })
      return
    }
    const target = new URL(`${ION_SERVER}/v1/assets/${assetId}/endpoint`)
    for (const [key, value] of query) {
      if (key !== 'access_token') target.searchParams.append(key, value)
    }
    let reply: Awaited<ReturnType<typeof fetchCapped>>
    try {
      reply = await fetchCapped(options.fetch, target, { Accept: 'application/json', Authorization: `Bearer ${token}` }, ION_LIMITS)
    } catch {
      logger.warn('[dev-api] Cesium ion gave no usable reply to an asset endpoint call')
      sendJson(res, 502, { error: 'Cesium ion gave no usable reply' })
      return
    }
    if (reply.body.includes(token)) {
      logger.warn('[dev-api] Cesium ion echoed the token back; the reply was withheld')
      sendJson(res, 502, { error: 'Cesium ion gave no usable reply' })
      return
    }
    sendBytes(res, reply.status, reply.contentType, reply.body)
  }

  async function serveRead(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams) {
    for (const [prefix, subfolder] of MOD_FILE_ROUTES) {
      if (path.startsWith(prefix)) return serveModFile(res, subfolder, path.slice(prefix.length))
    }
    const ionEndpoint = ION_ENDPOINT_ROUTE.exec(path)
    if (ionEndpoint) {
      if (!isSameOriginCall(req)) return sendJson(res, 403, { error: 'Only the page itself may call Cesium ion' })
      return forwardIonEndpoint(res, ionEndpoint[1], query)
    }
    switch (path) {
      case '/api/global-settings':
        if (!isSameOriginCall(req)) return sendJson(res, 403, { error: 'Only the page itself may read the settings' })
        return serveSettings(res)
      case '/api/dev-health':
        return serveHealth(res)
      case '/api/mods/discover':
        return sendJson(res, 200, discoverMods(options.modsRoot))
      case '/api/tower-positions':
        return sendJson(res, 200, readTowerPositions(options.bundledTowerPositionsDir, options.modsRoot))
      case '/api/airport-surfaces':
        return serveAirportSurfaces(res)
      case '/api/proxy':
        return proxyMetar(res, query)
      default:
        return sendJson(res, 404, { error: 'No such dev API route' })
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams) {
    const method = req.method ?? 'GET'
    if (path === '/api/global-settings' && method === 'POST' && isSameOriginCall(req)) return drainAndAccept(req, res)
    if (path === '/api/log' && method === 'POST') return drainAndAccept(req, res)
    if (method !== 'GET') {
      await discardBody(req)
      if (path === '/api/global-settings' && method === 'POST') {
        return sendJson(res, 403, { error: 'Only the page itself may write the settings' })
      }
      return sendJson(res, 405, { error: 'The dev API is read-only' })
    }
    return serveRead(req, res, path, query)
  }

  return async (req, res, next) => {
    const target = req.url ?? '/'
    const queryStart = target.indexOf('?')
    const path = queryStart === -1 ? target : target.slice(0, queryStart)
    const rawQuery = queryStart === -1 ? '' : target.slice(queryStart + 1)
    if (path !== '/api' && !path.startsWith('/api/')) {
      next()
      return
    }
    try {
      const refusal = requestRefusal(req)
      if (refusal) {
        if (req.method !== 'GET') await discardBody(req)
        sendJson(res, 403, { error: refusal })
        return
      }
      if (path.startsWith('/api/realtraffic/')) {
        next()
        return
      }
      await route(req, res, path, new URLSearchParams(rawQuery))
    } catch {
      failRequest(res, logger)
    }
  }
}

/**
 * Ends a request whose handling failed: a fixed log line and a fixed 500 (or a dropped connection
 * once the reply has started). The error may quote settings or upstream text, so none of it is used.
 */
function failRequest(res: ServerResponse, logger: DevApiLogger): void {
  logger.error('[dev-api] a request failed')
  if (res.headersSent) res.destroy()
  else sendJson(res, 500, { error: 'The dev API failed to answer' })
}

/** A path made comparable: absolute, through links when it exists, lower-case on Windows. */
function comparablePath(path: string): string {
  let real = resolve(path)
  try {
    real = realpathSync.native(real)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return process.platform === 'win32' ? real.toLowerCase() : real
}

/**
 * Refuses a settings file Vite would serve raw through `/@fs/`: one inside any of `servedFolders`
 * (`server.fs.allow` and the project root).
 *
 * Raises:
 *     Error: The settings file lies inside a served folder; the message names the variable to change,
 *     never the file's contents.
 */
export function assertSettingsOutsideServedFolders(settingsFile: string, servedFolders: readonly string[]): void {
  const settings = comparablePath(settingsFile)
  for (const folder of servedFolders) {
    const served = comparablePath(folder)
    if (settings === served || settings.startsWith(join(served, sep))) {
      throw new Error(
        '[dev-api] the settings file lies inside a folder the dev server serves (server.fs.allow or the project root), ' +
          'where /@fs/ would hand it to any page; set TC3D_SETTINGS_FILE to a file outside the repository',
      )
    }
  }
}

/**
 * An HTTP `upgrade` listener closing WebSocket upgrades under `/api/` at once (the observations and
 * presence sockets the desktop server has), so a page served by the dev API sees no host. Other
 * upgrades, such as Vite's HMR socket, are left to their own listeners.
 */
export function refuseApiWebSocket(req: IncomingMessage, socket: Duplex): void {
  const path = (req.url ?? '').split('?')[0]
  if (path === '/api' || path.startsWith('/api/')) socket.destroy()
}

/**
 * The dev API's options from the environment: `TC3D_SETTINGS_FILE` and `TC3D_MODS_DIR` when set,
 * else the desktop dev build's settings file and mods folder, and the bundled resources in `repoRoot`.
 */
export function devApiOptionsFromEnv(repoRoot: string, logger: DevApiLogger): DevApiOptions {
  return {
    settingsFile: devSettingsFile(process.env, process.platform),
    modsRoot: devModsRoot(process.env, repoRoot),
    bundledTowerPositionsDir: join(repoRoot, 'src-tauri', 'resources', 'tower-positions'),
    airportSurfacesFile: join(repoRoot, 'src-tauri', 'resources', 'airport-surfaces.json.gz'),
    fetch: globalThis.fetch,
    logger,
  }
}

/**
 * The Vite plugin serving the dev API, on only for `vite` (serve, never preview) in `DEV_API_MODE`.
 * `resolveOptions` runs when the server starts, never when the config loads, so loading the config
 * reads no settings. The server refuses to start when the settings file lies in a folder it serves.
 */
export function devApiPlugin(resolveOptions: (logger: DevApiLogger) => DevApiOptions): Plugin {
  return {
    name: DEV_API_PLUGIN_NAME,
    apply: (_config, env) => env.command === 'serve' && env.mode === DEV_API_MODE && !env.isPreview,
    configureServer(server) {
      const { logger } = server.config
      const options = resolveOptions(logger)
      assertSettingsOutsideServedFolders(options.settingsFile, [...server.config.server.fs.allow, server.config.root])
      const handler = createDevApiHandler(options)
      server.middlewares.use((req, res, next) => {
        handler(req, res, next).catch(() => failRequest(res, logger))
      })
      server.httpServer?.on('upgrade', refuseApiWebSocket)
      logger.info(`[dev-api] serving /api/* to loopback clients; mods root: ${realFolder(options.modsRoot) ? 'found' : 'missing'}`)
    },
  }
}
