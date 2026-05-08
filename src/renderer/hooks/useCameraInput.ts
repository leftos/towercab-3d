import * as Cesium from 'cesium'
import { useEffect, useMemo, useRef } from 'react'
import {
  FOLLOW_ZOOM_MAX,
  FOLLOW_ZOOM_MIN,
  FOV_MAX,
  FOV_MIN,
  ORBIT_DISTANCE_MAX,
  ORBIT_DISTANCE_MIN,
  ORBIT_PITCH_MAX,
  ORBIT_PITCH_MIN,
  PITCH_MAX,
  PITCH_MIN,
  TOPDOWN_ALTITUDE_MAX,
  TOPDOWN_ALTITUDE_MIN,
} from '../constants'
import { useAirportStore } from '../stores/airportStore'
import { type PendingDirection, useDatablockPositionStore } from '../stores/datablockPositionStore'
import { useGlobalSettingsStore } from '../stores/globalSettingsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useTowerPositioningStore } from '../stores/towerPositioningStore'
import { useUIFeedbackStore } from '../stores/uiFeedbackStore'
import { endManipulation, startManipulation } from '../stores/viewport/viewportHelpers'
import { useViewportStore } from '../stores/viewportStore'
import {
  accelerateVelocity,
  calculateEffectiveMoveSpeed,
  calculateTargetVelocities,
  createVelocityState,
  MOVEMENT_CONFIG,
  MOVEMENT_KEYS,
} from '../utils/inputVelocity'
import { hasViewingContext } from '../utils/viewingContext'
import { useTouchInput } from './useTouchInput'

interface UseCameraInputOptions {
  /** Callback when user manually breaks out of tower follow mode */
  onBreakTowerFollow?: () => void
  /** Callback when user escapes orbit mode via WASD */
  onEscapeOrbitMode?: () => void
  /**
   * When false, all mouse and keyboard input processing is disabled.
   * Used for iframe insets where input should only be processed when
   * the inset is activated by the parent window.
   * Defaults to true.
   */
  isInputEnabled?: boolean
}

/**
 * Handles keyboard, mouse, and wheel input for camera controls with smooth velocity-based movement.
 *
 * ## Responsibilities
 * - Processes keyboard input (WASD, arrows, view mode toggles) for camera movement
 * - Handles mouse drag input (right-click for rotation, left-click for panning in top-down mode)
 * - Manages mouse wheel scrolling for zoom/FOV adjustment
 * - Implements smooth acceleration/deceleration physics for all inputs
 * - Respects viewport activation state (only processes input when this viewport is active)
 * - Breaks tower follow mode when user manually manipulates camera
 *
 * ## Dependencies
 * - Requires: Cesium viewer instance (must be initialized)
 * - Reads: `settingsStore` (mouse sensitivity), `viewportStore` (camera state, active viewport)
 * - Writes: `viewportStore` (camera state via actions: adjustHeading, moveForward, etc.)
 *
 * ## Call Order
 * Call this hook in components that need camera input handling, typically alongside `useCesiumCamera`:
 * ```typescript
 * function CesiumViewer({ viewportId }) {
 *   const viewer = useRef<Cesium.Viewer>(null)
 *
 *   // Setup camera math (position/orientation calculations)
 *   useCesiumCamera(viewer.current, viewportId)
 *
 *   // Setup input handling (keyboard/mouse controls)
 *   useCameraInput(viewer.current, viewportId, {
 *     onBreakTowerFollow: () => handleStopFollowing()
 *   })
 * }
 * ```
 *
 * ## Input Handling
 *
 * ### Keyboard Controls
 * - **WASD / Arrow Keys**: Movement (forward/back/left/right)
 * - **Shift + WASD**: Sprint mode (3x speed)
 * - **Ctrl + WASD**: Fine control mode (0.2x speed)
 * - **Q/E**: Rotate heading (left/right)
 * - **Z/C**: Adjust pitch (up/down)
 * - **R/F**: Zoom (decrease/increase FOV)
 * - **T**: Toggle view mode (3D ⟷ top-down)
 * - **R**: Reset position offsets to zero
 * - **Shift+R / Home**: Reset view to user's saved default
 * - **Shift+Home**: Reset view to app defaults (ignoring user-saved default)
 * - **O**: Toggle follow mode (tower ⟷ orbit) when following aircraft
 * - **Esc**: Stop following aircraft
 *
 * ### Mouse Controls
 * - **Right-click drag**: Rotate camera (heading/pitch in 3D, orbit heading/pitch when following)
 * - **Middle-click drag**: Same as right-click drag
 * - **Left-click drag** (top-down mode only): Pan the map
 * - **Mouse wheel**: Zoom in/out (adjusts FOV or follow zoom)
 *
 * ### Sensitivity Scaling
 * Mouse drag rotation is scaled by user setting (0.1-2.0, default 1.0) from `settingsStore.camera.mouseSensitivity`.
 *
 * ## Velocity Physics
 *
 * All movements use smooth acceleration/deceleration rather than instant position changes:
 *
 * 1. **Target Velocity**: Calculated based on currently pressed keys (e.g., W pressed = forward target velocity)
 * 2. **Acceleration**: Current velocity interpolates toward target velocity each frame
 * 3. **Threshold**: Velocities below threshold are ignored to prevent jitter
 * 4. **Application**: Velocities are applied as deltas (velocity × deltaTime) to camera state
 *
 * This creates smooth, natural-feeling camera movement with momentum. See `utils/inputVelocity.ts` for implementation details.
 *
 * ## Wheel Impulse System
 *
 * Mouse wheel uses an impulse-based system for smooth scrolling:
 * - Each wheel event adds to an impulse accumulator (clamped to ±3)
 * - Impulse decays exponentially each frame as it's applied to zoom velocity
 * - Supports fast scrolling (multiple wheel events accumulate) without feeling laggy
 *
 * ## View Mode Behavior
 *
 * ### 3D Tower View
 * - WASD/arrows move camera position relative to tower
 * - Mouse drag rotates camera heading/pitch
 * - Wheel adjusts FOV
 *
 * ### Top-Down View
 * - WASD/arrows and left-click drag move camera position (panning)
 * - Q/E or right-click drag rotates heading (map rotation)
 * - Wheel adjusts altitude
 *
 * ### Follow Tower Mode
 * - Camera at tower, tracks aircraft heading
 * - Arrow keys, right/middle-click drag, or mouse wheel break follow mode
 * - Wheel adjusts follow zoom instead of FOV
 *
 * ### Follow Orbit Mode
 * - Camera orbits around aircraft
 * - WASD escapes orbit mode (stops following, keeps view pointed at aircraft)
 * - Arrow keys adjust orbit heading/pitch
 * - Mouse drag adjusts orbit heading/pitch
 * - Wheel adjusts orbit distance
 *
 * ## Multi-Viewport Behavior
 *
 * Only the **active viewport** receives input. When a viewport is clicked:
 * 1. It becomes the active viewport (cyan border in UI)
 * 2. All keyboard/mouse/wheel input routes to that viewport
 * 3. Other viewports ignore input until activated
 *
 * ## Event Handling
 *
 * - **Mouse events**: Uses Cesium's `ScreenSpaceEventHandler` for reliable canvas event handling
 * - **Keyboard events**: Uses global window event listeners (filtered by active viewport)
 * - **Animation loop**: RequestAnimationFrame loop for smooth 60Hz velocity updates
 * - **Cleanup**: All event listeners and animation frames are properly cleaned up on unmount
 *
 * @param viewer - The Cesium viewer instance (must not be destroyed)
 * @param viewportId - The unique ID of this viewport (for activation tracking)
 * @param options - Optional configuration
 * @param options.onBreakTowerFollow - Callback when user manually breaks tower follow mode (optional)
 *
 * @example
 * // Basic usage with follow break callback
 * useCameraInput(viewer, 'main-viewport', {
 *   onBreakTowerFollow: () => {
 *     console.log('User broke tower follow mode')
 *     viewportStore.getState().stopFollowing()
 *   }
 * })
 *
 * @example
 * // Usage in multi-viewport setup
 * function InsetViewer({ viewportId }) {
 *   const viewerRef = useRef<Cesium.Viewer>(null)
 *
 *   useCameraInput(viewerRef.current, viewportId, {
 *     onBreakTowerFollow: () => {
 *       // Only this viewport will receive input when active
 *       stopFollowing()
 *     }
 *   })
 *
 *   return <div ref={viewerRef} />
 * }
 *
 * @see useCesiumCamera - For camera position/orientation calculations
 * @see utils/inputVelocity.ts - For velocity physics implementation
 * @see viewportStore - For camera state management and actions
 */
