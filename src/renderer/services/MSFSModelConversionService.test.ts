import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SourceModelInfo } from './MSFSModelConversionService'

const settings = {
  cacheDirectory: 'C:/cache' as string | null,
  textureScale: '1k',
  cacheLimitMB: null,
}

vi.mock('@/stores/globalSettingsStore', () => ({
  useGlobalSettingsStore: { getState: () => ({ msfsModels: settings }) },
}))
const host = vi.hoisted(() => ({
  isTauri: false,
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}))

vi.mock('@/utils/tauriApi', () => ({ isTauri: () => host.isTauri }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: host.invoke }))
vi.mock('./AircraftDimensionsService', () => ({ aircraftDimensionsService: {} }))

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()

/** The service's private loaders the tests drive */
interface ServiceLoaders {
  loadCachedModels(cacheDir: string): Promise<void>
  fetchRemoteModelIndex(): Promise<void>
}

function loaders(service: unknown): ServiceLoaders {
  return service as ServiceLoaders
}

/** What the host's cache scan lists for one GLB */
function scanned(fileName: string, modelKey: string | null, converterVersion: number | null) {
  return {
    path: `C:/cache/${fileName}`,
    model_key: modelKey,
    file_name: fileName,
    file_size: 2048,
    converter_version: converterVersion,
  }
}

const CURRENT_VERSION = 9

function model(name: string): SourceModelInfo {
  const folder = 'C:/Community/fsltl-traffic-base/SimObjects/Airplanes/FSLTL_B738_ZZZZ'
  return {
    source: 'fsltl',
    modelName: name,
    folderName: 'FSLTL_B738_ZZZZ',
    aircraftFolderPath: folder,
    gltfPath: `${folder}/model/B738.gltf`,
    textureDirs: [`${folder}/texture.AAL`],
    aircraftType: 'B738',
    airlineCode: 'AAL',
    atcId: null,
  }
}

function converted(name: string): Response {
  return new Response(JSON.stringify({ success: true, output_path: `fsltl_${name}.glb` }), { status: 200 })
}

function busy(retryAfter: string): Response {
  return new Response(JSON.stringify({ success: false, error: 'busy' }), {
    status: 503,
    headers: { 'Retry-After': retryAfter },
  })
}

/** The private state the tests read */
interface ServiceInternals {
  activeConversions: number
  failedConversions: Set<string>
}

/** A fresh service, so no test sees another's caches or counters */
async function freshService() {
  vi.resetModules()
  const { MSFSModelConversionService } = await import('./MSFSModelConversionService')
  return MSFSModelConversionService
}

function internals(service: unknown): ServiceInternals {
  return service as ServiceInternals
}

