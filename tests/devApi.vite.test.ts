import fs, { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, request, type Server } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build, createLogger, createServer, type InlineConfig, resolveConfig, type ViteDevServer } from 'vite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEV_API_MODE, DEV_API_PLUGIN_NAME, devApiPlugin } from '../scripts/dev/devApi'
import { ION_PLACEHOLDER } from '../scripts/dev/settingsView'

const REPO = resolve(__dirname, '..')
const CONFIG_FILE = join(REPO, 'vite.config.ts')
const CLIENT_ION_BRANCH = join(REPO, 'src/renderer/utils/devIonServer.ts')
const SETTINGS = { cesiumIonToken: 'SECRET-ion', imagery: { provider: 'cesium', googleMapsApiKey: 'SECRET-google' } }

let dir: string
let settingsFile: string
let vite: ViteDevServer | undefined
let http: Server | undefined
const savedEnv = { ...process.env }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc3d-devapi-vite-'))
  settingsFile = join(dir, 'global-settings.json')
  writeFileSync(settingsFile, JSON.stringify(SETTINGS))
})

afterEach(async () => {
  await new Promise((done) => (http ? http.close(done) : done(undefined)))
  await vite?.close()
  http = undefined
  vite = undefined
  process.env = { ...savedEnv }
  rmSync(dir, { recursive: true, force: true })
})

/** A middleware-mode Vite server carrying only the dev API plugin, with Vite's own Host check off. */
async function startVite(logger = createLogger('silent')): Promise<number> {
  // The settings file sits beside the served root, never inside it (the plugin refuses that at start).
  const root = join(dir, 'root')
  mkdirSync(root)
  vite = await createServer({
    configFile: false,
    root,
    mode: DEV_API_MODE,
    logLevel: 'silent',
    customLogger: logger,
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, allowedHosts: true, ws: false, fs: { allow: [root] } },
    plugins: [
      devApiPlugin((viteLogger) => ({
        settingsFile,
        modsRoot: null,
        bundledTowerPositionsDir: join(dir, 'none'),
        airportSurfacesFile: join(dir, 'none.gz'),
        fetch: vi.fn<typeof fetch>(),
        logger: viteLogger,
      })),
    ],
  })
  const server = createHttpServer(vite.middlewares)
  http = server
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return (server.address() as AddressInfo).port
}

function get(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
      })
      res.on('end', () => done({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', fail)
    req.end()
  })
}

function pluginNames(config: { plugins: readonly { name: string }[] }): string[] {
  return config.plugins.map((plugin) => plugin.name)
}

