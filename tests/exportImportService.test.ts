import { describe, expect, it, vi } from 'vitest'
import type { SelectiveExportData } from '../src/renderer/types/exportImport'

const updateServer = vi.hoisted(() => vi.fn())

vi.mock('@/stores/globalSettingsStore', () => ({
  useGlobalSettingsStore: {
    getState: () => ({ updateServer, updateFsltl: vi.fn(), updateAirports: vi.fn() }),
  },
}))

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ importSettings: () => true }) },
}))

vi.mock('@/stores/viewportStore', () => ({
  useViewportStore: { getState: () => ({ airportViewportConfigs: {} }), setState: vi.fn() },
}))

describe('importData', () => {
  it('imports only port, enabled and minimizeToTray from the server block', async () => {
    const { importData } = await import('../src/renderer/services/ExportImportService')
    const data = {
      version: 3,
      exportDate: '2026-10-21T00:00:00Z',
      exportedPaths: ['global.server'],
      airports: {},
      globalSettings: {
        server: {
          port: 9000,
          enabled: true,
          minimizeToTray: false,
          allowNonLocalClients: true,
          authToken: 'OLD-token',
          requireLocalNetwork: true,
        },
      },
    } as unknown as SelectiveExportData

    const result = importData(data, { importGlobalSettings: true, selectedAirports: [], mergeMode: 'merge' })

    expect(result.success).toBe(true)
    expect(updateServer).toHaveBeenCalledTimes(1)
    expect(updateServer.mock.calls[0][0]).toEqual({ port: 9000, enabled: true, minimizeToTray: false })
  })
})
