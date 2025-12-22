import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  SettingsStore,
  CesiumSettings,
  GraphicsSettings,
  CameraSettings,
  WeatherSettings,
  MemorySettings,
  AircraftSettings,
  UISettings
} from '../types/settings'
import { DEFAULT_SETTINGS } from '../types/settings'

/**
 * Settings store with grouped structure
 *
 * Organizes settings into domain-specific groups for better discoverability:
 * - cesium: Globe, terrain, lighting, time
 * - graphics: Shadows, anti-aliasing, post-processing
 * - camera: FOV, speeds, sensitivity
 * - weather: Fog, clouds, visibility effects
 * - memory: Caching, data radius
 * - aircraft: Display modes, orientation emulation
 * - ui: Theme, panel visibility
 *
 * Migration: Old flat localStorage will be auto-converted to grouped structure
 * on first load. The migration preserves all user settings.
 *
 * @example
 * ```typescript
 * // Access grouped settings
 * const { cesium, graphics } = useSettingsStore()
 * console.log(cesium.terrainQuality)  // 1-5
 * console.log(graphics.enableShadows)  // boolean
 *
 * // Update settings (partial updates supported)
 * updateCesiumSettings({ terrainQuality: 4, enableLighting: true })
 * updateGraphicsSettings({ enableShadows: false })
 * ```
 */
