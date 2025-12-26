import { useEffect, useRef, useMemo } from 'react'
import * as Cesium from 'cesium'
import { useViewportStore } from '../stores/viewportStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIFeedbackStore } from '../stores/uiFeedbackStore'
import { useDatablockPositionStore, type DatablockPosition } from '../stores/datablockPositionStore'
import {
  createVelocityState,
  MOVEMENT_CONFIG,
  MOVEMENT_KEYS,
  accelerateVelocity,
  calculateEffectiveMoveSpeed,
  calculateTargetVelocities,
  applyWheelImpulse
} from '../utils/inputVelocity'
import {
  PITCH_MIN,
  PITCH_MAX,
  FOV_MIN,
  FOV_MAX,
  ORBIT_PITCH_MIN,
  ORBIT_PITCH_MAX,
  ORBIT_DISTANCE_MIN,
  ORBIT_DISTANCE_MAX,
  TOPDOWN_ALTITUDE_MIN,
  TOPDOWN_ALTITUDE_MAX,
  FOLLOW_ZOOM_MIN,
  FOLLOW_ZOOM_MAX
} from '../constants'

interface UseCameraInputOptions {
  /** Callback when user manually breaks out of tower follow mode */
  onBreakTowerFollow?: () => void
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
 * - WASD/arrows adjust orbit distance
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
  options: UseCameraInputOptions = {}
): void {
  const { onBreakTowerFollow } = options

  // Settings store
  const mouseSensitivity = useSettingsStore((state) => state.camera.mouseSensitivity)

  // Viewport store - check if this viewport is active
  const activeViewportId = useViewportStore((state) => state.activeViewportId)
  const viewports = useViewportStore((state) => state.viewports)

  // Find this viewport's camera state
  const thisViewport = useMemo(
    () => viewports.find(v => v.id === viewportId),
    [viewports, viewportId]
  )
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

  // Mouse wheel impulse for smooth scrolling
  const wheelImpulseRef = useRef(0)

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
  const isActiveRef = useRef(activeViewportId === viewportId)
  const viewportIdRef = useRef(viewportId)
  const lookAtTargetRef = useRef(lookAtTarget)

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
  isActiveRef.current = activeViewportId === viewportId
  viewportIdRef.current = viewportId
  lookAtTargetRef.current = lookAtTarget

  // Mouse drag controls for panning/tilting using Cesium's event handler
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return

    // Use Cesium's ScreenSpaceEventHandler for reliable mouse event handling
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas)

    // Left-click drag start (for panning in top-down view)
    handler.setInputAction((movement: { position: Cesium.Cartesian2 }) => {
      // Activate this viewport on click - update ref immediately so keyboard works without waiting for re-render
      setActiveViewport(viewportIdRef.current)
      isActiveRef.current = true
      if (viewModeRef.current === 'topdown') {
        isLeftDraggingRef.current = true
        lastMousePosRef.current = { x: movement.position.x, y: movement.position.y }
      }
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN)

    // Left-click drag end
    handler.setInputAction(() => {
      isLeftDraggingRef.current = false
    }, Cesium.ScreenSpaceEventType.LEFT_UP)

    // Right-click drag start
    handler.setInputAction((movement: { position: Cesium.Cartesian2 }) => {
      // Activate this viewport on click - update ref immediately so keyboard works without waiting for re-render
      setActiveViewport(viewportIdRef.current)
      isActiveRef.current = true
      isDraggingRef.current = true
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
        const headingRad = headingRef.current * Math.PI / 180
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
        adjustOrbitHeading(deltaX * sensitivity)
        adjustOrbitPitch(deltaY * sensitivity)
      } else {
        // Normal mode: update heading (horizontal movement) - positive deltaX = look right
        adjustHeading(deltaX * sensitivity)
        // Update pitch (vertical movement) - positive deltaY = look down
        adjustPitch(-deltaY * sensitivity)
      }

      lastMousePosRef.current = { x: movement.endPosition.x, y: movement.endPosition.y }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

    // Right-click drag end
    handler.setInputAction(() => {
      isDraggingRef.current = false
    }, Cesium.ScreenSpaceEventType.RIGHT_UP)

    // Middle-click drag end
    handler.setInputAction(() => {
      isDraggingRef.current = false
    }, Cesium.ScreenSpaceEventType.MIDDLE_UP)

    // Prevent context menu on right-click
    const canvas = viewer.canvas
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault()
    }
    canvas.addEventListener('contextmenu', handleContextMenu)

    return () => {
      handler.destroy()
      canvas.removeEventListener('contextmenu', handleContextMenu)
    }
  }, [viewer, adjustHeading, adjustPitch, adjustOrbitHeading, adjustOrbitPitch, moveForward, moveRight, onBreakTowerFollow, setActiveViewport, clearLookAtTarget])

  // Mouse wheel for zoom - adds impulse for smooth scrolling
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()

      // Normalize wheel delta and add to impulse (accumulates for fast scrolling)
      const normalizedDelta = Math.sign(event.deltaY) * Math.min(Math.abs(event.deltaY), 100) / 100
      wheelImpulseRef.current += normalizedDelta
      // Clamp total impulse to prevent excessive buildup
      wheelImpulseRef.current = Math.max(-3, Math.min(3, wheelImpulseRef.current))
    }

    const canvas = viewer.canvas
    canvas.addEventListener('wheel', handleWheel, { passive: false })

    return () => {
      canvas.removeEventListener('wheel', handleWheel)
    }
  }, [viewer])

  // Smooth keyboard controls with animation loop
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return

    const handleKeyDown = (event: KeyboardEvent) => {
      // Only process keyboard input if this viewport is active
      if (!isActiveRef.current) return

      // Ignore if typing in an input
      if (event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement) {
        return
      }

      // Ignore if any modal or command input is active
      if (useUIFeedbackStore.getState().isInputBlocked()) {
        return
      }

      const key = event.key

      // Handle one-shot keys (not continuous movement)
      switch (key) {
        case 't':
        case 'T':
          toggleViewMode()
          return
        case 'r':
          resetPosition()
          return
        case 'R':
          resetToDefault()
          return
        case 'Home':
          if (event.shiftKey) {
            resetToAppDefault()
          } else {
            resetToDefault()
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
      // Skip 5 - it's the center reference point, not a valid position
      if (!event.ctrlKey && !event.altKey && !event.shiftKey) {
        const numKey = parseInt(key)
        if (numKey >= 1 && numKey <= 9 && numKey !== 5) {
          const datablockStore = useDatablockPositionStore.getState()
          datablockStore.setPendingDirection(numKey as DatablockPosition)
          useUIFeedbackStore.getState().showFeedback(
            `Datablock position ${numKey}: Enter=all, Click=aircraft, Esc=cancel`,
            'success'
          )
          return
        }
      }

      // Handle Enter when pending direction exists (apply global position)
      if (key === 'Enter') {
        const datablockStore = useDatablockPositionStore.getState()
        if (datablockStore.pendingDirection) {
          useViewportStore.getState().setDatablockPosition(datablockStore.pendingDirection)
          useUIFeedbackStore.getState().showFeedback(
            `All datablocks moved to position ${datablockStore.pendingDirection}`,
            'success'
          )
          datablockStore.setPendingDirection(null)
          return
        }
      }

      // Track continuous movement keys
      if (MOVEMENT_KEYS.has(key)) {
        pressedKeysRef.current.add(key.toLowerCase())

        // Stop following in tower mode when arrow keys are pressed
        if ((key.startsWith('Arrow')) && followingCallsignRef.current && followModeRef.current === 'tower') {
          onBreakTowerFollow?.()
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
      const targets = calculateTargetVelocities(keys, viewModeRef.current, followingCallsignRef.current, followModeRef.current)

      // WASD movement (shift = sprint)
      const shiftHeld = keys.has('shift')
      const sprintMultiplier = shiftHeld ? 3.0 : 1.0

      // Process mouse wheel impulse (adds to velocity directly)
      wheelImpulseRef.current = applyWheelImpulse(vel, wheelImpulseRef.current, viewModeRef.current, followingCallsignRef.current, followModeRef.current)

      // Scale movement speed with altitude in topdown view, and apply sprint multiplier
      const effectiveMoveSpeed = calculateEffectiveMoveSpeed(
        MOVEMENT_CONFIG.MAX_MOVE_SPEED,
        viewModeRef.current === 'topdown',
        topdownAltitudeRef.current,
        sprintMultiplier
      )

      // Smoothly interpolate velocities toward targets
      vel.forward = accelerateVelocity(vel.forward, targets.forward, effectiveMoveSpeed, dt)
      vel.right = accelerateVelocity(vel.right, targets.right, effectiveMoveSpeed, dt)
      vel.up = accelerateVelocity(vel.up, targets.up, effectiveMoveSpeed, dt)
      vel.heading = accelerateVelocity(vel.heading, targets.heading, MOVEMENT_CONFIG.MAX_ROTATE_SPEED, dt)
      vel.pitch = accelerateVelocity(vel.pitch, targets.pitch, MOVEMENT_CONFIG.MAX_ROTATE_SPEED, dt)
      vel.zoom = accelerateVelocity(vel.zoom, targets.zoom, MOVEMENT_CONFIG.MAX_ZOOM_SPEED, dt)
      vel.orbitHeading = accelerateVelocity(vel.orbitHeading, targets.orbitHeading, MOVEMENT_CONFIG.MAX_ROTATE_SPEED, dt)
      vel.orbitPitch = accelerateVelocity(vel.orbitPitch, targets.orbitPitch, MOVEMENT_CONFIG.MAX_ROTATE_SPEED, dt)
      vel.orbitDistance = accelerateVelocity(vel.orbitDistance, targets.orbitDistance, MOVEMENT_CONFIG.MAX_ORBIT_DIST_SPEED, dt)
      vel.altitude = accelerateVelocity(vel.altitude, targets.altitude, MOVEMENT_CONFIG.MAX_ALTITUDE_SPEED, dt)

      // Reset velocity to zero when at a boundary to prevent momentum buildup
      // This stops the "rubberbanding" effect when hitting limits
      const currentPitch = pitchRef.current
      const currentFov = fovRef.current
      const currentOrbitPitch = orbitPitchRef.current
      const currentOrbitDistance = orbitDistanceRef.current
      const currentAltitude = topdownAltitudeRef.current

      // Pitch boundaries
      if ((currentPitch <= PITCH_MIN + 0.5 && vel.pitch < 0) ||
          (currentPitch >= PITCH_MAX - 0.5 && vel.pitch > 0)) {
        vel.pitch = 0
      }

      // Zoom velocity boundaries depend on current mode
      const inOrbitMode = followingCallsignRef.current && followModeRef.current === 'orbit'
      const inTowerFollow = followingCallsignRef.current && followModeRef.current === 'tower'

      if (inTowerFollow) {
        // Follow zoom boundaries (tower follow mode)
        const currentFollowZoom = followZoomRef.current
        if ((currentFollowZoom <= FOLLOW_ZOOM_MIN + 0.01 && vel.zoom < 0) ||
            (currentFollowZoom >= FOLLOW_ZOOM_MAX - 0.01 && vel.zoom > 0)) {
          vel.zoom = 0
          wheelImpulseRef.current = 0  // Also clear wheel impulse to stop momentum
        }
      } else if (!inOrbitMode && !followingCallsignRef.current) {
        // FOV boundaries (normal 3D mode, not following)
        if ((currentFov <= FOV_MIN + 0.5 && vel.zoom < 0) ||
            (currentFov >= FOV_MAX - 0.5 && vel.zoom > 0)) {
          vel.zoom = 0
          wheelImpulseRef.current = 0  // Also clear wheel impulse to stop momentum
        }
      }
      // Note: orbit mode uses orbitDistance for zoom, which is already checked above

      // Orbit pitch boundaries
      if ((currentOrbitPitch <= ORBIT_PITCH_MIN + 0.5 && vel.orbitPitch < 0) ||
          (currentOrbitPitch >= ORBIT_PITCH_MAX - 0.5 && vel.orbitPitch > 0)) {
        vel.orbitPitch = 0
      }

      // Orbit distance boundaries
      if ((currentOrbitDistance <= ORBIT_DISTANCE_MIN + 1 && vel.orbitDistance < 0) ||
          (currentOrbitDistance >= ORBIT_DISTANCE_MAX - 1 && vel.orbitDistance > 0)) {
        vel.orbitDistance = 0
        wheelImpulseRef.current = 0  // Also clear wheel impulse to stop momentum
      }

      // Top-down altitude boundaries
      if ((currentAltitude <= TOPDOWN_ALTITUDE_MIN + 1 && vel.altitude < 0) ||
          (currentAltitude >= TOPDOWN_ALTITUDE_MAX - 1 && vel.altitude > 0)) {
        vel.altitude = 0
        wheelImpulseRef.current = 0  // Also clear wheel impulse to stop momentum
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
          adjustFollowZoom(vel.zoom * dt)  // Tower follow mode zoom
        } else {
          adjustFov(vel.zoom * dt)
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
    setHeading,
    setPitch,
    clearLookAtTarget
  ])
}

export default useCameraInput
