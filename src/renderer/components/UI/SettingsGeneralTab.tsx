import { useState, useEffect, useCallback } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useGlobalSettingsStore } from '../../stores/globalSettingsStore'
import { exportAllData, downloadExport } from '../../services/ExportImportService'
import { shellApi } from '../../utils/tauriApi'
import FSLTLImportPanel from './FSLTLImportPanel'
import './ControlsBar.css'

interface SettingsGeneralTabProps {
  onShowImportModal: () => void
  importStatus: 'idle' | 'success' | 'error'
}

function SettingsGeneralTab({ onShowImportModal, importStatus }: SettingsGeneralTabProps) {
  // Cesium token from global settings (shared across browsers)
  const cesiumIonToken = useGlobalSettingsStore((state) => state.cesiumIonToken)
  const setCesiumIonToken = useGlobalSettingsStore((state) => state.setCesiumIonToken)

  // Settings store - Local settings
  const theme = useSettingsStore((state) => state.ui.theme)
  const updateUISettings = useSettingsStore((state) => state.updateUISettings)
  const defaultFov = useSettingsStore((state) => state.camera.defaultFov)
  const cameraSpeed = useSettingsStore((state) => state.camera.cameraSpeed)
  const mouseSensitivity = useSettingsStore((state) => state.camera.mouseSensitivity)
  const joystickSensitivity = useSettingsStore((state) => state.camera.joystickSensitivity)
  const enableAutoAirportSwitch = useSettingsStore((state) => state.camera.enableAutoAirportSwitch ?? false)
  const updateCameraSettings = useSettingsStore((state) => state.updateCameraSettings)

  // Local state for Cesium Ion token input (only saved on button click)
  const [tokenInput, setTokenInput] = useState('')
  const [tokenSaved, setTokenSaved] = useState(false)

  // Sync token input with store value when component mounts or store changes
  useEffect(() => {
    setTokenInput(cesiumIonToken)
    setTokenSaved(false)
  }, [cesiumIonToken])

  const handleSaveToken = useCallback(async () => {
    if (tokenInput.trim() && tokenInput !== cesiumIonToken) {
      // Save to global settings (host file system)
      await setCesiumIonToken(tokenInput.trim())
      setTokenSaved(true)
      setTimeout(() => setTokenSaved(false), 2000)
    }
  }, [tokenInput, cesiumIonToken, setCesiumIonToken])

  const handleExportSettings = () => {
    const data = exportAllData()
    downloadExport(data)
  }

  return (
    <>
      <div className="settings-section">
        <h3>Cesium Ion</h3>
        <div className="setting-item">
          <label>API Token</label>
          <div className="token-input-row">
            <input
              type="text"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="Enter your Cesium Ion access token"
              className="text-input token-input"
            />
            <button
              className={`token-save-button ${tokenSaved ? 'saved' : ''}`}
              onClick={handleSaveToken}
              disabled={!tokenInput.trim() || tokenInput === cesiumIonToken}
            >
              {tokenSaved ? 'Saved!' : 'Save'}
            </button>
          </div>
          <p className="setting-hint">
            Get a free token at{' '}
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); shellApi.openExternal('https://ion.cesium.com/tokens') }}
              className="external-link"
            >
              ion.cesium.com
            </a>
            . Changes require saving to take effect.
          </p>
        </div>
      </div>

      <div className="settings-section">
        <h3>Appearance</h3>
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
      </div>

      <div className="settings-section">
        <h3>Camera</h3>
        <div className="setting-item">
          <label>Default FOV</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="10"
              max="120"
              value={defaultFov}
              onChange={(e) => updateCameraSettings({ defaultFov: Number(e.target.value) })}
            />
            <span>{defaultFov}°</span>
          </div>
          <p className="setting-hint">Field of view used when resetting camera.</p>
        </div>

        <div className="setting-item">
          <label>Camera Speed</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="1"
              max="10"
              value={cameraSpeed}
              onChange={(e) => updateCameraSettings({ cameraSpeed: Number(e.target.value) })}
            />
            <span>{cameraSpeed}</span>
          </div>
          <p className="setting-hint">WASD movement speed multiplier.</p>
        </div>

        <div className="setting-item">
          <label>Mouse Sensitivity</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="0.1"
              max="2"
              step="0.1"
              value={mouseSensitivity}
              onChange={(e) => updateCameraSettings({ mouseSensitivity: Number(e.target.value) })}
            />
            <span>{mouseSensitivity.toFixed(1)}</span>
          </div>
          <p className="setting-hint">Right-click drag sensitivity for camera rotation.</p>
        </div>

        <div className="setting-item">
          <label>Joystick Sensitivity</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="1"
              max="10"
              value={joystickSensitivity}
              onChange={(e) => updateCameraSettings({ joystickSensitivity: Number(e.target.value) })}
            />
            <span>{joystickSensitivity}</span>
          </div>
          <p className="setting-hint">Virtual joystick movement speed on touch devices.</p>
        </div>

        <div className="setting-item">
          <label>
            <input
              type="checkbox"
              checked={enableAutoAirportSwitch}
              onChange={(e) => updateCameraSettings({ enableAutoAirportSwitch: e.target.checked })}
            />
            Auto-Switch to Nearest Airport
          </label>
          <p className="setting-hint">
            Automatically switch to the nearest airport as you move the camera.
          </p>
        </div>
      </div>

      <div className="settings-section">
        <FSLTLImportPanel />
      </div>

      <div className="settings-section">
        <h3>Import / Export Settings</h3>
        <p className="setting-hint" style={{ marginBottom: '12px' }}>
          Migrating from the Electron version? Use Import to transfer your settings.
        </p>
        <div className="setting-item">
          <div className="import-export-buttons">
            <button className="control-button" onClick={handleExportSettings}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Export Settings
            </button>
            <button
              className="control-button"
              onClick={onShowImportModal}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Import Settings
            </button>
          </div>
          {importStatus === 'success' && (
            <p className="setting-hint" style={{ color: '#4caf50', marginTop: '8px' }}>
              Settings imported successfully!
            </p>
          )}
        </div>
      </div>
    </>
  )
}

export default SettingsGeneralTab
