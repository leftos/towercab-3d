import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AircraftModManifest, TowerModManifest } from '../src/renderer/types/mod'
import type { DiscoveredMod } from '../src/renderer/utils/tauriApi'

const modsApi = vi.hoisted(() => ({
  discoverAllMods: vi.fn<() => Promise<DiscoveredMod[]>>(),
  readModManifest: vi.fn<(path: string) => Promise<unknown>>(),
  readTowerPositions: vi.fn<() => Promise<Record<string, unknown>>>(),
  getCustomTowerPositionIcaos: vi.fn<() => Promise<string[]>>(),
}))

/** The saved global settings the mod loader reads its `disabledMods` from. */
const settings = vi.hoisted(() => ({
  disabledMods: [] as string[],
}))

vi.mock('@/utils/tauriApi', () => ({
  isTauri: () => false,
  joinPath: (a: string, b: string) => `${a}/${b}`,
  modApi: modsApi,
}))

vi.mock('@/stores/globalSettingsStore', () => ({
  useGlobalSettingsStore: {
    getState: () => ({ disabledMods: settings.disabledMods }),
  },
}))

vi.mock('@/services/CustomVMRService', () => ({
  customVMRService: {
    loadVMRFiles: async () => {},
    getStats: () => ({ vmrFiles: 0, defaultRules: 0, airlineRules: 0 }),
    getLoadedFiles: () => [],
  },
}))

const AIRCRAFT_MOD: DiscoveredMod = {
  id: 'mods/aircraft/b738',
  path: 'mods/aircraft/B738',
  modType: 'aircraft',
  isGitRepo: false,
  repoName: null,
}

const TOWER_MOD: DiscoveredMod = {
  id: 'mods/towers/koak',
  path: 'mods/towers/KOAK',
  modType: 'tower',
  isGitRepo: false,
  repoName: null,
}

const AIRCRAFT_MANIFEST: AircraftModManifest = {
  name: 'Test 737',
  modelFile: 'model.glb',
  aircraftTypes: ['B738'],
}

const TOWER_MANIFEST: TowerModManifest = {
  name: 'Test KOAK tower',
  modelFile: 'model.glb',
  airports: ['KOAK'],
}

/** Fresh module, so the singleton's `loaded` latch and registry start empty. */
async function loadService() {
  vi.resetModules()
  const { modService } = await import('@/services/ModService')
  return modService
}

beforeEach(() => {
  settings.disabledMods = []
  modsApi.discoverAllMods.mockReset().mockResolvedValue([AIRCRAFT_MOD, TOWER_MOD])
  modsApi.readModManifest
    .mockReset()
    .mockImplementation(async (path: string) => (path.toLowerCase().includes('b738') ? AIRCRAFT_MANIFEST : TOWER_MANIFEST))
  modsApi.readTowerPositions.mockReset().mockResolvedValue({})
  modsApi.getCustomTowerPositionIcaos.mockReset().mockResolvedValue([])
})

describe('ModService disabled mods', () => {
  it('loadMods with no argument skips the mods the settings disable', async () => {
    settings.disabledMods = ['mods/aircraft/b738']
    const modService = await loadService()

    await modService.loadMods()

    expect(modService.getAircraftModel('B738')).toBeUndefined()
    expect(modService.getTowerModel('KOAK')).toBeDefined()
  })

  it('a disabled mod is listed with enabled false', async () => {
    const modService = await loadService()

    await modService.loadMods(['mods/aircraft/b738'])

    const result = modService.getModLoadingResult()
    const aircraft = result.aircraft.find((mod) => mod.id === 'mods/aircraft/b738')
    expect(aircraft?.enabled).toBe(false)
    expect(modService.getAircraftModel('B738')).toBeUndefined()

    const tower = result.towers.find((mod) => mod.id === 'mods/towers/koak')
    expect(tower?.enabled).toBe(true)
    expect(modService.getTowerModel('KOAK')).toBeDefined()
  })

  it('disabled ids match case-insensitively', async () => {
    settings.disabledMods = ['MODS/Aircraft/B738']
    const modService = await loadService()

    await modService.loadMods()

    expect(modService.getAircraftModel('B738')).toBeUndefined()
  })

  it('a disabled tower is listed and not loaded', async () => {
    const modService = await loadService()

    await modService.loadMods(['mods/towers/koak'])

    const tower = modService.getModLoadingResult().towers.find((mod) => mod.id === 'mods/towers/koak')
    expect(tower?.enabled).toBe(false)
    expect(modService.getTowerModel('KOAK')).toBeUndefined()
  })

  it('a disabled mod whose manifest cannot be read is listed under Errors', async () => {
    modsApi.readModManifest.mockImplementation(async (path: string) => {
      if (path.toLowerCase().includes('b738')) {
        throw new Error('manifest.json missing')
      }
      return TOWER_MANIFEST
    })
    const modService = await loadService()

    await modService.loadMods(['mods/aircraft/b738'])

    expect(modService.getModLoadingResult().errors).toContainEqual({
      path: 'mods/aircraft/B738',
      error: 'Missing or invalid manifest.json',
      type: 'aircraft',
    })
    expect(modService.getAircraftModel('B738')).toBeUndefined()
  })
})
