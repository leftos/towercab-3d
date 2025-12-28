/**
 * Settings Tree Builder
 *
 * Builds hierarchical tree structures for the Export/Import Settings Wizard.
 * Maps setting categories and sub-categories to tree nodes with human-readable labels.
 */

import type { TreeNodeData, SettingMapping } from '@/types/exportImport'
import type { AirportViewportConfig } from '@/types/viewport'
import { useSettingsStore } from '../stores/settingsStore'
import { useViewportStore } from '../stores/viewportStore'

/**
 * Human-readable labels for setting categories
 */
export const CATEGORY_LABELS: Record<string, string> = {
  cesium: 'Cesium / Globe',
  graphics: 'Graphics',
  camera: 'Camera Controls',
  weather: 'Weather Effects',
  memory: 'Memory & Performance',
  aircraft: 'Aircraft Display',
  ui: 'User Interface',
  fsltl: 'FSLTL Models'
}

/**
 * Sub-category definitions with their setting properties
 */
export const SUBCATEGORY_MAPPINGS: Record<string, Record<string, { label: string; properties: string[] }>> = {
  cesium: {
    // NOTE: cesiumIonToken intentionally excluded - personal API key should never be exported
    terrain: {
      label: 'Terrain',
      properties: ['terrainQuality', 'show3DBuildings']
    },
    timeLighting: {
      label: 'Time & Lighting',
      properties: ['timeMode', 'fixedTimeHour', 'enableLighting']
    }
  },
  graphics: {
    antialiasing: {
      label: 'Anti-Aliasing',
      properties: ['msaaSamples', 'enableFxaa']
    },
    postProcessing: {
      label: 'Post-Processing',
      properties: ['enableHdr', 'enableLogDepth', 'enableGroundAtmosphere', 'enableAmbientOcclusion', 'enableAircraftSilhouettes']
    },
    shadows: {
      label: 'Shadows',
      properties: [
        'enableShadows', 'shadowMapSize', 'shadowMaxDistance', 'shadowDarkness',
        'shadowSoftness', 'shadowFadingEnabled', 'shadowNormalOffset', 'aircraftShadowsOnly',
        'shadowDepthBias', 'shadowPolygonOffsetFactor', 'shadowPolygonOffsetUnits', 'cameraNearPlane'
      ]
    },
    modelAppearance: {
      label: 'Model Appearance',
      properties: ['builtinModelBrightness', 'builtinModelTintColor', 'fsltlModelBrightness']
    },
    nightEffects: {
      label: 'Night Effects',
      properties: ['enableNightDarkening', 'nightDarkeningIntensity', 'aircraftNightVisibility']
    },
    performance: {
      label: 'Performance',
      properties: ['maxFramerate']
    }
  },
  camera: {
    fov: {
      label: 'Field of View',
      properties: ['defaultFov']
    },
    speed: {
      label: 'Movement Speed',
      properties: ['cameraSpeed']
    },
    sensitivity: {
      label: 'Sensitivity',
      properties: ['mouseSensitivity', 'joystickSensitivity']
    },
    behavior: {
      label: 'Behavior',
      properties: ['enableAutoAirportSwitch']
    }
  },
  weather: {
    master: {
      label: 'Master Toggle',
      properties: ['showWeatherEffects']
    },
    fog: {
      label: 'Fog',
      properties: ['showCesiumFog', 'showBabylonFog', 'fogIntensity', 'visibilityScale']
    },
    clouds: {
      label: 'Clouds',
      properties: ['showClouds', 'cloudOpacity']
    },
    precipitation: {
      label: 'Precipitation',
      properties: ['showPrecipitation', 'precipitationIntensity']
    },
    lightning: {
      label: 'Lightning & Interpolation',
      properties: ['showLightning', 'enableWeatherInterpolation']
    }
  },
  memory: {
    tileCache: {
      label: 'Tile Cache',
      properties: ['inMemoryTileCacheSize', 'diskCacheSizeGB']
    },
    dataRadius: {
      label: 'Aircraft Data Radius',
      properties: ['aircraftDataRadiusNM']
    },
    replay: {
      label: 'Replay Buffer',
      properties: ['maxReplayDurationMinutes']
    }
  },
  aircraft: {
    visibility: {
      label: 'Visibility',
      properties: ['labelVisibilityDistance', 'maxAircraftDisplay']
    },
    trafficFilters: {
      label: 'Traffic Filters',
      properties: ['showGroundTraffic', 'showAirborneTraffic']
    },
    datablock: {
      label: 'Datablock Mode & Font',
      properties: ['datablockMode', 'datablockFontSize']
    },
    leaderLines: {
      label: 'Leader Lines & Overlap',
      properties: ['leaderDistance', 'autoAvoidOverlaps', 'defaultDatablockDirection', 'pinFollowedAircraftToTop']
    },
    orientation: {
      label: 'Orientation Emulation',
      properties: ['orientationEmulation', 'orientationIntensity']
    }
  },
  ui: {
    theme: {
      label: 'Theme',
      properties: ['theme']
    },
    panels: {
      label: 'Panels',
      properties: ['showAircraftPanel', 'showMetarOverlay', 'aircraftPanelWidth', 'aircraftPanelHeight']
    },
    prompts: {
      label: 'Prompts',
      properties: ['askToContributePositions', 'deviceOptimizationPromptDismissed']
    }
  },
  fsltl: {
    paths: {
      label: 'Paths',
      properties: ['sourcePath', 'outputPath']
    },
    textureQuality: {
      label: 'Texture Quality',
      properties: ['textureScale']
    },
    enableModels: {
      label: 'Enable Models',
      properties: ['enableFsltlModels']
    }
  }
}

