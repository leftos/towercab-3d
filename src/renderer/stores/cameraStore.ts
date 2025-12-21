import { create } from 'zustand'
import { persist, subscribeWithSelector } from 'zustand/middleware'
import type { ViewMode, FollowMode } from '../types'

// Debounce timer for auto-save
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null
const AUTO_SAVE_DELAY = 5000 // 5 seconds

// Camera settings for a single view mode
interface ViewSettings {
  heading: number
  pitch: number
  fov: number
  positionOffsetX: number
  positionOffsetY: number
  positionOffsetZ: number
  topdownAltitude: number
}

// Camera bookmark (numbered position save)
interface CameraBookmark extends ViewSettings {
  viewMode: ViewMode
}

// Per-airport camera settings (both view modes)
interface AirportCameraSettings {
  '3d': ViewSettings
  'topdown': ViewSettings
  lastViewMode: ViewMode
  // User-defined defaults (optional - if not set, uses global defaults)
  'default3d'?: ViewSettings
  'defaultTopdown'?: ViewSettings
  // Camera bookmarks (0-99)
  bookmarks?: { [slot: number]: CameraBookmark }
}

// Storage format for persisted settings
interface PersistedCameraSettings {
  [icao: string]: AirportCameraSettings
}

// State saved before following an aircraft (for restoration)
interface PreFollowState {
  heading: number
  pitch: number
  fov: number
  viewMode: ViewMode
}

interface CameraStore {
  // Current view mode
  viewMode: ViewMode

  // Current airport ICAO (for tracking which airport's settings we're using)
  currentAirportIcao: string | null

  // Current camera orientation (degrees)
  heading: number
  pitch: number
  fov: number

  // Position offset from tower (meters, in local ENU coordinates)
  positionOffsetX: number
  positionOffsetY: number
  positionOffsetZ: number

  // Top-down view altitude (meters above airport)
  topdownAltitude: number

  // Follow mode
  followingCallsign: string | null
  followMode: FollowMode
  followZoom: number
  preFollowState: PreFollowState | null  // Camera state before following started

  // Orbit follow mode parameters
  orbitDistance: number    // Distance from aircraft in meters
  orbitHeading: number     // Angle around aircraft (0=behind, relative to aircraft heading)
  orbitPitch: number       // Angle above/below aircraft level (-89 to 89)

  // Persisted per-airport settings
  airportSettings: PersistedCameraSettings

  // Actions
  setViewMode: (mode: ViewMode) => void
  toggleViewMode: () => void
  setHeading: (heading: number) => void
  setPitch: (pitch: number) => void
  setFov: (fov: number) => void
  adjustHeading: (delta: number) => void
  adjustPitch: (delta: number) => void
  adjustFov: (delta: number) => void
  setTopdownAltitude: (altitude: number) => void
  adjustTopdownAltitude: (delta: number) => void

  // Position movement (WASD)
  moveForward: (distance: number) => void
  moveRight: (distance: number) => void
  moveUp: (distance: number) => void
  resetPosition: () => void

  // Follow actions
  followAircraft: (callsign: string) => void
  followAircraftInOrbit: (callsign: string) => void
  stopFollowing: (restoreCamera?: boolean) => void
  clearPreFollowState: () => void  // Clear saved state (e.g., when user manually drags)
  setFollowMode: (mode: FollowMode) => void
  toggleFollowMode: () => void
  setFollowZoom: (zoom: number) => void
  adjustFollowZoom: (delta: number) => void

  // Orbit mode actions
  setOrbitDistance: (distance: number) => void
  adjustOrbitDistance: (delta: number) => void
  setOrbitHeading: (heading: number) => void
  adjustOrbitHeading: (delta: number) => void
  setOrbitPitch: (pitch: number) => void
  adjustOrbitPitch: (delta: number) => void

  // Airport-specific actions
  setCurrentAirport: (icao: string) => void
  saveCurrentViewSettings: () => void
  loadViewSettings: (mode: ViewMode) => void

  // Default view actions
  saveCurrentAsDefault: () => void
  resetToDefault: () => void
  hasCustomDefault: () => boolean

  // Bookmark actions (0-99)
  saveBookmark: (slot: number) => void
  loadBookmark: (slot: number) => boolean  // Returns true if bookmark exists

  // Reset
  resetView: () => void
}

const DEFAULT_HEADING = 0
const DEFAULT_PITCH = -15
const DEFAULT_FOV = 60
const DEFAULT_FOLLOW_ZOOM = 1.0
const DEFAULT_TOPDOWN_ALTITUDE = 2000

