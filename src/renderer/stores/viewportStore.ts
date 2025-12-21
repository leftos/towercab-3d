import { create } from 'zustand'
import { persist, subscribeWithSelector } from 'zustand/middleware'

// Generate unique IDs using native crypto API
const generateId = () => crypto.randomUUID()

export type ViewMode = '3d' | 'topdown'
export type FollowMode = 'tower' | 'orbit'

// Debounce timer for auto-save
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null
const AUTO_SAVE_DELAY = 5000 // 5 seconds

// Viewport position and size (normalized 0-1 values relative to container)
export interface ViewportLayout {
  x: number      // Left edge (0 = left of container, 1 = right)
  y: number      // Top edge (0 = top of container, 1 = bottom)
  width: number  // Width (0-1)
  height: number // Height (0-1)
  zIndex: number // Stacking order for overlapping viewports
}

// State saved before following an aircraft (for restoration)
interface PreFollowState {
  heading: number
  pitch: number
  fov: number
  viewMode: ViewMode
}

// Camera state for a single viewport (mirrors cameraStore structure)
export interface ViewportCameraState {
  // View mode
  viewMode: ViewMode

  // Camera orientation (degrees)
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
  preFollowState: PreFollowState | null

  // Orbit follow mode parameters
  orbitDistance: number
  orbitHeading: number
  orbitPitch: number
}

// Complete viewport definition
export interface Viewport {
  id: string
  layout: ViewportLayout
  cameraState: ViewportCameraState
  label?: string  // Optional user-defined label
}

// Camera bookmark (just camera state without follow/pre-follow state)
interface CameraBookmark {
  viewMode: ViewMode
  heading: number
  pitch: number
  fov: number
  positionOffsetX: number
  positionOffsetY: number
  positionOffsetZ: number
  topdownAltitude: number
}

// Per-airport viewport configuration (persisted)
interface AirportViewportConfig {
  viewports: Viewport[]
  activeViewportId: string
  defaultConfig?: {
    viewports: Viewport[]
    activeViewportId: string
  }
  // Camera bookmarks (0-99) - shared across all viewports for this airport
  bookmarks?: { [slot: number]: CameraBookmark }
}

// Default camera state values
const DEFAULT_HEADING = 0
const DEFAULT_PITCH = -15
const DEFAULT_FOV = 60
const DEFAULT_FOLLOW_ZOOM = 1.0
const DEFAULT_TOPDOWN_ALTITUDE = 2000
const DEFAULT_ORBIT_DISTANCE = 500
const DEFAULT_ORBIT_HEADING = 315
const DEFAULT_ORBIT_PITCH = 15

const createDefaultCameraState = (): ViewportCameraState => ({
  viewMode: '3d',
  heading: DEFAULT_HEADING,
  pitch: DEFAULT_PITCH,
  fov: DEFAULT_FOV,
  positionOffsetX: 0,
  positionOffsetY: 0,
  positionOffsetZ: 0,
  topdownAltitude: DEFAULT_TOPDOWN_ALTITUDE,
  followingCallsign: null,
  followMode: 'tower',
  followZoom: DEFAULT_FOLLOW_ZOOM,
  preFollowState: null,
  orbitDistance: DEFAULT_ORBIT_DISTANCE,
  orbitHeading: DEFAULT_ORBIT_HEADING,
  orbitPitch: DEFAULT_ORBIT_PITCH
})

// Main viewport always uses this fixed ID so CesiumViewer can find it
const MAIN_VIEWPORT_ID = 'main'

// Create main viewport (full screen)
const createMainViewport = (): Viewport => ({
  id: MAIN_VIEWPORT_ID,
  layout: { x: 0, y: 0, width: 1, height: 1, zIndex: 0 },
  cameraState: createDefaultCameraState(),
  label: 'Main'
})

// Normalize viewports loaded from storage to ensure main viewport has fixed ID
// This handles migration from old configs that used UUIDs for main viewport
const normalizeLoadedViewports = (
  viewports: Viewport[],
  activeViewportId: string
): { viewports: Viewport[]; activeViewportId: string } => {
  if (viewports.length === 0) {
    const main = createMainViewport()
    return { viewports: [main], activeViewportId: MAIN_VIEWPORT_ID }
  }

  // Get the old main viewport ID before normalization
  const oldMainId = viewports[0].id

  // Ensure first viewport (main) has the fixed ID
  const normalizedViewports = viewports.map((v, i) => {
    if (i === 0 && v.id !== MAIN_VIEWPORT_ID) {
      return { ...v, id: MAIN_VIEWPORT_ID }
    }
    return v
  })

  // Update activeViewportId if it was pointing to the old main ID
  const normalizedActiveId = activeViewportId === oldMainId
    ? MAIN_VIEWPORT_ID
    : activeViewportId

  return { viewports: normalizedViewports, activeViewportId: normalizedActiveId }
}

