/**
 * Settings-related type definitions
 *
 * This file centralizes all application settings with a grouped structure
 * for better organization and discoverability.
 *
 * Settings are organized into domain-specific groups:
 * - Cesium: Globe, terrain, lighting, time
 * - Graphics: Shadows, anti-aliasing, post-processing
 * - Camera: FOV, speeds, sensitivity
 * - Weather: Fog, clouds, visibility effects
 * - Memory: Caching, data radius
 * - Aircraft: Display modes, orientation emulation
 * - UI: Theme, panel visibility
 *
 * **NOTE:** This is the NEW grouped structure defined in Phase 1.
 * The actual settingsStore.ts will be migrated to use this in Phase 5.
 *
 * @see settingsStore - Store that will use these types (after Phase 5 migration)
 * @see SettingsModal - UI component for editing settings
 */

/**
 * Terrain quality level (1-5 scale)
 *
 * Controls Cesium terrain tile detail and load priority:
 * - 1 = Low: Faster load, less detail, lower memory usage
 * - 2 = Medium-Low
 * - 3 = High (default): Balanced quality/performance
 * - 4 = Very High: More detail, higher memory usage
 * - 5 = Ultra: Maximum detail, highest memory usage, slower load
 *
 * Higher quality loads more terrain tiles and uses higher LOD (Level of Detail).
 */
export type TerrainQuality = 1 | 2 | 3 | 4 | 5

/**
 * Shadow quality preset
 *
 * Controls shadow map resolution and filtering:
 * - 'low': 1024x1024 shadow map, hard shadows
 * - 'medium': 2048x2048 shadow map, soft shadows
 * - 'high': 2048x2048 shadow map, soft shadows, normal offset (default)
 * - 'ultra': 4096x4096 shadow map, soft shadows, normal offset, fading
 */
export type ShadowQuality = 'low' | 'medium' | 'high' | 'ultra'

/**
 * Datablock display mode for aircraft labels
 *
 * Controls what information is shown in aircraft labels:
 * - 'full': Show callsign, altitude, speed (full ATC datablock)
 * - 'airline': Show only callsign (ICAO code)
 * - 'none': No labels displayed
 */
export type DatablockMode = 'full' | 'airline' | 'none'

/**
 * Time mode for sun position and lighting
 *
 * - 'real': Use real-time based on current system clock
 * - 'fixed': Use user-specified fixed time (fixedTimeHour)
 */
export type TimeMode = 'real' | 'fixed'

/**
 * UI theme
 *
 * - 'dark': Dark mode (default)
 * - 'light': Light mode
 */
export type Theme = 'light' | 'dark'

/**
 * Cesium-specific configuration
 *
 * Settings related to the Cesium globe, terrain, and lighting system.
 */
export interface CesiumSettings {
  /** Cesium Ion access token for terrain/imagery (user-provided, free tier available) */
  cesiumIonToken: string

  /** Terrain quality level (1-5, default: 3) */
  terrainQuality: TerrainQuality

  /** Enable globe lighting based on sun position (default: true) */
  enableLighting: boolean

  /** Show 3D building models (OSM Buildings tileset, default: false) */
  show3DBuildings: boolean

  /** Time mode for sun position: real-time or fixed (default: 'real') */
  timeMode: TimeMode

  /**
   * Fixed time hour (0-24) when timeMode is 'fixed'
   * Represents local time at tower location
   * Default: 12 (noon)
   */
  fixedTimeHour: number
}

/**
 * Graphics and rendering settings
 *
 * Settings for shadows, anti-aliasing, and post-processing effects.
 */
export interface GraphicsSettings {
  // Anti-aliasing
  /** MSAA (Multi-Sample Anti-Aliasing) samples: 1, 2, 4, or 8 (default: 4) */
  msaaSamples: 1 | 2 | 4 | 8

  /** Enable FXAA (Fast Approximate Anti-Aliasing) for smoother edges (default: true) */
  enableFxaa: boolean

  // Post-processing
  /**
   * Enable HDR (High Dynamic Range) rendering
   * Can cause color banding on some displays (default: false)
   */
  enableHdr: boolean

  /** Enable logarithmic depth buffer for better z-fighting prevention (default: true) */
  enableLogDepth: boolean

  /** Enable ground atmosphere effect (atmospheric scattering, default: true) */
  enableGroundAtmosphere: boolean

  /**
   * Enable SSAO (Screen-Space Ambient Occlusion)
   * Adds contact shadows but can cause visible banding artifacts (default: false)
   */
  enableAmbientOcclusion: boolean