describe('MSFSModelConversionService remote conversions', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('returns the active counter to 0 after several remote conversions', async () => {
    const service = await freshService()
    fetchMock.mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model_name: string }
      return converted(body.model_name)
    })

    const results = await Promise.all(['A', 'B', 'C'].map((name) => service.convertModel(model(name))))

    expect(results.every((result) => result.success)).toBe(true)
    expect(internals(service).activeConversions).toBe(0)
  })

  it('retries a refused model after Retry-After, three times, without marking it failed', async () => {
    vi.useFakeTimers()
    const service = await freshService()
    fetchMock.mockImplementation(async () => busy('5'))

    let result: { success: boolean } | undefined
    const pending = service.convertModel(model('Busy')).then((r) => {
      result = r
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10000)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    await pending
    expect(result?.success).toBe(false)

    await vi.advanceTimersByTimeAsync(60000)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(internals(service).failedConversions.has('fsltl_Busy')).toBe(false)
    expect(internals(service).activeConversions).toBe(0)
  })

  it('sends at most one convert request at a time from a remote browser', async () => {
    const service = await freshService()
    let inFlight = 0
    let mostInFlight = 0
    fetchMock.mockImplementation(async (_input, init) => {
      inFlight++
      mostInFlight = Math.max(mostInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 0))
      inFlight--
      const body = JSON.parse(String(init?.body)) as { model_name: string }
      return converted(body.model_name)
    })

    await Promise.all(['P', 'Q', 'R'].map((name) => service.convertModel(model(name))))

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(mostInFlight).toBe(1)
  })

  it('frees the conversion slot while a refused model waits to retry', async () => {
    vi.useFakeTimers()
    const service = await freshService()
    fetchMock.mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model_name: string }
      return body.model_name === 'Refused' ? busy('5') : converted(body.model_name)
    })

    void service.convertModel(model('Refused'))
    const other = service.convertModel(model('Other'))
    await vi.advanceTimersByTimeAsync(0)

    const requested = fetchMock.mock.calls.map(
      ([, init]) => (JSON.parse(String(init?.body)) as { model_name: string }).model_name,
    )
    expect(requested).toEqual(['Refused', 'Other'])
    expect((await other).success).toBe(true)
  })

  it('makes one request for two calls for one model before any await', async () => {
    const service = await freshService()
    fetchMock.mockImplementation(async () => converted('Twice'))

    const first = service.convertModel(model('Twice'))
    const second = service.convertModel(model('Twice'))
    const results = await Promise.all([first, second])

    expect(results.every((result) => result.success)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('loads a converted model from the URL of its file name, keyed by its embedded title', async () => {
    const service = await freshService()
    fetchMock.mockImplementation(async (input) => {
      if (input === '/api/msfs/models') {
        const listed = scanned('fsltl_Some_Title-1a2b3c4d.glb', 'fsltl_Some Title', CURRENT_VERSION)
        const { path: _hostPath, ...remote } = listed
        return new Response(JSON.stringify([remote]), { status: 200 })
      }
      return new Response('', { status: 500 })
    })

    await loaders(service).fetchRemoteModelIndex()

    expect(service.getCachedModel('Some Title', 'fsltl')).toBe('/api/msfs/fsltl_Some_Title-1a2b3c4d.glb')
  })
})

describe('MSFSModelConversionService host cache', () => {
  beforeEach(() => {
    host.isTauri = true
    host.invoke.mockReset()
  })

  afterEach(() => {
    host.isTauri = false
  })

  it('keys a scanned model by its embedded title and loads it from its file', async () => {
    const service = await freshService()
    host.invoke.mockImplementation(async (command) =>
      command === 'scan_cache_directory'
        ? [scanned('fsltl_Some_Title-1a2b3c4d.glb', 'fsltl_Some Title', CURRENT_VERSION)]
        : undefined,
    )

    await loaders(service).loadCachedModels('C:/cache')

    expect(service.getCachedModel('Some Title', 'fsltl')).toBe('C:/cache/fsltl_Some_Title-1a2b3c4d.glb')
    expect(host.invoke).not.toHaveBeenCalledWith('delete_cache_file', expect.anything())
  })

  it('deletes a scanned model of an old converter version or without a key', async () => {
    const service = await freshService()
    const old = scanned('fsltl_Old-00000001.glb', 'fsltl_Old', CURRENT_VERSION - 1)
    const unkeyed = scanned('fsltl_Raw Title.glb', null, null)
    host.invoke.mockImplementation(async (command) => (command === 'scan_cache_directory' ? [old, unkeyed] : undefined))

    await loaders(service).loadCachedModels('C:/cache')

    expect(host.invoke).toHaveBeenCalledWith('delete_cache_file', { path: old.path })
    expect(host.invoke).toHaveBeenCalledWith('delete_cache_file', { path: unkeyed.path })
    expect(service.getCachedModel('Old', 'fsltl')).toBeNull()
  })

  it('finds a converted model on disk by its key without building a file name', async () => {
    const service = await freshService()
    const found = scanned('fsltl_Disk_Model-0badf00d.glb', 'fsltl_Disk Model', CURRENT_VERSION)
    host.invoke.mockImplementation(async (command) => (command === 'find_cached_model' ? found : undefined))

    const result = await service.convertModel(model('Disk Model'))

    expect(result).toEqual({ success: true, glbPath: found.path })
    expect(host.invoke).toHaveBeenCalledWith('find_cached_model', {
      cacheDir: 'C:/cache',
      source: 'fsltl',
      liveryTitle: 'Disk Model',
    })
    expect(host.invoke).not.toHaveBeenCalledWith('file_exists', expect.anything())
    expect(host.invoke).not.toHaveBeenCalledWith('convert_msfs_model', expect.anything())
    expect(service.getCachedModel('Disk Model', 'fsltl')).toBe(found.path)
  })

  it('converts again when the model on disk is of an old converter version', async () => {
    const service = await freshService()
    const outdated = scanned('fsltl_Disk_Model-0badf00d.glb', 'fsltl_Disk Model', CURRENT_VERSION - 1)
    host.invoke.mockImplementation(async (command) => (command === 'find_cached_model' ? outdated : undefined))

    await service.convertModel(model('Disk Model'))

    expect(host.invoke).toHaveBeenCalledWith('convert_msfs_model', expect.anything())
  })
})
