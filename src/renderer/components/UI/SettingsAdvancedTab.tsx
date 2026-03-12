import { useRef, useState } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useReplayStore } from '../../stores/replayStore'
import { useUpdateStore } from '../../stores/updateStore'
import { checkForUpdates } from '../../services/UpdateService'
import { repairSettingsMigration } from '../../stores/globalSettingsStore'
import { isRemoteMode } from '../../utils/remoteMode'
import { DIAGNOSTIC_FILE_EXTENSION } from '../../constants/diagnostic'
import CollapsibleSection from './settings/CollapsibleSection'
import './ControlsBar.css'

function SettingsAdvancedTab() {
  const diagnosticFileInputRef = useRef<HTMLInputElement>(null)

  // Theme setting
  const theme = useSettingsStore((state) => state.ui.theme)
  const updateUISettings = useSettingsStore((state) => state.updateUISettings)

  // Advanced settings
  const enableInterpolationDebugLogs = useSettingsStore(
    (state) => state.advanced?.enableInterpolationDebugLogs ?? false,
  )
  const enableDebugCoordinateOverlay = useSettingsStore(
    (state) => state.advanced?.enableDebugCoordinateOverlay ?? false,
  )
  const enableDynamicDisplayDelay = useSettingsStore((state) => state.advanced?.enableDynamicDisplayDelay ?? true)
  const updateAdvancedSettings = useSettingsStore((state) => state.updateAdvancedSettings)

  // Replay store (for diagnostic import)
  const importReplay = useReplayStore((state) => state.importReplay)
  const importedTimeRange = useReplayStore((state) => state.importedTimeRange)
  const importedAppState = useReplayStore((state) => state.importedAppState)
  const clearImportedReplay = useReplayStore((state) => state.clearImportedReplay)

  // Updates
  const updateStatus = useUpdateStore((state) => state.status)

  // Troubleshooting
  const [repairStatus, setRepairStatus] = useState<'idle' | 'running' | 'done'>('idle')
  const [repairResult, setRepairResult] = useState<{ recovered: string[]; errors: string[] } | null>(null)

  const handleDiagnosticFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    try {
      const text = await file.text()
      const data = JSON.parse(text)

      if (!data || typeof data !== 'object') {
        alert('Invalid diagnostic file: not a valid JSON object')
        return
      }

      const success = importReplay(data)
      if (!success) {
        alert('Invalid diagnostic file format. Check console for details.')
      }
    } catch (error) {
      const message =
        error instanceof SyntaxError ? 'Invalid JSON format' : error instanceof Error ? error.message : 'Unknown error'
      console.error('[Diagnostic Import] Failed to read file:', error)
      alert(`Failed to read diagnostic file: ${message}`)
    }

    e.target.value = ''
  }

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

      <CollapsibleSection title="Performance">
        <div className="setting-item">
          <label className="setting-label">
            <input
              type="checkbox"
              checked={enableDynamicDisplayDelay}
              onChange={(e) => updateAdvancedSettings({ enableDynamicDisplayDelay: e.target.checked })}
            />
            Dynamic Display Delay
          </label>
          <p className="setting-hint">
            Automatically adjusts display delay per aircraft based on observation timing. This minimizes latency while
            ensuring smooth interpolation between positions. Disable to use fixed source-based delays (legacy behavior).
          </p>
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
            Logs detailed interpolation data to the browser console for the followed aircraft. Useful for diagnosing
            position snapping or timing issues. Open Developer Tools (F12) to view.
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
            Shows a panel with camera coordinates. Click anywhere to copy terrain coordinates to clipboard. Useful for
            reporting exact locations of terrain flattening issues.
          </p>
        </div>

        <div className="setting-item">
          <div className="import-export-buttons">
            <button className="control-button" onClick={() => diagnosticFileInputRef.current?.click()}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Import Diagnostic
            </button>
            <input
              ref={diagnosticFileInputRef}
              type="file"
              accept={`.${DIAGNOSTIC_FILE_EXTENSION}`}
              onChange={handleDiagnosticFileChange}
              style={{ display: 'none' }}
            />
          </div>
          <p className="setting-hint">
            Load a .tc3d-diag file with raw timeline data for debugging. Export with Ctrl+Shift+D or from the Aircraft
            Timeline modal.
          </p>
        </div>

        {importedTimeRange && importedAppState && (
          <div className="setting-item">
            <p className="setting-hint" style={{ color: '#ff9800' }}>
              Viewing diagnostic data
              {importedAppState.airport ? ` (${importedAppState.airport.icao})` : ''}
            </p>
            <button className="control-button" onClick={clearImportedReplay} style={{ marginTop: '8px' }}>
              Clear Diagnostic Data
            </button>
          </div>
        )}
      </CollapsibleSection>

      {/* Updates and Troubleshooting - Only visible on desktop app */}
      {!isRemoteMode() && (
        <>
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
              <button className="control-button" onClick={handleRepairSettings} disabled={repairStatus === 'running'}>
                {repairStatus === 'running' ? 'Repairing...' : 'Repair Settings'}
              </button>
            </div>
            <p className="setting-hint">
              Settings recovery runs automatically on startup. Use this button to manually re-check if settings are
              still missing after an upgrade.
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
      )}
    </>
  )
}

export default SettingsAdvancedTab