// Calculate smart default position for new insets
const getNextInsetPosition = (existingViewports: Viewport[]): ViewportLayout => {
  const defaultPositions = [
    { x: 0.74, y: 0.02, width: 0.24, height: 0.30 }, // Top-right
    { x: 0.02, y: 0.02, width: 0.24, height: 0.30 }, // Top-left
    { x: 0.74, y: 0.68, width: 0.24, height: 0.30 }, // Bottom-right
    { x: 0.02, y: 0.68, width: 0.24, height: 0.30 }, // Bottom-left
  ]

  const insets = existingViewports.filter(v => v.layout.width < 0.5)
  const usedPositions = insets.map(v => ({ x: v.layout.x, y: v.layout.y }))

  // Find first unused default position
  for (const pos of defaultPositions) {
    const isUsed = usedPositions.some(
      used => Math.abs(used.x - pos.x) < 0.1 && Math.abs(used.y - pos.y) < 0.1
    )
    if (!isUsed) {
      const maxZIndex = Math.max(0, ...existingViewports.map(v => v.layout.zIndex))
      return { ...pos, zIndex: maxZIndex + 1 }
    }
  }

  // All default positions used, offset from last inset
  const lastInset = insets[insets.length - 1]
  const maxZIndex = Math.max(0, ...existingViewports.map(v => v.layout.zIndex))
  if (lastInset) {
    return {
      x: Math.min(0.74, lastInset.layout.x + 0.02),
      y: Math.min(0.68, lastInset.layout.y + 0.02),
      width: 0.24,
      height: 0.30,
      zIndex: maxZIndex + 1
    }
  }

  return { ...defaultPositions[0], zIndex: maxZIndex + 1 }
}

interface ViewportStore {
  // State
  viewports: Viewport[]
  activeViewportId: string
  currentAirportIcao: string | null
  airportViewportConfigs: Record<string, AirportViewportConfig>

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
  hasCustomDefault: () => boolean

  // Bookmark actions (0-99)
  saveBookmark: (slot: number) => void
  loadBookmark: (slot: number) => boolean  // Returns true if bookmark exists

  // Reset
  resetView: () => void

  // Selectors
  getActiveViewport: () => Viewport | undefined
  getActiveCameraState: () => ViewportCameraState
  getMainViewport: () => Viewport
  getInsetViewports: () => Viewport[]
  getViewportById: (id: string) => Viewport | undefined
}

// Helper to update a viewport's camera state
const updateViewportCameraState = (
  viewports: Viewport[],
  viewportId: string,
  updater: (state: ViewportCameraState) => Partial<ViewportCameraState>
): Viewport[] => {
  return viewports.map(viewport => {
    if (viewport.id !== viewportId) return viewport
    const updates = updater(viewport.cameraState)
    return {
      ...viewport,
      cameraState: { ...viewport.cameraState, ...updates }
    }
  })
}

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

