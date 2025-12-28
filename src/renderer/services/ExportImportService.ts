/**
 * Comprehensive export/import service for TowerCab 3D settings.
 * Handles global settings, per-airport camera settings, bookmarks, and viewport layouts.
 *
 * Export Versions:
 * - v1: Legacy format with camera data
 * - v2: Current format with viewports, globalSettings contains all local settings
 * - v3: Selective export format with separate localSettings and globalSettings
 *
 * Security: Cesium Ion token is NEVER exported (it's a personal API key)
 */

import { useSettingsStore } from '../stores/settingsStore'
import { useViewportStore } from '../stores/viewportStore'
import { useGlobalSettingsStore } from '../stores/globalSettingsStore'
import type { AirportViewportConfig, Viewport, DatablockDirection } from '@/types'
import type { ViewModeDefaults } from '@/types/viewport'
import type { SelectiveExportData } from '@/types/exportImport'
import { SUBCATEGORY_MAPPINGS, GLOBAL_SUBCATEGORY_MAPPINGS } from './SettingsTreeBuilder'

/** Settings that should never be exported for security reasons */
const EXCLUDED_FROM_EXPORT = ['cesiumIonToken']

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
 * Export selected data based on tree view selection
 */
export function exportSelectiveData(selectedIds: Set<string>): SelectiveExportData {
  const settingsState = useSettingsStore.getState()
  const viewportState = useViewportStore.getState()

  const result: SelectiveExportData = {
    version: 3,
    exportDate: new Date().toISOString(),
    appVersion: '0.0.15',
    airports: {},
    exportedPaths: [...selectedIds]
  }

  // Process local settings
  const localSettings: Record<string, Record<string, unknown>> = {}

  for (const [category, subcats] of Object.entries(SUBCATEGORY_MAPPINGS)) {
    const categoryData: Record<string, unknown> = {}

    for (const [subKey, subCat] of Object.entries(subcats)) {
      const nodeId = `local.${category}.${subKey}`

      if (selectedIds.has(nodeId)) {
        // Get the properties for this subcategory
        const categorySettings = settingsState[category as keyof typeof settingsState]
        if (categorySettings && typeof categorySettings === 'object') {
          for (const prop of subCat.properties) {
            const value = (categorySettings as unknown as Record<string, unknown>)[prop]
            if (value !== undefined) {
              categoryData[prop] = value
            }
          }
        }
      }
    }

    if (Object.keys(categoryData).length > 0) {
      localSettings[category] = categoryData
    }
  }

  if (Object.keys(localSettings).length > 0) {
    result.localSettings = localSettings
  }

  // Process global settings from globalSettingsStore (not settingsStore)
  const globalSettingsState = useGlobalSettingsStore.getState()
  const globalSettings: Record<string, unknown> = {}

  for (const key of Object.keys(GLOBAL_SUBCATEGORY_MAPPINGS)) {
    // Skip security-sensitive settings
    if (EXCLUDED_FROM_EXPORT.includes(key)) {
      continue
    }

    const nodeId = `global.${key}`
    if (selectedIds.has(nodeId)) {
      // Read from globalSettingsStore
      const value = globalSettingsState[key as keyof typeof globalSettingsState]
      if (value !== undefined && typeof value !== 'function') {
        globalSettings[key] = value
      }
    }
  }

  if (Object.keys(globalSettings).length > 0) {
    result.globalSettings = globalSettings as SelectiveExportData['globalSettings']
  }

  // Process per-airport data
  const airportConfigs = viewportState.airportViewportConfigs

  for (const icao of Object.keys(airportConfigs)) {
    const config = airportConfigs[icao]
    const airportData: SelectiveExportData['airports'][string] = {}

    // Check each airport sub-item
    if (selectedIds.has(`airports.${icao}.viewports`)) {
      airportData.viewports = config.viewports
      airportData.activeViewportId = config.activeViewportId
      if (config.defaultConfig) {
        airportData.defaultConfig = config.defaultConfig
      }
    }

    if (selectedIds.has(`airports.${icao}.default3d`) && config.default3d) {
      airportData.default3d = config.default3d as unknown as Record<string, unknown>
    }

    if (selectedIds.has(`airports.${icao}.default2d`) && config.default2d) {
      airportData.default2d = config.default2d as unknown as Record<string, unknown>
    }

    if (selectedIds.has(`airports.${icao}.bookmarks`) && config.bookmarks) {
      airportData.bookmarks = config.bookmarks as Record<number, unknown>
    }

    if (selectedIds.has(`airports.${icao}.datablockPosition`) && config.datablockPosition !== undefined) {
      airportData.datablockPosition = config.datablockPosition
    }

    if (Object.keys(airportData).length > 0) {
      result.airports[icao] = airportData
    }
  }

  return result
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
 * Validate export data format (supports v1, v2, and v3)
 */
export function validateExportData(data: unknown): data is ExportData | SelectiveExportData {
  if (!data || typeof data !== 'object') return false

  const d = data as Record<string, unknown>
  if (typeof d.version !== 'number') return false
  if (typeof d.exportDate !== 'string') return false
  if (typeof d.airports !== 'object' || d.airports === null) return false

  return true
}

/**
 * Check if export data is v3 (SelectiveExportData) format
 */
export function isSelectiveExportData(data: ExportData | SelectiveExportData): data is SelectiveExportData {
  return data.version === 3 && 'exportedPaths' in data
}

/**
 * Import data with options
 * Supports v1 (legacy camera), v2 (viewports), and v3 (selective) formats
 */
export function importData(data: ExportData | SelectiveExportData, options: ImportOptions): {
  success: boolean
  message: string
  importedAirports: string[]
} {
  try {
    const importedAirports: string[] = []
    const isV3 = isSelectiveExportData(data)

    // Import settings
    if (options.importGlobalSettings) {
      if (isV3) {
        // v3: Import local settings to settingsStore
        if (data.localSettings) {
          const settingsJson = JSON.stringify(data.localSettings)
          const result = useSettingsStore.getState().importSettings(settingsJson)
          if (!result) {
            return { success: false, message: 'Failed to import local settings', importedAirports: [] }
          }
        }

        // v3: Import global settings to globalSettingsStore
        if (data.globalSettings) {
          const globalStore = useGlobalSettingsStore.getState()
          // Import each global setting individually (skip cesiumIonToken for security)
          if (data.globalSettings.fsltl) {
            globalStore.updateFsltl(data.globalSettings.fsltl as Parameters<typeof globalStore.updateFsltl>[0])
          }
          if (data.globalSettings.airports) {
            globalStore.updateAirports(data.globalSettings.airports as Parameters<typeof globalStore.updateAirports>[0])
          }
          if (data.globalSettings.server) {
            globalStore.updateServer(data.globalSettings.server as Parameters<typeof globalStore.updateServer>[0])
          }
        }
      } else {
        // v2: globalSettings contains all local settings
        if (data.globalSettings) {
          const settingsJson = JSON.stringify(data.globalSettings)
          const result = useSettingsStore.getState().importSettings(settingsJson)
          if (!result) {
            return { success: false, message: 'Failed to import global settings', importedAirports: [] }
          }
        }
      }
    }

    // Import selected airports
    if (options.selectedAirports.length > 0) {
      const viewportStore = useViewportStore.getState()

      for (const icao of options.selectedAirports) {
        const airportData = data.airports[icao]
        if (!airportData) continue

        const newViewportConfigs = { ...viewportStore.airportViewportConfigs }

        if (isV3) {
          // v3: Airport data is stored directly (not wrapped in viewports property)
          const v3Airport = airportData as SelectiveExportData['airports'][string]

          // Build viewport config from v3 format
          const importedConfig: Partial<AirportViewportConfig> = {}

          if (v3Airport.viewports) {
            importedConfig.viewports = v3Airport.viewports as Viewport[]
            importedConfig.activeViewportId = v3Airport.activeViewportId || 'main'
          }
          if (v3Airport.defaultConfig) {
            importedConfig.defaultConfig = {
              viewports: v3Airport.defaultConfig.viewports as Viewport[],
              activeViewportId: v3Airport.defaultConfig.activeViewportId
            }
          }
          if (v3Airport.default3d) {
            importedConfig.default3d = v3Airport.default3d as unknown as ViewModeDefaults
          }
          if (v3Airport.default2d) {
            importedConfig.default2d = v3Airport.default2d as unknown as ViewModeDefaults
          }
          if (v3Airport.bookmarks) {
            importedConfig.bookmarks = v3Airport.bookmarks as AirportViewportConfig['bookmarks']
          }
          if (v3Airport.datablockPosition !== undefined) {
            importedConfig.datablockPosition = v3Airport.datablockPosition as DatablockDirection
          }

          if (options.mergeMode === 'merge' && newViewportConfigs[icao]) {
            const existing = newViewportConfigs[icao]
            newViewportConfigs[icao] = {
              ...existing,
              ...importedConfig,
              viewports: importedConfig.viewports || existing.viewports,
              defaultConfig: importedConfig.defaultConfig || existing.defaultConfig,
              default3d: importedConfig.default3d || existing.default3d,
              default2d: importedConfig.default2d || existing.default2d,
              bookmarks: {
                ...(existing.bookmarks || {}),
                ...(importedConfig.bookmarks || {})
              }
            }
          } else {
            // Replace mode or new airport
            newViewportConfigs[icao] = {
              viewports: importedConfig.viewports || [],
              activeViewportId: importedConfig.activeViewportId || 'main',
              ...importedConfig
            } as AirportViewportConfig
          }
        } else {
          // v2 format: Handle viewport settings (current format)
          const v2Airport = airportData as ExportedAirportData
          if (v2Airport.viewports) {
            if (options.mergeMode === 'merge' && newViewportConfigs[icao]) {
              // Merge: keep existing default if no new one, merge bookmarks
              const existing = newViewportConfigs[icao]
              const imported = v2Airport.viewports

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
              newViewportConfigs[icao] = v2Airport.viewports
            }
          }
          // Handle legacy camera format (version 1 exports)
          else if (v2Airport.camera) {
            const legacyCamera = v2Airport.camera
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
        }

        useViewportStore.setState({ airportViewportConfigs: newViewportConfigs })
        importedAirports.push(icao)
      }
    }

    const parts: string[] = []
    if (options.importGlobalSettings) parts.push('settings')
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
export function downloadExport(data: ExportData | SelectiveExportData, filename?: string): void {
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
export async function readImportFile(file: File): Promise<ExportData | SelectiveExportData> {
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