  // Shadows
  /** Enable terrain and model shadows (default: true) */
  enableShadows: boolean

  /** Shadow map resolution: 1024, 2048, 4096, or 8192 (default: 2048) */
  shadowMapSize: 1024 | 2048 | 4096 | 8192

  /** Maximum shadow rendering distance in meters (default: 10000) */
  shadowMaxDistance: number

  /** Shadow darkness: 0.0 (no darkening) to 1.0 (black) (default: 0.3) */
  shadowDarkness: number

  /** Enable soft shadows vs hard shadows (PCF filtering, default: true) */
  shadowSoftness: boolean

  /** Enable shadow fading at cascade boundaries (can show banding, default: false) */
  shadowFadingEnabled: boolean

  /** Use normal offset to reduce shadow acne artifacts (default: true) */
  shadowNormalOffset: boolean

  /** Only render shadows from aircraft models, not terrain self-shadowing (default: false) */
  aircraftShadowsOnly: boolean
}

/**
 * Camera behavior settings
 *
 * Settings for camera movement speed and input sensitivity.
 */
export interface CameraSettings {
  /** Default field of view in degrees (10-120, default: 60) */
  defaultFov: number

  /** Camera movement speed (1-10 scale, default: 5) */
  cameraSpeed: number

  /** Mouse sensitivity (0.1-2.0 scale, 1.0 = default) */
  mouseSensitivity: number
}

/**
 * Weather visualization settings
 *
 * Settings for METAR-based fog, clouds, and visibility effects.
 */
export interface WeatherSettings {
  /** Master toggle for all weather effects (default: true) */
  showWeatherEffects: boolean

  /** Show Cesium fog (reduces terrain draw distance, default: true) */
  showCesiumFog: boolean

  /** Show Babylon fog dome (visual fog atmosphere, default: true) */
  showBabylonFog: boolean

  /** Show cloud layer planes based on METAR (default: true) */
  showClouds: boolean

  /** Cloud plane opacity (0.3-0.8, default: 0.5) */
  cloudOpacity: number

  /**
   * Fog dome opacity multiplier (0.5-2.0, default: 1.0)
   * 0.5 = half opacity, 1.0 = default, 2.0 = double opacity
   */
  fogIntensity: number

  /**
   * Fog dome radius multiplier (0.5-2.0, default: 1.0)
   * 0.5 = half METAR visibility, 1.0 = match METAR, 2.0 = double METAR visibility
   */
  visibilityScale: number
}

/**
 * Memory and caching settings
 *
 * Settings for tile caching and data radius filtering.
 */
export interface MemorySettings {
  /**
   * In-memory tile cache size (50-500 tiles, default: 500)
   * Higher values = smoother panning but more RAM usage
   */
  inMemoryTileCacheSize: number

  /**
   * IndexedDB disk cache size in GB (0.1-10, default: 2)
   * Stores terrain/imagery tiles for offline access
   */
  diskCacheSizeGB: number

  /**
   * Aircraft data radius in nautical miles (10-500, default: 100)
   * Only aircraft within this radius are kept in memory
   * Reduces memory usage at busy airports
   */
  aircraftDataRadiusNM: number
}

/**
 * Aircraft display settings
 *
 * Settings for how aircraft are displayed and filtered.
 */
export interface AircraftSettings {
  /** Label visibility distance in nautical miles (1-100, default: 30) */
  labelVisibilityDistance: number

  /** Maximum aircraft to display simultaneously (10-1000, default: 200) */
  maxAircraftDisplay: number

  /** Show ground traffic (on taxiways/apron, default: true) */
  showGroundTraffic: boolean

  /** Show airborne traffic (in flight, default: true) */
  showAirborneTraffic: boolean

  /** Datablock display mode for aircraft labels (default: 'full') */
  datablockMode: DatablockMode

  /**
   * Enable aircraft pitch/roll orientation emulation
   * Calculates realistic pitch/roll based on turn rate and climb rate (default: true)
   */
  orientationEmulation: boolean

  /**
   * Orientation emulation intensity (0.25-1.5, default: 1.0)
   * 1.0 = realistic physics, <1.0 = reduced, >1.0 = exaggerated
   */
  orientationIntensity: number
}

/**
 * UI settings
 *
 * Settings for user interface appearance and visibility.
 */
export interface UISettings {
  /** UI theme: light or dark mode (default: 'dark') */
  theme: Theme

  /** Show aircraft panel on right side of screen (default: true) */
  showAircraftPanel: boolean
}

