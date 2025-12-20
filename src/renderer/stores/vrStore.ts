import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'

interface VRStore {
  // VR support detection
  isVRSupported: boolean

  // VR session state
  isVRActive: boolean
  vrError: string | null

  // VR settings
  ipd: number  // Interpupillary distance in meters (default 0.063 = 63mm)
  renderScale: number  // 0.5-1.0 for quality vs performance
  maxAircraftInVR: number  // Limit aircraft count for performance

  // Actions
  setVRSupported: (supported: boolean) => void
  setVRActive: (active: boolean) => void
  setVRError: (error: string | null) => void
  setIPD: (ipd: number) => void
  setRenderScale: (scale: number) => void
  setMaxAircraftInVR: (count: number) => void

  // Check WebXR support (call on app init)
  checkVRSupport: () => Promise<void>
}

// Default interpupillary distance (average human IPD)
const DEFAULT_IPD = 0.063  // 63mm in meters

export const useVRStore = create<VRStore>()(
  subscribeWithSelector((set) => ({
    // Initial state
    isVRSupported: false,
    isVRActive: false,
    vrError: null,
    ipd: DEFAULT_IPD,
    renderScale: 1.0,
    maxAircraftInVR: 50,

    // Actions
    setVRSupported: (supported: boolean) => set({ isVRSupported: supported }),

    setVRActive: (active: boolean) => set({ isVRActive: active }),

    setVRError: (error: string | null) => set({ vrError: error }),

    setIPD: (ipd: number) => {
      // Clamp to reasonable range (50mm - 80mm)
      const clamped = Math.max(0.050, Math.min(0.080, ipd))
      set({ ipd: clamped })
    },

    setRenderScale: (scale: number) => {
      const clamped = Math.max(0.5, Math.min(1.0, scale))
      set({ renderScale: clamped })
    },

    setMaxAircraftInVR: (count: number) => {
      const clamped = Math.max(10, Math.min(100, count))
      set({ maxAircraftInVR: clamped })
    },

    checkVRSupport: async () => {
      try {
        if ('xr' in navigator) {
          const xr = (navigator as Navigator & { xr: XRSystem }).xr
          const isSupported = await xr.isSessionSupported('immersive-vr')
          set({ isVRSupported: isSupported })
        } else {
          set({ isVRSupported: false })
        }
      } catch (error) {
        console.warn('Failed to check WebXR support:', error)
        set({ isVRSupported: false })
      }
    }
  }))
)
