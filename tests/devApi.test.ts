import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from 'node:http'
import { type AddressInfo, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDevApiHandler, type DevApiOptions, refuseApiWebSocket } from '../scripts/dev/devApi'
import { devSettingsView, ION_PLACEHOLDER, remoteView } from '../scripts/dev/settingsView'

const STORED_SETTINGS = {
  cesiumIonToken: 'SECRET-ion',
  renderingBackend: 'd3d11',
  imagery: { provider: 'cesium', googleMapsApiKey: 'SECRET-google' },
  realtraffic: { dataSource: 'vatsim', licenseKey: 'SECRET-rt', radiusNm: 50, maxParkedAircraft: 50 },
  server: { port: 8765, enabled: false, allowNonLocalClients: false, minimizeToTray: true },
  vnasTokens: 'SECRET-vnas',
}

interface Fixture {
  dir: string
  settingsFile: string
  modsRoot: string
  outside: string
  bundledTowerPositionsDir: string
  airportSurfacesFile: string
}

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

type FetchSpy = ReturnType<typeof vi.fn<typeof fetch>>

let fixture: Fixture
let servers: Server[] = []

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'tc3d-devapi-'))
  const settingsFile = join(dir, 'global-settings.json')
  writeFileSync(settingsFile, JSON.stringify(STORED_SETTINGS))

  const modsRoot = join(dir, 'mods')
  const tower = join(modsRoot, 'towers', 'KOAK')
  mkdirSync(tower, { recursive: true })
  writeFileSync(join(tower, 'manifest.json'), JSON.stringify({ type: 'tower', airports: ['KOAK'] }))
  writeFileSync(join(tower, 'model.glb'), 'glb-bytes')
  writeFileSync(join(tower, 'notes.txt'), 'notes')
  const repo = join(modsRoot, 'tc3d-mod-ksfo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]')
  mkdirSync(join(repo, 'tower', 'KSFO'), { recursive: true })
  writeFileSync(join(repo, 'tower', 'KSFO', 'manifest.json'), JSON.stringify({ airports: ['KSFO'] }))
  mkdirSync(join(modsRoot, 'tower-positions'), { recursive: true })
  writeFileSync(join(modsRoot, 'tower-positions', 'koak.json'), JSON.stringify({ source: 'user' }))
  writeFileSync(join(modsRoot, 'tower-positions.json'), JSON.stringify({ ksjc: { source: 'legacy' } }))

  const outside = join(dir, 'outside')
  mkdirSync(join(outside, 'evil'), { recursive: true })
  writeFileSync(join(outside, 'secret.json'), '{"outside":"OUTSIDE-SECRET"}')
  writeFileSync(join(outside, 'evil', 'manifest.json'), JSON.stringify({ type: 'aircraft' }))
  symlinkSync(outside, join(modsRoot, 'towers', 'link'), 'junction')
  const gone = join(dir, 'gone')
  mkdirSync(gone)
  symlinkSync(gone, join(modsRoot, 'towers', 'dangling'), 'junction')
  rmSync(gone, { recursive: true })

  const bundledTowerPositionsDir = join(dir, 'bundled-tower-positions')
  mkdirSync(bundledTowerPositionsDir)
  writeFileSync(join(bundledTowerPositionsDir, 'KOAK.json'), JSON.stringify({ source: 'bundled' }))
  writeFileSync(join(bundledTowerPositionsDir, 'KSJC.json'), JSON.stringify({ source: 'bundled' }))
  writeFileSync(join(bundledTowerPositionsDir, 'KLAX.json'), JSON.stringify({ source: 'bundled' }))

  const airportSurfacesFile = join(dir, 'airport-surfaces.json.gz')
  writeFileSync(airportSurfacesFile, gzipSync(JSON.stringify({ KOAK: [] })))

  return { dir, settingsFile, modsRoot, outside, bundledTowerPositionsDir, airportSurfacesFile }
}

function silentLogger() {
  return { info: vi.fn<(msg: string) => void>(), warn: vi.fn<(msg: string) => void>(), error: vi.fn<(msg: string) => void>() }
}

function fetchSpy(reply: () => Response = () => new Response('{}', { status: 200 })): FetchSpy {
  return vi.fn<typeof fetch>(async () => reply())
}

