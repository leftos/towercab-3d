import { useCallback, useEffect, useRef } from 'react'
import * as Cesium from 'cesium'
import { useAirportStore } from '../stores/airportStore'
import { useCameraStore } from '../stores/cameraStore'
import { getTowerPosition } from '../utils/towerHeight'
import { calculateBearing } from '../utils/interpolation'
import type { InterpolatedAircraftState } from '../types/vatsim'

interface CameraControls {
  resetView: () => void
  followAircraft: (callsign: string) => void
  stopFollowing: () => void
}

/**
 * Hook for managing Cesium camera controls in tower view mode
 * Camera is fixed at tower position, only orientation changes
 * @param viewer - The Cesium viewer instance
 * @param interpolatedAircraft - Map of interpolated aircraft states for smooth follow tracking
 */
export function useCesiumCamera(
  viewer: Cesium.Viewer | null,
  interpolatedAircraft?: Map<string, InterpolatedAircraftState>
): CameraControls {
  const currentAirport = useAirportStore((state) => state.currentAirport)
  const towerHeight = useAirportStore((state) => state.towerHeight)

  // Camera store
  const viewMode = useCameraStore((state) => state.viewMode)
  const heading = useCameraStore((state) => state.heading)
  const pitch = useCameraStore((state) => state.pitch)
  const fov = useCameraStore((state) => state.fov)
  const positionOffsetX = useCameraStore((state) => state.positionOffsetX)
  const positionOffsetY = useCameraStore((state) => state.positionOffsetY)
  const positionOffsetZ = useCameraStore((state) => state.positionOffsetZ)
  const topdownAltitude = useCameraStore((state) => state.topdownAltitude)
  const followingCallsign = useCameraStore((state) => state.followingCallsign)
  const followZoom = useCameraStore((state) => state.followZoom)
  const toggleViewMode = useCameraStore((state) => state.toggleViewMode)
  const setHeading = useCameraStore((state) => state.setHeading)
  const setPitch = useCameraStore((state) => state.setPitch)
  const adjustHeading = useCameraStore((state) => state.adjustHeading)
  const adjustPitch = useCameraStore((state) => state.adjustPitch)
  const adjustFov = useCameraStore((state) => state.adjustFov)
  const adjustTopdownAltitude = useCameraStore((state) => state.adjustTopdownAltitude)
  const adjustFollowZoom = useCameraStore((state) => state.adjustFollowZoom)
  const followMode = useCameraStore((state) => state.followMode)
  const toggleFollowMode = useCameraStore((state) => state.toggleFollowMode)
  const orbitDistance = useCameraStore((state) => state.orbitDistance)
  const orbitHeading = useCameraStore((state) => state.orbitHeading)
  const orbitPitch = useCameraStore((state) => state.orbitPitch)
  const adjustOrbitDistance = useCameraStore((state) => state.adjustOrbitDistance)
  const adjustOrbitHeading = useCameraStore((state) => state.adjustOrbitHeading)
  const adjustOrbitPitch = useCameraStore((state) => state.adjustOrbitPitch)
  const moveForward = useCameraStore((state) => state.moveForward)
  const moveRight = useCameraStore((state) => state.moveRight)
  const resetViewStore = useCameraStore((state) => state.resetView)
  const resetPosition = useCameraStore((state) => state.resetPosition)
  const followAircraftStore = useCameraStore((state) => state.followAircraft)
  const stopFollowingStore = useCameraStore((state) => state.stopFollowing)

  // Mouse drag state
  const isDraggingRef = useRef(false)
  const lastMousePosRef = useRef({ x: 0, y: 0 })

  // Get tower position
  const getTowerPos = useCallback(() => {
    if (!currentAirport) return null
    return getTowerPosition(currentAirport, towerHeight)
  }, [currentAirport, towerHeight])

  // Reset view
  const resetView = useCallback(() => {
    resetViewStore()
  }, [resetViewStore])

  // Follow aircraft
  const followAircraft = useCallback((callsign: string) => {
    followAircraftStore(callsign)
  }, [followAircraftStore])

  // Stop following
  const stopFollowing = useCallback(() => {
    stopFollowingStore()
  }, [stopFollowingStore])

  // Disable Cesium's default camera controls
  useEffect(() => {
    if (!viewer) return

    const controller = viewer.scene.screenSpaceCameraController
    controller.enableRotate = false
    controller.enableTranslate = false
    controller.enableZoom = false
    controller.enableTilt = false
    controller.enableLook = false
  }, [viewer])

  // Update camera position and orientation
  useEffect(() => {
    if (!viewer) return

    const towerPos = getTowerPos()

    // Handle orbit mode following without requiring an airport
    if (followingCallsign && followMode === 'orbit' && interpolatedAircraft) {
      const aircraft = interpolatedAircraft.get(followingCallsign)
      if (aircraft) {
        // Use interpolated positions for smooth tracking
        const aircraftLat = aircraft.interpolatedLatitude
        const aircraftLon = aircraft.interpolatedLongitude
        const aircraftAlt = aircraft.interpolatedAltitude
        const aircraftHeading = aircraft.interpolatedHeading
        const altitudeMeters = aircraftAlt * 0.3048

        // ORBIT MODE: Camera orbits around aircraft
        const absoluteOrbitAngle = aircraftHeading + 180 + orbitHeading
        const orbitAngleRad = Cesium.Math.toRadians(absoluteOrbitAngle)
        const orbitPitchRad = Cesium.Math.toRadians(orbitPitch)

        // Calculate camera position using spherical coordinates relative to aircraft
        const horizontalDistance = orbitDistance * Math.cos(orbitPitchRad)
        const verticalOffset = orbitDistance * Math.sin(orbitPitchRad)

        // Convert horizontal distance to lat/lon offset
        const metersToDegreesLatOrbit = 1 / 111111
        const metersToDegreesLonOrbit = 1 / (111111 * Math.cos(aircraftLat * Math.PI / 180))

        // Camera position: aircraft position + spherical offset
        const cameraLat = aircraftLat + horizontalDistance * Math.cos(orbitAngleRad) * metersToDegreesLatOrbit
        const cameraLon = aircraftLon + horizontalDistance * Math.sin(orbitAngleRad) * metersToDegreesLonOrbit
        let cameraHeight = altitudeMeters + verticalOffset

        // Ensure camera doesn't go below ground (minimum 10m)
        cameraHeight = Math.max(10, cameraHeight)

        // Calculate heading/pitch to look at aircraft from camera position
        const targetHeading = calculateBearing(cameraLat, cameraLon, aircraftLat, aircraftLon)

        // Calculate pitch to look at aircraft
        const latDiff = (aircraftLat - cameraLat) * 111111
        const lonDiff = (aircraftLon - cameraLon) * 111111 * Math.cos(cameraLat * Math.PI / 180)
        const distToAircraft = Math.sqrt(latDiff * latDiff + lonDiff * lonDiff)
        const altDiff = altitudeMeters - cameraHeight
        const targetPitch = Math.atan2(altDiff, distToAircraft) * 180 / Math.PI

        // Apply follow zoom to FOV
        const targetFov = Math.max(10, Math.min(120, 60 / followZoom))

        // Update store with calculated values (for UI display)
        setHeading(targetHeading)
        setPitch(targetPitch)

        // Set camera position and orientation
        const cameraPosition = Cesium.Cartesian3.fromDegrees(cameraLon, cameraLat, cameraHeight)
        viewer.camera.setView({
          destination: cameraPosition,
          orientation: {
            heading: Cesium.Math.toRadians(targetHeading),
            pitch: Cesium.Math.toRadians(targetPitch),
            roll: 0
          }
        })

        // Set FOV
        if (viewer.camera.frustum instanceof Cesium.PerspectiveFrustum) {
          viewer.camera.frustum.fov = Cesium.Math.toRadians(targetFov)
        }
        return
      } else {
        // Aircraft no longer exists, stop following
        stopFollowingStore()
      }
    }

    // For all other modes, we need a tower position
    if (!towerPos) return

    // Apply position offsets (convert meters to degrees approximately)
    const metersToDegreesLat = 1 / 111111
    const metersToDegreesLon = 1 / (111111 * Math.cos(towerPos.latitude * Math.PI / 180))

    const offsetLat = towerPos.latitude + positionOffsetY * metersToDegreesLat
    const offsetLon = towerPos.longitude + positionOffsetX * metersToDegreesLon
    const offsetHeight = towerPos.height + positionOffsetZ

    // Handle different view modes
    if (viewMode === 'topdown') {
      // Top-down view: camera above airport looking straight down
      const airportElevation = currentAirport?.elevation ? currentAirport.elevation * 0.3048 : 0
      const cameraPosition = Cesium.Cartesian3.fromDegrees(
        offsetLon,
        offsetLat,
        airportElevation + topdownAltitude
      )

      viewer.camera.setView({
        destination: cameraPosition,
        orientation: {
          heading: Cesium.Math.toRadians(heading),
          pitch: Cesium.Math.toRadians(-90), // Look straight down
          roll: 0
        }
      })

      // Wider FOV for top-down view
      if (viewer.camera.frustum instanceof Cesium.PerspectiveFrustum) {
        viewer.camera.frustum.fov = Cesium.Math.toRadians(60)
      }
      return
    }

    // 3D tower view mode
    let targetHeading = heading
    let targetPitch = pitch
    let targetFov = fov
    let cameraLat = offsetLat
    let cameraLon = offsetLon
    let cameraHeight = offsetHeight

    // If following an aircraft in tower mode
    if (followingCallsign && followMode === 'tower' && interpolatedAircraft) {
      const aircraft = interpolatedAircraft.get(followingCallsign)
      if (aircraft) {
        // Use interpolated positions for smooth tracking
        const aircraftLat = aircraft.interpolatedLatitude
        const aircraftLon = aircraft.interpolatedLongitude
        const aircraftAlt = aircraft.interpolatedAltitude
        const altitudeMeters = aircraftAlt * 0.3048

        // TOWER MODE: Camera stays at tower, rotates to look at aircraft
        // Calculate bearing to aircraft from current position
        const bearing = calculateBearing(
          offsetLat,
          offsetLon,
          aircraftLat,
          aircraftLon
        )

        // Calculate pitch based on altitude difference and distance
        const altitudeDiff = altitudeMeters - offsetHeight

        // Approximate distance in meters
        const latDiff = (aircraftLat - offsetLat) * 111111
        const lonDiff = (aircraftLon - offsetLon) *
          111111 * Math.cos(offsetLat * Math.PI / 180)
        const horizontalDistance = Math.sqrt(latDiff * latDiff + lonDiff * lonDiff)

        const pitchAngle = Math.atan2(altitudeDiff, horizontalDistance) * 180 / Math.PI

        targetHeading = bearing
        targetPitch = pitchAngle

        // Apply follow zoom to FOV
        targetFov = Math.max(10, Math.min(120, 60 / followZoom))

        // Update store with calculated values (for UI display)
        setHeading(bearing)
        setPitch(pitchAngle)
      } else {
        // Aircraft no longer exists, stop following
        stopFollowingStore()
      }
    }

    // Set camera position and orientation
    const cameraPosition = Cesium.Cartesian3.fromDegrees(
      cameraLon,
      cameraLat,
      cameraHeight
    )

    viewer.camera.setView({
      destination: cameraPosition,
      orientation: {
        heading: Cesium.Math.toRadians(targetHeading),
        pitch: Cesium.Math.toRadians(targetPitch),
        roll: 0
      }
    })

    // Set FOV
    if (viewer.camera.frustum instanceof Cesium.PerspectiveFrustum) {
      viewer.camera.frustum.fov = Cesium.Math.toRadians(targetFov)
    }
  }, [
    viewer,
    getTowerPos,
    viewMode,
    heading,
    pitch,
    fov,
    positionOffsetX,
    positionOffsetY,
    positionOffsetZ,
    topdownAltitude,
    currentAirport,
    followingCallsign,
    followMode,
    followZoom,
    orbitDistance,
    orbitHeading,
    orbitPitch,
    interpolatedAircraft,
    setHeading,
    setPitch,
    stopFollowingStore
  ])

  // Mouse drag controls for panning/tilting using Cesium's event handler
  useEffect(() => {
    if (!viewer) return

    // Use Cesium's ScreenSpaceEventHandler for reliable mouse event handling
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas)

    // Right-click drag start
    handler.setInputAction((movement: { position: Cesium.Cartesian2 }) => {
      isDraggingRef.current = true
      lastMousePosRef.current = { x: movement.position.x, y: movement.position.y }

      // In tower follow mode, stop following when user starts dragging
      // In orbit mode, allow drag to orbit around the aircraft
      if (followingCallsign && followMode === 'tower') {
        stopFollowingStore()
      }
    }, Cesium.ScreenSpaceEventType.RIGHT_DOWN)

    // Middle-click drag start
    handler.setInputAction((movement: { position: Cesium.Cartesian2 }) => {
      isDraggingRef.current = true
      lastMousePosRef.current = { x: movement.position.x, y: movement.position.y }

      // In tower follow mode, stop following when user starts dragging
      if (followingCallsign && followMode === 'tower') {
        stopFollowingStore()
      }
    }, Cesium.ScreenSpaceEventType.MIDDLE_DOWN)

    // Mouse move while dragging
    handler.setInputAction((movement: { startPosition: Cesium.Cartesian2; endPosition: Cesium.Cartesian2 }) => {
      if (!isDraggingRef.current) return

      const deltaX = movement.endPosition.x - lastMousePosRef.current.x
      const deltaY = movement.endPosition.y - lastMousePosRef.current.y

      // Sensitivity
      const sensitivity = 0.3

      if (followingCallsign && followMode === 'orbit') {
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
  }, [viewer, followingCallsign, followMode, adjustHeading, adjustPitch, adjustOrbitHeading, adjustOrbitPitch, stopFollowingStore])

  // Mouse wheel for zoom
  useEffect(() => {
    if (!viewer) return

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()

      if (viewMode === 'topdown') {
        // In top-down mode, adjust altitude
        const altitudeSpeed = 100
        adjustTopdownAltitude(event.deltaY > 0 ? altitudeSpeed : -altitudeSpeed)
      } else if (followingCallsign && followMode === 'orbit') {
        // In orbit mode, adjust orbit distance
        const distanceSpeed = 50
        adjustOrbitDistance(event.deltaY > 0 ? distanceSpeed : -distanceSpeed)
      } else if (followingCallsign) {
        // In tower follow mode, adjust follow zoom
        adjustFollowZoom(event.deltaY > 0 ? -0.1 : 0.1)
      } else {
        // When not following, adjust FOV
        const zoomSpeed = 2
        const delta = event.deltaY > 0 ? zoomSpeed : -zoomSpeed
        adjustFov(delta)
      }
    }

    const canvas = viewer.canvas
    canvas.addEventListener('wheel', handleWheel, { passive: false })

    return () => {
      canvas.removeEventListener('wheel', handleWheel)
    }
  }, [viewer, viewMode, followingCallsign, followMode, adjustFov, adjustFollowZoom, adjustOrbitDistance, adjustTopdownAltitude])

  // Keyboard controls
  useEffect(() => {
    if (!viewer) return

    const handleKeyDown = (event: KeyboardEvent) => {
      // Ignore if typing in an input
      if (event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement) {
        return
      }

      const rotateAmount = 3  // degrees
      const zoomAmount = 5
      const moveDistance = 10  // meters

      switch (event.key) {
        // WASD movement
        case 'w':
        case 'W':
          moveForward(moveDistance)
          break
        case 's':
        case 'S':
          moveForward(-moveDistance)
          break
        case 'a':
        case 'A':
          moveRight(-moveDistance)
          break
        case 'd':
        case 'D':
          moveRight(moveDistance)
          break

        // Arrow keys for camera rotation / orbit control
        case 'ArrowLeft':
          if (followingCallsign && followMode === 'orbit') {
            adjustOrbitHeading(-rotateAmount)
          } else {
            adjustHeading(-rotateAmount)
            if (followingCallsign) stopFollowingStore()
          }
          break
        case 'ArrowRight':
          if (followingCallsign && followMode === 'orbit') {
            adjustOrbitHeading(rotateAmount)
          } else {
            adjustHeading(rotateAmount)
            if (followingCallsign) stopFollowingStore()
          }
          break
        case 'ArrowUp':
          if (followingCallsign && followMode === 'orbit') {
            adjustOrbitPitch(rotateAmount)
          } else {
            adjustPitch(rotateAmount)
            if (followingCallsign) stopFollowingStore()
          }
          break
        case 'ArrowDown':
          if (followingCallsign && followMode === 'orbit') {
            adjustOrbitPitch(-rotateAmount)
          } else {
            adjustPitch(-rotateAmount)
            if (followingCallsign) stopFollowingStore()
          }
          break

        // View mode toggle
        case 't':
        case 'T':
          toggleViewMode()
          break

        // Reset position (R resets position, Home resets everything)
        case 'r':
          resetPosition()
          break
        case 'R':
        case 'Home':
          resetView()
          break

        // Zoom controls
        case '+':
        case '=':
          if (viewMode === 'topdown') {
            adjustTopdownAltitude(-200)
          } else if (followingCallsign && followMode === 'orbit') {
            adjustOrbitDistance(-100)
          } else if (followingCallsign) {
            adjustFollowZoom(0.2)
          } else {
            adjustFov(-zoomAmount)
          }
          break
        case '-':
        case '_':
          if (viewMode === 'topdown') {
            adjustTopdownAltitude(200)
          } else if (followingCallsign && followMode === 'orbit') {
            adjustOrbitDistance(100)
          } else if (followingCallsign) {
            adjustFollowZoom(-0.2)
          } else {
            adjustFov(zoomAmount)
          }
          break

        // Toggle follow mode (tower/orbit) when following
        case 'o':
        case 'O':
          if (followingCallsign) {
            toggleFollowMode()
          }
          break

        case 'Escape':
          stopFollowing()
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [
    viewer,
    viewMode,
    followingCallsign,
    followMode,
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
    toggleViewMode,
    resetView,
    resetPosition,
    stopFollowing,
    stopFollowingStore
  ])

  return {
    resetView,
    followAircraft,
    stopFollowing
  }
}

export default useCesiumCamera
