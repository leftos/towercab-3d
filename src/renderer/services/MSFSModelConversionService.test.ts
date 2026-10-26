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
vi.mock('@/utils/tauriApi', () => ({ isTauri: () => false }))
vi.mock('./AircraftDimensionsService', () => ({ aircraftDimensionsService: {} }))

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()

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
})