/**
 * Global settings sub-category mappings
 * NOTE: cesiumIonToken is intentionally excluded - it's a personal API key
 * and should never be exported or shared
 */
export const GLOBAL_SUBCATEGORY_MAPPINGS: Record<string, { label: string; path: string }> = {
  fsltl: { label: 'FSLTL Configuration', path: 'fsltl' },
  airports: { label: 'Default/Recent Airports', path: 'airports' },
  server: { label: 'Server Configuration', path: 'server' }
}

/**
 * Per-airport data sub-category mappings
 */
export const AIRPORT_SUBCATEGORY_MAPPINGS: Record<string, { label: string; path: string }> = {
  viewports: { label: 'Viewport Layout', path: 'viewports' },
  default3d: { label: '3D Default View', path: 'default3d' },
  default2d: { label: '2D Default View', path: 'default2d' },
  bookmarks: { label: 'Camera Bookmarks', path: 'bookmarks' },
  datablockPosition: { label: 'Datablock Position', path: 'datablockPosition' }
}

/**
 * Get all setting mappings for a category
 */
export function getSettingMappings(category: string): SettingMapping[] {
  const subcats = SUBCATEGORY_MAPPINGS[category]
  if (!subcats) return []

  return Object.entries(subcats).map(([subCatKey, subCat]) => ({
    id: `local.${category}.${subCatKey}`,
    category,
    subCategory: subCatKey,
    properties: subCat.properties
  }))
}

/**
 * Build the complete export tree from current application state
 */
export function buildExportTree(): TreeNodeData[] {
  const settingsState = useSettingsStore.getState()
  const viewportState = useViewportStore.getState()
  const airportConfigs = viewportState.airportViewportConfigs

  return [
    buildLocalSettingsTree(settingsState as unknown as Record<string, unknown>),
    buildGlobalSettingsTree(),
    buildAirportsTree(airportConfigs)
  ]
}

/**
 * Build the local settings tree node
 * @param _settings - Settings state (reserved for future use to show actual values)
 */
function buildLocalSettingsTree(_settings: Record<string, unknown>): TreeNodeData {
  const children: TreeNodeData[] = []

  for (const [category, label] of Object.entries(CATEGORY_LABELS)) {
    const subcats = SUBCATEGORY_MAPPINGS[category]
    if (!subcats) continue

    const subChildren: TreeNodeData[] = []
    let totalProps = 0

    for (const [subKey, subCat] of Object.entries(subcats)) {
      const propCount = subCat.properties.length
      totalProps += propCount
      subChildren.push({
        id: `local.${category}.${subKey}`,
        label: subCat.label,
        isLeaf: true,
        settingCount: propCount,
        description: `${propCount} setting${propCount > 1 ? 's' : ''}`
      })
    }

    children.push({
      id: `local.${category}`,
      label,
      isLeaf: false,
      children: subChildren,
      settingCount: totalProps
    })
  }

  return {
    id: 'local',
    label: 'Local Settings',
    isLeaf: false,
    children
  }
}

/**
 * Build the global settings tree node
 */
