/**
 * Device Optimization Prompt
 *
 * Shows a one-time prompt on touch devices (iPad/tablet) asking users if they
 * want to apply device-optimized settings for better performance.
 */

import { useState, useEffect } from 'react'
import { useSettingsStore, type SettingsPreset } from '../../stores/settingsStore'
import { isTouchDevice, isIPad, isMobileDevice, getDevicePerformanceTier } from '../../utils/deviceDetection'
import './DeviceOptimizationPrompt.css'

function DeviceOptimizationPrompt() {
  const [showPrompt, setShowPrompt] = useState(false)
  const [suggestedPreset, setSuggestedPreset] = useState<SettingsPreset>('ipad')

  const deviceOptimizationPromptDismissed = useSettingsStore((state) => state.ui.deviceOptimizationPromptDismissed)
  const updateUISettings = useSettingsStore((state) => state.updateUISettings)
  const applyPreset = useSettingsStore((state) => state.applyPreset)

  useEffect(() => {
    // Only show prompt on touch devices that haven't dismissed it
    if (deviceOptimizationPromptDismissed) return
    if (!isTouchDevice()) return

    // Determine suggested preset based on device type
    const tier = getDevicePerformanceTier()
    if (tier === 'low' || isMobileDevice()) {
      setSuggestedPreset('mobile')
    } else if (isIPad()) {
      setSuggestedPreset('ipad')
    } else {
      setSuggestedPreset('ipad') // Default to iPad for unknown touch devices
    }

    // Small delay to avoid flash on load
    const timer = setTimeout(() => {
      setShowPrompt(true)
    }, 1500)

    return () => clearTimeout(timer)
  }, [deviceOptimizationPromptDismissed])

  const handleApplyOptimizations = () => {
    applyPreset(suggestedPreset)
    updateUISettings({ deviceOptimizationPromptDismissed: true })
    setShowPrompt(false)
  }

  const handleDismiss = () => {
    updateUISettings({ deviceOptimizationPromptDismissed: true })
    setShowPrompt(false)
  }

  if (!showPrompt) return null

  const presetDisplayName = suggestedPreset === 'mobile' ? 'Mobile' : 'iPad/Tablet'
  const presetDescription = suggestedPreset === 'mobile'
    ? 'Lower graphics settings for smooth performance on phones'
    : 'Reduced shadows and tile caching for smooth iPad performance'

  return (
    <div className="device-opt-overlay">
      <div className="device-opt-modal">
        <div className="device-opt-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="4" y="2" width="16" height="20" rx="2" />
            <line x1="12" y1="18" x2="12" y2="18.01" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>

        <h2 className="device-opt-title">Optimize for {presetDisplayName}?</h2>

        <p className="device-opt-description">
          We detected you&apos;re using a touch device. Would you like to apply
          optimized settings for better performance?
        </p>

        <div className="device-opt-preset-info">
          <div className="device-opt-preset-name">{presetDisplayName} Preset</div>
          <div className="device-opt-preset-desc">{presetDescription}</div>
          <ul className="device-opt-preset-changes">
            {suggestedPreset === 'mobile' ? (
              <>
                <li>Shadows: Off</li>
                <li>Anti-aliasing: None</li>
                <li>Terrain: Low quality</li>
                <li>Tile cache: 200 tiles</li>
              </>
            ) : (
              <>
                <li>Shadows: Off</li>
                <li>Anti-aliasing: 2x MSAA</li>
                <li>Terrain: Medium quality</li>
                <li>Tile cache: 500 tiles</li>
              </>
            )}
          </ul>
        </div>

        <div className="device-opt-actions">
          <button className="device-opt-btn device-opt-btn-primary" onClick={handleApplyOptimizations}>
            Apply Optimizations
          </button>
          <button className="device-opt-btn device-opt-btn-secondary" onClick={handleDismiss}>
            Keep Desktop Settings
          </button>
        </div>

        <p className="device-opt-note">
          You can change these later in Settings → Graphics
        </p>
      </div>
    </div>
  )
}

export default DeviceOptimizationPrompt
