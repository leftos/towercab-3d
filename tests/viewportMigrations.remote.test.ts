import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AirportViewportConfig } from '../src/renderer/stores/viewport/viewportHelpers'
import { createMainViewport } from '../src/renderer/stores/viewport/viewportHelpers'
import { migrateCameraStoreBookmarks, migrateToGlobalSettings } from '../src/renderer/stores/viewport/viewportMigrations'

vi.mock('@/utils/tauriApi', () => ({ isTauri: () => false }))

// Run a scheduled sync at once, so a sync the migration schedules is seen by the test.
vi.mock('../src/renderer/stores/viewport/globalSettingsSync', () => ({
  scheduleGlobalSync: (sync: () => void) => sync(),
}))

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

function localAirportConfigs(): Record<string, AirportViewportConfig> {
  const main = createMainViewport()
  return { KSFO: { viewports: [main], activeViewportId: main.id } }
}

describe('viewport migrations in a remote browser', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'localStorage',
      memoryStorage({
        'camera-store': JSON.stringify({
          state: { airportSettings: { KSFO: { bookmarks: { 1: { heading: 90, pitch: -5, fov: 60 } } } } },
        }),
      }),
    )
  })

  it('does not sync migrated cameraStore bookmarks to the host', () => {
    const sync = vi.fn()
    let configs: Record<string, AirportViewportConfig> = {}

    migrateCameraStoreBookmarks(
      () => ({ airportViewportConfigs: configs }),
      (state) => {
        configs = state.airportViewportConfigs
      },
      sync,
    )

    expect(sync).not.toHaveBeenCalled()
  })

  it('does not sync local viewport configs to the host', () => {
    const sync = vi.fn()

    migrateToGlobalSettings(
      () => ({ initialized: true, viewports: { airportConfigs: {} } }),
      () => ({
        airportViewportConfigs: localAirportConfigs(),
        globalOrbitSettings: { distance: 500, heading: 0, pitch: -20 },
        currentAirportIcao: 'KSFO',
      }),
      sync,
    )

    expect(sync).not.toHaveBeenCalled()
  })
})