export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      ...DEFAULT_SETTINGS,

      // ========================================================================
      // UPDATE FUNCTIONS (Group-based)
      // ========================================================================

      updateCesiumSettings: (updates: Partial<CesiumSettings>) =>
        set((state) => ({
          cesium: { ...state.cesium, ...updates }
        })),

      updateGraphicsSettings: (updates: Partial<GraphicsSettings>) =>
        set((state) => ({
          graphics: {
            ...state.graphics,
            ...updates,
            // Validate enum values
            ...(updates.msaaSamples !== undefined && {
              msaaSamples: [1, 2, 4, 8].includes(updates.msaaSamples)
                ? updates.msaaSamples
                : state.graphics.msaaSamples
            }),
            ...(updates.shadowMapSize !== undefined && {
              shadowMapSize: [1024, 2048, 4096, 8192].includes(updates.shadowMapSize)
                ? updates.shadowMapSize
                : state.graphics.shadowMapSize
            }),
            // Clamp numeric values
            ...(updates.shadowMaxDistance !== undefined && {
              shadowMaxDistance: Math.max(100, Math.min(20000, updates.shadowMaxDistance))
            }),
            ...(updates.shadowDarkness !== undefined && {
              shadowDarkness: Math.max(0, Math.min(1, updates.shadowDarkness))
            }),
            // Advanced shadow bias settings
            ...(updates.shadowDepthBias !== undefined && {
              shadowDepthBias: Math.max(0.00001, Math.min(0.01, updates.shadowDepthBias))
            }),
            ...(updates.shadowPolygonOffsetFactor !== undefined && {
              shadowPolygonOffsetFactor: Math.max(0.1, Math.min(5.0, updates.shadowPolygonOffsetFactor))
            }),
            ...(updates.shadowPolygonOffsetUnits !== undefined && {
              shadowPolygonOffsetUnits: Math.max(0.1, Math.min(10.0, updates.shadowPolygonOffsetUnits))
            }),
            ...(updates.cameraNearPlane !== undefined && {
              cameraNearPlane: Math.max(0.1, Math.min(10.0, updates.cameraNearPlane))
            })
          }
        })),

      updateCameraSettings: (updates: Partial<CameraSettings>) =>
        set((state) => ({
          camera: {
            ...state.camera,
            ...updates,
            // Clamp numeric values
            ...(updates.defaultFov !== undefined && {
              defaultFov: Math.max(10, Math.min(120, updates.defaultFov))
            }),
            ...(updates.cameraSpeed !== undefined && {
              cameraSpeed: Math.max(1, Math.min(10, updates.cameraSpeed))
            }),
            ...(updates.mouseSensitivity !== undefined && {
              mouseSensitivity: Math.max(0.1, Math.min(2.0, updates.mouseSensitivity))
            })
          }
        })),

      updateWeatherSettings: (updates: Partial<WeatherSettings>) =>
        set((state) => ({
          weather: {
            ...state.weather,
            ...updates,
            // Clamp numeric values
            ...(updates.cloudOpacity !== undefined && {
              cloudOpacity: Math.max(0.3, Math.min(0.8, updates.cloudOpacity))
            }),
            ...(updates.fogIntensity !== undefined && {
              fogIntensity: Math.max(0.5, Math.min(2.0, updates.fogIntensity))
            }),
            ...(updates.visibilityScale !== undefined && {
              visibilityScale: Math.max(0.5, Math.min(2.0, updates.visibilityScale))
            })
          }
        })),

      updateMemorySettings: (updates: Partial<MemorySettings>) =>
        set((state) => ({
          memory: {
            ...state.memory,
            ...updates,
            // Clamp numeric values
            ...(updates.inMemoryTileCacheSize !== undefined && {
              inMemoryTileCacheSize: Math.max(
                50,
                Math.min(500, Math.round(updates.inMemoryTileCacheSize))
              )
            }),
            ...(updates.diskCacheSizeGB !== undefined && {
              diskCacheSizeGB: Math.max(0.1, Math.min(10, updates.diskCacheSizeGB))
            }),
            ...(updates.aircraftDataRadiusNM !== undefined && {
              aircraftDataRadiusNM: Math.max(
                10,
                Math.min(500, Math.round(updates.aircraftDataRadiusNM))
              )
            })
          }
        })),

      updateAircraftSettings: (updates: Partial<AircraftSettings>) =>
        set((state) => ({
          aircraft: {
            ...state.aircraft,
            ...updates,
            // Clamp numeric values
            ...(updates.labelVisibilityDistance !== undefined && {
              labelVisibilityDistance: Math.max(1, Math.min(100, updates.labelVisibilityDistance))
            }),
            ...(updates.maxAircraftDisplay !== undefined && {
              maxAircraftDisplay: Math.max(10, Math.min(1000, updates.maxAircraftDisplay))
            }),
            ...(updates.orientationIntensity !== undefined && {
              orientationIntensity: Math.max(0.25, Math.min(1.5, updates.orientationIntensity))
            })
          }
        })),

      updateUISettings: (updates: Partial<UISettings>) =>
        set((state) => ({
          ui: { ...state.ui, ...updates }
        })),

      // ========================================================================
      // RESET TO DEFAULTS
      // ========================================================================

      resetToDefaults: () => set(DEFAULT_SETTINGS),

      // ========================================================================
      // EXPORT / IMPORT
      // ========================================================================

      exportSettings: () => {
        const state = get()
        const settings = {
          cesium: state.cesium,
          graphics: state.graphics,
          camera: state.camera,
          weather: state.weather,
          memory: state.memory,
          aircraft: state.aircraft,
          ui: state.ui
        }
        return JSON.stringify(settings, null, 2)
      },

      importSettings: (json: string) => {
        try {
          const imported = JSON.parse(json)

          // Validate it's an object
          if (typeof imported !== 'object' || imported === null) {
            return false
          }

          // If it's the old flat structure, migrate it
          if ('cesiumIonToken' in imported && !('cesium' in imported)) {
            const migrated = migrateOldSettings(imported)
            set(migrated)
            return true
          }

          // New grouped structure - validate and apply
          const updates: Partial<typeof DEFAULT_SETTINGS> = {}

          if (imported.cesium && typeof imported.cesium === 'object') {
            updates.cesium = { ...DEFAULT_SETTINGS.cesium, ...imported.cesium }
          }
          if (imported.graphics && typeof imported.graphics === 'object') {
            updates.graphics = { ...DEFAULT_SETTINGS.graphics, ...imported.graphics }
          }
          if (imported.camera && typeof imported.camera === 'object') {
            updates.camera = { ...DEFAULT_SETTINGS.camera, ...imported.camera }
          }
          if (imported.weather && typeof imported.weather === 'object') {
            updates.weather = { ...DEFAULT_SETTINGS.weather, ...imported.weather }
          }
          if (imported.memory && typeof imported.memory === 'object') {
            updates.memory = { ...DEFAULT_SETTINGS.memory, ...imported.memory }
          }
          if (imported.aircraft && typeof imported.aircraft === 'object') {
            updates.aircraft = { ...DEFAULT_SETTINGS.aircraft, ...imported.aircraft }
          }
          if (imported.ui && typeof imported.ui === 'object') {
            updates.ui = { ...DEFAULT_SETTINGS.ui, ...imported.ui }
          }

          set(updates)
          return true
        } catch {
          return false
        }
      }
    }),
    {
      name: 'settings-store',
      version: 2, // Incremented for migration
      migrate: (persistedState: unknown, version: number) => {
        // Auto-migrate old flat structure to grouped structure
        if (version < 2) {
          console.log('[Settings] Migrating from flat structure (v1) to grouped structure (v2)')
          return migrateOldSettings(persistedState)
        }
        return persistedState as SettingsStore
      }
    }
  )
)

