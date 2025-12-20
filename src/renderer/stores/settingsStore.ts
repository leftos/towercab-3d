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

  // Graphics settings
  terrainQuality: number  // 1-5 scale (1=low, 5=ultra)

  // Camera settings
  defaultFov: number  // degrees
  cameraSpeed: number  // 1-10 scale

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

  // Actions
  setCesiumIonToken: (token: string) => void
  setLabelVisibilityDistance: (distance: number) => void
  setMaxAircraftDisplay: (max: number) => void
  setShowGroundTraffic: (show: boolean) => void
  setShowAirborneTraffic: (show: boolean) => void
  setDatablockMode: (mode: 'full' | 'airline' | 'none') => void
  setTerrainQuality: (quality: number) => void
  setDefaultFov: (fov: number) => void
  setCameraSpeed: (speed: number) => void
  setTheme: (theme: 'light' | 'dark') => void
  setShowAircraftPanel: (show: boolean) => void
  setShow3DBuildings: (show: boolean) => void
  setTimeMode: (mode: 'real' | 'fixed') => void
  setFixedTimeHour: (hour: number) => void
  setInMemoryTileCacheSize: (size: number) => void
  setDiskCacheSizeGB: (size: number) => void
  setAircraftDataRadiusNM: (radius: number) => void
  resetToDefaults: () => void
}

const DEFAULT_SETTINGS = {
  cesiumIonToken: '',
  labelVisibilityDistance: 30,  // 30 nm
  maxAircraftDisplay: 200,
  showGroundTraffic: true,
  showAirborneTraffic: true,
  datablockMode: 'full' as const,  // full=show all, airline=ICAO only, none=no labels
  terrainQuality: 3,  // 1=low, 2=medium, 3=high, 4=very high, 5=ultra
  defaultFov: 60,
  cameraSpeed: 5,
  theme: 'dark' as const,
  showAircraftPanel: true,
  show3DBuildings: false,
  timeMode: 'real' as const,
  fixedTimeHour: 12,
  // Memory management - balanced defaults for smooth panning without OOM
  inMemoryTileCacheSize: 500,  // Cesium tile cache size (higher = smoother panning, more RAM)
  diskCacheSizeGB: 2,  // 2GB disk cache for tiles
  aircraftDataRadiusNM: 100  // Only keep aircraft data within 100nm of camera
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

      setTerrainQuality: (quality: number) =>
        set({ terrainQuality: Math.max(1, Math.min(5, Math.round(quality))) }),

      setDefaultFov: (fov: number) =>
        set({ defaultFov: Math.max(10, Math.min(120, fov)) }),

      setCameraSpeed: (speed: number) =>
        set({ cameraSpeed: Math.max(1, Math.min(10, speed)) }),

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

      resetToDefaults: () => set(DEFAULT_SETTINGS)
    }),
    {
      name: 'settings-store'
    }
  )
)
