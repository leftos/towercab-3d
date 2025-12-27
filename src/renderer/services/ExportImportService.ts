/**
 * Comprehensive export/import service for TowerCab 3D settings.
 * Handles global settings, per-airport camera settings, bookmarks, and viewport layouts.
 */

import { useSettingsStore } from '../stores/settingsStore'
import { useViewportStore } from '../stores/viewportStore'
import type { AirportViewportConfig } from '@/types'

export interface ExportedAirportData {
  // Legacy camera format (for backward compatibility with old exports)
  camera?: {
    '3d'?: unknown
    'topdown'?: unknown
    lastViewMode?: string
    default3d?: unknown
    defaultTopdown?: unknown
    bookmarks?: Record<number, unknown>
  }
  // Current viewports format
  viewports?: AirportViewportConfig
}

export interface ExportData {
  version: number
  exportDate: string
  appVersion: string
  globalSettings?: Record<string, unknown>
  airports: Record<string, ExportedAirportData>
}

export interface ImportOptions {
  importGlobalSettings: boolean
  selectedAirports: string[]
  mergeMode: 'replace' | 'merge'
}

/**
 * Export all data or selected airports
 */
export function exportAllData(selectedAirports?: string[]): ExportData {
  const settingsState = useSettingsStore.getState()
  const viewportState = useViewportStore.getState()

  // Get global settings (exclude functions)
  const globalSettings: Record<string, unknown> = {}
  for (const key in settingsState) {
    if (typeof settingsState[key as keyof typeof settingsState] !== 'function') {
      globalSettings[key] = settingsState[key as keyof typeof settingsState]
    }
  }

  // Get all airport ICAOs from viewportStore
  const allAirports = Object.keys(viewportState.airportViewportConfigs)

  // Filter to selected airports if specified
  const airportsToExport = selectedAirports
    ? allAirports.filter(icao => selectedAirports.includes(icao))
    : allAirports

  // Build airport data
  const airports: Record<string, ExportedAirportData> = {}
  for (const icao of airportsToExport) {
    const config = viewportState.airportViewportConfigs[icao]
    if (config) {
      airports[icao] = { viewports: config }
    }
  }

  return {
    version: 2, // Bumped version for new format without legacy camera data
    exportDate: new Date().toISOString(),
    appVersion: '0.0.15', // Current version
    globalSettings,
    airports
  }
}

/**
 * Get list of airports in export data
 */
export function getAirportsInExport(data: ExportData): string[] {
  return Object.keys(data.airports).sort()
}

/**
 * Get summary of what's included for an airport in the export
 */
export function getAirportExportSummary(data: ExportData, icao: string): {
  hasBookmarks: boolean
  bookmarkCount: number
  hasDefaultView: boolean
  hasViewports: boolean
  viewportCount: number
} {
  const airportData = data.airports[icao]
  if (!airportData) {
    return {
      hasBookmarks: false,
      bookmarkCount: 0,
      hasDefaultView: false,
      hasViewports: false,
      viewportCount: 0
    }
  }

  const bookmarks = airportData.camera?.bookmarks || {}
  const bookmarkCount = Object.keys(bookmarks).length

  const hasDefaultView = !!(airportData.camera?.default3d || airportData.camera?.defaultTopdown)

  const viewports = airportData.viewports?.viewports || []
  const viewportCount = Array.isArray(viewports) ? viewports.length : 0

  return {
    hasBookmarks: bookmarkCount > 0,
    bookmarkCount,
    hasDefaultView,
    hasViewports: viewportCount > 0,
    viewportCount
  }
}

/**
 * Validate export data format
 */
export function validateExportData(data: unknown): data is ExportData {
  if (!data || typeof data !== 'object') return false

  const d = data as Record<string, unknown>
  if (typeof d.version !== 'number') return false
  if (typeof d.exportDate !== 'string') return false
  if (typeof d.airports !== 'object' || d.airports === null) return false

  return true
}

/**
 * Import data with options
 * Supports both legacy format (version 1 with camera data) and new format (version 2+ with viewports)
 */
