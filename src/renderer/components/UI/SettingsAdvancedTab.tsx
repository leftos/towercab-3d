import { useState } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUpdateStore } from '../../stores/updateStore'
import { checkForUpdates } from '../../services/UpdateService'
import { repairSettingsMigration } from '../../stores/globalSettingsStore'
import CollapsibleSection from './settings/CollapsibleSection'
import './ControlsBar.css'

function SettingsAdvancedTab() {
  // Theme setting
  const theme = useSettingsStore((state) => state.ui.theme)
  const updateUISettings = useSettingsStore((state) => state.updateUISettings)

  // Debugging settings
  const enableInterpolationDebugLogs = useSettingsStore((state) => state.advanced?.enableInterpolationDebugLogs ?? false)
  const enableDebugCoordinateOverlay = useSettingsStore((state) => state.advanced?.enableDebugCoordinateOverlay ?? false)
  const updateAdvancedSettings = useSettingsStore((state) => state.updateAdvancedSettings)

  // Updates
  const updateStatus = useUpdateStore((state) => state.status)

  // Troubleshooting
  const [repairStatus, setRepairStatus] = useState<'idle' | 'running' | 'done'>('idle')
  const [repairResult, setRepairResult] = useState<{ recovered: string[]; errors: string[] } | null>(null)

  const handleRepairSettings = async () => {
    setRepairStatus('running')
    setRepairResult(null)
    try {
      const result = await repairSettingsMigration()
      setRepairResult(result)
      setRepairStatus('done')
      if (result.recovered.length > 0) {
        // Reload the page to apply recovered settings
        setTimeout(() => {
          window.location.reload()
        }, 2000)
      }
    } catch {
      setRepairStatus('done')
      setRepairResult({ recovered: [], errors: ['Repair failed unexpectedly'] })
    }
  }

  return (
    <>
      <CollapsibleSection title="Appearance">
        <div className="setting-item">
          <label>Theme</label>
          <div className="radio-group">
            <label>
              <input
                type="radio"
                name="theme"
                value="dark"
                checked={theme === 'dark'}
                onChange={() => updateUISettings({ theme: 'dark' })}
              />
              Dark
            </label>
            <label>
              <input
                type="radio"
                name="theme"
                value="light"
                checked={theme === 'light'}
                onChange={() => updateUISettings({ theme: 'light' })}
              />
              Light
            </label>
          </div>
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Debugging">
        <div className="setting-item">
          <label className="setting-label">
            <input
              type="checkbox"
              checked={enableInterpolationDebugLogs}
              onChange={(e) => updateAdvancedSettings({ enableInterpolationDebugLogs: e.target.checked })}
            />
            Enable Interpolation Debug Logs
          </label>
          <p className="setting-hint">
            Logs detailed interpolation data to the browser console for the followed aircraft.
            Useful for diagnosing position snapping or timing issues. Open Developer Tools (F12) to view.
          </p>
        </div>

        <div className="setting-item">
          <label className="setting-label">
            <input
              type="checkbox"
              checked={enableDebugCoordinateOverlay}
              onChange={(e) => updateAdvancedSettings({ enableDebugCoordinateOverlay: e.target.checked })}
            />
            Enable Debug Coordinate Overlay
          </label>
          <p className="setting-hint">
            Shows a panel with camera coordinates. Click anywhere to copy terrain coordinates to clipboard.
            Useful for reporting exact locations of terrain flattening issues.
          </p>
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Updates">
        <div className="setting-row">
          <button
            className="control-button"
            onClick={() => checkForUpdates()}
            disabled={updateStatus === 'checking' || updateStatus === 'downloading'}
          >
            {updateStatus === 'checking' ? 'Checking...' : 'Check for Updates'}
          </button>
        </div>
        <p className="setting-hint" style={{ marginTop: '8px' }}>
          Current version: v{APP_VERSION}
        </p>
      </CollapsibleSection>

      <CollapsibleSection title="Troubleshooting">
        <div className="setting-row">
          <span className="setting-label">Repair Settings Migration</span>
          <button
            className="control-button"
            onClick={handleRepairSettings}
            disabled={repairStatus === 'running'}
          >
            {repairStatus === 'running' ? 'Repairing...' : 'Repair Settings'}
          </button>
        </div>
        <p className="setting-hint">
          Settings recovery runs automatically on startup. Use this button to manually
          re-check if settings are still missing after an upgrade.
        </p>
        {repairResult && (
          <div style={{ marginTop: '8px' }}>
            {repairResult.recovered.length > 0 && (
              <>
                <p style={{ color: 'var(--success-color, #4caf50)', margin: '4px 0' }}>
                  Recovered: {repairResult.recovered.join(', ')}
                </p>
                <p className="setting-hint">Reloading to apply changes...</p>
              </>
            )}
            {repairResult.recovered.length === 0 && repairResult.errors.length === 0 && (
              <p className="setting-hint">No recoverable settings found in browser storage.</p>
            )}
            {repairResult.errors.length > 0 && (
              <p style={{ color: 'var(--error-color, #f44336)', margin: '4px 0' }}>
                Errors: {repairResult.errors.join(', ')}
              </p>
            )}
          </div>
        )}
      </CollapsibleSection>
    </>
  )
}

export default SettingsAdvancedTab
