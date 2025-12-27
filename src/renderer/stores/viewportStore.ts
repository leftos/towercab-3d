import { create } from 'zustand'
import { persist, subscribeWithSelector } from 'zustand/middleware'
import type { ViewMode, FollowMode, ViewportLayout, ViewportCameraState, Viewport, CameraBookmark } from '../types'
import { useVatsimStore } from './vatsimStore'
import { useAirportStore } from './airportStore'
import { useSettingsStore } from './settingsStore'
import { useGlobalSettingsStore } from './globalSettingsStore'
import { useDatablockPositionStore, type DatablockPosition } from './datablockPositionStore'
import { modService } from '../services/ModService'
import {
  HEADING_DEFAULT,
  PITCH_DEFAULT,
  PITCH_MIN,
  PITCH_MAX,
  FOV_DEFAULT,
  FOV_MIN,
  FOV_MAX,
  FOLLOW_ZOOM_DEFAULT,
  TOPDOWN_ALTITUDE_DEFAULT,
  TOPDOWN_ALTITUDE_MIN,
  TOPDOWN_ALTITUDE_MAX,
  ORBIT_DISTANCE_MIN,
  ORBIT_DISTANCE_MAX,
  ORBIT_DISTANCE_DEFAULT,
  ORBIT_HEADING_DEFAULT,
  ORBIT_PITCH_DEFAULT,
  ORBIT_PITCH_MIN,
  ORBIT_PITCH_MAX
} from '../constants'

// Import extracted modules
import {
  type GlobalOrbitSettings,
  type ViewModeDefaults,
  type AirportViewportConfig,
  MAIN_VIEWPORT_ID,
  generateId,
  createDefaultCameraState,
  createMainViewport,
  normalizeLoadedViewports,
  getNextInsetPosition,
  updateViewportCameraState,
  scheduleAutoSave
} from './viewport/viewportHelpers'

import {
  toGlobalViewportSettings,
  scheduleGlobalSync,
  getIsLoadingFromGlobal,
  setIsLoadingFromGlobal,
  mergeGlobalAirportConfig
} from './viewport/globalSettingsSync'

import {
  migrateCameraStoreBookmarks,
  migrateToGlobalSettings
} from './viewport/viewportMigrations'

import { DEFAULT_GLOBAL_VIEWPORT_SETTINGS } from '../types'

// Re-export types for consumers
export type { GlobalOrbitSettings, ViewModeDefaults, AirportViewportConfig }

// =============================================================================
// ViewportStore Interface
// =============================================================================

interface ViewportStore {
  // State
  viewports: Viewport[]
  activeViewportId: string
  currentAirportIcao: string | null
  airportViewportConfigs: Record<string, AirportViewportConfig>
  // Global orbit settings - persist last used values across all airports
  globalOrbitSettings: GlobalOrbitSettings

  // Viewport management
  addViewport: (layout?: Partial<ViewportLayout>, copyFromViewportId?: string) => string
  removeViewport: (id: string) => void
  updateViewportLayout: (id: string, layout: Partial<ViewportLayout>) => void
  setActiveViewport: (id: string) => void
  setViewportLabel: (id: string, label: string) => void
  bringToFront: (id: string) => void

  // Camera actions (operate on active viewport)
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
  moveForward: (distance: number) => void
  moveRight: (distance: number) => void
  moveUp: (distance: number) => void
  resetPosition: () => void

  // Look-at animation (smooth pan to target heading/pitch)
  setLookAtTarget: (heading: number, pitch: number) => void
  clearLookAtTarget: () => void

  // Follow actions
  followAircraft: (callsign: string) => void
  followAircraftInOrbit: (callsign: string) => void
  stopFollowing: (restoreCamera?: boolean) => void
  clearPreFollowState: () => void
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

  // Default view actions
  saveCurrentAsDefault: () => void
  resetToDefault: () => void
  resetToAppDefault: () => void  // Reset to app defaults, ignoring user-saved default
  hasCustomDefault: () => boolean

  // Bookmark actions (0-99)
  saveBookmark: (slot: number, name?: string) => void
  loadBookmark: (slot: number) => boolean  // Returns true if bookmark exists
  deleteBookmark: (slot: number) => void
  renameBookmark: (slot: number, name: string | undefined) => void
  getBookmarks: () => { [slot: number]: CameraBookmark } | undefined

  // Datablock position actions
  setDatablockPosition: (position: DatablockPosition) => void
  getDatablockPosition: () => DatablockPosition

  // Reset
  resetView: () => void

  // Selectors
  getActiveViewport: () => Viewport | undefined
  getActiveCameraState: () => ViewportCameraState
  getMainViewport: () => Viewport
  getInsetViewports: () => Viewport[]
  getViewportById: (id: string) => Viewport | undefined
}

// =============================================================================
// Sync Functions (use extracted modules)
// =============================================================================

/**
 * Sync viewportStore state to globalSettingsStore
 */
