import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  CesiumSettings,
  GraphicsSettings,
  CameraSettings,
  WeatherSettings,
  MemorySettings,
  AircraftSettings,
  UISettings,
  FSLTLSettings
} from '../types/settings'
import { DEFAULT_SETTINGS } from '../types/settings'

// ============================================================================
// Preset System Types and Constants
// ============================================================================

/**
 * Available settings presets
 *
 * - 'desktop': High quality for desktop PCs (default settings)
 * - 'ipad': Optimized for iPad/tablet with reduced GPU/memory usage
 * - 'mobile': Low quality for phones or low-end devices
 */
export type SettingsPreset = 'desktop' | 'ipad' | 'mobile'

/**
 * Partial settings that a preset can override
 */
interface PresetSettings {
  graphics?: Partial<GraphicsSettings>
  memory?: Partial<MemorySettings>
  cesium?: Partial<CesiumSettings>
}

/**
 * Settings presets for different device types
 *
 * Presets only override specific settings - other settings are preserved.
 * This allows users to customize non-performance settings while using a preset.
 */
export const SETTINGS_PRESETS: Record<SettingsPreset, PresetSettings> = {
  desktop: {
    graphics: {
      msaaSamples: 4,
      enableShadows: true,
      shadowMapSize: 2048,
      enableAmbientOcclusion: false,
      enableFxaa: true
    },
    memory: {
      inMemoryTileCacheSize: 2000,
      maxReplayDurationMinutes: 15
    },
    cesium: {
      terrainQuality: 3,
      show3DBuildings: false
    }
  },
  ipad: {
    graphics: {
      msaaSamples: 2,
      enableShadows: false,
      shadowMapSize: 1024,
      enableAmbientOcclusion: false,
      enableFxaa: true,
      enableAircraftSilhouettes: false
    },
    memory: {
      inMemoryTileCacheSize: 500,
      maxReplayDurationMinutes: 5
    },
    cesium: {
      terrainQuality: 2,
      show3DBuildings: false
    }
  },
  mobile: {
    graphics: {
      msaaSamples: 1,
      enableShadows: false,
      shadowMapSize: 1024,
      enableAmbientOcclusion: false,
      enableFxaa: false,
      enableAircraftSilhouettes: false,
      enableHdr: false
    },
    memory: {
      inMemoryTileCacheSize: 200,
      maxReplayDurationMinutes: 3
    },
    cesium: {
      terrainQuality: 1,
      show3DBuildings: false
    }
  }
}

/**
 * Extended SettingsStore interface with preset support
 */
interface SettingsStoreWithPresets {
  cesium: CesiumSettings
  graphics: GraphicsSettings
  camera: CameraSettings
  weather: WeatherSettings
  memory: MemorySettings
  aircraft: AircraftSettings
  ui: UISettings
  fsltl: FSLTLSettings

