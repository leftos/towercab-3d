import { useEffect } from 'react'
import { useVRStore } from '../../stores/vrStore'

function VRButton() {
  const isVRSupported = useVRStore((state) => state.isVRSupported)
  const isVRActive = useVRStore((state) => state.isVRActive)
  const setVRActive = useVRStore((state) => state.setVRActive)
  const checkVRSupport = useVRStore((state) => state.checkVRSupport)

  // Check for WebXR support on mount
  useEffect(() => {
    checkVRSupport()
  }, [checkVRSupport])

  // Don't render if VR is not supported
  if (!isVRSupported) {
    return null
  }

  const handleClick = () => {
    setVRActive(!isVRActive)
  }

  return (
    <button
      className={`control-button vr-button ${isVRActive ? 'active' : ''}`}
      onClick={handleClick}
      title={isVRActive ? 'Exit VR Mode' : 'Enter VR Mode'}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        {/* VR Headset icon */}
        <rect x="2" y="7" width="20" height="10" rx="2" />
        <circle cx="8" cy="12" r="2" />
        <circle cx="16" cy="12" r="2" />
        <path d="M10 12h4" />
      </svg>
      {isVRActive ? 'Exit VR' : 'VR'}
    </button>
  )
}

export default VRButton