// Orbit follow mode defaults
const DEFAULT_ORBIT_DISTANCE = 500    // meters
const DEFAULT_ORBIT_HEADING = 315     // back-left of aircraft (0=behind, 90=right, 180=front, 270=left)
const DEFAULT_ORBIT_PITCH = 15        // 15 degree angle above aircraft

const DEFAULT_3D_SETTINGS: ViewSettings = {
  heading: DEFAULT_HEADING,
  pitch: DEFAULT_PITCH,
  fov: DEFAULT_FOV,
  positionOffsetX: 0,
  positionOffsetY: 0,
  positionOffsetZ: 0,
  topdownAltitude: DEFAULT_TOPDOWN_ALTITUDE
}

const DEFAULT_TOPDOWN_SETTINGS: ViewSettings = {
  heading: DEFAULT_HEADING,
  pitch: -90,  // Looking straight down
  fov: 60,
  positionOffsetX: 0,
  positionOffsetY: 0,
  positionOffsetZ: 0,
  topdownAltitude: DEFAULT_TOPDOWN_ALTITUDE
}

const getDefaultAirportSettings = (): AirportCameraSettings => ({
  '3d': { ...DEFAULT_3D_SETTINGS },
  'topdown': { ...DEFAULT_TOPDOWN_SETTINGS },
  lastViewMode: '3d'
})

// Schedule a debounced auto-save
const scheduleAutoSave = (saveFunc: () => void) => {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer)
  }
  autoSaveTimer = setTimeout(() => {
    saveFunc()
    autoSaveTimer = null
  }, AUTO_SAVE_DELAY)
}

