import { useMemo } from 'react'
import { useViewportStore } from '../stores/viewportStore'
import type { ViewportCameraState, ViewMode, FollowMode } from '@/types'

/**
 * Provides reactive access to the active viewport's camera state and control actions.
 *
 * ## Responsibilities
 * - Identifies the currently active viewport from the viewport store
 * - Provides read access to all camera state properties (heading, pitch, FOV, follow mode, etc.)
 * - Provides all camera control actions (setHeading, adjustFov, followAircraft, etc.)
 * - Automatically updates when active viewport changes or camera state changes
 * - Provides sensible defaults when no viewport is active
 *
 * ## Dependencies
 * - Requires: `viewportStore` to be initialized
 * - Reads: `viewportStore` (viewports array, activeViewportId)
 * - Writes: Via returned actions (all modify the active viewport's camera state)
 *
 * ## Call Order
 * This hook can be called in any component that needs to read or control the active viewport's camera:
 * ```typescript
 * function CameraControls() {
 *   // Get camera state and actions for active viewport
 *   const {
 *     heading,
 *     pitch,
 *     fov,
 *     followingCallsign,
 *     setHeading,
 *     adjustPitch,
 *     followAircraft
 *   } = useActiveViewportCamera()
 *
 *   return (
 *     <div>
 *       <div>Heading: {heading.toFixed(1)}°</div>
 *       <button onClick={() => followAircraft('DAL123')}>
 *         Follow DAL123
 *       </button>
 *     </div>
 *   )
 * }
 * ```
 *
 * ## Active Viewport Concept
 *
 * Only one viewport can be **active** at a time:
 * - Active viewport receives keyboard/mouse input
 * - Active viewport is indicated by cyan border in UI
 * - Clicking a viewport makes it active
 * - Camera controls (keyboard, UI sliders) affect the active viewport's camera
 *
 * This hook always operates on the **active** viewport, regardless of how many viewports exist.
 *
 * ## State vs Actions
 *
 * This hook returns two categories of values:
 *
 * ### State Values (Read-Only)
 * - `activeViewportId`: ID of the active viewport
 * - `activeViewport`: Full viewport object
 * - `viewMode`: Current view mode ('3d' or 'topdown')
 * - `heading`: Camera heading in degrees (0-360)
 * - `pitch`: Camera pitch in degrees (-90 to 90)
 * - `fov`: Field of view in degrees (10-120)
 * - `positionOffsetX/Y/Z`: Camera position offset in meters
 * - `topdownAltitude`: Camera altitude in top-down mode (meters)
 * - `followingCallsign`: Callsign of followed aircraft (or null)
 * - `followMode`: Follow mode ('tower' or 'orbit')
 * - `followZoom`: Zoom level in tower follow mode
 * - `orbitDistance/Heading/Pitch`: Orbit mode parameters
 * - `preFollowState`: Camera state before following (for restoration)
 *
 * ### Actions (Mutators)
 * - **Absolute setters**: `setViewMode()`, `setHeading()`, `setPitch()`, `setFov()`
 * - **Relative adjusters**: `adjustHeading()`, `adjustPitch()`, `adjustFov()`
 * - **Position**: `moveForward()`, `moveRight()`, `moveUp()`
 * - **Reset**: `resetPosition()`, `resetView()`
 * - **Follow**: `followAircraft()`, `stopFollowing()`, `toggleFollowMode()`
 * - **Orbit**: `setOrbitDistance()`, `adjustOrbitHeading()`, etc.
 *
 * ## Default Values
 *
 * If no viewport is active (e.g., during initialization), the hook returns default values:
 * - `viewMode`: '3d'
 * - `heading`: 0
 * - `pitch`: -15
 * - `fov`: 60
 * - `followingCallsign`: null
 * - etc.
 *
 * This prevents errors when rendering UI before viewports are initialized.
 *
 * ## Reactivity
 *
 * The hook uses `useMemo` to efficiently detect changes:
 * - Re-executes when `viewports` array changes (camera state updates)
 * - Re-executes when `activeViewportId` changes (different viewport selected)
 * - Does NOT re-execute on unrelated store changes
 *
 * This ensures components using this hook only re-render when necessary.
 *
 * ## Multi-Viewport Workflow
 *
 * In a multi-viewport setup:
 * 1. User clicks an inset viewport → it becomes active
 * 2. `useActiveViewportCamera()` now returns that viewport's camera state
 * 3. UI controls (sliders, buttons) now affect that viewport
 * 4. User clicks main viewport → it becomes active
 * 5. Hook returns main viewport's camera state
 *
 * This allows a single set of UI controls to operate on whichever viewport is active.
 *
 * ## Simplified Hook
 *
 * For components that only need to **read** camera state (not modify it), use the simplified hook:
 * ```typescript
 * const cameraState = useActiveViewportCameraState()
 * // Returns just the ViewportCameraState object, no actions
 * ```
 *
 * This is more efficient when actions aren't needed.
 *
 * @returns Active viewport camera state and control actions
 *
 * @example
 * // Basic usage in controls UI
 * function ControlsBar() {
 *   const { heading, pitch, fov, adjustHeading, adjustPitch } = useActiveViewportCamera()
 *
 *   return (
 *     <div>
 *       <label>
 *         Heading: {heading.toFixed(1)}°
 *         <input
 *           type="range"
 *           min={0}
 *           max={360}
 *           value={heading}
 *           onChange={(e) => adjustHeading(parseFloat(e.target.value) - heading)}
 *         />
 *       </label>
 *     </div>
 *   )
 * }
 *
 * @example
 * // Following aircraft with state display
 * function FollowControls() {
 *   const {
 *     followingCallsign,
 *     followMode,
 *     followAircraft,
 *     stopFollowing,
 *     toggleFollowMode
 *   } = useActiveViewportCamera()
 *
 *   if (!followingCallsign) {
 *     return (
 *       <button onClick={() => followAircraft('UAL456')}>
 *         Follow UAL456
 *       </button>
 *     )
 *   }
 *
 *   return (
 *     <div>
 *       Following: {followingCallsign} ({followMode} mode)
 *       <button onClick={toggleFollowMode}>
 *         Switch to {followMode === 'tower' ? 'orbit' : 'tower'}
 *       </button>
 *       <button onClick={stopFollowing}>Stop Following</button>
 *     </div>
 *   )
 * }
 *
 * @example
 * // Read-only usage with simplified hook
 * function CameraDebugInfo() {
 *   const cameraState = useActiveViewportCameraState()
 *
 *   if (!cameraState) return <div>No active viewport</div>
 *
 *   return (
 *     <div>
 *       <div>Heading: {cameraState.heading.toFixed(1)}°</div>
 *       <div>Pitch: {cameraState.pitch.toFixed(1)}°</div>
 *       <div>FOV: {cameraState.fov.toFixed(1)}°</div>
 *     </div>
 *   )
 * }
 *
 * @see viewportStore - For viewport and camera state management
 * @see ViewportManager.tsx - For viewport activation and rendering
 * @see ControlsBar.tsx - Primary consumer of this hook for camera controls UI
 */
