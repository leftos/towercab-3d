import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../src/renderer/types'
import { DEFAULT_GLOBAL_SETTINGS } from '../src/renderer/types'

const api = vi.hoisted(() => ({
  read: vi.fn<() => Promise<GlobalSettings>>(),
  write: vi.fn<(settings: GlobalSettings) => Promise<void>>(),
}))

vi.mock('@/utils/tauriApi', () => ({
  isTauri: () => false,
  globalSettingsApi: {
    getPath: async () => '(remote browser - settings on host)',
    read: api.read,
    write: api.write,
  },
}))

vi.mock('@/services/fsltlApi', () => ({
  listVmrFiles: async () => [],
}))

/** The `server` block exactly as Rust's `GlobalServerSettings` serialises it. */
const RUST_SERVER = {
  port: 8765,
  enabled: true,
  allowNonLocalClients: true,
  minimizeToTray: false,
}

/** What the host's GET returns to a remote browser: its remote view, as Rust serialises it. */
function hostRemoteView(): GlobalSettings {
  return {
    ...structuredClone(DEFAULT_GLOBAL_SETTINGS),
    cesiumIonToken: '',
    server: { ...RUST_SERVER },
  }
}

function memoryStorage(entries: Record<string, string>): Storage {
  const items = new Map(Object.entries(entries))
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key)
    },
    setItem: (key, value) => {
      items.set(key, value)
    },
  }
}

/** A browser that used an older version: local display settings and a Cesium token, never migrated. */
const OLD_BROWSER_STORAGE = {
  'settings-store': JSON.stringify({
    state: { aircraft: { leaderDistance: 3 }, cesium: { cesiumIonToken: 'LOCAL-ion' } },
  }),
}

async function loadStore() {
  vi.resetModules()
  return import('../src/renderer/stores/globalSettingsStore')
}

describe('globalSettingsStore in a remote browser', () => {
  beforeEach(() => {
    api.read.mockReset()
    api.write.mockReset()
    api.write.mockResolvedValue(undefined)
    vi.stubGlobal('localStorage', memoryStorage(OLD_BROWSER_STORAGE))
  })

  it('sends no write while loading', async () => {
    api.read.mockResolvedValue(hostRemoteView())
    const { initializeGlobalSettings } = await loadStore()

    await initializeGlobalSettings()

    expect(api.write).not.toHaveBeenCalled()
  })

  it('never holds or sends vNAS tokens, even from a host that returns them', async () => {
    api.read.mockResolvedValue({ ...hostRemoteView(), vnasTokens: 'HOST-vnas' } as GlobalSettings)
    const { initializeGlobalSettings, useGlobalSettingsStore } = await loadStore()
    await initializeGlobalSettings()

    expect(useGlobalSettingsStore.getState().getSettings()).not.toHaveProperty('vnasTokens')

    await useGlobalSettingsStore.getState().updateDisplay({ leaderDistance: 4 })
    expect(api.write).toHaveBeenCalledTimes(1)
    expect(api.write.mock.calls[0][0]).not.toHaveProperty('vnasTokens')
  })

  it('round-trips the server block with the Rust field names', async () => {
    api.read.mockResolvedValue(hostRemoteView())
    const { initializeGlobalSettings, useGlobalSettingsStore } = await loadStore()
    await initializeGlobalSettings()

    expect(Object.keys(DEFAULT_GLOBAL_SETTINGS.server).sort()).toEqual(Object.keys(RUST_SERVER).sort())
    expect(DEFAULT_GLOBAL_SETTINGS.server.allowNonLocalClients).toBe(false)
    expect(useGlobalSettingsStore.getState().getSettings().server).toEqual(RUST_SERVER)
  })
})