const syncToGlobalSettings = () => {
  const state = useViewportStore.getState()
  const globalSettings = toGlobalViewportSettings(
    state.airportViewportConfigs,
    state.globalOrbitSettings,
    state.currentAirportIcao
  )

  useGlobalSettingsStore.getState().setViewports(globalSettings).catch(err => {
    console.error('[ViewportStore] Failed to sync to global settings:', err)
  })
}

/**
 * Load viewport settings from globalSettingsStore and merge into viewportStore
 */
const loadFromGlobalSettings = () => {
  const globalState = useGlobalSettingsStore.getState()

  if (!globalState.initialized) {
    console.log('[ViewportStore] Global settings not initialized yet, skipping load')
    return
  }

  try {
    setIsLoadingFromGlobal(true)

    const globalViewports = globalState.viewports || DEFAULT_GLOBAL_VIEWPORT_SETTINGS

    if (!globalViewports.airportConfigs || typeof globalViewports.airportConfigs !== 'object') {
      console.warn('[ViewportStore] Global settings has invalid airportConfigs, skipping load')
      return
    }

    const state = useViewportStore.getState()
    const updatedConfigs = { ...state.airportViewportConfigs }

    for (const [icao, globalConfig] of Object.entries(globalViewports.airportConfigs)) {
      if (!globalConfig || typeof globalConfig !== 'object') {
        console.warn(`[ViewportStore] Invalid config for ${icao}, skipping`)
        continue
      }

      const localConfig = updatedConfigs[icao]
      const mergedUpdates = mergeGlobalAirportConfig(localConfig, globalConfig)

      if (localConfig) {
        updatedConfigs[icao] = { ...localConfig, ...mergedUpdates }
      } else {
        const orbitSettings = globalViewports.orbitSettings && typeof globalViewports.orbitSettings === 'object'
          ? globalViewports.orbitSettings
          : undefined
        const mainViewport = createMainViewport(undefined, orbitSettings)
        updatedConfigs[icao] = {
          viewports: [mainViewport],
          activeViewportId: mainViewport.id,
          ...mergedUpdates
        }
      }
    }

    const orbitSettings = globalViewports.orbitSettings && typeof globalViewports.orbitSettings === 'object'
      ? globalViewports.orbitSettings
      : state.globalOrbitSettings

    useViewportStore.setState({
      airportViewportConfigs: updatedConfigs,
      globalOrbitSettings: orbitSettings
    })

    console.log('[ViewportStore] Loaded from global settings')
  } catch (error) {
    console.error('[ViewportStore] Failed to load from global settings:', error)
  } finally {
    setIsLoadingFromGlobal(false)
  }
}