/**
 * Main settings store interface (NEW grouped structure)
 *
 * This is the target structure for Phase 5 migration.
 * Currently, settingsStore.ts still uses the old flat structure.
 *
 * Migration plan (Phase 5):
 * 1. Refactor settingsStore.ts to use this grouped structure
 * 2. Add migration logic to convert old flat localStorage to grouped
 * 3. Update all consumers (~15 files) to access nested properties
 * 4. Update SettingsModal to use grouped update functions
 *
 * @example
 * // OLD (current flat structure):
 * const quality = useSettingsStore().terrainQuality
 * const enableShadows = useSettingsStore().enableShadows
 *
 * // NEW (Phase 5 grouped structure):
 * const quality = useSettingsStore().cesium.terrainQuality
 * const enableShadows = useSettingsStore().graphics.enableShadows
 *
 * @see settingsStore - Will be refactored to use this structure in Phase 5
 */
export interface SettingsStore {
  /** Cesium globe, terrain, and lighting settings */
  cesium: CesiumSettings

  /** Graphics rendering and post-processing settings */
  graphics: GraphicsSettings

  /** Camera behavior settings */
  camera: CameraSettings

  /** Weather visualization settings */
  weather: WeatherSettings

  /** Memory management and caching settings */
  memory: MemorySettings

  /** Aircraft display and filtering settings */
  aircraft: AircraftSettings

  /** UI appearance settings */
  ui: UISettings

  // Actions (will be added in Phase 5)
  /** Update Cesium settings (partial update) */
  updateCesiumSettings: (updates: Partial<CesiumSettings>) => void

  /** Update graphics settings (partial update) */
  updateGraphicsSettings: (updates: Partial<GraphicsSettings>) => void

  /** Update camera settings (partial update) */
  updateCameraSettings: (updates: Partial<CameraSettings>) => void

  /** Update weather settings (partial update) */
  updateWeatherSettings: (updates: Partial<WeatherSettings>) => void

  /** Update memory settings (partial update) */
  updateMemorySettings: (updates: Partial<MemorySettings>) => void

  /** Update aircraft settings (partial update) */
  updateAircraftSettings: (updates: Partial<AircraftSettings>) => void

  /** Update UI settings (partial update) */
  updateUISettings: (updates: Partial<UISettings>) => void

  /** Reset all settings to defaults */
  resetToDefaults: () => void

  /** Export settings as JSON string */
  exportSettings: () => string

  /** Import settings from JSON string, returns true if successful */
  importSettings: (json: string) => boolean
}

/**
 * Default settings values
 *
 * Used for initialization and reset-to-defaults functionality.
 * Will be referenced by settingsStore in Phase 5.
 */
export const DEFAULT_SETTINGS: Omit<SettingsStore, keyof {
  updateCesiumSettings: unknown
  updateGraphicsSettings: unknown
  updateCameraSettings: unknown
  updateWeatherSettings: unknown
  updateMemorySettings: unknown
  updateAircraftSettings: unknown
  updateUISettings: unknown
  resetToDefaults: unknown
  exportSettings: unknown
  importSettings: unknown
}> = {
  cesium: {
    cesiumIonToken: '',
    terrainQuality: 3,
    enableLighting: true,
    show3DBuildings: false,
    timeMode: 'real',
    fixedTimeHour: 12
  },
  graphics: {
    msaaSamples: 4,
    enableFxaa: true,
    enableHdr: false,
    enableLogDepth: true,
    enableGroundAtmosphere: true,
    enableAmbientOcclusion: false,
    enableShadows: true,
    shadowMapSize: 2048,
    shadowMaxDistance: 10000,
    shadowDarkness: 0.3,
    shadowSoftness: true,
    shadowFadingEnabled: false,
    shadowNormalOffset: true,
    aircraftShadowsOnly: false
  },
  camera: {
    defaultFov: 60,
    cameraSpeed: 5,
    mouseSensitivity: 1.0
  },
  weather: {
    showWeatherEffects: true,
    showCesiumFog: true,
    showBabylonFog: true,
    showClouds: true,
    cloudOpacity: 0.5,
    fogIntensity: 1.0,
    visibilityScale: 1.0
  },
  memory: {
    inMemoryTileCacheSize: 500,
    diskCacheSizeGB: 2,
    aircraftDataRadiusNM: 100
  },
  aircraft: {
    labelVisibilityDistance: 30,
    maxAircraftDisplay: 200,
    showGroundTraffic: true,
    showAirborneTraffic: true,
    datablockMode: 'full',
    orientationEmulation: true,
    orientationIntensity: 1.0
  },
  ui: {
    theme: 'dark',
    showAircraftPanel: true
  }
}
