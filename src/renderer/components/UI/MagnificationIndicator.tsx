import { FOV_DEFAULT } from '../../constants'
import { useViewportStore } from '../../stores/viewportStore'
import { calculateFollowFov } from '../../utils/cameraGeometry'
import './MagnificationIndicator.css'

/**
 * Displays magnification level (e.g., "10x") when zoomed past normal vision.
 *
 * Magnification = FOV_DEFAULT / effectiveFov, where:
 * - Normal 3D mode: effectiveFov = camera FOV
 * - Tower follow mode: effectiveFov = calculateFollowFov(60, followZoom)
 *
 * Only visible when magnification >= 1.1x. Hidden in topdown mode.
 */
function MagnificationIndicator() {
  const cameraState = useViewportStore((state) => state.getActiveCameraState())

  const { viewMode, followingCallsign, followMode, fov, followZoom } = cameraState

  // Don't show in topdown mode
  if (viewMode === 'topdown') return null

  // Calculate effective FOV
  let effectiveFov: number
  if (followingCallsign && followMode === 'tower') {
    effectiveFov = calculateFollowFov(FOV_DEFAULT, followZoom)
  } else {
    effectiveFov = fov
  }

  // Calculate magnification
  const magnification = FOV_DEFAULT / effectiveFov

  // Only show when zoomed past 1.1x
  if (magnification < 1.1) return null

  // Format: one decimal for < 10x, integer for >= 10x
  const formatted = magnification >= 10 ? `${Math.round(magnification)}x` : `${magnification.toFixed(1)}x`

  return <div className="magnification-indicator">{formatted}</div>
}

export default MagnificationIndicator