function buildGlobalSettingsTree(): TreeNodeData {
  const children: TreeNodeData[] = Object.entries(GLOBAL_SUBCATEGORY_MAPPINGS).map(
    ([key, mapping]) => ({
      id: `global.${key}`,
      label: mapping.label,
      isLeaf: true
    })
  )

  return {
    id: 'global',
    label: 'Global Settings',
    isLeaf: false,
    children,
    description: 'Shared across all devices'
  }
}

/**
 * Build the per-airport data tree node
 */
function buildAirportsTree(airportConfigs: Record<string, AirportViewportConfig>): TreeNodeData {
  const airports = Object.keys(airportConfigs).sort()

  const children: TreeNodeData[] = airports.map(icao => {
    const config = airportConfigs[icao]
    const subChildren: TreeNodeData[] = []

    // Viewports (inset geometry and camera configs)
    if (config.viewports && config.viewports.length > 0) {
      const insetCount = config.viewports.filter(v => v.id !== 'main').length
      subChildren.push({
        id: `airports.${icao}.viewports`,
        label: 'Viewport Layout',
        isLeaf: true,
        badge: insetCount > 0 ? `${insetCount} inset${insetCount > 1 ? 's' : ''}` : 'main only'
      })
    }

    // 3D default view
    if (config.default3d) {
      subChildren.push({
        id: `airports.${icao}.default3d`,
        label: '3D Default View',
        isLeaf: true
      })
    }

    // 2D default view
    if (config.default2d) {
      subChildren.push({
        id: `airports.${icao}.default2d`,
        label: '2D Default View',
        isLeaf: true
      })
    }

    // Bookmarks
    if (config.bookmarks) {
      const bookmarkCount = Object.keys(config.bookmarks).length
      if (bookmarkCount > 0) {
        subChildren.push({
          id: `airports.${icao}.bookmarks`,
          label: 'Camera Bookmarks',
          isLeaf: true,
          badge: `${bookmarkCount} bookmark${bookmarkCount > 1 ? 's' : ''}`
        })
      }
    }

    // Datablock position
    if (config.datablockPosition !== undefined) {
      subChildren.push({
        id: `airports.${icao}.datablockPosition`,
        label: 'Datablock Position',
        isLeaf: true
      })
    }

    // Build badge for airport node
    const badges: string[] = []
    if (config.bookmarks) {
      const count = Object.keys(config.bookmarks).length
      if (count > 0) badges.push(`${count} bookmark${count > 1 ? 's' : ''}`)
    }
    const insetCount = config.viewports?.filter(v => v.id !== 'main').length || 0
    if (insetCount > 0) badges.push(`${insetCount} inset${insetCount > 1 ? 's' : ''}`)

    return {
      id: `airports.${icao}`,
      label: icao,
      isLeaf: false,
      children: subChildren,
      badge: badges.length > 0 ? badges.join(', ') : undefined
    }
  })

  return {
    id: 'airports',
    label: 'Per-Airport Data',
    isLeaf: false,
    children,
    badge: `${airports.length} airport${airports.length !== 1 ? 's' : ''}`
  }
}

/**
 * Build an import tree from exported data
 * Only shows nodes that exist in the import file
 */
export function buildImportTree(exportData: {
  localSettings?: Record<string, unknown>
  globalSettings?: Record<string, unknown>
  airports?: Record<string, unknown>
}): TreeNodeData[] {
  const nodes: TreeNodeData[] = []

  // Local settings
  if (exportData.localSettings) {
    const localNode = buildImportLocalSettingsTree(exportData.localSettings)
    if (localNode.children && localNode.children.length > 0) {
      nodes.push(localNode)
    }
  }

  // Global settings
  if (exportData.globalSettings) {
    const globalNode = buildImportGlobalSettingsTree(exportData.globalSettings)
    if (globalNode.children && globalNode.children.length > 0) {
      nodes.push(globalNode)
    }
  }

  // Per-airport data
  if (exportData.airports && Object.keys(exportData.airports).length > 0) {
    nodes.push(buildImportAirportsTree(exportData.airports))
  }

  return nodes
}

/**
 * Build import tree for local settings
 */