function options(overrides: Partial<DevApiOptions> = {}): DevApiOptions {
  return {
    settingsFile: fixture.settingsFile,
    modsRoot: fixture.modsRoot,
    bundledTowerPositionsDir: fixture.bundledTowerPositionsDir,
    airportSurfacesFile: fixture.airportSurfacesFile,
    fetch: fetchSpy(),
    logger: silentLogger(),
    ...overrides,
  }
}

async function listen(opts: DevApiOptions): Promise<number> {
  const handler = createDevApiHandler(opts)
  const server = createServer((req, res) => {
    void handler(req, res, () => {
      res.statusCode = 299
      res.end('next')
    })
  })
  server.on('upgrade', refuseApiWebSocket)
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return (server.address() as AddressInfo).port
}

function send(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  // An explicit length frames the body for every method (Node sends a DELETE body unframed otherwise).
  const length: Record<string, string> = init.body === undefined ? {} : { 'content-length': String(Buffer.byteLength(init.body)) }
  return new Promise((done, fail) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: init.method ?? 'GET',
        headers: { host: `localhost:${port}`, ...length, ...init.headers },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body }))
      },
    )
    req.on('error', fail)
    req.end(init.body)
  })
}

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }

/** A request object as the handler sees it, from any socket address. */
function fakeRequest(remoteAddress: string, path: string, headers: Record<string, string> = {}): IncomingMessage {
  return {
    method: 'GET',
    url: path,
    headers: { host: 'localhost:5174', ...headers },
    socket: { remoteAddress, localPort: 5174 },
  } as unknown as IncomingMessage
}

function fakeResponse() {
  const reply = {
    statusCode: 200,
    headersSent: false,
    headers: {} as Record<string, string>,
    body: '',
    setHeader(name: string, value: string | number) {
      reply.headers[name.toLowerCase()] = String(value)
    },
    end(chunk?: string) {
      reply.body += chunk ?? ''
      reply.headersSent = true
    },
  }
  return reply
}

function fileState(path: string): { hash: string; mtimeMs: number } {
  return { hash: createHash('sha256').update(readFileSync(path)).digest('hex'), mtimeMs: statSync(path).mtimeMs }
}

function allLoggedText(logger: ReturnType<typeof silentLogger>): string {
  return [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls].flat().join('\n')
}

beforeEach(() => {
  fixture = makeFixture()
})

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))))
  servers = []
  rmSync(fixture.dir, { recursive: true, force: true })
})