export const useViewportStore = create<ViewportStore>()(
  subscribeWithSelector(
    persist(
      (set, get) => {
        // Create initial main viewport
        const initialMainViewport = createMainViewport()

        return {
          // Initial state
          viewports: [initialMainViewport],
          activeViewportId: initialMainViewport.id,
          currentAirportIcao: null,
          airportViewportConfigs: {},
          globalOrbitSettings: {
            distance: ORBIT_DISTANCE_DEFAULT,
            heading: ORBIT_HEADING_DEFAULT,
            pitch: ORBIT_PITCH_DEFAULT
          },

          // Viewport management
          addViewport: (layout, copyFromViewportId) => {
            const state = get()
            const newId = generateId()
            const defaultLayout = getNextInsetPosition(state.viewports)

            // Get camera state to copy from (either specified viewport or main)
            // Use global orbit settings when creating fresh camera state
            let cameraState = createDefaultCameraState(undefined, state.globalOrbitSettings)
            if (copyFromViewportId) {
              const sourceViewport = state.viewports.find(v => v.id === copyFromViewportId)
              if (sourceViewport) {
                cameraState = { ...sourceViewport.cameraState, followingCallsign: null, preFollowState: null }
              }
            } else {
              // Copy from main viewport by default
              const mainViewport = state.viewports[0]
              if (mainViewport) {
                cameraState = { ...mainViewport.cameraState, followingCallsign: null, preFollowState: null }
              }
            }

            const newViewport: Viewport = {
              id: newId,
              layout: { ...defaultLayout, ...layout },
              cameraState
            }

            set({
              viewports: [...state.viewports, newViewport],
              activeViewportId: newId // Auto-activate new viewport
            })

            return newId
          },

          removeViewport: (id) => {
            const state = get()
            // Cannot remove main viewport (index 0)
            if (state.viewports[0]?.id === id) return
            if (state.viewports.length <= 1) return

            const newViewports = state.viewports.filter(v => v.id !== id)
            const newActiveId = state.activeViewportId === id
              ? newViewports[0].id
              : state.activeViewportId

            set({
              viewports: newViewports,
              activeViewportId: newActiveId
            })
          },

          updateViewportLayout: (id, layout) => {
            set(state => ({
              viewports: state.viewports.map(viewport =>
                viewport.id === id
                  ? { ...viewport, layout: { ...viewport.layout, ...layout } }
                  : viewport
              )
            }))
          },

          setActiveViewport: (id) => {
            const state = get()
            if (state.viewports.some(v => v.id === id)) {
              set({ activeViewportId: id })
            }
          },

          setViewportLabel: (id, label) => {
            set(state => ({
              viewports: state.viewports.map(viewport =>
                viewport.id === id ? { ...viewport, label } : viewport
              )
            }))
          },

          bringToFront: (id) => {
            const state = get()
            const maxZIndex = Math.max(...state.viewports.map(v => v.layout.zIndex))
            const viewport = state.viewports.find(v => v.id === id)
            if (viewport && viewport.layout.zIndex < maxZIndex) {
              set({
                viewports: state.viewports.map(v =>
                  v.id === id
                    ? { ...v, layout: { ...v.layout, zIndex: maxZIndex + 1 } }
                    : v
                )
              })
            }
          },

          // Camera actions - all operate on active viewport
          setViewMode: (mode) => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, (state) => {
                // Tower follow is incompatible with topdown - auto-switch to orbit follow
                if (mode === 'topdown' && state.followingCallsign && state.followMode === 'tower') {
                  return { viewMode: mode, followMode: 'orbit' as FollowMode }
                }
                return { viewMode: mode }
              })
            })
          },

          toggleViewMode: () => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, (state) => {
                const newMode = state.viewMode === '3d' ? 'topdown' : '3d'
                // Tower follow is incompatible with topdown - auto-switch to orbit follow
                if (newMode === 'topdown' && state.followingCallsign && state.followMode === 'tower') {
                  return { viewMode: newMode, followMode: 'orbit' as FollowMode }
                }
                return { viewMode: newMode }
              })
            })
          },

          setHeading: (heading) => {
            const normalized = ((heading % 360) + 360) % 360
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, () => ({
                heading: normalized
              }))
            })
          },

          setPitch: (pitch) => {
            const clamped = Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch))
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, () => ({
                pitch: clamped
              }))
            })
          },

          setFov: (fov) => {
            const clamped = Math.max(FOV_MIN, Math.min(FOV_MAX, fov))
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, () => ({
                fov: clamped
              }))
            })
          },

          adjustHeading: (delta) => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, (state) => ({
                heading: ((state.heading + delta) % 360 + 360) % 360
              }))
            })
          },

          adjustPitch: (delta) => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, (state) => ({
                pitch: Math.max(PITCH_MIN, Math.min(PITCH_MAX, state.pitch + delta))
              }))
            })
          },

          adjustFov: (delta) => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, (state) => ({
                fov: Math.max(FOV_MIN, Math.min(FOV_MAX, state.fov + delta))
              }))
            })
          },

          setTopdownAltitude: (altitude) => {
            const clamped = Math.max(TOPDOWN_ALTITUDE_MIN, Math.min(TOPDOWN_ALTITUDE_MAX, altitude))
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, () => ({
                topdownAltitude: clamped
              }))
            })
          },

          adjustTopdownAltitude: (delta) => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, (state) => ({
                topdownAltitude: Math.max(TOPDOWN_ALTITUDE_MIN, Math.min(TOPDOWN_ALTITUDE_MAX, state.topdownAltitude + delta))
              }))
            })
          },

          moveForward: (distance) => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, (state) => {
                const headingRad = state.heading * Math.PI / 180
                return {
                  positionOffsetX: state.positionOffsetX + Math.sin(headingRad) * distance,
                  positionOffsetY: state.positionOffsetY + Math.cos(headingRad) * distance
                }
              })
            })
          },

          moveRight: (distance) => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, (state) => {
                const headingRad = state.heading * Math.PI / 180
                return {
                  positionOffsetX: state.positionOffsetX + Math.cos(headingRad) * distance,
                  positionOffsetY: state.positionOffsetY - Math.sin(headingRad) * distance
                }
              })
            })
          },

          moveUp: (distance) => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, (state) => ({
                positionOffsetZ: state.positionOffsetZ + distance
              }))
            })
          },

          resetPosition: () => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, () => ({
                positionOffsetX: 0,
                positionOffsetY: 0,
                positionOffsetZ: 0
              }))
            })
          },

          // Look-at animation
          setLookAtTarget: (heading, pitch) => {
            const normalizedHeading = ((heading % 360) + 360) % 360
            const clampedPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch))
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, () => ({
                lookAtTarget: { heading: normalizedHeading, pitch: clampedPitch }
              }))
            })
          },

          clearLookAtTarget: () => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, () => ({
                lookAtTarget: null
              }))
            })
          },

          // Follow actions
          followAircraft: (callsign) => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, (state) => {
                const preFollowState = state.followingCallsign ? state.preFollowState : {
                  heading: state.heading,
                  pitch: state.pitch,
                  fov: state.fov,
                  viewMode: state.viewMode
                }
                // In topdown mode, use orbit follow (tower follow is incompatible with topdown)
                // Orbit settings persist across aircraft switches - only resetView() resets them
                // Preserve current zoom level: followZoom = baseFov / currentFov
                // If already following, keep current followZoom; otherwise calculate from FOV
                const preservedFollowZoom = state.followingCallsign
                  ? state.followZoom
                  : Math.max(0.5, Math.min(5.0, FOV_DEFAULT / state.fov))
                return {
                  followingCallsign: callsign,
                  followMode: state.viewMode === 'topdown' ? 'orbit' as FollowMode : state.followMode,
                  followZoom: preservedFollowZoom,
                  preFollowState
                }
              })
            })

            // Immediately update reference position to trigger VATSIM re-filter
            const vatsimStore = useVatsimStore.getState()
            const aircraftState = vatsimStore.aircraftStates.get(callsign)
            if (aircraftState) {
              vatsimStore.setReferencePosition(aircraftState.latitude, aircraftState.longitude)
            }
          },

          followAircraftInOrbit: (callsign) => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, (state) => {
                const preFollowState = state.followingCallsign ? state.preFollowState : {
                  heading: state.heading,
                  pitch: state.pitch,
                  fov: state.fov,
                  viewMode: state.viewMode
                }
                // Orbit settings persist across aircraft switches - only resetView() resets them
                // Preserve current zoom level: followZoom = baseFov / currentFov
                // If already following, keep current followZoom; otherwise calculate from FOV
                const preservedFollowZoom = state.followingCallsign
                  ? state.followZoom
                  : Math.max(0.5, Math.min(5.0, FOV_DEFAULT / state.fov))
                return {
                  followingCallsign: callsign,
                  followMode: 'orbit' as FollowMode,
                  followZoom: preservedFollowZoom,
                  preFollowState
                }
              })
            })

            // Immediately update reference position to trigger VATSIM re-filter
            const vatsimStore = useVatsimStore.getState()
            const aircraftState = vatsimStore.aircraftStates.get(callsign)
            if (aircraftState) {
              vatsimStore.setReferencePosition(aircraftState.latitude, aircraftState.longitude)
            }
          },

          stopFollowing: (restoreCamera = true) => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, (state) => {
                if (restoreCamera && state.preFollowState) {
                  return {
                    followingCallsign: null,
                    heading: state.preFollowState.heading,
                    pitch: state.preFollowState.pitch,
                    fov: state.preFollowState.fov,
                    preFollowState: null
                  }
                }
                return { followingCallsign: null, preFollowState: null }
              })
            })
          },

          clearPreFollowState: () => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, () => ({
                preFollowState: null
              }))
            })
          },

          setFollowMode: (mode) => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, (state) => {
                // Tower follow is incompatible with topdown - auto-switch to 3D view
                if (mode === 'tower' && state.viewMode === 'topdown') {
                  return { followMode: mode, viewMode: '3d' as ViewMode }
                }
                return { followMode: mode }
              })
            })
          },

          toggleFollowMode: () => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, (state) => {
                if (state.followingCallsign) {
                  const newFollowMode = state.followMode === 'tower' ? 'orbit' : 'tower'
                  // Tower follow is incompatible with topdown - auto-switch to 3D view
                  if (newFollowMode === 'tower' && state.viewMode === 'topdown') {
                    return { followMode: newFollowMode, viewMode: '3d' as ViewMode }
                  }
                  return { followMode: newFollowMode }
                }
                return {}
              })
            })
          },

          setFollowZoom: (zoom) => {
            const clamped = Math.max(0.5, Math.min(5.0, zoom))
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, () => ({
                followZoom: clamped
              }))
            })
          },

          adjustFollowZoom: (delta) => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, (state) => ({
                followZoom: Math.max(0.5, Math.min(5.0, state.followZoom + delta))
              }))
            })
          },

          // Orbit mode actions - also save to globalOrbitSettings for persistence
          setOrbitDistance: (distance) => {
            const clamped = Math.max(ORBIT_DISTANCE_MIN, Math.min(ORBIT_DISTANCE_MAX, distance))
            const { activeViewportId, viewports, globalOrbitSettings } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, () => ({
                orbitDistance: clamped
              })),
              globalOrbitSettings: { ...globalOrbitSettings, distance: clamped }
            })
          },

          adjustOrbitDistance: (delta) => {
            const { activeViewportId, viewports, globalOrbitSettings } = get()
            const activeViewport = viewports.find(v => v.id === activeViewportId)
            const currentDistance = activeViewport?.cameraState.orbitDistance ?? globalOrbitSettings.distance
            const newDistance = Math.max(ORBIT_DISTANCE_MIN, Math.min(ORBIT_DISTANCE_MAX, currentDistance + delta))
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, () => ({
                orbitDistance: newDistance
              })),
              globalOrbitSettings: { ...globalOrbitSettings, distance: newDistance }
            })
          },

          setOrbitHeading: (heading) => {
            const normalized = ((heading % 360) + 360) % 360
            const { activeViewportId, viewports, globalOrbitSettings } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, () => ({
                orbitHeading: normalized
              })),
              globalOrbitSettings: { ...globalOrbitSettings, heading: normalized }
            })
          },

          adjustOrbitHeading: (delta) => {
            const { activeViewportId, viewports, globalOrbitSettings } = get()
            const activeViewport = viewports.find(v => v.id === activeViewportId)
            const currentHeading = activeViewport?.cameraState.orbitHeading ?? globalOrbitSettings.heading
            const newHeading = ((currentHeading + delta) % 360 + 360) % 360
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, () => ({
                orbitHeading: newHeading
              })),
              globalOrbitSettings: { ...globalOrbitSettings, heading: newHeading }
            })
          },

          setOrbitPitch: (pitch) => {
            const clamped = Math.max(ORBIT_PITCH_MIN, Math.min(ORBIT_PITCH_MAX, pitch))
            const { activeViewportId, viewports, globalOrbitSettings } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, () => ({
                orbitPitch: clamped
              })),
              globalOrbitSettings: { ...globalOrbitSettings, pitch: clamped }
            })
          },

          adjustOrbitPitch: (delta) => {
            const { activeViewportId, viewports, globalOrbitSettings } = get()
            const activeViewport = viewports.find(v => v.id === activeViewportId)
            const currentPitch = activeViewport?.cameraState.orbitPitch ?? globalOrbitSettings.pitch
            const newPitch = Math.max(ORBIT_PITCH_MIN, Math.min(ORBIT_PITCH_MAX, currentPitch + delta))
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, () => ({
                orbitPitch: newPitch
              })),
              globalOrbitSettings: { ...globalOrbitSettings, pitch: newPitch }
            })
          },

          // Airport-specific actions
          setCurrentAirport: (icao) => {
            const state = get()
            const normalizedIcao = icao.toUpperCase()

            // Save current viewport config before switching (if we have an airport)
            if (state.currentAirportIcao && state.currentAirportIcao !== normalizedIcao) {
              const airportViewportConfigs = { ...state.airportViewportConfigs }
              airportViewportConfigs[state.currentAirportIcao] = {
                viewports: state.viewports.map(v => ({
                  ...v,
                  cameraState: { ...v.cameraState, followingCallsign: null, preFollowState: null }
                })),
                activeViewportId: state.activeViewportId,
                defaultConfig: airportViewportConfigs[state.currentAirportIcao]?.defaultConfig,
                bookmarks: airportViewportConfigs[state.currentAirportIcao]?.bookmarks,  // Preserve bookmarks
                datablockPosition: airportViewportConfigs[state.currentAirportIcao]?.datablockPosition  // Preserve datablock position
              }
              set({ airportViewportConfigs })
            }

            // Load saved config for new airport, or create default
            const savedConfig = state.airportViewportConfigs[normalizedIcao]
            if (savedConfig) {
              // Normalize to ensure main viewport has fixed ID (migration from old configs)
              const normalized = normalizeLoadedViewports(
                savedConfig.viewports,
                savedConfig.activeViewportId
              )
              set({
                currentAirportIcao: normalizedIcao,
                viewports: normalized.viewports,
                activeViewportId: normalized.activeViewportId
              })
            } else {
              // Create fresh main viewport for new airport
              // Apply custom heading from tower mod or tower-positions.json if available
              // Also apply 2D altitude from tower-positions if available
              // Use global orbit settings for consistency across airports
              const customHeading = useAirportStore.getState().customHeading ?? undefined
              const position2d = modService.get2dPosition(normalizedIcao)
              const topdownAltitude = position2d?.altitude
              const mainViewport = createMainViewport(customHeading, state.globalOrbitSettings, topdownAltitude)
              set({
                currentAirportIcao: normalizedIcao,
                viewports: [mainViewport],
                activeViewportId: mainViewport.id
              })
            }
          },

          // Default view actions
          saveCurrentAsDefault: () => {
            const state = get()
            const icao = state.currentAirportIcao
            if (!icao) return

            const activeViewport = state.viewports.find(v => v.id === state.activeViewportId)
            if (!activeViewport) return

            const airportViewportConfigs = { ...state.airportViewportConfigs }
            if (!airportViewportConfigs[icao]) {
              airportViewportConfigs[icao] = {
                viewports: state.viewports,
                activeViewportId: state.activeViewportId
              }
            }

            const cam = activeViewport.cameraState
            const defaults: ViewModeDefaults = {
              heading: cam.heading,
              pitch: cam.pitch,
              fov: cam.fov,
              positionOffsetX: cam.positionOffsetX,
              positionOffsetY: cam.positionOffsetY,
              positionOffsetZ: cam.positionOffsetZ,
              topdownAltitude: cam.topdownAltitude
            }

            // Save to the appropriate view mode slot
            if (cam.viewMode === 'topdown') {
              airportViewportConfigs[icao].default2d = defaults
            } else {
              airportViewportConfigs[icao].default3d = defaults
            }

            set({ airportViewportConfigs })
          },

          resetToDefault: () => {
            const state = get()
            const icao = state.currentAirportIcao
            if (!icao) return

            const activeViewport = state.viewports.find(v => v.id === state.activeViewportId)
            if (!activeViewport) return

            const config = state.airportViewportConfigs[icao]
            const currentViewMode = activeViewport.cameraState.viewMode
            const savedDefaults = currentViewMode === 'topdown' ? config?.default2d : config?.default3d

            if (savedDefaults) {
              // Apply saved defaults for the current view mode (doesn't change view mode)
              const updatedViewports = updateViewportCameraState(
                state.viewports,
                state.activeViewportId,
                () => {
                  const updates: Partial<ViewportCameraState> = {
                    heading: savedDefaults.heading,
                    pitch: savedDefaults.pitch,
                    fov: savedDefaults.fov,
                    positionOffsetX: savedDefaults.positionOffsetX,
                    positionOffsetY: savedDefaults.positionOffsetY,
                    positionOffsetZ: savedDefaults.positionOffsetZ
                  }
                  // Include topdown altitude for 2D mode
                  if (currentViewMode === 'topdown' && savedDefaults.topdownAltitude !== undefined) {
                    updates.topdownAltitude = savedDefaults.topdownAltitude
                  }
                  return updates
                }
              )
              set({ viewports: updatedViewports })
            } else {
              // No user-saved default for this view mode, fall back to app default
              get().resetToAppDefault()
            }
          },

          resetToAppDefault: () => {
            // Reset active viewport to app defaults based on current view mode
            // Uses view-specific settings from tower-positions if available
            // Only updates the active viewport's camera state, preserves other viewports
            const state = get()
            const icao = state.currentAirportIcao
            if (!icao) return

            const activeViewport = state.viewports.find(v => v.id === state.activeViewportId)
            if (!activeViewport) return

            const currentViewMode = activeViewport.cameraState.viewMode

            // Get view-specific defaults from tower-positions
            const position3d = modService.get3dPosition(icao)
            const position2d = modService.get2dPosition(icao)

            // Update airportStore with tower position data so camera uses it
            if (position3d) {
              useAirportStore.setState({
                customTowerPosition: position3d,
                customHeading: position3d.heading ?? 0,
                towerHeight: position3d.aglHeight
              })
            }

            // Build the new camera state for the active viewport
            let newCameraState: Partial<ViewportCameraState>

            if (currentViewMode === 'topdown') {
              // Reset 2D topdown view
              if (position2d) {
                newCameraState = {
                  positionOffsetX: 0,
                  positionOffsetY: 0,
                  positionOffsetZ: 0,
                  heading: position2d.heading ?? HEADING_DEFAULT,
                  topdownAltitude: position2d.altitude,
                  pitch: PITCH_DEFAULT,
                  fov: FOV_DEFAULT
                }
              } else if (position3d) {
                // Derive 2D from 3D: use 3D heading but default altitude
                newCameraState = {
                  positionOffsetX: 0,
                  positionOffsetY: 0,
                  positionOffsetZ: 0,
                  heading: position3d.heading ?? HEADING_DEFAULT,
                  topdownAltitude: TOPDOWN_ALTITUDE_DEFAULT,
                  pitch: PITCH_DEFAULT,
                  fov: FOV_DEFAULT
                }
              } else {
                // Pure defaults
                newCameraState = {
                  positionOffsetX: 0,
                  positionOffsetY: 0,
                  positionOffsetZ: 0,
                  heading: HEADING_DEFAULT,
                  topdownAltitude: TOPDOWN_ALTITUDE_DEFAULT,
                  pitch: PITCH_DEFAULT,
                  fov: FOV_DEFAULT
                }
              }
            } else {
              // Reset 3D view
              const heading = position3d?.heading ?? HEADING_DEFAULT
              newCameraState = {
                positionOffsetX: 0,
                positionOffsetY: 0,
                positionOffsetZ: 0,
                heading,
                pitch: PITCH_DEFAULT,
                fov: FOV_DEFAULT
              }
            }

            // Update only the active viewport's camera state
            const updatedViewports = updateViewportCameraState(
              state.viewports,
              state.activeViewportId,
              () => newCameraState
            )

            set({ viewports: updatedViewports })
          },

          hasCustomDefault: () => {
            const state = get()
            const icao = state.currentAirportIcao
            if (!icao) return false

            const activeViewport = state.viewports.find(v => v.id === state.activeViewportId)
            if (!activeViewport) return false

            const config = state.airportViewportConfigs[icao]
            const currentViewMode = activeViewport.cameraState.viewMode

            // Check for view-mode-specific saved default
            if (currentViewMode === 'topdown') {
              return !!config?.default2d
            } else {
              return !!config?.default3d
            }
          },

          // Save current active viewport camera state to a bookmark slot (0-99)
          saveBookmark: (slot: number, name?: string) => {
            if (slot < 0 || slot > 99) return

            const state = get()
            const icao = state.currentAirportIcao
            if (!icao) return

            const activeViewport = state.viewports.find(v => v.id === state.activeViewportId)
            if (!activeViewport) return

            const cam = activeViewport.cameraState
            const bookmark: CameraBookmark = {
              name,
              viewMode: cam.viewMode,
              heading: cam.heading,
              pitch: cam.pitch,
              fov: cam.fov,
              positionOffsetX: cam.positionOffsetX,
              positionOffsetY: cam.positionOffsetY,
              positionOffsetZ: cam.positionOffsetZ,
              topdownAltitude: cam.topdownAltitude
            }

            const airportViewportConfigs = { ...state.airportViewportConfigs }
            if (!airportViewportConfigs[icao]) {
              airportViewportConfigs[icao] = {
                viewports: state.viewports,
                activeViewportId: state.activeViewportId
              }
            }
            if (!airportViewportConfigs[icao].bookmarks) {
              airportViewportConfigs[icao].bookmarks = {}
            }
            airportViewportConfigs[icao].bookmarks![slot] = bookmark

            set({ airportViewportConfigs })
          },

          // Load a bookmark slot (0-99), returns true if bookmark exists
          loadBookmark: (slot: number): boolean => {
            if (slot < 0 || slot > 99) return false

            const state = get()
            const icao = state.currentAirportIcao
            if (!icao) return false

            const bookmark = state.airportViewportConfigs[icao]?.bookmarks?.[slot]
            if (!bookmark) return false

            // Apply bookmark to active viewport
            set({
              viewports: updateViewportCameraState(state.viewports, state.activeViewportId, () => ({
                viewMode: bookmark.viewMode,
                heading: bookmark.heading,
                pitch: bookmark.pitch,
                fov: bookmark.fov,
                positionOffsetX: bookmark.positionOffsetX,
                positionOffsetY: bookmark.positionOffsetY,
                positionOffsetZ: bookmark.positionOffsetZ,
                topdownAltitude: bookmark.topdownAltitude,
                followingCallsign: null,  // Stop following when loading bookmark
                preFollowState: null
              }))
            })

            return true
          },

          // Delete a bookmark slot (0-99)
          deleteBookmark: (slot: number) => {
            if (slot < 0 || slot > 99) return

            const state = get()
            const icao = state.currentAirportIcao
            if (!icao) return

            const config = state.airportViewportConfigs[icao]
            if (!config?.bookmarks?.[slot]) return

            const airportViewportConfigs = { ...state.airportViewportConfigs }
            const newBookmarks = { ...config.bookmarks }
            delete newBookmarks[slot]
            airportViewportConfigs[icao] = { ...config, bookmarks: newBookmarks }

            set({ airportViewportConfigs })
          },

          // Rename a bookmark without re-saving camera state
          renameBookmark: (slot: number, name: string | undefined) => {
            if (slot < 0 || slot > 99) return

            const state = get()
            const icao = state.currentAirportIcao
            if (!icao) return

            const config = state.airportViewportConfigs[icao]
            if (!config?.bookmarks?.[slot]) return

            const airportViewportConfigs = { ...state.airportViewportConfigs }
            const newBookmarks = { ...config.bookmarks }
            newBookmarks[slot] = { ...newBookmarks[slot], name }
            airportViewportConfigs[icao] = { ...config, bookmarks: newBookmarks }

            set({ airportViewportConfigs })
          },

          // Get all bookmarks for current airport
          getBookmarks: () => {
            const state = get()
            const icao = state.currentAirportIcao
            if (!icao) return undefined
            return state.airportViewportConfigs[icao]?.bookmarks
          },

          // Set global datablock position for current airport (clears per-aircraft overrides)
          setDatablockPosition: (position: DatablockPosition) => {
            const state = get()
            const icao = state.currentAirportIcao
            if (!icao) {
              return
            }

            // Clear all per-aircraft overrides when setting global position
            useDatablockPositionStore.getState().clearAllOverrides()

            // Create immutable update for proper state change detection
            const existingConfig = state.airportViewportConfigs[icao] ?? {
              viewports: state.viewports,
              activeViewportId: state.activeViewportId
            }
            const airportViewportConfigs = {
              ...state.airportViewportConfigs,
              [icao]: {
                ...existingConfig,
                datablockPosition: position
              }
            }

            set({ airportViewportConfigs })
          },

          // Get global datablock position for current airport (uses app default for new airports)
          getDatablockPosition: (): DatablockPosition => {
            const state = get()
            const icao = state.currentAirportIcao
            // Get app default from settings
            const appDefault = useSettingsStore.getState().aircraft.defaultDatablockDirection
            if (!icao) return appDefault
            const pos = state.airportViewportConfigs[icao]?.datablockPosition ?? appDefault
            return pos
          },

          // Reset active viewport's camera
          resetView: () => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, (state) => {
                const defaults = state.viewMode === '3d'
                  ? { heading: HEADING_DEFAULT, pitch: PITCH_DEFAULT, fov: FOV_DEFAULT }
                  : { heading: HEADING_DEFAULT, pitch: -90, fov: 60 }
                return {
                  ...defaults,
                  positionOffsetX: 0,
                  positionOffsetY: 0,
                  positionOffsetZ: 0,
                  topdownAltitude: TOPDOWN_ALTITUDE_DEFAULT,
                  followingCallsign: null,
                  followMode: 'tower' as FollowMode,
                  followZoom: FOLLOW_ZOOM_DEFAULT,
                  orbitDistance: ORBIT_DISTANCE_DEFAULT,
                  orbitHeading: ORBIT_HEADING_DEFAULT,
                  orbitPitch: ORBIT_PITCH_DEFAULT,
                  preFollowState: null
                }
              })
            })
          },

          // Selectors
          getActiveViewport: () => {
            const state = get()
            return state.viewports.find(v => v.id === state.activeViewportId)
          },

          getActiveCameraState: () => {
            const state = get()
            const activeViewport = state.viewports.find(v => v.id === state.activeViewportId)
            return activeViewport?.cameraState || createDefaultCameraState()
          },

          getMainViewport: () => {
            return get().viewports[0]
          },

          getInsetViewports: () => {
            return get().viewports.slice(1)
          },

          getViewportById: (id) => {
            return get().viewports.find(v => v.id === id)
          }
        }
      },
      {
        name: 'viewport-store',
        partialize: (state) => ({
          airportViewportConfigs: state.airportViewportConfigs,
          currentAirportIcao: state.currentAirportIcao,
          globalOrbitSettings: state.globalOrbitSettings
        }),
        onRehydrateStorage: () => (state) => {
          // After rehydration, load the saved viewport config for the current airport
          if (state && state.currentAirportIcao) {
            const icao = state.currentAirportIcao
            const savedConfig = state.airportViewportConfigs[icao]
            if (savedConfig) {
              // Normalize to ensure main viewport has fixed ID (migration from old configs)
              const normalized = normalizeLoadedViewports(
                savedConfig.viewports,
                savedConfig.activeViewportId
              )
              useViewportStore.setState({
                viewports: normalized.viewports,
                activeViewportId: normalized.activeViewportId
              })
            }
          }

          // Migrate bookmarks from cameraStore if not already migrated
          if (state) {
            migrateCameraStoreBookmarks(
              () => useViewportStore.getState(),
              (newState) => useViewportStore.setState(newState),
              syncToGlobalSettings
            )
          }

          // After rehydration, try to migrate to global settings and/or load from global
          // This runs after globalSettingsStore is initialized
          const globalState = useGlobalSettingsStore.getState()
          const runMigrations = () => {
            migrateToGlobalSettings(
              () => useGlobalSettingsStore.getState(),
              () => useViewportStore.getState(),
              syncToGlobalSettings
            )
            loadFromGlobalSettings()
          }

          if (globalState.initialized) {
            runMigrations()
          } else {
            const unsubscribe = useGlobalSettingsStore.subscribe((newState) => {
              if (newState.initialized) {
                unsubscribe()
                runMigrations()
              }
            })
          }
        }
      }
    )
  )
)