describe('devApi', () => {
  it('refusesForeignHostOriginAndNavigation', async () => {
    const port = await startVite()
    const own = `localhost:${port}`
    const sameOrigin = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }
    const cases: [string, string, Record<string, string>, number][] = [
      ['own host', '/api/dev-health', { host: own }, 200],
      ['127.0.0.1 host', '/api/dev-health', { host: `127.0.0.1:${port}` }, 200],
      ['[::1] host', '/api/dev-health', { host: `[::1]:${port}` }, 200],
      ['own origin', '/api/dev-health', { host: own, origin: `http://${own}` }, 200],
      ['rebound name', '/api/dev-health', { host: `evil.example:${port}` }, 403],
      ['LAN literal', '/api/dev-health', { host: `192.168.1.20:${port}` }, 403],
      ['other port', '/api/dev-health', { host: 'localhost:5173' }, 403],
      ['no port', '/api/dev-health', { host: 'localhost' }, 403],
      ['other localhost origin', '/api/dev-health', { host: own, origin: 'http://localhost:3000' }, 403],
      ['foreign origin', '/api/dev-health', { host: own, origin: 'https://evil.example' }, 403],
      ['null origin', '/api/dev-health', { host: own, origin: 'null' }, 403],
      ['settings, same origin', '/api/global-settings', { host: own, ...sameOrigin }, 200],
      ['settings, no fetch metadata', '/api/global-settings', { host: own }, 403],
      ['settings, cross-site', '/api/global-settings', { host: own, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }, 403],
      ['settings, same-site', '/api/global-settings', { host: own, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' }, 403],
      ['settings, navigation', '/api/global-settings', { host: own, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' }, 403],
      ['settings, foreign host', '/api/global-settings', { host: `evil.example:${port}`, ...sameOrigin }, 403],
    ]
    for (const [name, path, headers, status] of cases) {
      const reply = await get(port, path, headers)
      expect({ name, status: reply.status }).toEqual({ name, status })
      if (status !== 200) expect(reply.body).not.toMatch(/SECRET-|placeholder/)
    }
  })

  it('corruptSettingsNeverReachViteLoggerOrHmr', async () => {
    const logger = createLogger('silent')
    const logged = [vi.spyOn(logger, 'info'), vi.spyOn(logger, 'warn'), vi.spyOn(logger, 'error'), vi.spyOn(logger, 'warnOnce')]
    const port = await startVite(logger)
    const sends = [vi.spyOn(vite!.environments.client.hot, 'send'), vi.spyOn(vite!.ws, 'send')]
    writeFileSync(settingsFile, '{"cesiumIonToken":"SECRET-ion","imagery":')
    const reply = await get(port, '/api/global-settings', {
      host: `localhost:${port}`,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
    })
    expect(reply.status).toBe(500)
    expect(reply.body).not.toMatch(/SECRET-|Unexpected|JSON|tc3d-devapi/)
    for (const spy of sends) expect(spy).not.toHaveBeenCalled()
    expect(JSON.stringify(logged.map((spy) => spy.mock.calls))).not.toMatch(/SECRET-|Unexpected/)
  })

  it('configLoadReadsNoSettings', async () => {
    process.env.TC3D_SETTINGS_FILE = settingsFile
    process.env.TC3D_MODS_DIR = dir
    // The bundled config imports `node:fs` as an ES module, so the spies are pushed into its bindings.
    const syncRead = vi.spyOn(fs, 'readFileSync')
    const asyncRead = vi.spyOn(fs.promises, 'readFile')
    syncBuiltinESMExports()
    let readPaths: string[]
    let config: Awaited<ReturnType<typeof resolveConfig>>
    try {
      config = await resolveConfig({ configFile: CONFIG_FILE, mode: DEV_API_MODE, logLevel: 'silent' }, 'serve')
    } finally {
      readPaths = [...syncRead.mock.calls, ...asyncRead.mock.calls].map(([path]) => String(path))
      syncRead.mockRestore()
      asyncRead.mockRestore()
      syncBuiltinESMExports()
    }
    expect(readPaths.length).toBeGreaterThan(0)
    expect(readPaths.filter((path) => resolve(path).toLowerCase() === settingsFile.toLowerCase())).toEqual([])
    expect(pluginNames(config)).toContain(DEV_API_PLUGIN_NAME)
    const seen = new WeakSet<object>()
    const text = JSON.stringify(config, (_key, value: unknown) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return undefined
        seen.add(value)
      }
      return typeof value === 'function' ? undefined : value
    })
    expect(text).not.toMatch(/SECRET-/)
    expect(JSON.stringify(config.define)).not.toMatch(/SECRET-|cesiumIonToken/)
    expect(Object.keys(config.env).filter((key) => /ION|TOKEN|SECRET/i.test(key))).toEqual([])
  })

  it('settingsFileInsideServedFoldersRefusedAtStart', async () => {
    process.env.TC3D_MODS_DIR = dir
    const startHeadless = () =>
      createServer({
        configFile: CONFIG_FILE,
        mode: DEV_API_MODE,
        logLevel: 'silent',
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { middlewareMode: true, ws: false, watch: null },
      })
    mkdirSync(join(REPO, '.tmp'), { recursive: true })
    const inTree = mkdtempSync(join(REPO, '.tmp', 'tc3d-devapi-served-'))
    try {
      const inside = join(inTree, 'global-settings.json')
      writeFileSync(inside, JSON.stringify(SETTINGS))
      process.env.TC3D_SETTINGS_FILE = inside
      const failure = await startHeadless().then(
        (server) => {
          vite = server
          return 'started'
        },
        (error: unknown) => String(error),
      )
      expect(failure).toMatch(/TC3D_SETTINGS_FILE/)
      expect(failure).not.toMatch(/SECRET-/)
      await vite?.close()
      vite = undefined
    } finally {
      rmSync(inTree, { recursive: true, force: true })
    }

    process.env.TC3D_SETTINGS_FILE = settingsFile
    vite = await startHeadless()
    expect(pluginNames(vite.config)).toContain(DEV_API_PLUGIN_NAME)
  })

  it('offWithoutOptIn', async () => {
    const serveDefault = await resolveConfig({ configFile: CONFIG_FILE, logLevel: 'silent' }, 'serve')
    expect(pluginNames(serveDefault)).not.toContain(DEV_API_PLUGIN_NAME)
    expect(serveDefault.server.port).toBe(5173)
    const buildHeadless = await resolveConfig({ configFile: CONFIG_FILE, mode: DEV_API_MODE, logLevel: 'silent' }, 'build')
    expect(pluginNames(buildHeadless)).not.toContain(DEV_API_PLUGIN_NAME)
    const serveHeadless = await resolveConfig({ configFile: CONFIG_FILE, mode: DEV_API_MODE, logLevel: 'silent' }, 'serve')
    expect(pluginNames(serveHeadless)).toContain(DEV_API_PLUGIN_NAME)

    const scripts = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> })
      .scripts
    expect(scripts['vite:headless']).toBe(`vite --mode ${DEV_API_MODE} --port 5174 --strictPort`)
    for (const name of ['dev', 'vite:dev', 'serve', 'dev:server']) {
      expect({ name, script: scripts[name] }).not.toEqual({ name, script: expect.stringContaining(DEV_API_MODE) })
    }
  })

  it(
    'absentFromBuild',
    async () => {
      const clientSource = readFileSync(CLIENT_ION_BRANCH, 'utf8')
      expect(clientSource).toContain(ION_PLACEHOLDER)
      expect(clientSource).toContain('/api/ion/')
      // Vitest sets NODE_ENV=test, which Vite would keep, building with import.meta.env.DEV on.
      process.env.NODE_ENV = 'production'
      const outDir = join(dir, 'build')
      const inline: InlineConfig = {
        configFile: CONFIG_FILE,
        mode: 'production',
        logLevel: 'silent',
        publicDir: false,
        build: { outDir, emptyOutDir: true },
      }
      await build(inline)
      const emitted = readdirSync(outDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.(js|html|css|txt)$/.test(entry.name))
        .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
      expect(emitted.length).toBeGreaterThan(0)
      for (const marker of [ION_PLACEHOLDER, '/api/ion/', 'api/dev-health', 'TC3D_SETTINGS_FILE']) {
        expect({ marker, found: emitted.some((text) => text.includes(marker)) }).toEqual({ marker, found: false })
      }
    },
    300_000,
  )
})
