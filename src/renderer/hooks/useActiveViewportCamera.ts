import { useMemo } from 'react'
import { useViewportStore } from '../stores/viewportStore'
import type { ViewportCameraState, ViewMode, FollowMode } from '@/types'

/**
 * Hook to access the active viewport's camera state reactively.
 * Returns both the camera state values and the actions to modify them.
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