export function importData(data: ExportData, options: ImportOptions): {
  success: boolean
  message: string
  importedAirports: string[]
} {
  try {
    const importedAirports: string[] = []

    // Import global settings
    if (options.importGlobalSettings && data.globalSettings) {
      const settingsJson = JSON.stringify(data.globalSettings)
      const result = useSettingsStore.getState().importSettings(settingsJson)
      if (!result) {
        return { success: false, message: 'Failed to import global settings', importedAirports: [] }
      }
    }

    // Import selected airports
    if (options.selectedAirports.length > 0) {
      const viewportStore = useViewportStore.getState()

      for (const icao of options.selectedAirports) {
        const airportData = data.airports[icao]
        if (!airportData) continue

        const newViewportConfigs = { ...viewportStore.airportViewportConfigs }

        // Handle viewport settings (current format)
        if (airportData.viewports) {
          if (options.mergeMode === 'merge' && newViewportConfigs[icao]) {
            // Merge: keep existing default if no new one, merge bookmarks
            const existing = newViewportConfigs[icao]
            const imported = airportData.viewports

            newViewportConfigs[icao] = {
              ...imported,
              defaultConfig: imported.defaultConfig || existing.defaultConfig,
              default3d: imported.default3d || existing.default3d,
              default2d: imported.default2d || existing.default2d,
              bookmarks: {
                ...(existing.bookmarks || {}),
                ...(imported.bookmarks || {})
              }
            }
          } else {
            // Replace: overwrite completely
            newViewportConfigs[icao] = airportData.viewports
          }
        }
        // Handle legacy camera format (version 1 exports)
        else if (airportData.camera) {
          const legacyCamera = airportData.camera
          // Convert legacy camera settings to viewport config format
          const legacyConfig: AirportViewportConfig = {
            viewports: [],
            activeViewportId: 'main',
            bookmarks: legacyCamera.bookmarks as AirportViewportConfig['bookmarks']
          }

          // Map legacy defaults to new format
          if (legacyCamera.default3d) {
            legacyConfig.default3d = legacyCamera.default3d as AirportViewportConfig['default3d']
          }
          if (legacyCamera.defaultTopdown) {
            legacyConfig.default2d = legacyCamera.defaultTopdown as AirportViewportConfig['default2d']
          }

          if (options.mergeMode === 'merge' && newViewportConfigs[icao]) {
            const existing = newViewportConfigs[icao]
            newViewportConfigs[icao] = {
              ...existing,
              bookmarks: {
                ...(existing.bookmarks || {}),
                ...(legacyConfig.bookmarks || {})
              },
              default3d: legacyConfig.default3d || existing.default3d,
              default2d: legacyConfig.default2d || existing.default2d
            }
          } else {
            newViewportConfigs[icao] = legacyConfig
          }
        }

        useViewportStore.setState({ airportViewportConfigs: newViewportConfigs })
        importedAirports.push(icao)
      }
    }

    const parts: string[] = []
    if (options.importGlobalSettings) parts.push('global settings')
    if (importedAirports.length > 0) parts.push(`${importedAirports.length} airport(s)`)

    return {
      success: true,
      message: `Successfully imported ${parts.join(' and ')}`,
      importedAirports
    }
  } catch (error) {
    return {
      success: false,
      message: `Import failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      importedAirports: []
    }
  }
}

/**
 * Download export data as a JSON file
 */
export function downloadExport(data: ExportData, filename?: string): void {
  const json = JSON.stringify(data, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)

  const a = document.createElement('a')
  a.href = url
  a.download = filename || `towercab-export-${new Date().toISOString().slice(0, 10)}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * Read and parse an import file
 */
export async function readImportFile(file: File): Promise<ExportData> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = (e) => {
      try {
        const json = e.target?.result as string
        const data = JSON.parse(json)

        if (!validateExportData(data)) {
          reject(new Error('Invalid export file format'))
          return
        }

        resolve(data)
      } catch (error) {
        reject(new Error('Failed to parse file: ' + (error instanceof Error ? error.message : 'Unknown error')))
      }
    }

    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsText(file)
  })
}
