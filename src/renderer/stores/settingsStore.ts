import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface SettingsStore {
  // Cesium settings
  cesiumIonToken: string

  // Display settings
  labelVisibilityDistance: number  // nautical miles
  maxAircraftDisplay: number
  showGroundTraffic: boolean
  showAirborneTraffic: boolean
  datablockMode: 'full' | 'airline' | 'none'  // full=show all, airline=ICAO only, none=no labels

  // Aircraft orientation emulation
  orientationEmulation: boolean   // Enable/disable pitch/roll emulation
  orientationIntensity: number    // 0.25 to 1.5 (1.0 = realistic)

  // Graphics settings
  terrainQuality: number  // 1-5 scale (1=low, 5=ultra)

  // Camera settings
  defaultFov: number  // degrees
  cameraSpeed: number  // 1-10 scale
  mouseSensitivity: number  // 0.1-2.0 scale (1.0 = default)

  // UI settings
  theme: 'light' | 'dark'
  showAircraftPanel: boolean

  // 3D Buildings
  show3DBuildings: boolean

  // Lighting settings
  timeMode: 'real' | 'fixed'
  fixedTimeHour: number  // 0-24, local time at tower

  // Memory management settings
  inMemoryTileCacheSize: number  // Number of tiles to keep in Cesium's memory (50-500)
  diskCacheSizeGB: number  // IndexedDB cache size in GB (0.1-10)
  aircraftDataRadiusNM: number  // Radius for keeping aircraft data in memory (10-500 NM)

  // Weather settings
  showWeatherEffects: boolean  // Master toggle for weather effects
  showCesiumFog: boolean       // Show Cesium fog (reduces draw distance)
  showBabylonFog: boolean      // Show Babylon fog (visual fog atmosphere)
  showClouds: boolean          // Show cloud layer planes
  cloudOpacity: number         // Cloud plane opacity (0.3-0.8)
  fogIntensity: number         // Fog dome opacity multiplier (0.5-2.0)
  visibilityScale: number      // Fog dome radius multiplier (0.5-2.0)

  // Experimental graphics settings
  msaaSamples: number          // MSAA samples: 1, 2, 4, 8
  enableFxaa: boolean          // Fast approximate anti-aliasing
  enableHdr: boolean           // High dynamic range
  enableLogDepth: boolean      // Logarithmic depth buffer
  enableGroundAtmosphere: boolean  // Ground atmosphere effect
  enableLighting: boolean      // Globe lighting
  enableShadows: boolean       // Terrain/model shadows
  shadowMapSize: number        // Shadow map resolution: 1024, 2048, 4096
  shadowCascades: number       // Number of shadow cascades: 1, 2, 4
  shadowMaxDistance: number    // Maximum shadow distance in meters
  shadowDarkness: number       // Shadow darkness: 0.0-1.0
  shadowSoftness: boolean      // Soft shadows vs hard shadows
  shadowFadingEnabled: boolean // Fade shadows at edge
  shadowNormalOffset: boolean  // Use normal offset to reduce shadow acne

  // Actions
  setCesiumIonToken: (token: string) => void
  setLabelVisibilityDistance: (distance: number) => void
  setMaxAircraftDisplay: (max: number) => void
  setShowGroundTraffic: (show: boolean) => void
  setShowAirborneTraffic: (show: boolean) => void
  setDatablockMode: (mode: 'full' | 'airline' | 'none') => void
  setOrientationEmulation: (enabled: boolean) => void
  setOrientationIntensity: (intensity: number) => void
  setTerrainQuality: (quality: number) => void
  setDefaultFov: (fov: number) => void
  setCameraSpeed: (speed: number) => void
  setMouseSensitivity: (sensitivity: number) => void
  setTheme: (theme: 'light' | 'dark') => void
  setShowAircraftPanel: (show: boolean) => void
  setShow3DBuildings: (show: boolean) => void
  setTimeMode: (mode: 'real' | 'fixed') => void
  setFixedTimeHour: (hour: number) => void
  setInMemoryTileCacheSize: (size: number) => void
  setDiskCacheSizeGB: (size: number) => void
  setAircraftDataRadiusNM: (radius: number) => void
  setShowWeatherEffects: (show: boolean) => void
  setShowCesiumFog: (show: boolean) => void
  setShowBabylonFog: (show: boolean) => void
  setShowClouds: (show: boolean) => void
  setCloudOpacity: (opacity: number) => void
  setFogIntensity: (intensity: number) => void
  setVisibilityScale: (scale: number) => void
  setMsaaSamples: (samples: number) => void
  setEnableFxaa: (enable: boolean) => void
  setEnableHdr: (enable: boolean) => void
  setEnableLogDepth: (enable: boolean) => void
  setEnableGroundAtmosphere: (enable: boolean) => void
  setEnableLighting: (enable: boolean) => void
  setEnableShadows: (enable: boolean) => void
  setShadowMapSize: (size: number) => void
  setShadowCascades: (cascades: number) => void
  setShadowMaxDistance: (distance: number) => void
  setShadowDarkness: (darkness: number) => void
  setShadowSoftness: (soft: boolean) => void
  setShadowFadingEnabled: (enabled: boolean) => void
  setShadowNormalOffset: (enabled: boolean) => void
  resetToDefaults: () => void
  exportSettings: () => string
  importSettings: (json: string) => boolean
}