function buildImportLocalSettingsTree(localSettings: Record<string, unknown>): TreeNodeData {
  const children: TreeNodeData[] = []

  for (const [category, label] of Object.entries(CATEGORY_LABELS)) {
    const categoryData = localSettings[category]
    if (!categoryData || typeof categoryData !== 'object') continue

    const subcats = SUBCATEGORY_MAPPINGS[category]
    if (!subcats) continue

    const subChildren: TreeNodeData[] = []

    for (const [subKey, subCat] of Object.entries(subcats)) {
      // Check if any of the subcategory's properties exist in the import
      const hasAnyProperty = subCat.properties.some(
        prop => (categoryData as Record<string, unknown>)[prop] !== undefined
      )

      if (hasAnyProperty) {
        const propCount = subCat.properties.filter(
          prop => (categoryData as Record<string, unknown>)[prop] !== undefined
        ).length

        subChildren.push({
          id: `local.${category}.${subKey}`,
          label: subCat.label,
          isLeaf: true,
          settingCount: propCount
        })
      }
    }

    if (subChildren.length > 0) {
      children.push({
        id: `local.${category}`,
        label,
        isLeaf: false,
        children: subChildren
      })
    }
  }

  return {
    id: 'local',
    label: 'Local Settings',
    isLeaf: false,
    children
  }
}

/**
 * Build import tree for global settings
 */
function buildImportGlobalSettingsTree(globalSettings: Record<string, unknown>): TreeNodeData {
  const children: TreeNodeData[] = []

  for (const [key, mapping] of Object.entries(GLOBAL_SUBCATEGORY_MAPPINGS)) {
    if (globalSettings[key] !== undefined) {
      children.push({
        id: `global.${key}`,
        label: mapping.label,
        isLeaf: true
      })
    }
  }

  return {
    id: 'global',
    label: 'Global Settings',
    isLeaf: false,
    children
  }
}

/**
 * Build import tree for airports
 */
function buildImportAirportsTree(airports: Record<string, unknown>): TreeNodeData {
  const children: TreeNodeData[] = Object.entries(airports)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([icao, data]) => {
      const airportData = data as Record<string, unknown>
      const subChildren: TreeNodeData[] = []

      if (airportData.viewports) {
        const viewports = airportData.viewports as unknown[]
        const insetCount = viewports.filter((v: unknown) => (v as { id: string }).id !== 'main').length
        subChildren.push({
          id: `airports.${icao}.viewports`,
          label: 'Viewport Layout',
          isLeaf: true,
          badge: insetCount > 0 ? `${insetCount} inset${insetCount > 1 ? 's' : ''}` : 'main only'
        })
      }

      if (airportData.default3d) {
        subChildren.push({
          id: `airports.${icao}.default3d`,
          label: '3D Default View',
          isLeaf: true
        })
      }

      if (airportData.default2d) {
        subChildren.push({
          id: `airports.${icao}.default2d`,
          label: '2D Default View',
          isLeaf: true
        })
      }

      if (airportData.bookmarks) {
        const bookmarks = airportData.bookmarks as Record<string, unknown>
        const count = Object.keys(bookmarks).length
        if (count > 0) {
          subChildren.push({
            id: `airports.${icao}.bookmarks`,
            label: 'Camera Bookmarks',
            isLeaf: true,
            badge: `${count} bookmark${count > 1 ? 's' : ''}`
          })
        }
      }

      if (airportData.datablockPosition !== undefined) {
        subChildren.push({
          id: `airports.${icao}.datablockPosition`,
          label: 'Datablock Position',
          isLeaf: true
        })
      }

      return {
        id: `airports.${icao}`,
        label: icao,
        isLeaf: false,
        children: subChildren
      }
    })

  return {
    id: 'airports',
    label: 'Per-Airport Data',
    isLeaf: false,
    children,
    badge: `${children.length} airport${children.length !== 1 ? 's' : ''}`
  }
}

/**
 * Get all leaf node IDs from a tree
 */
export function getAllLeafIds(nodes: TreeNodeData[]): string[] {
  const ids: string[] = []

  function traverse(node: TreeNodeData) {
    if (node.isLeaf) {
      ids.push(node.id)
    } else if (node.children) {
      node.children.forEach(traverse)
    }
  }

  nodes.forEach(traverse)
  return ids
}

/**
 * Get all node IDs (both leaf and branch) from a tree
 */
export function getAllNodeIds(nodes: TreeNodeData[]): string[] {
  const ids: string[] = []

  function traverse(node: TreeNodeData) {
    ids.push(node.id)
    if (node.children) {
      node.children.forEach(traverse)
    }
  }

  nodes.forEach(traverse)
  return ids
}

/**
 * Find a node by ID in the tree
 */
export function findNodeById(nodes: TreeNodeData[], id: string): TreeNodeData | undefined {
  for (const node of nodes) {
    if (node.id === id) return node
    if (node.children) {
      const found = findNodeById(node.children, id)
      if (found) return found
    }
  }
  return undefined
}