// Subscribe to viewport/camera changes and auto-save
useViewportStore.subscribe(
  (state) => ({
    viewports: state.viewports,
    activeViewportId: state.activeViewportId
  }),
  () => {
    scheduleAutoSave(() => {
      const state = useViewportStore.getState()
      const icao = state.currentAirportIcao
      if (!icao) return

      const airportViewportConfigs = { ...state.airportViewportConfigs }
      airportViewportConfigs[icao] = {
        viewports: state.viewports.map(v => ({
          ...v,
          cameraState: { ...v.cameraState, followingCallsign: null, preFollowState: null }
        })),
        activeViewportId: state.activeViewportId,
        defaultConfig: airportViewportConfigs[icao]?.defaultConfig,
        bookmarks: airportViewportConfigs[icao]?.bookmarks,  // Preserve bookmarks
        datablockPosition: airportViewportConfigs[icao]?.datablockPosition  // Preserve datablock position
      }

      useViewportStore.setState({ airportViewportConfigs })
    })
  },
  { equalityFn: (a, b) => JSON.stringify(a) === JSON.stringify(b) }
)

// Subscribe to global-relevant changes and sync to globalSettingsStore
// This syncs: airportViewportConfigs (defaults, bookmarks, datablockPosition), globalOrbitSettings
useViewportStore.subscribe(
  (state) => ({
    airportViewportConfigs: state.airportViewportConfigs,
    globalOrbitSettings: state.globalOrbitSettings,
    currentAirportIcao: state.currentAirportIcao
  }),
  () => {
    // Don't sync if global settings not initialized yet
    if (!useGlobalSettingsStore.getState().initialized) {
      return
    }

    // Debounce the sync to avoid too many writes
    scheduleGlobalSync(syncToGlobalSettings)
  },
  { equalityFn: (a, b) => JSON.stringify(a) === JSON.stringify(b) }
)