const DEFAULT_SETTINGS = {
  cesiumIonToken: '',
  labelVisibilityDistance: 30,  // 30 nm
  maxAircraftDisplay: 200,
  showGroundTraffic: true,
  showAirborneTraffic: true,
  datablockMode: 'full' as const,  // full=show all, airline=ICAO only, none=no labels
  orientationEmulation: true,      // Enable pitch/roll emulation by default
  orientationIntensity: 1.0,       // 1.0 = realistic physics
  terrainQuality: 3,  // 1=low, 2=medium, 3=high, 4=very high, 5=ultra
  defaultFov: 60,
  cameraSpeed: 5,
  mouseSensitivity: 1.0,
  theme: 'dark' as const,
  showAircraftPanel: true,
  show3DBuildings: false,
  timeMode: 'real' as const,
  fixedTimeHour: 12,
  // Memory management - balanced defaults for smooth panning without OOM
  inMemoryTileCacheSize: 500,  // Cesium tile cache size (higher = smoother panning, more RAM)
  diskCacheSizeGB: 2,  // 2GB disk cache for tiles
  aircraftDataRadiusNM: 100,  // Only keep aircraft data within 100nm of camera
  // Weather settings
  showWeatherEffects: true,
  showCesiumFog: true,
  showBabylonFog: true,
  showClouds: true,
  cloudOpacity: 0.5,
  fogIntensity: 1.0,      // 1.0 = default, 0.5 = half opacity, 2.0 = double opacity
  visibilityScale: 1.0,   // 1.0 = match METAR, 2.0 = see twice as far as reported
  // Experimental graphics settings
  msaaSamples: 4,         // 1, 2, 4, or 8
  enableFxaa: true,       // Fast approximate anti-aliasing
  enableHdr: false,       // High dynamic range (can cause banding)
  enableLogDepth: true,   // Logarithmic depth buffer
  enableGroundAtmosphere: true,
  enableLighting: true,
  enableShadows: true,
  shadowMapSize: 4096,    // 1024, 2048, 4096
  shadowCascades: 4,      // 1, 2, 4
  shadowMaxDistance: 2000, // meters
  shadowDarkness: 0.3,    // 0.0 = no darkening, 1.0 = black
  shadowSoftness: true,   // soft vs hard shadows
  shadowFadingEnabled: true,
  shadowNormalOffset: true
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,

      setCesiumIonToken: (token: string) => set({ cesiumIonToken: token }),

      setLabelVisibilityDistance: (distance: number) =>
        set({ labelVisibilityDistance: Math.max(1, Math.min(100, distance)) }),

      setMaxAircraftDisplay: (max: number) =>
        set({ maxAircraftDisplay: Math.max(10, Math.min(1000, max)) }),

      setShowGroundTraffic: (show: boolean) => set({ showGroundTraffic: show }),

      setShowAirborneTraffic: (show: boolean) => set({ showAirborneTraffic: show }),

      setDatablockMode: (mode: 'full' | 'airline' | 'none') => set({ datablockMode: mode }),

      setOrientationEmulation: (enabled: boolean) => set({ orientationEmulation: enabled }),

      setOrientationIntensity: (intensity: number) =>
        set({ orientationIntensity: Math.max(0.25, Math.min(1.5, intensity)) }),

      setTerrainQuality: (quality: number) =>
        set({ terrainQuality: Math.max(1, Math.min(5, Math.round(quality))) }),

      setDefaultFov: (fov: number) =>
        set({ defaultFov: Math.max(10, Math.min(120, fov)) }),

      setCameraSpeed: (speed: number) =>
        set({ cameraSpeed: Math.max(1, Math.min(10, speed)) }),

      setMouseSensitivity: (sensitivity: number) =>
        set({ mouseSensitivity: Math.max(0.1, Math.min(2.0, sensitivity)) }),

      setTheme: (theme: 'light' | 'dark') => set({ theme }),

      setShowAircraftPanel: (show: boolean) => set({ showAircraftPanel: show }),

      setShow3DBuildings: (show: boolean) => set({ show3DBuildings: show }),

      setTimeMode: (mode: 'real' | 'fixed') => set({ timeMode: mode }),

      setFixedTimeHour: (hour: number) =>
        set({ fixedTimeHour: Math.max(0, Math.min(24, hour)) }),

      setInMemoryTileCacheSize: (size: number) =>
        set({ inMemoryTileCacheSize: Math.max(50, Math.min(500, Math.round(size))) }),

      setDiskCacheSizeGB: (size: number) =>
        set({ diskCacheSizeGB: Math.max(0.1, Math.min(10, size)) }),

      setAircraftDataRadiusNM: (radius: number) =>
        set({ aircraftDataRadiusNM: Math.max(10, Math.min(500, Math.round(radius))) }),

      setShowWeatherEffects: (show: boolean) => set({ showWeatherEffects: show }),

      setShowCesiumFog: (show: boolean) => set({ showCesiumFog: show }),

      setShowBabylonFog: (show: boolean) => set({ showBabylonFog: show }),

      setShowClouds: (show: boolean) => set({ showClouds: show }),

      setCloudOpacity: (opacity: number) =>
        set({ cloudOpacity: Math.max(0.3, Math.min(0.8, opacity)) }),

      setFogIntensity: (intensity: number) =>
        set({ fogIntensity: Math.max(0.5, Math.min(2.0, intensity)) }),

      setVisibilityScale: (scale: number) =>
        set({ visibilityScale: Math.max(0.5, Math.min(2.0, scale)) }),

      setMsaaSamples: (samples: number) =>
        set({ msaaSamples: [1, 2, 4, 8].includes(samples) ? samples : 4 }),

      setEnableFxaa: (enable: boolean) => set({ enableFxaa: enable }),

      setEnableHdr: (enable: boolean) => set({ enableHdr: enable }),

      setEnableLogDepth: (enable: boolean) => set({ enableLogDepth: enable }),

      setEnableGroundAtmosphere: (enable: boolean) => set({ enableGroundAtmosphere: enable }),

      setEnableLighting: (enable: boolean) => set({ enableLighting: enable }),

      setEnableShadows: (enable: boolean) => set({ enableShadows: enable }),

      setShadowMapSize: (size: number) =>
        set({ shadowMapSize: [1024, 2048, 4096, 8192].includes(size) ? size : 4096 }),

      setShadowCascades: (cascades: number) =>
        set({ shadowCascades: [1, 2, 4].includes(cascades) ? cascades : 4 }),

      setShadowMaxDistance: (distance: number) =>
        set({ shadowMaxDistance: Math.max(100, Math.min(10000, distance)) }),

      setShadowDarkness: (darkness: number) =>
        set({ shadowDarkness: Math.max(0, Math.min(1, darkness)) }),

      setShadowSoftness: (soft: boolean) => set({ shadowSoftness: soft }),

      setShadowFadingEnabled: (enabled: boolean) => set({ shadowFadingEnabled: enabled }),

      setShadowNormalOffset: (enabled: boolean) => set({ shadowNormalOffset: enabled }),

      resetToDefaults: () => set(DEFAULT_SETTINGS),

      exportSettings: () => {
        // Get current state, excluding action functions
        const state = useSettingsStore.getState()
        const settings: Record<string, unknown> = {}
        for (const key in state) {
          if (typeof state[key as keyof SettingsStore] !== 'function') {
            settings[key] = state[key as keyof SettingsStore]
          }
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
          // Only import known settings keys (filter out functions and unknown keys)
          const validKeys = Object.keys(DEFAULT_SETTINGS)
          const validSettings: Partial<typeof DEFAULT_SETTINGS> = {}
          for (const key of validKeys) {
            if (key in imported) {
              validSettings[key as keyof typeof DEFAULT_SETTINGS] = imported[key]
            }
          }
          // Apply imported settings
          set(validSettings)
          return true
        } catch {
          return false
        }
      }
    }),
    {
      name: 'settings-store'
    }
  )
)