  updateCesiumSettings: (updates: Partial<CesiumSettings>) => void
  updateGraphicsSettings: (updates: Partial<GraphicsSettings>) => void
  updateCameraSettings: (updates: Partial<CameraSettings>) => void
  updateWeatherSettings: (updates: Partial<WeatherSettings>) => void
  updateMemorySettings: (updates: Partial<MemorySettings>) => void
  updateAircraftSettings: (updates: Partial<AircraftSettings>) => void
  updateUISettings: (updates: Partial<UISettings>) => void
  updateFSLTLSettings: (updates: Partial<FSLTLSettings>) => void
  resetToDefaults: () => void
  exportSettings: () => string
  importSettings: (json: string) => boolean
  applyPreset: (preset: SettingsPreset) => void
}

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
export const useSettingsStore = create<SettingsStoreWithPresets>()(
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
            }),
            // Model brightness - separate sliders for built-in and FSLTL models
            ...(updates.builtinModelBrightness !== undefined && {
              builtinModelBrightness: Math.max(0.5, Math.min(3.0, updates.builtinModelBrightness))
            }),
            ...(updates.fsltlModelBrightness !== undefined && {
              fsltlModelBrightness: Math.max(0.5, Math.min(3.0, updates.fsltlModelBrightness))
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
            }),
            ...(updates.joystickSensitivity !== undefined && {
              joystickSensitivity: Math.max(1, Math.min(10, updates.joystickSensitivity))
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
            }),
            ...(updates.precipitationIntensity !== undefined && {
              precipitationIntensity: Math.max(0.5, Math.min(2.0, updates.precipitationIntensity))
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
                Math.min(5000, Math.round(updates.inMemoryTileCacheSize))
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
            }),
            ...(updates.maxReplayDurationMinutes !== undefined && {
              maxReplayDurationMinutes: Math.max(
                1,
                Math.min(60, Math.round(updates.maxReplayDurationMinutes))
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

      updateFSLTLSettings: (updates: Partial<FSLTLSettings>) =>
        set((state) => ({
          fsltl: { ...state.fsltl, ...updates }
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
          ui: state.ui,
          fsltl: state.fsltl
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
          if (imported.fsltl && typeof imported.fsltl === 'object') {
            updates.fsltl = { ...DEFAULT_SETTINGS.fsltl, ...imported.fsltl }
          }

          set(updates)
          return true
        } catch {
          return false
        }
      },

      // ========================================================================
      // PRESETS
      // ========================================================================

      applyPreset: (presetName: SettingsPreset) => {
        const preset = SETTINGS_PRESETS[presetName]
        if (!preset) return

        // Apply preset values on top of current settings (preserves non-preset values)
        set((state) => ({
          graphics: { ...state.graphics, ...preset.graphics },
          memory: { ...state.memory, ...preset.memory },
          cesium: { ...state.cesium, ...preset.cesium }
        }))
      }
    }),
    {
      name: 'settings-store',
      version: 18, // Incremented for joystickSensitivity camera setting
      migrate: (persistedState: unknown, version: number) => {
        // Auto-migrate old flat structure to grouped structure
        if (version < 2) {
          console.log('[Settings] Migrating from flat structure (v1) to grouped structure (v2)')
          return migrateOldSettings(persistedState)
        }
        // Migrate v2 to v3: add missing weather precipitation settings
        if (version < 3) {
          console.log('[Settings] Migrating v2 to v3: adding precipitation settings')
          const state = persistedState as Partial<typeof DEFAULT_SETTINGS>
          return {
            ...state,
            weather: {
              ...DEFAULT_SETTINGS.weather,
              ...state.weather
            }
          }
        }
        // Migrate v3 to v4: add weather interpolation and auto-airport switching
        if (version < 4) {
          console.log('[Settings] Migrating v3 to v4: adding weather interpolation and auto-airport switching')
          const state = persistedState as Partial<typeof DEFAULT_SETTINGS>
          return {
            ...state,
            weather: {
              ...DEFAULT_SETTINGS.weather,
              ...state.weather
            },
            camera: {
              ...DEFAULT_SETTINGS.camera,
              ...state.camera
            }
          }
        }
        // Migrate v4 to v5: add model brightness setting
        if (version < 5) {
          console.log('[Settings] Migrating v4 to v5: adding model brightness setting')
          const state = persistedState as Partial<typeof DEFAULT_SETTINGS>
          return {
            ...state,
            graphics: {
              ...DEFAULT_SETTINGS.graphics,
              ...state.graphics
            }
          }
        }
        // Migrate v5 to v6: add FSLTL settings
        if (version < 6) {
          console.log('[Settings] Migrating v5 to v6: adding FSLTL settings')
          const state = persistedState as Partial<typeof DEFAULT_SETTINGS>
          return {
            ...state,
            fsltl: {
              ...DEFAULT_SETTINGS.fsltl,
              ...state.fsltl
            }
          }
        }
        // Migrate v6 to v7: split modelBrightness into builtinModelBrightness and fsltlModelBrightness
        if (version < 7) {
          console.log('[Settings] Migrating v6 to v7: splitting model brightness into built-in and FSLTL')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const state = persistedState as any
          const oldBrightness = state.graphics?.modelBrightness ?? 1.0
          return {
            ...state,
            graphics: {
              ...DEFAULT_SETTINGS.graphics,
              ...state.graphics,
              // Use old brightness for built-in, default for FSLTL
              builtinModelBrightness: oldBrightness,
              fsltlModelBrightness: DEFAULT_SETTINGS.graphics.fsltlModelBrightness
            }
          }
        }
        // Migrate v7 to v8: add pinFollowedAircraftToTop setting
        if (version < 8) {
          console.log('[Settings] Migrating v7 to v8: adding pinFollowedAircraftToTop setting')
          const state = persistedState as Partial<typeof DEFAULT_SETTINGS>
          return {
            ...state,
            aircraft: {
              ...DEFAULT_SETTINGS.aircraft,
              ...state.aircraft
            }
          }
        }
        // Migrate v8 to v9: add autoAvoidOverlaps setting
        if (version < 9) {
          console.log('[Settings] Migrating v8 to v9: adding autoAvoidOverlaps setting')
          const state = persistedState as Partial<typeof DEFAULT_SETTINGS>
          return {
            ...state,
            aircraft: {
              ...DEFAULT_SETTINGS.aircraft,
              ...state.aircraft
            }
          }
        }
        // Migrate v9 to v10: add leaderDistance setting
        if (version < 10) {
          console.log('[Settings] Migrating v9 to v10: adding leaderDistance setting')
          const state = persistedState as Partial<typeof DEFAULT_SETTINGS>
          return {
            ...state,
            aircraft: {
              ...DEFAULT_SETTINGS.aircraft,
              ...state.aircraft
            }
          }
        }
        // Migrate v10 to v11: add enableFsltlModels setting
        if (version < 11) {
          console.log('[Settings] Migrating v10 to v11: adding enableFsltlModels setting')
          const state = persistedState as Partial<typeof DEFAULT_SETTINGS>
          return {
            ...state,
            fsltl: {
              ...DEFAULT_SETTINGS.fsltl,
              ...state.fsltl
            }
          }
        }
        // Migrate v11 to v12: increase default tile cache from 500 to 2000
        if (version < 12) {
          console.log('[Settings] Migrating v11 to v12: increasing default tile cache size')
          const state = persistedState as Partial<typeof DEFAULT_SETTINGS>
          // Only update if user was using the old default (500)
          const currentCache = state.memory?.inMemoryTileCacheSize ?? 500
          return {
            ...state,
            memory: {
              ...DEFAULT_SETTINGS.memory,
              ...state.memory,
              // If user was at old max (500), bump to new default (2000)
              inMemoryTileCacheSize: currentCache >= 500 ? 2000 : currentCache
            }
          }
        }
        // Migrate v12 to v13: add askToContributePositions UI setting
        if (version < 13) {
          console.log('[Settings] Migrating v12 to v13: adding askToContributePositions setting')
          const state = persistedState as Partial<typeof DEFAULT_SETTINGS>
          return {
            ...state,
            ui: {
              ...DEFAULT_SETTINGS.ui,
              ...state.ui
            }
          }
        }
        // Migrate v13 to v14: add defaultDatablockDirection setting
        if (version < 14) {
          console.log('[Settings] Migrating v13 to v14: adding defaultDatablockDirection setting')
          const state = persistedState as Partial<typeof DEFAULT_SETTINGS>
          return {
            ...state,
            aircraft: {
              ...DEFAULT_SETTINGS.aircraft,
              ...state.aircraft
            }
          }
        }
        // Migrate v14 to v15: add enableAircraftSilhouettes setting
        if (version < 15) {
          console.log('[Settings] Migrating v14 to v15: adding enableAircraftSilhouettes setting')
          const state = persistedState as Partial<typeof DEFAULT_SETTINGS>
          return {
            ...state,
            graphics: {
              ...DEFAULT_SETTINGS.graphics,
              ...state.graphics
            }
          }
        }
        // Migrate v15 to v16: add builtinModelTintColor setting
        if (version < 16) {
          console.log('[Settings] Migrating v15 to v16: adding builtinModelTintColor setting')
          const state = persistedState as Partial<typeof DEFAULT_SETTINGS>
          return {
            ...state,
            graphics: {
              ...DEFAULT_SETTINGS.graphics,
              ...state.graphics
            }
          }
        }
        // Migrate v16 to v17: add deviceOptimizationPromptDismissed setting
        if (version < 17) {
          console.log('[Settings] Migrating v16 to v17: adding deviceOptimizationPromptDismissed setting')
          const state = persistedState as Partial<typeof DEFAULT_SETTINGS>
          return {
            ...state,
            ui: {
              ...DEFAULT_SETTINGS.ui,
              ...state.ui
            }
          }
        }
        // Migrate v17 to v18: add joystickSensitivity setting
        if (version < 18) {
          console.log('[Settings] Migrating v17 to v18: adding joystickSensitivity setting')
          const state = persistedState as Partial<typeof DEFAULT_SETTINGS>
          return {
            ...state,
            camera: {
              ...DEFAULT_SETTINGS.camera,
              ...state.camera
            }
          }
        }
        return persistedState as SettingsStoreWithPresets
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
      enableAircraftSilhouettes:
        oldSettings.enableAircraftSilhouettes ?? DEFAULT_SETTINGS.graphics.enableAircraftSilhouettes,
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
        oldSettings.cameraNearPlane ?? DEFAULT_SETTINGS.graphics.cameraNearPlane,
      builtinModelBrightness:
        oldSettings.builtinModelBrightness ?? oldSettings.modelBrightness ?? DEFAULT_SETTINGS.graphics.builtinModelBrightness,
      builtinModelTintColor:
        oldSettings.builtinModelTintColor ?? DEFAULT_SETTINGS.graphics.builtinModelTintColor,
      fsltlModelBrightness:
        oldSettings.fsltlModelBrightness ?? DEFAULT_SETTINGS.graphics.fsltlModelBrightness
    },
    camera: {
      defaultFov: oldSettings.defaultFov ?? DEFAULT_SETTINGS.camera.defaultFov,
      cameraSpeed: oldSettings.cameraSpeed ?? DEFAULT_SETTINGS.camera.cameraSpeed,
      mouseSensitivity: oldSettings.mouseSensitivity ?? DEFAULT_SETTINGS.camera.mouseSensitivity,
      joystickSensitivity: oldSettings.joystickSensitivity ?? DEFAULT_SETTINGS.camera.joystickSensitivity,
      enableAutoAirportSwitch: oldSettings.enableAutoAirportSwitch ?? DEFAULT_SETTINGS.camera.enableAutoAirportSwitch
    },
    weather: {
      showWeatherEffects:
        oldSettings.showWeatherEffects ?? DEFAULT_SETTINGS.weather.showWeatherEffects,
      showCesiumFog: oldSettings.showCesiumFog ?? DEFAULT_SETTINGS.weather.showCesiumFog,
      showBabylonFog: oldSettings.showBabylonFog ?? DEFAULT_SETTINGS.weather.showBabylonFog,
      showClouds: oldSettings.showClouds ?? DEFAULT_SETTINGS.weather.showClouds,
      cloudOpacity: oldSettings.cloudOpacity ?? DEFAULT_SETTINGS.weather.cloudOpacity,
      fogIntensity: oldSettings.fogIntensity ?? DEFAULT_SETTINGS.weather.fogIntensity,
      visibilityScale: oldSettings.visibilityScale ?? DEFAULT_SETTINGS.weather.visibilityScale,
      showPrecipitation:
        oldSettings.showPrecipitation ?? DEFAULT_SETTINGS.weather.showPrecipitation,
      precipitationIntensity:
        oldSettings.precipitationIntensity ?? DEFAULT_SETTINGS.weather.precipitationIntensity,
      showLightning: oldSettings.showLightning ?? oldSettings.weather?.showLightning ?? DEFAULT_SETTINGS.weather.showLightning,
      enableWeatherInterpolation: oldSettings.enableWeatherInterpolation ?? DEFAULT_SETTINGS.weather.enableWeatherInterpolation
    },
    memory: {
      inMemoryTileCacheSize:
        oldSettings.inMemoryTileCacheSize ?? DEFAULT_SETTINGS.memory.inMemoryTileCacheSize,
      diskCacheSizeGB: oldSettings.diskCacheSizeGB ?? DEFAULT_SETTINGS.memory.diskCacheSizeGB,
      aircraftDataRadiusNM:
        oldSettings.aircraftDataRadiusNM ?? DEFAULT_SETTINGS.memory.aircraftDataRadiusNM,
      maxReplayDurationMinutes:
        oldSettings.maxReplayDurationMinutes ?? DEFAULT_SETTINGS.memory.maxReplayDurationMinutes
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
        oldSettings.orientationIntensity ?? DEFAULT_SETTINGS.aircraft.orientationIntensity,
      pinFollowedAircraftToTop:
        oldSettings.pinFollowedAircraftToTop ?? DEFAULT_SETTINGS.aircraft.pinFollowedAircraftToTop,
      autoAvoidOverlaps:
        oldSettings.autoAvoidOverlaps ?? DEFAULT_SETTINGS.aircraft.autoAvoidOverlaps,
      leaderDistance:
        oldSettings.leaderDistance ?? DEFAULT_SETTINGS.aircraft.leaderDistance,
      defaultDatablockDirection:
        oldSettings.defaultDatablockDirection ?? DEFAULT_SETTINGS.aircraft.defaultDatablockDirection
    },
    ui: {
      theme: oldSettings.theme ?? DEFAULT_SETTINGS.ui.theme,
      showAircraftPanel: oldSettings.showAircraftPanel ?? DEFAULT_SETTINGS.ui.showAircraftPanel,
      showMetarOverlay: oldSettings.showMetarOverlay ?? DEFAULT_SETTINGS.ui.showMetarOverlay,
      askToContributePositions: oldSettings.askToContributePositions ?? DEFAULT_SETTINGS.ui.askToContributePositions,
      deviceOptimizationPromptDismissed: oldSettings.deviceOptimizationPromptDismissed ?? DEFAULT_SETTINGS.ui.deviceOptimizationPromptDismissed
    },
    fsltl: {
      sourcePath: oldSettings.fsltl?.sourcePath ?? DEFAULT_SETTINGS.fsltl.sourcePath,
      outputPath: oldSettings.fsltl?.outputPath ?? DEFAULT_SETTINGS.fsltl.outputPath,
      textureScale: oldSettings.fsltl?.textureScale ?? DEFAULT_SETTINGS.fsltl.textureScale,
      enableFsltlModels: oldSettings.fsltl?.enableFsltlModels ?? DEFAULT_SETTINGS.fsltl.enableFsltlModels
    }
  }
}