// Migrate bookmarks from cameraStore to viewportStore (one-time migration)
const migrateCameraStoreBookmarks = (viewportState: ViewportStore) => {
  const MIGRATION_KEY = 'viewport-store-bookmark-migration-v1'
  if (localStorage.getItem(MIGRATION_KEY)) {
    return // Already migrated
  }

  try {
    // Get cameraStore data from localStorage
    const cameraStoreRaw = localStorage.getItem('camera-store')
    if (!cameraStoreRaw) {
      localStorage.setItem(MIGRATION_KEY, 'done')
      return
    }

    const cameraStoreData = JSON.parse(cameraStoreRaw)
    const airportSettings = cameraStoreData?.state?.airportSettings
    if (!airportSettings || typeof airportSettings !== 'object') {
      localStorage.setItem(MIGRATION_KEY, 'done')
      return
    }

    // Copy bookmarks from cameraStore to viewportStore for each airport
    const updatedConfigs = { ...viewportState.airportViewportConfigs }
    let hasMigrations = false

    for (const [icao, settings] of Object.entries(airportSettings)) {
      const cameraSettings = settings as { bookmarks?: Record<number, CameraBookmark> }
      if (!cameraSettings.bookmarks || Object.keys(cameraSettings.bookmarks).length === 0) {
        continue
      }

      // Ensure we have a config for this airport
      if (!updatedConfigs[icao]) {
        const mainViewport = createMainViewport()
        updatedConfigs[icao] = {
          viewports: [mainViewport],
          activeViewportId: mainViewport.id
        }
      }

      // Merge bookmarks (don't overwrite if viewportStore already has them)
      if (!updatedConfigs[icao].bookmarks) {
        updatedConfigs[icao].bookmarks = {}
      }

      for (const [slotStr, bookmark] of Object.entries(cameraSettings.bookmarks)) {
        const slot = parseInt(slotStr, 10)
        if (!updatedConfigs[icao].bookmarks![slot]) {
          updatedConfigs[icao].bookmarks![slot] = bookmark
          hasMigrations = true
        }
      }
    }

    if (hasMigrations) {
      useViewportStore.setState({ airportViewportConfigs: updatedConfigs })
      console.log('Migrated bookmarks from cameraStore to viewportStore')
    }

    localStorage.setItem(MIGRATION_KEY, 'done')
  } catch (e) {
    console.error('Failed to migrate cameraStore bookmarks:', e)
    // Mark as done to avoid repeated failures
    localStorage.setItem(MIGRATION_KEY, 'done')
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

          // Viewport management
          addViewport: (layout, copyFromViewportId) => {
            const state = get()
            const newId = generateId()
            const defaultLayout = getNextInsetPosition(state.viewports)

            // Get camera state to copy from (either specified viewport or main)
            let cameraState = createDefaultCameraState()
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
              viewports: updateViewportCameraState(viewports, activeViewportId, () => ({
                viewMode: mode
              }))
            })
          },

          toggleViewMode: () => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, (state) => ({
                viewMode: state.viewMode === '3d' ? 'topdown' : '3d'
              }))
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
            const clamped = Math.max(-90, Math.min(90, pitch))
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, () => ({
                pitch: clamped
              }))
            })
          },

          setFov: (fov) => {
            const clamped = Math.max(10, Math.min(120, fov))
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
                pitch: Math.max(-90, Math.min(90, state.pitch + delta))
              }))
            })
          },

          adjustFov: (delta) => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, (state) => ({
                fov: Math.max(10, Math.min(120, state.fov + delta))
              }))
            })
          },

          setTopdownAltitude: (altitude) => {
            const clamped = Math.max(500, Math.min(50000, altitude))
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
                topdownAltitude: Math.max(500, Math.min(50000, state.topdownAltitude + delta))
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
                return {
                  followingCallsign: callsign,
                  followZoom: DEFAULT_FOLLOW_ZOOM,
                  orbitDistance: DEFAULT_ORBIT_DISTANCE,
                  orbitHeading: DEFAULT_ORBIT_HEADING,
                  orbitPitch: DEFAULT_ORBIT_PITCH,
                  preFollowState
                }
              })
            })
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
                return {
                  followingCallsign: callsign,
                  followMode: 'orbit' as FollowMode,
                  followZoom: DEFAULT_FOLLOW_ZOOM,
                  orbitDistance: DEFAULT_ORBIT_DISTANCE,
                  orbitHeading: DEFAULT_ORBIT_HEADING,
                  orbitPitch: DEFAULT_ORBIT_PITCH,
                  preFollowState
                }
              })
            })
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
              viewports: updateViewportCameraState(viewports, activeViewportId, () => ({
                followMode: mode
              }))
            })
          },

          toggleFollowMode: () => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, (state) => {
                if (state.followingCallsign) {
                  return { followMode: state.followMode === 'tower' ? 'orbit' : 'tower' }
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

          // Orbit mode actions
          setOrbitDistance: (distance) => {
            const clamped = Math.max(50, Math.min(5000, distance))
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, () => ({
                orbitDistance: clamped
              }))
            })
          },

          adjustOrbitDistance: (delta) => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, (state) => ({
                orbitDistance: Math.max(50, Math.min(5000, state.orbitDistance + delta))
              }))
            })
          },

          setOrbitHeading: (heading) => {
            const normalized = ((heading % 360) + 360) % 360
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, () => ({
                orbitHeading: normalized
              }))
            })
          },

          adjustOrbitHeading: (delta) => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, (state) => ({
                orbitHeading: ((state.orbitHeading + delta) % 360 + 360) % 360
              }))
            })
          },

          setOrbitPitch: (pitch) => {
            const clamped = Math.max(-89, Math.min(89, pitch))
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, () => ({
                orbitPitch: clamped
              }))
            })
          },

          adjustOrbitPitch: (delta) => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, (state) => ({
                orbitPitch: Math.max(-89, Math.min(89, state.orbitPitch + delta))
              }))
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
                bookmarks: airportViewportConfigs[state.currentAirportIcao]?.bookmarks  // Preserve bookmarks
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
              const mainViewport = createMainViewport()
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

            const airportViewportConfigs = { ...state.airportViewportConfigs }
            if (!airportViewportConfigs[icao]) {
              airportViewportConfigs[icao] = {
                viewports: state.viewports,
                activeViewportId: state.activeViewportId
              }
            }

            // Save complete viewport configuration as default
            airportViewportConfigs[icao].defaultConfig = {
              viewports: state.viewports.map(v => ({
                ...v,
                cameraState: { ...v.cameraState, followingCallsign: null, preFollowState: null }
              })),
              activeViewportId: state.activeViewportId
            }

            set({ airportViewportConfigs })
          },

          resetToDefault: () => {
            const state = get()
            const icao = state.currentAirportIcao
            if (!icao) return

            const savedDefault = state.airportViewportConfigs[icao]?.defaultConfig
            if (savedDefault) {
              // Restore from saved default, ensuring main viewport keeps fixed ID
              const normalized = normalizeLoadedViewports(
                savedDefault.viewports.map(v => ({
                  ...v,
                  cameraState: { ...v.cameraState }
                })),
                savedDefault.activeViewportId
              )
              set({
                viewports: normalized.viewports,
                activeViewportId: normalized.activeViewportId
              })
            } else {
              // No saved default, reset to single main viewport with defaults
              const mainViewport = createMainViewport()
              set({
                viewports: [mainViewport],
                activeViewportId: mainViewport.id
              })
            }
          },

          hasCustomDefault: () => {
            const state = get()
            const icao = state.currentAirportIcao
            if (!icao) return false
            return !!state.airportViewportConfigs[icao]?.defaultConfig
          },

          // Save current active viewport camera state to a bookmark slot (0-99)
          saveBookmark: (slot: number) => {
            if (slot < 0 || slot > 99) return

            const state = get()
            const icao = state.currentAirportIcao
            if (!icao) return

            const activeViewport = state.viewports.find(v => v.id === state.activeViewportId)
            if (!activeViewport) return

            const cam = activeViewport.cameraState
            const bookmark: CameraBookmark = {
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

          // Reset active viewport's camera
          resetView: () => {
            const { activeViewportId, viewports } = get()
            set({
              viewports: updateViewportCameraState(viewports, activeViewportId, (state) => {
                const defaults = state.viewMode === '3d'
                  ? { heading: DEFAULT_HEADING, pitch: DEFAULT_PITCH, fov: DEFAULT_FOV }
                  : { heading: DEFAULT_HEADING, pitch: -90, fov: 60 }
                return {
                  ...defaults,
                  positionOffsetX: 0,
                  positionOffsetY: 0,
                  positionOffsetZ: 0,
                  topdownAltitude: DEFAULT_TOPDOWN_ALTITUDE,
                  followingCallsign: null,
                  followMode: 'tower' as FollowMode,
                  followZoom: DEFAULT_FOLLOW_ZOOM,
                  orbitDistance: DEFAULT_ORBIT_DISTANCE,
                  orbitHeading: DEFAULT_ORBIT_HEADING,
                  orbitPitch: DEFAULT_ORBIT_PITCH,
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
          currentAirportIcao: state.currentAirportIcao
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
            migrateCameraStoreBookmarks(state)
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
        bookmarks: airportViewportConfigs[icao]?.bookmarks  // Preserve bookmarks
      }

      useViewportStore.setState({ airportViewportConfigs })
    })
  },
  { equalityFn: (a, b) => JSON.stringify(a) === JSON.stringify(b) }
)