describe('devApi', () => {
  it('refusesNonLoopbackSocket', async () => {
    const handler = createDevApiHandler(options())
    const cases: [string, number][] = [
      ['127.0.0.1', 200],
      ['127.9.8.7', 200],
      ['::1', 200],
      ['::ffff:127.0.0.1', 200],
      ['192.168.1.20', 403],
      ['10.0.0.5', 403],
      ['172.16.0.1', 403],
      ['169.254.1.1', 403],
      ['8.8.8.8', 403],
      ['fe80::1', 403],
      ['fc00::1', 403],
      ['::ffff:192.168.1.20', 403],
      ['', 403],
    ]
    for (const [address, status] of cases) {
      const res = fakeResponse()
      const next = vi.fn()
      await handler(fakeRequest(address, '/api/dev-health'), res as unknown as ServerResponse, next)
      expect({ address, status: res.statusCode }).toEqual({ address, status })
      expect(next).not.toHaveBeenCalled()
    }

    const spoofed = fakeResponse()
    await handler(
      fakeRequest('192.168.1.20', '/api/dev-health', { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' }),
      spoofed as unknown as ServerResponse,
      vi.fn(),
    )
    expect(spoofed.statusCode).toBe(403)
  })

  it('writesNeverTouchSettingsFile', async () => {
    const logger = silentLogger()
    const port = await listen(options({ logger }))
    const before = fileState(fixture.settingsFile)
    const listingBefore = readdirSync(fixture.dir).sort()
    const modsListingBefore = readdirSync(join(fixture.modsRoot, 'tower-positions')).sort()
    const posted = JSON.stringify({ ...STORED_SETTINGS, cesiumIonToken: 'SECRET-posted' })
    const json = { 'content-type': 'application/json' }

    const save = await send(port, '/api/global-settings', {
      method: 'POST',
      headers: { ...json, ...SAME_ORIGIN },
      body: posted,
    })
    expect(save.status).toBe(204)
    expect(save.body).toBe('')
    expect((await send(port, '/api/log', { method: 'POST', headers: json, body: '[{"msg":"SECRET-log"}]' })).status).toBe(
      204,
    )
    for (const [method, path] of [
      ['POST', '/api/diagnostic'],
      ['PUT', '/api/tower-positions/KOAK'],
      ['POST', '/api/msfs/convert'],
      ['DELETE', '/api/global-settings'],
      ['POST', '/api/mods/discover'],
    ]) {
      const reply = await send(port, path, { method, headers: { ...json, ...SAME_ORIGIN }, body: posted })
      expect({ method, path, status: reply.status }).toEqual({ method, path, status: 405 })
      expect(reply.headers['content-type']).toMatch(/application\/json/)
    }

    expect(fileState(fixture.settingsFile)).toEqual(before)
    expect(readdirSync(fixture.dir).sort()).toEqual(listingBefore)
    expect(readdirSync(join(fixture.modsRoot, 'tower-positions')).sort()).toEqual(modsListingBefore)
    expect(allLoggedText(logger)).not.toMatch(/SECRET-/)
  })

  it('settingsViewDropsUnknownPathBlockFields', () => {
    const view = remoteView({
      ...STORED_SETTINGS,
      fsltl: {
        textureScale: '2k',
        enableFsltlModels: true,
        sourcePath: 'D:/TC3D-HOST/fsltl',
        outputPath: 'D:/TC3D-HOST/out',
        surprisePath: 'D:/TC3D-HOST/surprise',
      },
      msfsModels: {
        enableFsltl: true,
        enableAig: true,
        priority: ['fsltl', 'aig'],
        cacheLimitMB: 5120,
        textureScale: '1k',
        skipGenericVmrMatches: false,
        communityPath: 'D:/TC3D-HOST/Community',
        cacheDirectory: 'D:/TC3D-HOST/cache',
        vmrFiles: ['D:/TC3D-HOST/rules.vmr'],
        surpriseDirectory: 'D:/TC3D-HOST/surprise-cache',
      },
    })
    expect(view.fsltl).toEqual({
      textureScale: '2k',
      enableFsltlModels: true,
      sourcePath: null,
      outputPath: null,
    })
    expect(view.msfsModels).toEqual({
      enableFsltl: true,
      enableAig: true,
      priority: ['fsltl', 'aig'],
      cacheLimitMB: 5120,
      textureScale: '1k',
      skipGenericVmrMatches: false,
      communityPath: null,
      cacheDirectory: null,
      vmrFiles: [],
    })
    expect(JSON.stringify(view)).not.toMatch(/TC3D-HOST/)
  })

  it('settingsViewSendsDisabledModsAsIds', () => {
    const view = remoteView({
      ...STORED_SETTINGS,
      disabledMods: [
        'C:\\TC3D-HOST\\app\\mods\\aircraft\\B738',
        '\\\\?\\D:\\TC3D-HOST\\mods\\towers\\KOAK\\KOAK',
        '\\\\srv\\share\\TC3D-HOST\\Mods\\Aircraft\\A320',
        '/applications/towercab 3d.app/contents/resources/mods/aircraft/e170',
        'unc/srv/share/tc3d-host/mods/towers/kjfk',
        'C:/TC3D-HOST/mods/repo/mods/KSFO',
        'mods/Aircraft/C172',
        'mods/aircraft/c172',
        'c:/tc3d-host/app/mods/aircraft/b738',
        'C:/TC3D-HOST/mods/aircraft/../b738',
        'mods/./b738',
        'D:\\TC3D-HOST\\models\\B738',
        'aircraft/B738',
      ],
    })
    expect(view.disabledMods).toEqual([
      'mods/aircraft/b738',
      'mods/towers/koak/koak',
      'mods/aircraft/a320',
      'mods/aircraft/e170',
      'mods/towers/kjfk',
      'mods/ksfo',
      'mods/aircraft/c172',
    ])
    expect(JSON.stringify(view)).not.toMatch(/TC3D-HOST/i)
  })

  it('settingsViewHoldsOnlyIonToken', async () => {
    const parity = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/remote-view.json'), 'utf8')) as {
      secretPaths: string[]
      cases: { name: string; input: Record<string, unknown>; expected: Record<string, unknown> }[]
    }
    expect(parity.secretPaths).toEqual(['cesiumIonToken', 'imagery.googleMapsApiKey', 'realtraffic.licenseKey', 'vnasTokens'])
    expect(parity.cases).toHaveLength(2)
    for (const { name, input, expected } of parity.cases) {
      expect({ name, view: remoteView(input) }).toEqual({ name, view: expected })
      // The one documented difference from the desktop server: the ion token becomes a placeholder.
      expect({ name, view: devSettingsView(input) }).toEqual({ name, view: { ...expected, cesiumIonToken: ION_PLACEHOLDER } })
      const google = (input.imagery as { provider: string }).provider === 'google'
      const markers = JSON.stringify(devSettingsView(input)).match(/SECRET-[a-z]+/g) ?? []
      expect({ name, markers }).toEqual({ name, markers: google ? ['SECRET-google'] : [] })
    }

    expect(devSettingsView({ ...STORED_SETTINGS, cesiumIonToken: '' }).cesiumIonToken).toBe('')
    expect(devSettingsView({ ...STORED_SETTINGS, surprise: 'SECRET-unknown' })).not.toHaveProperty('surprise')

    const port = await listen(options())
    const reply = await send(port, '/api/global-settings', { headers: SAME_ORIGIN })
    expect(reply.status).toBe(200)
    expect(reply.headers['cache-control']).toBe('no-store')
    expect(reply.body).not.toMatch(/SECRET-/)
    expect(JSON.parse(reply.body)).toMatchObject({
      cesiumIonToken: ION_PLACEHOLDER,
      imagery: { provider: 'cesium', googleMapsApiKey: '' },
      realtraffic: { licenseKey: '', radiusNm: 50 },
      server: { port: 8765 },
    })
    expect(JSON.parse(reply.body)).not.toHaveProperty('vnasTokens')

    writeFileSync(fixture.settingsFile, JSON.stringify({ ...STORED_SETTINGS, imagery: { provider: 'google', googleMapsApiKey: 'SECRET-google' } }))
    const google = await send(port, '/api/global-settings', { headers: SAME_ORIGIN })
    expect(JSON.parse(google.body).imagery.googleMapsApiKey).toBe('SECRET-google')
    expect(google.body.match(/SECRET-[a-z]+/g)).toEqual(['SECRET-google'])

    rmSync(fixture.settingsFile)
    const missing = await send(port, '/api/global-settings', { headers: SAME_ORIGIN })
    expect(missing.status).toBe(200)
    expect(JSON.parse(missing.body)).toEqual({ cesiumIonToken: '' })
  })

  it('corruptSettingsGivesGenericError', async () => {
    const logger = silentLogger()
    const port = await listen(options({ logger }))
    const corrupt = [
      '{"cesiumIonToken":"SECRET-ion","imagery":{"provider":',
      `\uFEFF${JSON.stringify(STORED_SETTINGS)}`,
      JSON.stringify({ ...STORED_SETTINGS, cesiumIonToken: ['SECRET-ion'] }),
      JSON.stringify({ ...STORED_SETTINGS, imagery: 'SECRET-google' }),
      JSON.stringify(['SECRET-ion']),
    ]
    const bodies = new Set<string>()
    for (const content of corrupt) {
      writeFileSync(fixture.settingsFile, content)
      const reply = await send(port, '/api/global-settings', { headers: SAME_ORIGIN })
      expect(reply.status).toBe(500)
      expect(reply.headers['cache-control']).toBe('no-store')
      expect(reply.body).not.toMatch(/SECRET-|global-settings|tc3d-devapi/)
      bodies.add(reply.body)
      const health = await send(port, '/api/dev-health')
      expect(JSON.parse(health.body).settings).toBe('unreadable')
    }
    expect(bodies.size).toBe(1)
    expect(allLoggedText(logger)).not.toMatch(/SECRET-|Unexpected|JSON/)
  })

  it('modPathRefusesEscapes', async () => {
    const port = await listen(options())
    const ok = await send(port, '/api/mods/file/towers/KOAK/manifest.json')
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.body)).toEqual({ type: 'tower', airports: ['KOAK'] })
    expect((await send(port, '/api/mods/file/towers%2FKOAK/model.glb')).body).toBe('glb-bytes')
    expect((await send(port, '/api/mods/towers/KOAK/model.glb')).body).toBe('glb-bytes')

    const refused = [
      '/api/mods/file/../outside/secret.json',
      '/api/mods/file/towers/../../outside/secret.json',
      '/api/mods/file/%2e%2e/outside/secret.json',
      '/api/mods/file/..%2Foutside%2Fsecret.json',
      '/api/mods/file/..%5Coutside%5Csecret.json',
      '/api/mods/file/towers\\..\\..\\outside\\secret.json',
      '/api/mods/file/C:/Windows/win.ini',
      '/api/mods/file/C%3A%5CWindows%5Cwin.ini',
      '/api/mods/file//server/share/secret.json',
      '/api/mods/file/%5C%5Cserver%5Cshare%5Csecret.json',
      '/api/mods/file/towers/KOAK/model.glb:stream',
      '/api/mods/file/towers/KOAK/model.glb%3A%3A%24DATA',
      '/api/mods/file/towers/CON.glb',
      '/api/mods/file/towers/con',
      '/api/mods/file/towers/LPT1.json',
      '/api/mods/file/towers/CON%20.glb',
      '/api/mods/file/towers/nul%20%20.json',
      '/api/mods/file/towers/con.',
      '/api/mods/file/tc3d-mod-ksfo/.git/config',
      '/api/mods/file/towers/KOAK/model.glb.',
      '/api/mods/file/towers/KOAK/model.glb%20',
      '/api/mods/file/towers/KOAK/%00model.glb',
      '/api/mods/file/towers/KOAK/model%3F.glb',
      '/api/mods/file/towers/KOAK/notes.txt',
      '/api/mods/file/towers/./KOAK/model.glb',
      '/api/mods/file/towers//KOAK/model.glb',
      '/api/mods/file/%E0%A4%A',
      '/api/mods/file/towers/link/secret.json',
      '/api/mods/aircraft/../towers/KOAK/model.glb',
    ]
    for (const path of refused) {
      const reply = await send(port, path)
      expect({ path, status: reply.status }).toEqual({ path, status: 403 })
      expect(reply.body).not.toMatch(/OUTSIDE-SECRET|remote "origin"/)
    }

    const dangling = await send(port, '/api/mods/file/towers/dangling/secret.json')
    expect([403, 404]).toContain(dangling.status)
    expect((await send(port, '/api/mods/file/towers/KOAK/missing.glb')).status).toBe(404)

    const discovered = JSON.parse((await send(port, '/api/mods/discover')).body)
    expect(discovered).toEqual([
      {
        id: 'mods/tc3d-mod-ksfo/tower/ksfo',
        path: 'mods/tc3d-mod-ksfo/tower/KSFO',
        modType: 'tower',
        isGitRepo: true,
        repoName: 'tc3d-mod-ksfo',
      },
      { id: 'mods/towers/koak', path: 'mods/towers/KOAK', modType: 'tower', isGitRepo: false, repoName: null },
    ])
  })

  it('missingModsRootListsEmpty', async () => {
    for (const modsRoot of [join(fixture.dir, 'no-such-mods'), null]) {
      const port = await listen(options({ modsRoot }))
      const discover = await send(port, '/api/mods/discover')
      expect(discover.status).toBe(200)
      expect(JSON.parse(discover.body)).toEqual([])
      expect((await send(port, '/api/mods/file/towers/KOAK/manifest.json')).status).toBe(404)
      expect(JSON.parse((await send(port, '/api/tower-positions')).body)).toEqual({
        KOAK: { source: 'bundled' },
        KSJC: { source: 'bundled' },
        KLAX: { source: 'bundled' },
      })
      expect(JSON.parse((await send(port, '/api/dev-health')).body).modsRoot).toBe('missing')
    }
  })

  it('towerPositionsAndAirportSurfacesMatchTheDesktopServer', async () => {
    const port = await listen(options())
    expect(JSON.parse((await send(port, '/api/tower-positions')).body)).toEqual({
      KOAK: { source: 'user' },
      KSJC: { source: 'legacy' },
      KLAX: { source: 'bundled' },
    })
    const surfaces = await send(port, '/api/airport-surfaces')
    expect(surfaces.status).toBe(200)
    expect(surfaces.headers['content-type']).toMatch(/application\/json/)
    expect(JSON.parse(surfaces.body)).toEqual({ KOAK: [] })
  })

  it('devHealthReportsOnlyFlags', async () => {
    const port = await listen(options())
    const health = await send(port, '/api/dev-health')
    expect(health.status).toBe(200)
    expect(JSON.parse(health.body)).toEqual({ settings: 'found', ionToken: true, modsRoot: 'found' })
    rmSync(fixture.settingsFile)
    expect(JSON.parse((await send(port, '/api/dev-health')).body)).toEqual({
      settings: 'missing',
      ionToken: false,
      modsRoot: 'found',
    })
  })

  it('proxyRefusesNonMetarUrls', async () => {
    const upstream = fetchSpy(() => new Response('METAR KSFO', { status: 200, headers: { 'content-type': 'text/plain', 'set-cookie': 'a=b' } }))
    const port = await listen(options({ fetch: upstream }))
    const refused = [
      'https://evil.example/',
      'https://aviationweather.gov.evil.example/api/data/metar?ids=KSFO',
      'https://sub.aviationweather.gov/api/data/metar?ids=KSFO',
      'http://aviationweather.gov/api/data/metar?ids=KSFO',
      'https://user:pw@aviationweather.gov/api/data/metar?ids=KSFO',
      'https://aviationweather.gov:8443/api/data/metar?ids=KSFO',
      'https://aviationweather.gov/api/data/taf?ids=KSFO',
      'https://aviationweather.gov/api/data/metar/../taf?ids=KSFO',
      'https://aviationweather.gov/api/data/metar?ids=KSFO&callback=x',
      'https://data.vatsim.net/v3/vatsim-data.json',
      'https://raw.githubusercontent.com/x/y/z.json',
      'not a url',
    ]
    for (const url of refused) {
      const reply = await send(port, `/api/proxy?url=${encodeURIComponent(url)}`)
      expect({ url, status: reply.status }).toEqual({ url, status: 403 })
    }
    expect((await send(port, '/api/proxy')).status).toBe(400)
    expect(upstream).not.toHaveBeenCalled()

    const allowed = 'https://aviationweather.gov/api/data/metar?ids=KSFO,KOAK&format=json'
    const reply = await send(port, `/api/proxy?url=${encodeURIComponent(allowed)}`, {
      headers: { cookie: 'session=1', authorization: 'Bearer x' },
    })
    expect(reply.status).toBe(200)
    expect(reply.body).toBe('METAR KSFO')
    expect(reply.headers['set-cookie']).toBeUndefined()
    expect(upstream).toHaveBeenCalledTimes(1)
    const [target, init] = upstream.mock.calls[0]
    expect(String(target)).toBe(allowed)
    expect(init?.redirect).toBe('manual')
    expect(JSON.stringify(init?.headers ?? {})).not.toMatch(/session|Bearer/)
  })

  it('proxyDoesNotFollowRedirects', async () => {
    const upstream = fetchSpy(() => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }))
    const port = await listen(options({ fetch: upstream }))
    const url = 'https://aviationweather.gov/api/data/metar?ids=KSFO&format=json'
    const reply = await send(port, `/api/proxy?url=${encodeURIComponent(url)}`)
    expect(reply.status).toBe(502)
    expect(reply.headers.location).toBeUndefined()
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(upstream.mock.calls[0][1]?.redirect).toBe('manual')
  })

  it('proxyAnswersOnlyJsonMetarAsJson', async () => {
    const upstream = fetchSpy(() => new Response('<script>alert(1)</script>', { status: 200, headers: { 'content-type': 'text/html' } }))
    const port = await listen(options({ fetch: upstream }))
    const metar = 'https://aviationweather.gov/api/data/metar'
    for (const query of ['ids=KSFO', 'ids=KSFO&format=raw', 'ids=KSFO&format=xml', 'ids=KSFO&format=json&format=html', 'ids=KSFO&format=JSON']) {
      const reply = await send(port, `/api/proxy?url=${encodeURIComponent(`${metar}?${query}`)}`)
      expect({ query, status: reply.status }).toEqual({ query, status: 403 })
    }
    expect(upstream).not.toHaveBeenCalled()

    const reply = await send(port, `/api/proxy?url=${encodeURIComponent(`${metar}?ids=KSFO&format=json`)}`)
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toMatch(/^application\/json/)
    expect(reply.headers['x-content-type-options']).toBe('nosniff')
  })

  it('refusesNavigationAndCrossSiteOnEveryRoute', async () => {
    const port = await listen(options())
    const refused = [
      { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' },
      { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'cross-site' },
    ]
    const routes: [string, number][] = [
      ['/api/dev-health', 200],
      ['/api/mods/discover', 200],
      ['/api/realtraffic/auth', 299],
    ]
    for (const [path, served] of routes) {
      for (const headers of refused) {
        const reply = await send(port, path, { headers })
        expect({ path, headers, status: reply.status }).toEqual({ path, headers, status: 403 })
        expect(reply.headers['content-type']).toMatch(/application\/json/)
      }
      // A request without fetch metadata (Node fetch, curl) is still served.
      expect({ path, status: (await send(port, path)).status }).toEqual({ path, status: served })
    }
    expect((await send(port, '/api/dev-health', { headers: SAME_ORIGIN })).status).toBe(200)
  })

  it('bodyStreamErrorGives500AndServerKeepsAnswering', async () => {
    const logger = silentLogger()
    const handler = createDevApiHandler(options({ logger }))
    const body = Object.assign(new PassThrough(), {
      method: 'POST',
      url: '/api/log',
      headers: { host: 'localhost:5174' },
      socket: { remoteAddress: '10.0.0.5', localPort: 5174 },
    })
    const res = fakeResponse()
    const handled = handler(body as unknown as IncomingMessage, res as unknown as ServerResponse, vi.fn())
    body.write('partial')
    body.destroy(new Error('connection reset'))
    await expect(handled).resolves.toBeUndefined()
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body)).toEqual({ error: 'The dev API failed to answer' })

    const settled: Promise<void>[] = []
    let arrived: () => void = () => {}
    const firstArrived = new Promise<void>((done) => {
      arrived = done
    })
    const real = createDevApiHandler(options({ logger }))
    const server = createServer((req, reply) => {
      settled.push(real(req, reply, () => reply.end()))
      arrived()
    })
    servers.push(server)
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const port = (server.address() as AddressInfo).port
    const socket = connect(port, '127.0.0.1')
    socket.on('error', () => {})
    socket.write(`POST /api/log HTTP/1.1\r\nHost: evil.example:${port}\r\nContent-Length: 1000\r\n\r\npartial`)
    await firstArrived
    socket.destroy()
    await expect(settled[0]).resolves.toBeUndefined()
    expect((await send(port, '/api/dev-health')).status).toBe(200)
    expect(allLoggedText(logger)).not.toMatch(/evil|partial|SECRET-/)
  })

  it('modSubfolderRoutesStayInTheirSubfolder', async () => {
    mkdirSync(join(fixture.modsRoot, 'aircraft', 'A320'), { recursive: true })
    writeFileSync(join(fixture.modsRoot, 'aircraft', 'A320', 'model.glb'), 'a320-bytes')
    const port = await listen(options())
    expect((await send(port, '/api/mods/aircraft/A320/model.glb')).body).toBe('a320-bytes')
    for (const path of [
      '/api/mods/aircraft/..%2Ftowers%2FKOAK%2Fmodel.glb',
      '/api/mods/aircraft/../towers/KOAK/model.glb',
      '/api/mods/aircraft/..%5Ctowers%5CKOAK%5Cmodel.glb',
    ]) {
      expect({ path, status: (await send(port, path)).status }).toEqual({ path, status: 403 })
    }

    // A subfolder that is itself a link out of the mods root serves nothing from where it leads.
    rmSync(join(fixture.modsRoot, 'aircraft'), { recursive: true })
    symlinkSync(fixture.outside, join(fixture.modsRoot, 'aircraft'), 'junction')
    const linked = await send(port, '/api/mods/aircraft/secret.json')
    expect(linked.status).toBe(403)
    expect(linked.body).not.toContain('OUTSIDE-SECRET')
  })

  it('towerPositionsSkipLinksOutOfTheModsRoot', async () => {
    rmSync(join(fixture.modsRoot, 'tower-positions'), { recursive: true })
    symlinkSync(fixture.outside, join(fixture.modsRoot, 'tower-positions'), 'junction')
    const port = await listen(options())
    const reply = await send(port, '/api/tower-positions')
    expect(reply.body).not.toContain('OUTSIDE-SECRET')
    expect(JSON.parse(reply.body)).toEqual({
      KOAK: { source: 'bundled' },
      KSJC: { source: 'legacy' },
      KLAX: { source: 'bundled' },
    })
  })

  it('ionForwarderAddsTheTokenOnlyUpstream', async () => {
    const logger = silentLogger()
    const endpoint = { type: 'TERRAIN', url: 'https://assets.ion.cesium.com/1/', accessToken: 'per-asset-token' }
    const upstream = fetchSpy(() => new Response(JSON.stringify(endpoint), { status: 200, headers: { 'content-type': 'application/json' } }))
    const port = await listen(options({ fetch: upstream, logger }))

    const reply = await send(port, `/api/ion/v1/assets/1/endpoint?access_token=${ION_PLACEHOLDER}&v=2`, { headers: SAME_ORIGIN })
    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body)).toEqual(endpoint)
    expect(reply.headers['cache-control']).toBe('no-store')
    const [target, init] = upstream.mock.calls[0]
    expect(String(target)).toBe('https://api.cesium.com/v1/assets/1/endpoint?v=2')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer SECRET-ion')
    expect(init?.redirect).toBe('manual')
    expect(allLoggedText(logger)).not.toMatch(/SECRET-/)

    expect((await send(port, '/api/ion/v1/assets/1/endpoint')).status).toBe(403)
    for (const path of ['/api/ion/v1/me', '/api/ion/v1/assets/1a/endpoint', '/api/ion/v1/assets/1/endpoint/x', '/api/ion/']) {
      const other = await send(port, path, { headers: SAME_ORIGIN })
      expect({ path, status: other.status }).toEqual({ path, status: 404 })
    }
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('ionForwarderPassesRefusalsAndHidesAnEchoedToken', async () => {
    let body = '{"code":"InvalidCredentials","message":"Invalid access token"}'
    let status = 401
    const upstream = fetchSpy(() => new Response(body, { status, headers: { 'content-type': 'application/json' } }))
    const port = await listen(options({ fetch: upstream }))
    const path = '/api/ion/v1/assets/2/endpoint'

    const refused = await send(port, path, { headers: SAME_ORIGIN })
    expect(refused.status).toBe(401)
    expect(JSON.parse(refused.body).code).toBe('InvalidCredentials')

    body = '{"message":"token SECRET-ion is invalid"}'
    status = 400
    const echoed = await send(port, path, { headers: SAME_ORIGIN })
    expect(echoed.status).toBe(502)
    expect(echoed.body).not.toMatch(/SECRET-/)

    writeFileSync(fixture.settingsFile, JSON.stringify({ ...STORED_SETTINGS, cesiumIonToken: '' }))
    const calls = upstream.mock.calls.length
    expect((await send(port, path, { headers: SAME_ORIGIN })).status).toBe(401)
    expect(upstream).toHaveBeenCalledTimes(calls)
  })

  it('unknownApiIs404AndRealtrafficPassesThrough', async () => {
    const port = await listen(options())
    for (const path of ['/api/nope', '/api/vmr-rules', '/api/msfs/index', '/api/mods/aircraft', '/api']) {
      const reply = await send(port, path)
      expect({ path, status: reply.status }).toEqual({ path, status: 404 })
      expect(reply.headers['content-type']).toMatch(/application\/json/)
    }
    const traffic = await send(port, '/api/realtraffic/auth', { method: 'POST', body: '{}' })
    expect(traffic.status).toBe(299)
    expect((await send(port, '/index.html')).status).toBe(299)
    expect((await send(port, '/apix')).status).toBe(299)

    const handler = createDevApiHandler(options())
    const next = vi.fn()
    const res = fakeResponse()
    await handler(fakeRequest('10.0.0.5', '/api/realtraffic/auth'), res as unknown as ServerResponse, next)
    expect(res.statusCode).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('refusesApiWebSockets', async () => {
    const port = await listen(options())
    for (const path of ['/api/observations/ws', '/api/presence']) {
      const outcome = await new Promise<string>((done) => {
        const req = request({
          host: '127.0.0.1',
          port,
          path,
          headers: { host: `localhost:${port}`, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
        })
        req.on('upgrade', () => done('upgraded'))
        req.on('response', (res) => done(`response ${res.statusCode}`))
        req.on('error', () => done('closed'))
        req.end()
      })
      expect({ path, outcome }).toEqual({ path, outcome: 'closed' })
    }
  })
})
