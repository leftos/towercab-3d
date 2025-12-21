import { useEffect, useRef, useMemo } from 'react'
import * as Cesium from 'cesium'
import { useViewportStore } from '../stores/viewportStore'
import { useSettingsStore } from '../stores/settingsStore'
import {
  createVelocityState,
  MOVEMENT_CONFIG,
  MOVEMENT_KEYS,
  accelerateVelocity,
  calculateEffectiveMoveSpeed,
  calculateTargetVelocities,
  applyWheelImpulse
} from '../utils/inputVelocity'

interface UseCameraInputOptions {
  /** Callback when user manually breaks out of tower follow mode */
  onBreakTowerFollow?: () => void
}

/**
 * Hook for handling camera input (keyboard, mouse drag, mouse wheel)
 * Manages smooth velocity-based movement with acceleration/deceleration
 * Only processes input when this viewport is the active viewport.
 *
 * @param viewer - The Cesium viewer instance
 * @param viewportId - The ID of the viewport this hook controls
 * @param options - Configuration options
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
  const topdownAltitude = cameraState?.topdownAltitude ?? 5000
  const followingCallsign = cameraState?.followingCallsign ?? null
  const followMode = cameraState?.followMode ?? 'tower'

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
  const resetView = useViewportStore((state) => state.resetView)
  const resetPosition = useViewportStore((state) => state.resetPosition)
  const stopFollowing = useViewportStore((state) => state.stopFollowing)
  const setActiveViewport = useViewportStore((state) => state.setActiveViewport)

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
  const followingCallsignRef = useRef(followingCallsign)
  const followModeRef = useRef(followMode)
  const mouseSensitivityRef = useRef(mouseSensitivity)
  const isActiveRef = useRef(activeViewportId === viewportId)
  const viewportIdRef = useRef(viewportId)

  // Keep refs updated
  viewModeRef.current = viewMode
  topdownAltitudeRef.current = topdownAltitude
  headingRef.current = heading
  followingCallsignRef.current = followingCallsign
  followModeRef.current = followMode
  mouseSensitivityRef.current = mouseSensitivity
  isActiveRef.current = activeViewportId === viewportId
  viewportIdRef.current = viewportId

  // Mouse drag controls for panning/tilting using Cesium's event handler
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return

    // Use Cesium's ScreenSpaceEventHandler for reliable mouse event handling
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas)

    // Left-click drag start (for panning in top-down view)
    handler.setInputAction((movement: { position: Cesium.Cartesian2 }) => {
      // Activate this viewport on click
      setActiveViewport(viewportIdRef.current)
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
      // Activate this viewport on click
      setActiveViewport(viewportIdRef.current)
      isDraggingRef.current = true
      lastMousePosRef.current = { x: movement.position.x, y: movement.position.y }

      // In tower follow mode, stop following when user starts dragging
      if (followingCallsignRef.current && followModeRef.current === 'tower') {
        onBreakTowerFollow?.()
      }
    }, Cesium.ScreenSpaceEventType.RIGHT_DOWN)

    // Middle-click drag start
    handler.setInputAction((movement: { position: Cesium.Cartesian2 }) => {
      // Activate this viewport on click
      setActiveViewport(viewportIdRef.current)
      isDraggingRef.current = true
      lastMousePosRef.current = { x: movement.position.x, y: movement.position.y }

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
  }, [viewer, adjustHeading, adjustPitch, adjustOrbitHeading, adjustOrbitPitch, moveForward, moveRight, onBreakTowerFollow, setActiveViewport])

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
        case 'Home':
          resetView()
          return
        case 'o':
        case 'O':
          if (followingCallsignRef.current) {
            toggleFollowMode()
          }
          return
        case 'Escape':
          stopFollowing()
          return
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

      // Apply velocities
      const threshold = MOVEMENT_CONFIG.VELOCITY_THRESHOLD

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
          adjustFollowZoom(vel.zoom * dt * 0.05)  // Scale down for follow zoom
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
    resetView,
    resetPosition,
    stopFollowing,
    onBreakTowerFollow
  ])
}

export default useCameraInput