export function useActiveViewportCamera() {
  const viewports = useViewportStore((state) => state.viewports)
  const activeViewportId = useViewportStore((state) => state.activeViewportId)

  // Memoize finding the active viewport to prevent unnecessary recalculations
  const activeViewport = useMemo(
    () => viewports.find(v => v.id === activeViewportId),
    [viewports, activeViewportId]
  )

  const cameraState = activeViewport?.cameraState

  // Actions from the store
  const setViewMode = useViewportStore((state) => state.setViewMode)
  const toggleViewMode = useViewportStore((state) => state.toggleViewMode)
  const setHeading = useViewportStore((state) => state.setHeading)
  const setPitch = useViewportStore((state) => state.setPitch)
  const setFov = useViewportStore((state) => state.setFov)
  const adjustHeading = useViewportStore((state) => state.adjustHeading)
  const adjustPitch = useViewportStore((state) => state.adjustPitch)
  const adjustFov = useViewportStore((state) => state.adjustFov)
  const setTopdownAltitude = useViewportStore((state) => state.setTopdownAltitude)
  const adjustTopdownAltitude = useViewportStore((state) => state.adjustTopdownAltitude)
  const moveForward = useViewportStore((state) => state.moveForward)
  const moveRight = useViewportStore((state) => state.moveRight)
  const moveUp = useViewportStore((state) => state.moveUp)
  const resetPosition = useViewportStore((state) => state.resetPosition)
  const resetView = useViewportStore((state) => state.resetView)
  const followAircraft = useViewportStore((state) => state.followAircraft)
  const stopFollowing = useViewportStore((state) => state.stopFollowing)
  const setFollowMode = useViewportStore((state) => state.setFollowMode)
  const toggleFollowMode = useViewportStore((state) => state.toggleFollowMode)
  const setFollowZoom = useViewportStore((state) => state.setFollowZoom)
  const adjustFollowZoom = useViewportStore((state) => state.adjustFollowZoom)
  const setOrbitDistance = useViewportStore((state) => state.setOrbitDistance)
  const adjustOrbitDistance = useViewportStore((state) => state.adjustOrbitDistance)
  const setOrbitHeading = useViewportStore((state) => state.setOrbitHeading)
  const adjustOrbitHeading = useViewportStore((state) => state.adjustOrbitHeading)
  const setOrbitPitch = useViewportStore((state) => state.setOrbitPitch)
  const adjustOrbitPitch = useViewportStore((state) => state.adjustOrbitPitch)
  const followAircraftInOrbit = useViewportStore((state) => state.followAircraftInOrbit)

  return {
    // Active viewport info
    activeViewportId,
    activeViewport,

    // Camera state values (with defaults if no active viewport)
    viewMode: cameraState?.viewMode ?? '3d' as ViewMode,
    heading: cameraState?.heading ?? 0,
    pitch: cameraState?.pitch ?? -15,
    fov: cameraState?.fov ?? 60,
    positionOffsetX: cameraState?.positionOffsetX ?? 0,
    positionOffsetY: cameraState?.positionOffsetY ?? 0,
    positionOffsetZ: cameraState?.positionOffsetZ ?? 0,
    topdownAltitude: cameraState?.topdownAltitude ?? 5000,
    followingCallsign: cameraState?.followingCallsign ?? null,
    followMode: cameraState?.followMode ?? 'tower' as FollowMode,
    followZoom: cameraState?.followZoom ?? 1,
    orbitDistance: cameraState?.orbitDistance ?? 500,
    orbitHeading: cameraState?.orbitHeading ?? 0,
    orbitPitch: cameraState?.orbitPitch ?? -20,
    preFollowState: cameraState?.preFollowState ?? null,

    // Actions
    setViewMode,
    toggleViewMode,
    setHeading,
    setPitch,
    setFov,
    adjustHeading,
    adjustPitch,
    adjustFov,
    setTopdownAltitude,
    adjustTopdownAltitude,
    moveForward,
    moveRight,
    moveUp,
    resetPosition,
    resetView,
    followAircraft,
    stopFollowing,
    setFollowMode,
    toggleFollowMode,
    setFollowZoom,
    adjustFollowZoom,
    setOrbitDistance,
    adjustOrbitDistance,
    setOrbitHeading,
    adjustOrbitHeading,
    setOrbitPitch,
    adjustOrbitPitch,
    followAircraftInOrbit
  }
}

/**
 * Simpler hook that just returns the camera state values for the active viewport.
 * Use when you only need to read values, not modify them.
 */
export function useActiveViewportCameraState(): ViewportCameraState | undefined {
  const viewports = useViewportStore((state) => state.viewports)
  const activeViewportId = useViewportStore((state) => state.activeViewportId)

  return useMemo(
    () => viewports.find(v => v.id === activeViewportId)?.cameraState,
    [viewports, activeViewportId]
  )
}

export default useActiveViewportCamera