/**
 * Migrate old flat settings structure to new grouped structure
 *
 * Preserves all user settings during migration from v1 (flat) to v2 (grouped).
 * This function is called automatically on first load after upgrading.
 *
 * @param oldSettings - Old flat settings object from localStorage
 * @returns New grouped settings object
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateOldSettings(oldSettings: any): typeof DEFAULT_SETTINGS {
  return {
    cesium: {
      cesiumIonToken: oldSettings.cesiumIonToken ?? DEFAULT_SETTINGS.cesium.cesiumIonToken,
      terrainQuality: oldSettings.terrainQuality ?? DEFAULT_SETTINGS.cesium.terrainQuality,
      enableLighting: oldSettings.enableLighting ?? DEFAULT_SETTINGS.cesium.enableLighting,
      show3DBuildings: oldSettings.show3DBuildings ?? DEFAULT_SETTINGS.cesium.show3DBuildings,
      timeMode: oldSettings.timeMode ?? DEFAULT_SETTINGS.cesium.timeMode,
      fixedTimeHour: oldSettings.fixedTimeHour ?? DEFAULT_SETTINGS.cesium.fixedTimeHour
    },
    graphics: {
      msaaSamples: oldSettings.msaaSamples ?? DEFAULT_SETTINGS.graphics.msaaSamples,
      enableFxaa: oldSettings.enableFxaa ?? DEFAULT_SETTINGS.graphics.enableFxaa,
      enableHdr: oldSettings.enableHdr ?? DEFAULT_SETTINGS.graphics.enableHdr,
      enableLogDepth: oldSettings.enableLogDepth ?? DEFAULT_SETTINGS.graphics.enableLogDepth,
      enableGroundAtmosphere:
        oldSettings.enableGroundAtmosphere ?? DEFAULT_SETTINGS.graphics.enableGroundAtmosphere,
      enableAmbientOcclusion:
        oldSettings.enableAmbientOcclusion ?? DEFAULT_SETTINGS.graphics.enableAmbientOcclusion,
      enableShadows: oldSettings.enableShadows ?? DEFAULT_SETTINGS.graphics.enableShadows,
      shadowMapSize: oldSettings.shadowMapSize ?? DEFAULT_SETTINGS.graphics.shadowMapSize,
      shadowMaxDistance:
        oldSettings.shadowMaxDistance ?? DEFAULT_SETTINGS.graphics.shadowMaxDistance,
      shadowDarkness: oldSettings.shadowDarkness ?? DEFAULT_SETTINGS.graphics.shadowDarkness,
      shadowSoftness: oldSettings.shadowSoftness ?? DEFAULT_SETTINGS.graphics.shadowSoftness,
      shadowFadingEnabled:
        oldSettings.shadowFadingEnabled ?? DEFAULT_SETTINGS.graphics.shadowFadingEnabled,
      shadowNormalOffset:
        oldSettings.shadowNormalOffset ?? DEFAULT_SETTINGS.graphics.shadowNormalOffset,
      aircraftShadowsOnly:
        oldSettings.aircraftShadowsOnly ?? DEFAULT_SETTINGS.graphics.aircraftShadowsOnly,
      shadowDepthBias:
        oldSettings.shadowDepthBias ?? DEFAULT_SETTINGS.graphics.shadowDepthBias,
      shadowPolygonOffsetFactor:
        oldSettings.shadowPolygonOffsetFactor ?? DEFAULT_SETTINGS.graphics.shadowPolygonOffsetFactor,
      shadowPolygonOffsetUnits:
        oldSettings.shadowPolygonOffsetUnits ?? DEFAULT_SETTINGS.graphics.shadowPolygonOffsetUnits,
      cameraNearPlane:
        oldSettings.cameraNearPlane ?? DEFAULT_SETTINGS.graphics.cameraNearPlane
    },
    camera: {
      defaultFov: oldSettings.defaultFov ?? DEFAULT_SETTINGS.camera.defaultFov,
      cameraSpeed: oldSettings.cameraSpeed ?? DEFAULT_SETTINGS.camera.cameraSpeed,
      mouseSensitivity: oldSettings.mouseSensitivity ?? DEFAULT_SETTINGS.camera.mouseSensitivity
    },
    weather: {
      showWeatherEffects:
        oldSettings.showWeatherEffects ?? DEFAULT_SETTINGS.weather.showWeatherEffects,
      showCesiumFog: oldSettings.showCesiumFog ?? DEFAULT_SETTINGS.weather.showCesiumFog,
      showBabylonFog: oldSettings.showBabylonFog ?? DEFAULT_SETTINGS.weather.showBabylonFog,
      showClouds: oldSettings.showClouds ?? DEFAULT_SETTINGS.weather.showClouds,
      cloudOpacity: oldSettings.cloudOpacity ?? DEFAULT_SETTINGS.weather.cloudOpacity,
      fogIntensity: oldSettings.fogIntensity ?? DEFAULT_SETTINGS.weather.fogIntensity,
      visibilityScale: oldSettings.visibilityScale ?? DEFAULT_SETTINGS.weather.visibilityScale
    },
    memory: {
      inMemoryTileCacheSize:
        oldSettings.inMemoryTileCacheSize ?? DEFAULT_SETTINGS.memory.inMemoryTileCacheSize,
      diskCacheSizeGB: oldSettings.diskCacheSizeGB ?? DEFAULT_SETTINGS.memory.diskCacheSizeGB,
      aircraftDataRadiusNM:
        oldSettings.aircraftDataRadiusNM ?? DEFAULT_SETTINGS.memory.aircraftDataRadiusNM
    },
    aircraft: {
      labelVisibilityDistance:
        oldSettings.labelVisibilityDistance ?? DEFAULT_SETTINGS.aircraft.labelVisibilityDistance,
      maxAircraftDisplay:
        oldSettings.maxAircraftDisplay ?? DEFAULT_SETTINGS.aircraft.maxAircraftDisplay,
      showGroundTraffic:
        oldSettings.showGroundTraffic ?? DEFAULT_SETTINGS.aircraft.showGroundTraffic,
      showAirborneTraffic:
        oldSettings.showAirborneTraffic ?? DEFAULT_SETTINGS.aircraft.showAirborneTraffic,
      datablockMode: oldSettings.datablockMode ?? DEFAULT_SETTINGS.aircraft.datablockMode,
      orientationEmulation:
        oldSettings.orientationEmulation ?? DEFAULT_SETTINGS.aircraft.orientationEmulation,
      orientationIntensity:
        oldSettings.orientationIntensity ?? DEFAULT_SETTINGS.aircraft.orientationIntensity
    },
    ui: {
      theme: oldSettings.theme ?? DEFAULT_SETTINGS.ui.theme,
      showAircraftPanel: oldSettings.showAircraftPanel ?? DEFAULT_SETTINGS.ui.showAircraftPanel
    }
  }
}
