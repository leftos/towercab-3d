import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SourceModelInfo } from '@/services/MSFSModelConversionService'

/**
 * Model cache and closest-search behaviour of AircraftModelService, with the MSFS
 * services' index seeded in memory: no Community folder, no real conversion.
 */

const invoke = vi.hoisted(() => vi.fn<(command: string, args?: unknown) => Promise<SourceModelInfo[]>>())

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }))

// The services read the page origin and dispatch window events; node has neither.
vi.stubGlobal('window', {
  location: { origin: 'http://localhost:8765' },
  dispatchEvent: () => true,
})

const realFetch = globalThis.fetch

type IndexInternals = {
  fsltlModels: Map<string, SourceModelInfo>
  aigModels: Map<string, SourceModelInfo>
  buildFsltlIndex: (path: string) => Promise<void>
  buildAigIndex: (path: string) => Promise<void>
}

type DimensionsInternals = { dimensions: Map<string, { wingspan: number; length: number }> }

let aircraftModelService: (typeof import('@/services/AircraftModelService'))['aircraftModelService']
let msfs: (typeof import('@/services/MSFSModelConversionService'))['MSFSModelConversionService']
let dimensions: (typeof import('@/services/AircraftDimensionsService'))['aircraftDimensionsService']

/** Build an indexed source model; the conversion fields are irrelevant to matching. */
function sourceModel(overrides: Partial<SourceModelInfo> & { modelName: string }): SourceModelInfo {
  return {
    source: 'fsltl',
    modelName: overrides.modelName,
    folderName: '',
    aircraftFolderPath: '',
    gltfPath: '',
    textureDirs: [],
    aircraftType: 'C172',
    airlineCode: null,
    atcId: null,
    ...overrides,
  }
}

function indexInternals(): IndexInternals {
  return msfs as unknown as IndexInternals
}

function seedFsltlModels(...models: SourceModelInfo[]): void {
  for (const model of models) indexInternals().fsltlModels.set(model.modelName, model)
}

function seedDimensions(aircraftType: string, wingspan: number, length: number): void {
  const internals = dimensions as unknown as DimensionsInternals
  internals.dimensions.set(aircraftType, { wingspan, length })
}

/** Stub the conversion side of the MSFS service: the named models are already cached as GLBs. */
function stubSourceLookup(cachedModelNames: string[] = []): void {
  vi.spyOn(msfs, 'getCachedModel').mockImplementation((modelName) =>
    cachedModelNames.includes(modelName) ? `C:/cache/${modelName}.glb` : null,
  )
  vi.spyOn(msfs, 'isConverting').mockReturnValue(false)
  vi.spyOn(msfs, 'hasConversionFailed').mockReturnValue(false)
  vi.spyOn(msfs, 'convertModel').mockResolvedValue({ success: true, glbPath: 'C:/cache/unused.glb' })
}

beforeAll(async () => {
  ;({ aircraftModelService } = await import('@/services/AircraftModelService'))
  ;({ MSFSModelConversionService: msfs } = await import('@/services/MSFSModelConversionService'))
  ;({ aircraftDimensionsService: dimensions } = await import('@/services/AircraftDimensionsService'))
})

beforeEach(() => {
  vi.restoreAllMocks()
  invoke.mockReset()
  indexInternals().fsltlModels.clear()
  indexInternals().aigModels.clear()
  ;(dimensions as unknown as DimensionsInternals).dimensions.clear()
  seedDimensions('C172', 11, 8.28)
  seedDimensions('C17X', 11.4, 8.5)
  seedDimensions('B738', 35.78, 39.47)
  aircraftModelService.clearCache()
})

afterEach(() => {
  vi.stubGlobal('fetch', realFetch)
  delete (globalThis.window as unknown as { __TAURI__?: unknown }).__TAURI__
})