export const useCameraStore = create<CameraStore>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
      // Initial state
      viewMode: '3d' as ViewMode,
      currentAirportIcao: null,
      heading: DEFAULT_HEADING,
      pitch: DEFAULT_PITCH,
      fov: DEFAULT_FOV,
      positionOffsetX: 0,
      positionOffsetY: 0,
      positionOffsetZ: 0,
      topdownAltitude: DEFAULT_TOPDOWN_ALTITUDE,
      followingCallsign: null,
      followMode: 'tower' as FollowMode,
      followZoom: DEFAULT_FOLLOW_ZOOM,
      preFollowState: null,
      orbitDistance: DEFAULT_ORBIT_DISTANCE,
      orbitHeading: DEFAULT_ORBIT_HEADING,
      orbitPitch: DEFAULT_ORBIT_PITCH,
      airportSettings: {},

      // Save current view settings to the persisted store
      saveCurrentViewSettings: () => {
        const state = get()
        const icao = state.currentAirportIcao
        if (!icao) return

        const currentSettings: ViewSettings = {
          heading: state.heading,
          pitch: state.pitch,
          fov: state.fov,
          positionOffsetX: state.positionOffsetX,
          positionOffsetY: state.positionOffsetY,
          positionOffsetZ: state.positionOffsetZ,
          topdownAltitude: state.topdownAltitude
        }

        const airportSettings = { ...state.airportSettings }
        if (!airportSettings[icao]) {
          airportSettings[icao] = getDefaultAirportSettings()
        }
        airportSettings[icao][state.viewMode] = currentSettings
        airportSettings[icao].lastViewMode = state.viewMode

        set({ airportSettings })
      },

      // Load settings for a specific view mode
      loadViewSettings: (mode: ViewMode) => {
        const state = get()
        const icao = state.currentAirportIcao
        if (!icao) return

        const settings = state.airportSettings[icao]?.[mode]
        if (settings) {
          set({
            heading: settings.heading,
            pitch: settings.pitch,
            fov: settings.fov,
            positionOffsetX: settings.positionOffsetX,
            positionOffsetY: settings.positionOffsetY,
            positionOffsetZ: settings.positionOffsetZ,
            topdownAltitude: settings.topdownAltitude
          })
        } else {
          // Use defaults for this mode
          const defaults = mode === '3d' ? DEFAULT_3D_SETTINGS : DEFAULT_TOPDOWN_SETTINGS
          set({
            heading: defaults.heading,
            pitch: defaults.pitch,
            fov: defaults.fov,
            positionOffsetX: defaults.positionOffsetX,
            positionOffsetY: defaults.positionOffsetY,
            positionOffsetZ: defaults.positionOffsetZ,
            topdownAltitude: defaults.topdownAltitude
          })
        }
      },

      // Set current airport and load its settings
      setCurrentAirport: (icao: string) => {
        const state = get()
        const normalizedIcao = icao.toUpperCase()

        // Save current airport's settings before switching (only if switching to a different airport)
        if (state.currentAirportIcao && state.currentAirportIcao !== normalizedIcao) {
          state.saveCurrentViewSettings()
        }

        // Initialize settings for new airport if needed
        const airportSettings = { ...state.airportSettings }
        if (!airportSettings[normalizedIcao]) {
          airportSettings[normalizedIcao] = getDefaultAirportSettings()
        }

        // Get the saved view mode for this airport (default to '3d' for legacy settings)
        const savedViewMode = airportSettings[normalizedIcao].lastViewMode || '3d'

        set({
          currentAirportIcao: normalizedIcao,
          airportSettings,
          viewMode: savedViewMode,
          // Stop following any aircraft when switching airports
          followingCallsign: null
        })

        // Load settings for the saved view mode
        get().loadViewSettings(savedViewMode)
      },

      // View mode
      setViewMode: (mode: ViewMode) => {
        const state = get()
        if (mode === state.viewMode) return

        // Save current view settings before switching
        state.saveCurrentViewSettings()

        set({ viewMode: mode })

        // Load settings for new view mode
        get().loadViewSettings(mode)
      },

      toggleViewMode: () => {
        const { viewMode, setViewMode } = get()
        setViewMode(viewMode === '3d' ? 'topdown' : '3d')
      },

      // Setters
      setHeading: (heading: number) => {
        const normalized = ((heading % 360) + 360) % 360
        set({ heading: normalized })
      },

      setPitch: (pitch: number) => {
        const clamped = Math.max(-90, Math.min(90, pitch))
        set({ pitch: clamped })
      },

      setFov: (fov: number) => {
        const clamped = Math.max(10, Math.min(120, fov))
        set({ fov: clamped })
      },

      setTopdownAltitude: (altitude: number) => {
        const clamped = Math.max(500, Math.min(50000, altitude))
        set({ topdownAltitude: clamped })
      },

      // Adjusters
      adjustHeading: (delta: number) => {
        const { heading, setHeading } = get()
        setHeading(heading + delta)
      },

      adjustPitch: (delta: number) => {
        const { pitch, setPitch } = get()
        setPitch(pitch + delta)
      },

      adjustFov: (delta: number) => {
        const { fov, setFov } = get()
        setFov(fov + delta)
      },

      adjustTopdownAltitude: (delta: number) => {
        const { topdownAltitude, setTopdownAltitude } = get()
        setTopdownAltitude(topdownAltitude + delta)
      },

      // Position movement (relative to camera heading)
      moveForward: (distance: number) => {
        const { heading, positionOffsetX, positionOffsetY } = get()
        const headingRad = heading * Math.PI / 180
        set({
          positionOffsetX: positionOffsetX + Math.sin(headingRad) * distance,
          positionOffsetY: positionOffsetY + Math.cos(headingRad) * distance
        })
      },

      moveRight: (distance: number) => {
        const { heading, positionOffsetX, positionOffsetY } = get()
        const headingRad = heading * Math.PI / 180
        set({
          positionOffsetX: positionOffsetX + Math.cos(headingRad) * distance,
          positionOffsetY: positionOffsetY - Math.sin(headingRad) * distance
        })
      },

      moveUp: (distance: number) => {
        const { positionOffsetZ } = get()
        set({ positionOffsetZ: positionOffsetZ + distance })
      },

      resetPosition: () => {
        set({
          positionOffsetX: 0,
          positionOffsetY: 0,
          positionOffsetZ: 0
        })
      },

      // Follow mode
      followAircraft: (callsign: string) => {
        const state = get()
        // Save current camera state before starting to follow (only if not already following)
        const preFollowState = state.followingCallsign ? state.preFollowState : {
          heading: state.heading,
          pitch: state.pitch,
          fov: state.fov,
          viewMode: state.viewMode
        }
        set({
          followingCallsign: callsign,
          followZoom: DEFAULT_FOLLOW_ZOOM,
          orbitDistance: DEFAULT_ORBIT_DISTANCE,
          orbitHeading: DEFAULT_ORBIT_HEADING,
          orbitPitch: DEFAULT_ORBIT_PITCH,
          preFollowState
        })
      },

      followAircraftInOrbit: (callsign: string) => {
        const state = get()
        // Save current camera state before starting to follow (only if not already following)
        const preFollowState = state.followingCallsign ? state.preFollowState : {
          heading: state.heading,
          pitch: state.pitch,
          fov: state.fov,
          viewMode: state.viewMode
        }
        set({
          followingCallsign: callsign,
          followMode: 'orbit' as FollowMode,
          followZoom: DEFAULT_FOLLOW_ZOOM,
          orbitDistance: DEFAULT_ORBIT_DISTANCE,
          orbitHeading: DEFAULT_ORBIT_HEADING,
          orbitPitch: DEFAULT_ORBIT_PITCH,
          preFollowState
        })
      },

      stopFollowing: (restoreCamera = true) => {
        const state = get()
        if (restoreCamera && state.preFollowState) {
          // Restore camera to pre-follow state
          set({
            followingCallsign: null,
            heading: state.preFollowState.heading,
            pitch: state.preFollowState.pitch,
            fov: state.preFollowState.fov,
            preFollowState: null
          })
        } else {
          set({ followingCallsign: null, preFollowState: null })
        }
      },

      clearPreFollowState: () => {
        set({ preFollowState: null })
      },

      setFollowMode: (mode: FollowMode) => {
        set({ followMode: mode })
      },

      toggleFollowMode: () => {
        const { followMode, followingCallsign } = get()
        if (followingCallsign) {
          set({ followMode: followMode === 'tower' ? 'orbit' : 'tower' })
        }
      },

      setFollowZoom: (zoom: number) => {
        const clamped = Math.max(0.5, Math.min(5.0, zoom))
        set({ followZoom: clamped })
      },

      adjustFollowZoom: (delta: number) => {
        const { followZoom, setFollowZoom } = get()
        setFollowZoom(followZoom + delta)
      },

      // Orbit mode actions
      setOrbitDistance: (distance: number) => {
        const clamped = Math.max(50, Math.min(5000, distance))
        set({ orbitDistance: clamped })
      },

      adjustOrbitDistance: (delta: number) => {
        const { orbitDistance, setOrbitDistance } = get()
        setOrbitDistance(orbitDistance + delta)
      },

      setOrbitHeading: (heading: number) => {
        const normalized = ((heading % 360) + 360) % 360
        set({ orbitHeading: normalized })
      },

      adjustOrbitHeading: (delta: number) => {
        const { orbitHeading, setOrbitHeading } = get()
        setOrbitHeading(orbitHeading + delta)
      },

      setOrbitPitch: (pitch: number) => {
        const clamped = Math.max(-89, Math.min(89, pitch))
        set({ orbitPitch: clamped })
      },

      adjustOrbitPitch: (delta: number) => {
        const { orbitPitch, setOrbitPitch } = get()
        setOrbitPitch(orbitPitch + delta)
      },

      // Save current view as the default for this airport/view mode
      saveCurrentAsDefault: () => {
        const state = get()
        const icao = state.currentAirportIcao
        if (!icao) return

        const currentSettings: ViewSettings = {
          heading: state.heading,
          pitch: state.pitch,
          fov: state.fov,
          positionOffsetX: state.positionOffsetX,
          positionOffsetY: state.positionOffsetY,
          positionOffsetZ: state.positionOffsetZ,
          topdownAltitude: state.topdownAltitude
        }

        const airportSettings = { ...state.airportSettings }
        if (!airportSettings[icao]) {
          airportSettings[icao] = getDefaultAirportSettings()
        }

        // Save to the appropriate default key based on current view mode
        if (state.viewMode === '3d') {
          airportSettings[icao].default3d = { ...currentSettings }
        } else {
          airportSettings[icao].defaultTopdown = { ...currentSettings }
        }

        set({ airportSettings })
      },

      // Reset to the user-defined default (or global default if none set)
      resetToDefault: () => {
        const state = get()
        const icao = state.currentAirportIcao

        // Get the default settings for current view mode
        let defaults: ViewSettings
        if (icao && state.airportSettings[icao]) {
          const airportDefaults = state.viewMode === '3d'
            ? state.airportSettings[icao].default3d
            : state.airportSettings[icao].defaultTopdown

          defaults = airportDefaults || (state.viewMode === '3d' ? DEFAULT_3D_SETTINGS : DEFAULT_TOPDOWN_SETTINGS)
        } else {
          defaults = state.viewMode === '3d' ? DEFAULT_3D_SETTINGS : DEFAULT_TOPDOWN_SETTINGS
        }

        set({
          heading: defaults.heading,
          pitch: defaults.pitch,
          fov: defaults.fov,
          positionOffsetX: defaults.positionOffsetX,
          positionOffsetY: defaults.positionOffsetY,
          positionOffsetZ: defaults.positionOffsetZ,
          topdownAltitude: defaults.topdownAltitude,
          followingCallsign: null,
          followMode: 'tower' as FollowMode,
          followZoom: DEFAULT_FOLLOW_ZOOM
        })
      },

      // Check if the current airport has a custom default for current view mode
      hasCustomDefault: () => {
        const state = get()
        const icao = state.currentAirportIcao
        if (!icao || !state.airportSettings[icao]) return false

        return state.viewMode === '3d'
          ? !!state.airportSettings[icao].default3d
          : !!state.airportSettings[icao].defaultTopdown
      },

      // Save current camera state to a bookmark slot (0-99)
      saveBookmark: (slot: number) => {
        if (slot < 0 || slot > 99) return

        const state = get()
        const icao = state.currentAirportIcao
        if (!icao) return

        const bookmark: CameraBookmark = {
          heading: state.heading,
          pitch: state.pitch,
          fov: state.fov,
          positionOffsetX: state.positionOffsetX,
          positionOffsetY: state.positionOffsetY,
          positionOffsetZ: state.positionOffsetZ,
          topdownAltitude: state.topdownAltitude,
          viewMode: state.viewMode
        }

        const airportSettings = { ...state.airportSettings }
        if (!airportSettings[icao]) {
          airportSettings[icao] = getDefaultAirportSettings()
        }
        if (!airportSettings[icao].bookmarks) {
          airportSettings[icao].bookmarks = {}
        }
        airportSettings[icao].bookmarks![slot] = bookmark

        set({ airportSettings })
      },

      // Load a bookmark slot (0-99), returns true if bookmark exists
      loadBookmark: (slot: number): boolean => {
        if (slot < 0 || slot > 99) return false

        const state = get()
        const icao = state.currentAirportIcao
        if (!icao) return false

        const bookmark = state.airportSettings[icao]?.bookmarks?.[slot]
        if (!bookmark) return false

        set({
          heading: bookmark.heading,
          pitch: bookmark.pitch,
          fov: bookmark.fov,
          positionOffsetX: bookmark.positionOffsetX,
          positionOffsetY: bookmark.positionOffsetY,
          positionOffsetZ: bookmark.positionOffsetZ,
          topdownAltitude: bookmark.topdownAltitude,
          viewMode: bookmark.viewMode,
          followingCallsign: null,  // Stop following when loading bookmark
          preFollowState: null
        })

        return true
      },

      // Reset all
      resetView: () => {
        const state = get()
        const viewMode = state.viewMode
        const defaults = viewMode === '3d' ? DEFAULT_3D_SETTINGS : DEFAULT_TOPDOWN_SETTINGS

        set({
          heading: defaults.heading,
          pitch: defaults.pitch,
          fov: defaults.fov,
          positionOffsetX: 0,
          positionOffsetY: 0,
          positionOffsetZ: 0,
          topdownAltitude: defaults.topdownAltitude,
          followingCallsign: null,
          followMode: 'tower' as FollowMode,
          followZoom: DEFAULT_FOLLOW_ZOOM,
          orbitDistance: DEFAULT_ORBIT_DISTANCE,
          orbitHeading: DEFAULT_ORBIT_HEADING,
          orbitPitch: DEFAULT_ORBIT_PITCH
        })
      }
    }),
      {
        name: 'camera-store',
        partialize: (state) => ({
          airportSettings: state.airportSettings,
          currentAirportIcao: state.currentAirportIcao
        }),
        onRehydrateStorage: () => (state) => {
          // After rehydration, load the saved camera settings for the current airport
          if (state && state.currentAirportIcao) {
            const icao = state.currentAirportIcao
            const settings = state.airportSettings[icao]
            if (settings) {
              // Get the saved view mode (default to '3d' for legacy settings)
              const savedViewMode = settings.lastViewMode || '3d'
              const viewSettings = settings[savedViewMode]
              if (viewSettings) {
                // Apply the saved settings
                useCameraStore.setState({
                  viewMode: savedViewMode,
                  heading: viewSettings.heading,
                  pitch: viewSettings.pitch,
                  fov: viewSettings.fov,
                  positionOffsetX: viewSettings.positionOffsetX,
                  positionOffsetY: viewSettings.positionOffsetY,
                  positionOffsetZ: viewSettings.positionOffsetZ,
                  topdownAltitude: viewSettings.topdownAltitude
                })
              }
            }
          }
        }
      }
    )
  )
)

// Subscribe to camera setting changes and auto-save after 5 seconds of inactivity
useCameraStore.subscribe(
  (state) => ({
    heading: state.heading,
    pitch: state.pitch,
    fov: state.fov,
    positionOffsetX: state.positionOffsetX,
    positionOffsetY: state.positionOffsetY,
    positionOffsetZ: state.positionOffsetZ,
    topdownAltitude: state.topdownAltitude
  }),
  () => {
    // Schedule auto-save when any camera setting changes
    scheduleAutoSave(() => {
      useCameraStore.getState().saveCurrentViewSettings()
    })
  },
  { equalityFn: (a, b) => JSON.stringify(a) === JSON.stringify(b) }
)
