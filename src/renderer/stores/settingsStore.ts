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

  // Camera settings
  defaultFov: number  // degrees
  cameraSpeed: number  // 1-10 scale

  // UI settings
  theme: 'light' | 'dark'
  showAircraftPanel: boolean

  // Actions
  setCesiumIonToken: (token: string) => void
  setLabelVisibilityDistance: (distance: number) => void
  setMaxAircraftDisplay: (max: number) => void
  setShowGroundTraffic: (show: boolean) => void
  setShowAirborneTraffic: (show: boolean) => void
  setDefaultFov: (fov: number) => void
  setCameraSpeed: (speed: number) => void
  setTheme: (theme: 'light' | 'dark') => void
  setShowAircraftPanel: (show: boolean) => void
  resetToDefaults: () => void
}

const DEFAULT_SETTINGS = {
  cesiumIonToken: '',
  labelVisibilityDistance: 30,  // 30 nm
  maxAircraftDisplay: 200,
  showGroundTraffic: true,
  showAirborneTraffic: true,
  defaultFov: 60,
  cameraSpeed: 5,
  theme: 'dark' as const,
  showAircraftPanel: true
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

      setDefaultFov: (fov: number) =>
        set({ defaultFov: Math.max(10, Math.min(120, fov)) }),

      setCameraSpeed: (speed: number) =>
        set({ cameraSpeed: Math.max(1, Math.min(10, speed)) }),

      setTheme: (theme: 'light' | 'dark') => set({ theme }),

      setShowAircraftPanel: (show: boolean) => set({ showAircraftPanel: show }),

      resetToDefaults: () => set(DEFAULT_SETTINGS)
    }),
    {
      name: 'settings-store'
    }
  )
)