export function useCameraInput(
  viewer: Cesium.Viewer | null,
  viewportId: string,
  options: UseCameraInputOptions = {},
): void {
  const { onBreakTowerFollow, onEscapeOrbitMode, isInputEnabled = true } = options

  // Settings store
  const mouseSensitivity = useSettingsStore((state) => state.camera.mouseSensitivity)
  const mouseInvert = useSettingsStore((state) => state.camera.mouseInvert)
  const mouseOrbitInvert = useSettingsStore((state) => state.camera.mouseOrbitInvert)
  const invertWheelZoom = useSettingsStore((state) => state.camera.invertWheelZoom)
  const keyboardInvert = useSettingsStore((state) => state.camera.keyboardInvert)
  const keyboardOrbitInvert = useSettingsStore((state) => state.camera.keyboardOrbitInvert)

  // Viewport store - check if this viewport is active
  const activeViewportId = useViewportStore((state) => state.activeViewportId)
  const viewports = useViewportStore((state) => state.viewports)

  // Find this viewport's camera state
  const thisViewport = useMemo(() => viewports.find((v) => v.id === viewportId), [viewports, viewportId])
  const cameraState = thisViewport?.cameraState

  // Camera state values (from this viewport)
  const viewMode = cameraState?.viewMode ?? '3d'
  const heading = cameraState?.heading ?? 0
  const pitch = cameraState?.pitch ?? -15
  const fov = cameraState?.fov ?? 60
  const topdownAltitude = cameraState?.topdownAltitude ?? 5000
  const followingCallsign = cameraState?.followingCallsign ?? null
  const followMode = cameraState?.followMode ?? 'tower'
  const followZoom = cameraState?.followZoom ?? 1
  const orbitPitch = cameraState?.orbitPitch ?? 15
  const orbitDistance = cameraState?.orbitDistance ?? 500
  const lookAtTarget = cameraState?.lookAtTarget ?? null

  // Viewport store actions (operate on active viewport)
  const toggleViewMode = useViewportStore((state) => state.toggleViewMode)
  const adjustHeading = useViewportStore((state) => state.adjustHeading)
  const adjustPitch = useViewportStore((state) => state.adjustPitch)
  const adjustFov = useViewportStore((state) => state.adjustFov)
  const adjustTopdownAltitude = useViewportStore((state) => state.adjustTopdownAltitude)
  const adjustFollowZoom = useViewportStore((state) => state.adjustFollowZoom)
  const adjustOrbitHeading = useViewportStore((state) => state.adjustOrbitHeading)
  const adjustOrbitPitch = useViewportStore((state) => state.adjustOrbitPitch)
  const adjustOrbitDistance = useViewportStore((state) => state.adjustOrbitDistance)
  const toggleFollowMode = useViewportStore((state) => state.toggleFollowMode)
  const moveForward = useViewportStore((state) => state.moveForward)
  const moveRight = useViewportStore((state) => state.moveRight)
  const moveUp = useViewportStore((state) => state.moveUp)
  const resetToDefault = useViewportStore((state) => state.resetToDefault)
  const resetToAppDefault = useViewportStore((state) => state.resetToAppDefault)
  const resetPosition = useViewportStore((state) => state.resetPosition)
  const stopFollowing = useViewportStore((state) => state.stopFollowing)
  const setActiveViewport = useViewportStore((state) => state.setActiveViewport)
  const setHeading = useViewportStore((state) => state.setHeading)
  const setPitch = useViewportStore((state) => state.setPitch)
  const clearLookAtTarget = useViewportStore((state) => state.clearLookAtTarget)

  // Mouse drag state
  const isDraggingRef = useRef(false)
  const isLeftDraggingRef = useRef(false)
  const lastMousePosRef = useRef({ x: 0, y: 0 })

  // Smooth keyboard movement state
  const pressedKeysRef = useRef<Set<string>>(new Set())
  const velocityRef = useRef(createVelocityState())
  const animationFrameRef = useRef<number | null>(null)
  const lastFrameTimeRef = useRef<number>(0)

  // Refs for values needed during drag (avoids effect re-running during drag)
  const viewModeRef = useRef(viewMode)
  const topdownAltitudeRef = useRef(topdownAltitude)
  const headingRef = useRef(heading)
  const pitchRef = useRef(pitch)
  const fovRef = useRef(fov)
  const followingCallsignRef = useRef(followingCallsign)
  const followModeRef = useRef(followMode)
  const followZoomRef = useRef(followZoom)
  const orbitPitchRef = useRef(orbitPitch)
  const orbitDistanceRef = useRef(orbitDistance)
  const mouseSensitivityRef = useRef(mouseSensitivity)
  const mouseInvertRef = useRef(mouseInvert)
  const mouseOrbitInvertRef = useRef(mouseOrbitInvert)
  const invertWheelZoomRef = useRef(invertWheelZoom)
  const keyboardInvertRef = useRef(keyboardInvert)
  const keyboardOrbitInvertRef = useRef(keyboardOrbitInvert)
  const isActiveRef = useRef(activeViewportId === viewportId)
  const viewportIdRef = useRef(viewportId)
  const lookAtTargetRef = useRef(lookAtTarget)

  // Reference point tracking (airport or orbit-following)
  const currentAirportRef = useRef(useAirportStore.getState().currentAirport)
  const hasReferenceRef = useRef(hasViewingContext(currentAirportRef.current, followMode, followingCallsign))

  // Keep refs updated
  viewModeRef.current = viewMode
  topdownAltitudeRef.current = topdownAltitude
  headingRef.current = heading
  pitchRef.current = pitch
  fovRef.current = fov
  followingCallsignRef.current = followingCallsign
  followModeRef.current = followMode
  followZoomRef.current = followZoom
  orbitPitchRef.current = orbitPitch
  orbitDistanceRef.current = orbitDistance
  mouseSensitivityRef.current = mouseSensitivity
  mouseInvertRef.current = mouseInvert
  mouseOrbitInvertRef.current = mouseOrbitInvert
  invertWheelZoomRef.current = invertWheelZoom
  keyboardInvertRef.current = keyboardInvert
  keyboardOrbitInvertRef.current = keyboardOrbitInvert
  isActiveRef.current = activeViewportId === viewportId
  viewportIdRef.current = viewportId
  lookAtTargetRef.current = lookAtTarget
  currentAirportRef.current = useAirportStore.getState().currentAirport
  hasReferenceRef.current = hasViewingContext(currentAirportRef.current, followMode, followingCallsign)

  // Mouse drag controls for panning/tilting using Cesium's event handler
  useEffect(() => {
    // Skip all mouse input handling when input is disabled (e.g., inactive iframe inset)
    if (!isInputEnabled) return
    if (!viewer || viewer.isDestroyed()) return

    // Use Cesium's ScreenSpaceEventHandler for reliable mouse event handling
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas)

    // Left-click drag start (for panning in top-down view)
    handler.setInputAction((movement: { position: Cesium.Cartesian2 }) => {
      // Activate this viewport on click - update ref immediately so keyboard works without waiting for re-render
      setActiveViewport(viewportIdRef.current)
      isActiveRef.current = true
      startManipulation()
      if (viewModeRef.current === 'topdown') {
        isLeftDraggingRef.current = true
        lastMousePosRef.current = { x: movement.position.x, y: movement.position.y }
      }
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN)

    // Left-click drag end
    handler.setInputAction(() => {
      isLeftDraggingRef.current = false
      endManipulation()
    }, Cesium.ScreenSpaceEventType.LEFT_UP)

    // Intercept LEFT_CLICK to prevent Cesium's default behavior
    // This fixes aircraft flickering on click (Cesium does internal processing on click
    // that briefly affects the scene state, causing culling to produce different results)
    handler.setInputAction(() => {
      // Intentionally empty - just intercepts the event
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

    // Right-click drag start
    handler.setInputAction((movement: { position: Cesium.Cartesian2 }) => {
      // Activate this viewport on click - update ref immediately so keyboard works without waiting for re-render
      setActiveViewport(viewportIdRef.current)
      isActiveRef.current = true
      isDraggingRef.current = true
      startManipulation()
      lastMousePosRef.current = { x: movement.position.x, y: movement.position.y }

      // Cancel any ongoing look-at animation when user manually moves camera
      if (lookAtTargetRef.current) {
        clearLookAtTarget()
      }

      // In tower follow mode, stop following when user starts dragging
      if (followingCallsignRef.current && followModeRef.current === 'tower') {
        onBreakTowerFollow?.()
      }
    }, Cesium.ScreenSpaceEventType.RIGHT_DOWN)

    // Middle-click drag start
    handler.setInputAction((movement: { position: Cesium.Cartesian2 }) => {
      // Activate this viewport on click - update ref immediately so keyboard works without waiting for re-render
      setActiveViewport(viewportIdRef.current)
      isActiveRef.current = true
      isDraggingRef.current = true
      startManipulation()
      lastMousePosRef.current = { x: movement.position.x, y: movement.position.y }

      // Cancel any ongoing look-at animation when user manually moves camera
      if (lookAtTargetRef.current) {
        clearLookAtTarget()
      }

      // In tower follow mode, stop following when user starts dragging
      if (followingCallsignRef.current && followModeRef.current === 'tower') {
        onBreakTowerFollow?.()
      }
    }, Cesium.ScreenSpaceEventType.MIDDLE_DOWN)

    // Mouse move while dragging
    handler.setInputAction((movement: { startPosition: Cesium.Cartesian2; endPosition: Cesium.Cartesian2 }) => {
      const deltaX = movement.endPosition.x - lastMousePosRef.current.x
      const deltaY = movement.endPosition.y - lastMousePosRef.current.y

      // Handle left-click drag for panning in top-down view
      if (isLeftDraggingRef.current && viewModeRef.current === 'topdown') {
        // Scale pan speed with altitude (higher = faster panning)
        const panScale = topdownAltitudeRef.current / 1000
        // Account for heading rotation
        const headingRad = (headingRef.current * Math.PI) / 180
        const cosH = Math.cos(headingRad)
        const sinH = Math.sin(headingRad)
        // Rotate the delta by heading to get world-space movement (inverted for grab-and-drag feel)
        const worldDeltaX = -(deltaX * cosH - deltaY * sinH)
        const worldDeltaY = -(deltaX * sinH + deltaY * cosH)
        moveRight(worldDeltaX * panScale)
        moveForward(worldDeltaY * panScale)
        lastMousePosRef.current = { x: movement.endPosition.x, y: movement.endPosition.y }
        return
      }

      if (!isDraggingRef.current) return

      // Base sensitivity (0.3) scaled by user setting (0.1-2.0, default 1.0)
      const sensitivity = 0.3 * mouseSensitivityRef.current

      if (followingCallsignRef.current && followModeRef.current === 'orbit') {
        // In orbit mode: adjust orbit heading/pitch
        const orbitXSign = mouseOrbitInvertRef.current.invertX ? -1 : 1
        const orbitYSign = mouseOrbitInvertRef.current.invertY ? -1 : 1
        adjustOrbitHeading(deltaX * sensitivity * orbitXSign)
        adjustOrbitPitch(deltaY * sensitivity * orbitYSign)
      } else {
        // Normal mode: update heading (horizontal movement) - positive deltaX = look right
        const xSign = mouseInvertRef.current.invertX ? -1 : 1
        const ySign = mouseInvertRef.current.invertY ? -1 : 1
        adjustHeading(deltaX * sensitivity * xSign)
        // Update pitch (vertical movement) - positive deltaY = look down
        adjustPitch(-deltaY * sensitivity * ySign)
      }

      lastMousePosRef.current = { x: movement.endPosition.x, y: movement.endPosition.y }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

    // Right-click drag end
    handler.setInputAction(() => {
      isDraggingRef.current = false
      endManipulation()
    }, Cesium.ScreenSpaceEventType.RIGHT_UP)

    // Middle-click drag end
    handler.setInputAction(() => {
      isDraggingRef.current = false
      endManipulation()
    }, Cesium.ScreenSpaceEventType.MIDDLE_UP)

    // Prevent context menu on right-click
    const canvas = viewer.canvas
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault()
    }
    canvas.addEventListener('contextmenu', handleContextMenu)

    // Global mouseup listeners to catch releases that happen outside canvas or are missed due to low framerate
    const handleGlobalMouseUp = (event: MouseEvent) => {
      // Right button (button 2) or middle button (button 1)
      if (event.button === 2 || event.button === 1) {
        isDraggingRef.current = false
        endManipulation()
      }
      // Left button (button 0)
      if (event.button === 0) {
        isLeftDraggingRef.current = false
        endManipulation()
      }
    }

    // Also check button state on any mouse move - if button is no longer pressed, end drag
    const handleGlobalMouseMove = (event: MouseEvent) => {
      // event.buttons is a bitmask: 1=left, 2=right, 4=middle
      const wasManipulating = isDraggingRef.current || isLeftDraggingRef.current
      if (isDraggingRef.current && !(event.buttons & 2) && !(event.buttons & 4)) {
        isDraggingRef.current = false
      }
      if (isLeftDraggingRef.current && !(event.buttons & 1)) {
        isLeftDraggingRef.current = false
      }
      // If we were manipulating but now all buttons are released, end manipulation
      if (wasManipulating && !isDraggingRef.current && !isLeftDraggingRef.current) {
        endManipulation()
      }
    }

    window.addEventListener('mouseup', handleGlobalMouseUp)
    window.addEventListener('mousemove', handleGlobalMouseMove)

    return () => {
      handler.destroy()
      canvas.removeEventListener('contextmenu', handleContextMenu)
      window.removeEventListener('mouseup', handleGlobalMouseUp)
      window.removeEventListener('mousemove', handleGlobalMouseMove)
    }
  }, [
    viewer,
    adjustHeading,
    adjustPitch,
    adjustOrbitHeading,
    adjustOrbitPitch,
    moveForward,
    moveRight,
    onBreakTowerFollow,
    setActiveViewport,
    clearLookAtTarget,
    isInputEnabled,
  ])

  // Mouse wheel for zoom - direct adjustment per scroll notch
  useEffect(() => {
    // Skip wheel handling when input is disabled (e.g., inactive iframe inset)
    if (!isInputEnabled) return
    if (!viewer || viewer.isDestroyed()) return

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()

      // Normalize wheel delta: one notch = ~1 unit
      // Cap at 150 to handle high-DPI mice, divide by 100 for unit scale
      let normalizedDelta = (Math.sign(event.deltaY) * Math.min(Math.abs(event.deltaY), 150)) / 100

      // Optionally invert wheel direction (user preference)
      if (invertWheelZoomRef.current) {
        normalizedDelta = -normalizedDelta
      }

      // Scale wheel sensitivity based on viewport size
      // Smaller viewports get reduced sensitivity to prevent aggressive zooming
      // Reference size is 800px - viewports smaller than this get proportionally reduced sensitivity
      const viewportSize = Math.min(canvas.clientWidth, canvas.clientHeight)
      const sizeScale = Math.min(1, Math.max(0.2, viewportSize / 800))
      normalizedDelta *= sizeScale

      // Apply zoom directly based on current mode
      const currentViewMode = viewModeRef.current
      const currentFollowingCallsign = followingCallsignRef.current
      const currentFollowMode = followModeRef.current

      if (currentViewMode === 'topdown') {
        // Top-down: adjust altitude (scale with current altitude for natural feel)
        const altitudeStep = topdownAltitudeRef.current * 0.15 * normalizedDelta
        adjustTopdownAltitude(altitudeStep)
      } else if (currentFollowingCallsign && currentFollowMode === 'orbit') {
        // Orbit mode: adjust distance (scale with current distance)
        const distanceStep = orbitDistanceRef.current * 0.15 * normalizedDelta
        adjustOrbitDistance(distanceStep)
      } else if (currentFollowingCallsign && currentFollowMode === 'tower') {
        // Tower follow mode: proportional follow zoom (inverted so scroll down = zoom in)
        const zoomStep = -normalizedDelta * followZoomRef.current * 0.05
        adjustFollowZoom(zoomStep)
      } else {
        // Normal 3D mode: proportional FOV zoom
        // Each scroll notch changes FOV by ~8%, giving ~5° at 60° and ~0.24° at 3°
        const currentFov = fovRef.current
        const fovStep = currentFov * (1.08 ** normalizedDelta - 1)
        adjustFov(fovStep)
      }
    }

    const canvas = viewer.canvas
    canvas.addEventListener('wheel', handleWheel, { passive: false })

    return () => {
      canvas.removeEventListener('wheel', handleWheel)
    }
  }, [viewer, isInputEnabled, adjustFov, adjustTopdownAltitude, adjustFollowZoom, adjustOrbitDistance])

  // Smooth keyboard controls with animation loop
  useEffect(() => {
    // Skip keyboard handling when input is disabled (e.g., inactive iframe inset)
    if (!isInputEnabled) {
      return
    }
    if (!viewer || viewer.isDestroyed()) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      // Only process keyboard input if this viewport is active
      if (!isActiveRef.current) {
        return
      }

      // Ignore if typing in an input
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return
      }

      // Ignore if any modal or command input is active
      if (useUIFeedbackStore.getState().isInputBlocked()) {
        return
      }

      const key = event.key

      // Handle tower positioning mode
      const positioningState = useTowerPositioningStore.getState()
      if (positioningState.isActive) {
        if (positioningState.step === 'model') {
          // Step 1: Model Positioning
          // Tab toggles between model and camera control modes
          if (key === 'Tab') {
            event.preventDefault()
            positioningState.toggleStep1ControlMode()
            return
          }

          // Handle Enter/Escape regardless of control mode
          if (key === 'Enter') {
            positioningState.proceedToStep2()
            return
          }
          if (key === 'Escape') {
            positioningState.stopPositioning()
            return
          }

          // If in camera control mode, allow normal camera movement
          if (positioningState.step1ControlMode === 'camera') {
            // Continue to normal key handling below
          } else {
            // Model control mode - control the model with WASD/QE/ZX
            // Movement speed: 1m base, 10m with Shift, 0.1m with Ctrl
            const speed = event.shiftKey ? 10 : event.ctrlKey ? 0.1 : 1
            // Rotation speed: 5 deg base, 45 deg with Shift, 1 deg with Ctrl
            const rotSpeed = event.shiftKey ? 45 : event.ctrlKey ? 1 : 5

            // Camera-relative WASD. Cesium camera.heading is radians clockwise from north
            // (0 = N, π/2 = E). Forward unit vector in (east, north) is (sin h, cos h);
            // Right is forward rotated 90° clockwise = (cos h, -sin h).
            const heading = viewer.camera.heading
            const cosH = Math.cos(heading)
            const sinH = Math.sin(heading)

            switch (key.toLowerCase()) {
              case 'w':
              case 'arrowup':
                positioningState.adjustModelOffset('north', speed * cosH)
                positioningState.adjustModelOffset('east', speed * sinH)
                return
              case 's':
              case 'arrowdown':
                positioningState.adjustModelOffset('north', -speed * cosH)
                positioningState.adjustModelOffset('east', -speed * sinH)
                return
              case 'a':
              case 'arrowleft':
                positioningState.adjustModelOffset('north', speed * sinH)
                positioningState.adjustModelOffset('east', -speed * cosH)
                return
              case 'd':
              case 'arrowright':
                positioningState.adjustModelOffset('north', -speed * sinH)
                positioningState.adjustModelOffset('east', speed * cosH)
                return
              case 'q':
                positioningState.adjustModelOffset('up', -speed)
                return
              case 'e':
                positioningState.adjustModelOffset('up', speed)
                return
              case 'z':
                positioningState.adjustModelRotation(-rotSpeed) // CCW
                return
              case 'x':
                positioningState.adjustModelRotation(rotSpeed) // CW
                return
              case 'r':
                positioningState.resetModelOffset()
                return
            }
            // Block other keys in model control mode
            return
          }
        } else if (positioningState.step === 'camera') {
          // Step 2: Camera Positioning - allow normal camera movement, intercept Enter/Esc
          if (key === 'Enter') {
            // Save will be handled by the save logic in SettingsModsTab
            // For now, emit an event or call a save function
            // The actual save logic will be added when we implement the save functionality
            window.dispatchEvent(new CustomEvent('tower-positioning-save'))
            return
          }
          if (key === 'Escape') {
            positioningState.goBackToStep1()
            return
          }
          // Allow normal camera movement - continue to normal key handling
        }
      }

      // Handle one-shot keys (not continuous movement)
      switch (key) {
        case 't':
        case 'T':
          // Only toggle view mode if we have a reference point (airport or orbit-following)
          if (hasReferenceRef.current) {
            toggleViewMode()
          }
          return
        case 'r':
          // Only reset position if we have a reference point
          if (hasReferenceRef.current) {
            resetPosition()
          }
          return
        case 'R':
          // Only reset to default if we have an airport selected (defaults are per-airport)
          if (currentAirportRef.current) {
            resetToDefault()
          }
          return
        case 'Home':
          // Only load defaults if we have an airport selected (defaults are per-airport)
          if (currentAirportRef.current) {
            if (event.shiftKey) {
              resetToAppDefault()
            } else {
              resetToDefault()
            }
          }
          return
        case 'o':
        case 'O':
          if (followingCallsignRef.current) {
            toggleFollowMode()
          }
          return
        case 'Escape': {
          // First check if we're in datablock position mode
          const datablockStore = useDatablockPositionStore.getState()
          if (datablockStore.pendingDirection) {
            datablockStore.setPendingDirection(null)
            useUIFeedbackStore.getState().showFeedback('Datablock positioning cancelled', 'error')
            return
          }
          // Otherwise stop following
          stopFollowing()
          return
        }
      }

      // Handle numpad keys 1-9 for datablock positioning (without modifiers)
      // Key 5 means "reset to app default"
      if (!event.ctrlKey && !event.altKey && !event.shiftKey) {
        const numKey = parseInt(key, 10)
        if (numKey >= 1 && numKey <= 9) {
          const datablockStore = useDatablockPositionStore.getState()
          datablockStore.setPendingDirection(numKey as PendingDirection)
          if (numKey === 5) {
            const appDefault = useGlobalSettingsStore.getState().display.defaultDatablockDirection
            useUIFeedbackStore
              .getState()
              .showFeedback(`Reset to default (${appDefault}): Enter=all, Click=aircraft, Esc=cancel`, 'success')
          } else {
            useUIFeedbackStore
              .getState()
              .showFeedback(`Datablock position ${numKey}: Enter=all, Click=aircraft, Esc=cancel`, 'success')
          }
          return
        }
      }

      // Handle Enter when pending direction exists (apply global position)
      if (key === 'Enter') {
        const datablockStore = useDatablockPositionStore.getState()
        if (datablockStore.pendingDirection) {
          // Key 5 means "reset to app default"
          if (datablockStore.pendingDirection === 5) {
            const appDefault = useGlobalSettingsStore.getState().display.defaultDatablockDirection
            useViewportStore.getState().setDatablockPosition(appDefault)
            useUIFeedbackStore
              .getState()
              .showFeedback(`All datablocks reset to default (position ${appDefault})`, 'success')
          } else {
            useViewportStore.getState().setDatablockPosition(datablockStore.pendingDirection)
            useUIFeedbackStore
              .getState()
              .showFeedback(`All datablocks moved to position ${datablockStore.pendingDirection}`, 'success')
          }
          datablockStore.setPendingDirection(null)
          return
        }
      }

      // Track continuous movement keys
      if (MOVEMENT_KEYS.has(key)) {
        pressedKeysRef.current.add(key.toLowerCase())

        // Stop following in tower mode when arrow keys are pressed
        if (key.startsWith('Arrow') && followingCallsignRef.current && followModeRef.current === 'tower') {
          onBreakTowerFollow?.()
        }

        // Escape orbit mode when WASD is pressed (WASD has no other function in orbit mode)
        const wasdKey = key.toLowerCase()
        if (
          (wasdKey === 'w' || wasdKey === 's' || wasdKey === 'a' || wasdKey === 'd') &&
          followingCallsignRef.current &&
          followModeRef.current === 'orbit'
        ) {
          onEscapeOrbitMode?.()
        }
      }
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      const key = event.key
      pressedKeysRef.current.delete(key.toLowerCase())
      // Also remove the uppercase version in case it was tracked that way
      pressedKeysRef.current.delete(key)
    }

    // Clear all keys when window loses focus
    const handleBlur = () => {
      pressedKeysRef.current.clear()
    }

    // Animation loop for smooth movement
    const animate = (currentTime: number) => {
      const deltaTime = lastFrameTimeRef.current ? (currentTime - lastFrameTimeRef.current) / 1000 : 0.016
      lastFrameTimeRef.current = currentTime

      // Clamp deltaTime to avoid huge jumps
      const dt = Math.min(deltaTime, 0.1)

      const keys = pressedKeysRef.current
      const vel = velocityRef.current

      // Only process input if this viewport is active
      if (!isActiveRef.current) {
        // Still need to schedule next frame but skip processing
        animationFrameRef.current = requestAnimationFrame(animate)
        return
      }

      // Calculate target velocities based on pressed keys
      const targets = calculateTargetVelocities(
        keys,
        viewModeRef.current,
        followingCallsignRef.current,
        followModeRef.current,
        {
          invertX: keyboardInvertRef.current.invertX,
          invertY: keyboardInvertRef.current.invertY,
          invertOrbitX: keyboardOrbitInvertRef.current.invertX,
          invertOrbitY: keyboardOrbitInvertRef.current.invertY,
        },
      )

      // WASD movement (shift = sprint, ctrl = fine control)
      const shiftHeld = keys.has('shift')
      const ctrlHeld = keys.has('control')
      // Shift = 3x speed, Ctrl = 0.2x speed (fine control), both = normal speed
      const speedMultiplier = shiftHeld && ctrlHeld ? 1.0 : shiftHeld ? 3.0 : ctrlHeld ? 0.2 : 1.0

      // Scale movement speed with altitude in topdown view, and apply speed multiplier
      const effectiveMoveSpeed = calculateEffectiveMoveSpeed(
        MOVEMENT_CONFIG.MAX_MOVE_SPEED,
        viewModeRef.current === 'topdown',
        topdownAltitudeRef.current,
        speedMultiplier,
      )

      // Smoothly interpolate velocities toward targets (apply speed multiplier to all)
      vel.forward = accelerateVelocity(vel.forward, targets.forward, effectiveMoveSpeed, dt)
      vel.right = accelerateVelocity(vel.right, targets.right, effectiveMoveSpeed, dt)
      vel.up = accelerateVelocity(vel.up, targets.up, effectiveMoveSpeed, dt)
      vel.heading = accelerateVelocity(
        vel.heading,
        targets.heading,
        MOVEMENT_CONFIG.MAX_ROTATE_SPEED * speedMultiplier,
        dt,
      )
      vel.pitch = accelerateVelocity(vel.pitch, targets.pitch, MOVEMENT_CONFIG.MAX_ROTATE_SPEED * speedMultiplier, dt)
      vel.zoom = accelerateVelocity(vel.zoom, targets.zoom, MOVEMENT_CONFIG.MAX_ZOOM_SPEED * speedMultiplier, dt)
      vel.orbitHeading = accelerateVelocity(
        vel.orbitHeading,
        targets.orbitHeading,
        MOVEMENT_CONFIG.MAX_ROTATE_SPEED * speedMultiplier,
        dt,
      )
      vel.orbitPitch = accelerateVelocity(
        vel.orbitPitch,
        targets.orbitPitch,
        MOVEMENT_CONFIG.MAX_ROTATE_SPEED * speedMultiplier,
        dt,
      )
      vel.orbitDistance = accelerateVelocity(
        vel.orbitDistance,
        targets.orbitDistance,
        MOVEMENT_CONFIG.MAX_ORBIT_DIST_SPEED * speedMultiplier,
        dt,
      )
      vel.altitude = accelerateVelocity(
        vel.altitude,
        targets.altitude,
        MOVEMENT_CONFIG.MAX_ALTITUDE_SPEED * speedMultiplier,
        dt,
      )

      // Reset velocity to zero when at a boundary to prevent momentum buildup
      // This stops the "rubberbanding" effect when hitting limits
      const currentPitch = pitchRef.current
      const currentFov = fovRef.current
      const currentOrbitPitch = orbitPitchRef.current
      const currentOrbitDistance = orbitDistanceRef.current
      const currentAltitude = topdownAltitudeRef.current

      // Pitch boundaries
      if ((currentPitch <= PITCH_MIN + 0.5 && vel.pitch < 0) || (currentPitch >= PITCH_MAX - 0.5 && vel.pitch > 0)) {
        vel.pitch = 0
      }

      // Zoom velocity boundaries depend on current mode
      const inOrbitMode = followingCallsignRef.current && followModeRef.current === 'orbit'
      const inTowerFollow = followingCallsignRef.current && followModeRef.current === 'tower'

      if (inTowerFollow) {
        // Follow zoom boundaries (tower follow mode)
        const currentFollowZoom = followZoomRef.current
        if (
          (currentFollowZoom <= FOLLOW_ZOOM_MIN + 0.01 && vel.zoom < 0) ||
          (currentFollowZoom >= FOLLOW_ZOOM_MAX - 0.01 && vel.zoom > 0)
        ) {
          vel.zoom = 0
        }
      } else if (!inOrbitMode && !followingCallsignRef.current) {
        // FOV boundaries (normal 3D mode, not following)
        if ((currentFov <= FOV_MIN + 0.5 && vel.zoom < 0) || (currentFov >= FOV_MAX - 0.5 && vel.zoom > 0)) {
          vel.zoom = 0
        }
      }
      // Note: orbit mode uses orbitDistance for zoom, which is already checked above

      // Orbit pitch boundaries
      if (
        (currentOrbitPitch <= ORBIT_PITCH_MIN + 0.5 && vel.orbitPitch < 0) ||
        (currentOrbitPitch >= ORBIT_PITCH_MAX - 0.5 && vel.orbitPitch > 0)
      ) {
        vel.orbitPitch = 0
      }

      // Orbit distance boundaries
      if (
        (currentOrbitDistance <= ORBIT_DISTANCE_MIN + 1 && vel.orbitDistance < 0) ||
        (currentOrbitDistance >= ORBIT_DISTANCE_MAX - 1 && vel.orbitDistance > 0)
      ) {
        vel.orbitDistance = 0
      }

      // Top-down altitude boundaries
      if (
        (currentAltitude <= TOPDOWN_ALTITUDE_MIN + 1 && vel.altitude < 0) ||
        (currentAltitude >= TOPDOWN_ALTITUDE_MAX - 1 && vel.altitude > 0)
      ) {
        vel.altitude = 0
      }

      // Velocity threshold for applying movements
      const threshold = MOVEMENT_CONFIG.VELOCITY_THRESHOLD

      // Smooth look-at animation toward target heading/pitch
      // This runs independently of velocity-based input
      const target = lookAtTargetRef.current
      if (target) {
        // Check if user is actively trying to move camera via keyboard
        // If so, cancel the look-at animation
        if (Math.abs(vel.heading) > threshold || Math.abs(vel.pitch) > threshold) {
          clearLookAtTarget()
        } else {
          const currentH = headingRef.current
          const currentP = pitchRef.current

          // Calculate heading delta (handle 360° wrap)
          let deltaH = target.heading - currentH
          // Normalize to [-180, 180] to take shortest path
          if (deltaH > 180) deltaH -= 360
          if (deltaH < -180) deltaH += 360

          const deltaP = target.pitch - currentP

          // Threshold for "close enough" (degrees)
          const reachedThreshold = 0.5

          if (Math.abs(deltaH) < reachedThreshold && Math.abs(deltaP) < reachedThreshold) {
            // Snap to exact target and clear
            setHeading(target.heading)
            setPitch(target.pitch)
            clearLookAtTarget()
          } else {
            // Smooth exponential interpolation (easing)
            // Higher value = faster animation
            const easeSpeed = 8.0
            const t = 1 - Math.exp(-easeSpeed * dt)

            // Apply interpolated movement
            const newHeading = currentH + deltaH * t
            const newPitch = currentP + deltaP * t

            setHeading(newHeading)
            setPitch(newPitch)
          }
        }
      }

      // Apply velocities

      if (Math.abs(vel.forward) > threshold) {
        moveForward(vel.forward * dt)
      }
      if (Math.abs(vel.right) > threshold) {
        moveRight(vel.right * dt)
      }
      if (Math.abs(vel.up) > threshold) {
        moveUp(vel.up * dt)
      }
      if (Math.abs(vel.heading) > threshold) {
        adjustHeading(vel.heading * dt)
      }
      if (Math.abs(vel.pitch) > threshold) {
        adjustPitch(vel.pitch * dt)
      }
      if (Math.abs(vel.zoom) > threshold) {
        if (followingCallsignRef.current && followModeRef.current !== 'orbit') {
          adjustFollowZoom(vel.zoom * dt) // Tower follow mode zoom
        } else {
          // Proportional FOV change: scale by current FOV / 60
          // At 60° behavior is unchanged, at 3° zoom rate is 1/20th
          const fovScale = fovRef.current / 60
          adjustFov(vel.zoom * dt * fovScale)
        }
      }
      if (Math.abs(vel.orbitHeading) > threshold) {
        adjustOrbitHeading(vel.orbitHeading * dt)
      }
      if (Math.abs(vel.orbitPitch) > threshold) {
        adjustOrbitPitch(vel.orbitPitch * dt)
      }
      if (Math.abs(vel.orbitDistance) > threshold) {
        adjustOrbitDistance(vel.orbitDistance * dt)
      }
      if (Math.abs(vel.altitude) > threshold) {
        adjustTopdownAltitude(vel.altitude * dt)
      }

      animationFrameRef.current = requestAnimationFrame(animate)
    }

    // Start animation loop
    animationFrameRef.current = requestAnimationFrame(animate)

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleBlur)

    // Capture ref for cleanup to avoid stale reference issues
    const pressedKeys = pressedKeysRef.current

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleBlur)
      pressedKeys.clear()
    }
  }, [
    viewer,
    adjustHeading,
    adjustPitch,
    adjustFov,
    adjustTopdownAltitude,
    adjustFollowZoom,
    adjustOrbitHeading,
    adjustOrbitPitch,
    adjustOrbitDistance,
    toggleFollowMode,
    moveForward,
    moveRight,
    moveUp,
    toggleViewMode,
    resetToDefault,
    resetToAppDefault,
    resetPosition,
    stopFollowing,
    onBreakTowerFollow,
    onEscapeOrbitMode,
    setHeading,
    setPitch,
    clearLookAtTarget,
    isInputEnabled,
  ])

  // NOTE: Viewport activation is handled ONLY by canvas clicks (LEFT_DOWN, RIGHT_DOWN, MIDDLE_DOWN)
  // in the mouse input effect above. We deliberately do NOT activate main viewport on window focus
  // events because:
  // 1. Clicking on UI panels (like nearby aircraft panel) gives focus to main window but shouldn't
  //    change which viewport is active - the user is interacting with the UI, not the viewport
  // 2. Actions triggered from UI panels (like "Look At Runway") should target the currently active
  //    viewport, even if that's an inset
  // 3. If an inset is active and user clicks the main viewport's canvas, the LEFT_DOWN/RIGHT_DOWN
  //    handler will activate main viewport correctly
  // 4. Keyboard input naturally goes to whichever window has focus - if user clicked on main window
  //    UI, they need to click on the inset to send keyboard input there again

  // Touch input support for iPad/mobile devices
  // Only enable touch input when input is enabled (activated inset or main viewport)
  useTouchInput(viewer, viewportId, { onBreakTowerFollow, isInputEnabled })
}

export default useCameraInput