describe('AircraftModelService model cache', () => {
  it('registration match is cached per callsign, not per type', () => {
    seedFsltlModels(
      sourceModel({ modelName: 'FSLTL_C172_N100VE', aircraftType: 'C172', airlineCode: null, atcId: 'N100VE' }),
    )
    stubSourceLookup(['FSLTL_C172_N100VE'])

    const registered = aircraftModelService.getModelInfo('C172', 'N100VE')
    expect(registered.matchedModel).toBe('FSLTL_C172_N100VE')

    const other = aircraftModelService.getModelInfo('C172', 'N200XY')
    expect(other.matchedModel).not.toBe('FSLTL_C172_N100VE')
    expect(other.modelUrl).not.toContain('FSLTL_C172_N100VE')
  })

  it('the same registered callsign hits the cache', () => {
    seedFsltlModels(
      sourceModel({ modelName: 'FSLTL_C172_N100VE', aircraftType: 'C172', airlineCode: null, atcId: 'N100VE' }),
    )
    stubSourceLookup(['FSLTL_C172_N100VE'])
    const findModelByCallsign = vi.spyOn(msfs, 'findModelByCallsign')

    const first = aircraftModelService.getModelInfo('C172', 'N100VE')
    const second = aircraftModelService.getModelInfo('C172', 'N100VE')

    expect(findModelByCallsign).toHaveBeenCalledTimes(1)
    expect(second.matchedModel).toBe(first.matchedModel)
  })

  it('findClosestModel skips registered private liveries', () => {
    seedFsltlModels(
      sourceModel({ modelName: 'C172_PRIVATE_N100VE', aircraftType: 'C172', airlineCode: null, atcId: 'N100VE' }),
      sourceModel({ modelName: 'FSLTL_C17X_UAL', aircraftType: 'C17X', airlineCode: 'UAL', atcId: null }),
    )

    const closest = msfs.findClosestModel('C172')

    expect(closest?.model.modelName).toBe('FSLTL_C17X_UAL')
  })

  it('findClosestModel keeps generic null-airline liveries', () => {
    seedFsltlModels(
      sourceModel({ modelName: 'FSLTL_C172_GENERIC', aircraftType: 'C172', airlineCode: null, atcId: null }),
    )

    const closest = msfs.findClosestModel('C172')

    expect(closest?.model.modelName).toBe('FSLTL_C172_GENERIC')
  })

  it('unknown-type airline aircraft checks the cache before scanning', () => {
    seedFsltlModels(
      sourceModel({ modelName: 'FSLTL_B738_UAL', aircraftType: 'B738', airlineCode: 'UAL', atcId: null }),
    )
    stubSourceLookup(['FSLTL_B738_UAL'])
    const findAirlineFallbackModel = vi.spyOn(msfs, 'findAirlineFallbackModel')

    const first = aircraftModelService.getModelInfo(null, 'UAL123')
    const second = aircraftModelService.getModelInfo(null, 'UAL123')

    expect(findAirlineFallbackModel).toHaveBeenCalledTimes(1)
    expect(first.matchedModel).toBe('FSLTL_B738_UAL')
    expect(second.matchedModel).toBe('FSLTL_B738_UAL')
  })

  it('unknown-type airline with no fallback model does not rescan', () => {
    stubSourceLookup()
    const findAirlineFallbackModel = vi.spyOn(msfs, 'findAirlineFallbackModel').mockReturnValue(null)

    const first = aircraftModelService.getModelInfo(null, 'UAL123')
    const second = aircraftModelService.getModelInfo(null, 'UAL123')

    expect(findAirlineFallbackModel).toHaveBeenCalledTimes(1)
    expect(first.matchType).toBe('fallback')
    expect(first.modelUrl).toBe('./b738.glb')
    expect(second.modelUrl).toBe(first.modelUrl)
  })

  it('remote index reload clears the model cache', async () => {
    const findModelByTypeAndAirline = vi.spyOn(msfs, 'findModelByTypeAndAirline')

    aircraftModelService.getModelInfo('A320', 'UAL123')
    expect(findModelByTypeAndAirline).toHaveBeenCalledTimes(1)

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input)
        if (url.endsWith('/api/msfs/index')) {
          return { ok: true, json: async () => ({ fsltl: [], aig: [], totalCount: 0 }) }
        }
        if (url.endsWith('/api/msfs/models')) {
          return { ok: true, json: async () => [] }
        }
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )
    await msfs.initialize()

    aircraftModelService.getModelInfo('A320', 'UAL123')
    expect(findModelByTypeAndAirline).toHaveBeenCalledTimes(2)
  })

  it('desktop index load clears the model cache', async () => {
    invoke.mockImplementation(async (command) =>
      command === 'list_aig_models'
        ? [sourceModel({ modelName: 'AIG_C172_INDEXED', aircraftType: 'C172', source: 'aig' })]
        : [sourceModel({ modelName: 'FSLTL_C172_INDEXED', aircraftType: 'C172' })],
    )
    ;(globalThis.window as unknown as { __TAURI__?: unknown }).__TAURI__ = {}
    const findModelByTypeAndAirline = vi.spyOn(msfs, 'findModelByTypeAndAirline')

    aircraftModelService.getModelInfo('A320', 'UAL123')
    expect(findModelByTypeAndAirline).toHaveBeenCalledTimes(1)

    await indexInternals().buildFsltlIndex('C:/Community/fsltl-traffic-base')
    aircraftModelService.getModelInfo('A320', 'UAL123')
    expect(findModelByTypeAndAirline).toHaveBeenCalledTimes(2)

    await indexInternals().buildAigIndex('C:/Community/aig-aitraffic-oci')
    aircraftModelService.getModelInfo('A320', 'UAL123')
    expect(findModelByTypeAndAirline).toHaveBeenCalledTimes(3)
  })
})
