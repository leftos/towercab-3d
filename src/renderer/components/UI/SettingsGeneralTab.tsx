import { useState, useEffect, useCallback } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useGlobalSettingsStore } from '../../stores/globalSettingsStore'
import { useRealTrafficStore } from '../../stores/realTrafficStore'
import { useVatsimStore } from '../../stores/vatsimStore'
import { useViewportStore } from '../../stores/viewportStore'
import { useAirportStore } from '../../stores/airportStore'
import { useAircraftTimelineStore } from '../../stores/aircraftTimelineStore'
import { shellApi } from '../../utils/tauriApi'
import FSLTLImportPanel from './FSLTLImportPanel'
import CollapsibleSection from './settings/CollapsibleSection'
import type { DataSourceType } from '../../types/realtraffic'
import './ControlsBar.css'

interface SettingsGeneralTabProps {
  onShowImportModal: () => void
  onShowExportModal: () => void
  importStatus: 'idle' | 'success' | 'error'
}

function SettingsGeneralTab({ onShowImportModal, onShowExportModal, importStatus }: SettingsGeneralTabProps) {
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

  // RealTraffic settings (from global settings - shared across devices)
  const dataSource = useGlobalSettingsStore((state) => state.realtraffic.dataSource)
  const licenseKey = useGlobalSettingsStore((state) => state.realtraffic.licenseKey)
  const radiusNm = useGlobalSettingsStore((state) => state.realtraffic.radiusNm)
  const maxParkedAircraft = useGlobalSettingsStore((state) => state.realtraffic.maxParkedAircraft)
  const updateRealTrafficSettings = useGlobalSettingsStore((state) => state.updateRealTraffic)

  // RealTraffic store for connection state (used for UI display)
  const rtStatus = useRealTrafficStore((state) => state.status)
  const rtIsPro = useRealTrafficStore((state) => state.isPro)
  const rtError = useRealTrafficStore((state) => state.error)
  const rtAuthenticate = useRealTrafficStore((state) => state.authenticate)
  const rtDisconnect = useRealTrafficStore((state) => state.disconnect)

  // Local state for Cesium Ion token input (only saved on button click)
  const [tokenInput, setTokenInput] = useState('')
  const [tokenSaved, setTokenSaved] = useState(false)

  // Local state for RealTraffic license key input
  const [rtLicenseInput, setRtLicenseInput] = useState('')
  const [rtLicenseSaved, setRtLicenseSaved] = useState(false)

  // Sync token input with store value when component mounts or store changes
  useEffect(() => {
    setTokenInput(cesiumIonToken)
    setTokenSaved(false)
  }, [cesiumIonToken])

  // Sync RealTraffic license input with store value
  useEffect(() => {
    setRtLicenseInput(licenseKey)
    setRtLicenseSaved(false)
  }, [licenseKey])

  const handleSaveToken = useCallback(async () => {
    if (tokenInput.trim() && tokenInput !== cesiumIonToken) {
      // Save to global settings (host file system)
      await setCesiumIonToken(tokenInput.trim())
      setTokenSaved(true)
      setTimeout(() => setTokenSaved(false), 2000)
    }
  }, [tokenInput, cesiumIonToken, setCesiumIonToken])

  const handleConnectRt = useCallback(async () => {
    const keyToUse = rtLicenseInput.trim() || licenseKey
    if (keyToUse) {
      // Save the license key if it's new
      if (rtLicenseInput.trim() && rtLicenseInput !== licenseKey) {
        updateRealTrafficSettings({ licenseKey: rtLicenseInput.trim() })
      }
      // Authenticate
      const success = await rtAuthenticate(keyToUse)

      // If authentication succeeded, start polling with current airport position
      if (success) {
        const airport = useAirportStore.getState().currentAirport
        const rtStore = useRealTrafficStore.getState()
        if (airport) {
          rtStore.setReferencePosition(airport.lat, airport.lon)
        }
        rtStore.startPolling()
      }
    }
  }, [rtLicenseInput, licenseKey, updateRealTrafficSettings, rtAuthenticate])

  const handleDisconnectRt = useCallback(() => {
    rtDisconnect()
  }, [rtDisconnect])

  const handleDataSourceChange = useCallback((newSource: DataSourceType) => {
    // Get current state directly from stores to avoid stale closure values
    const currentDataSource = useGlobalSettingsStore.getState().realtraffic.dataSource
    if (newSource === currentDataSource) return

    const airport = useAirportStore.getState().currentAirport
    const mainViewport = useViewportStore.getState().viewports.find(v => v.id === 'main')
    const isFollowing = mainViewport?.cameraState.followingCallsign ?? null

    // Stop following any aircraft
    if (isFollowing) {
      useViewportStore.getState().stopFollowing(false)
    }

    // If no airport selected and we were following, go back to main menu
    if (!airport && isFollowing) {
      useAirportStore.getState().deselectAirport()
    }

    // Update the data source setting
    updateRealTrafficSettings({ dataSource: newSource })

    // Clear the unified aircraft timeline store to remove stale data from previous source
    useAircraftTimelineStore.getState().clear()

    // Stop the old data source and start the new one
    if (newSource === 'realtraffic') {
      // Switch to RealTraffic: stop VATSIM polling first
      useVatsimStore.getState().stopPolling()

      // Start RealTraffic if connected and airport selected
      const rtStore = useRealTrafficStore.getState()
      if (airport) {
        rtStore.setReferencePosition(airport.lat, airport.lon)
      }
      if (rtStore.status === 'connected') {
        rtStore.startPolling()
      } else {
        // Auto-connect if license key is present but not connected
        const storedLicenseKey = useGlobalSettingsStore.getState().realtraffic.licenseKey
        if (storedLicenseKey) {
          rtStore.authenticate(storedLicenseKey).then((success) => {
            if (success && airport) {
              rtStore.startPolling()
            }
          })
        }
      }
    } else {
      // Switch to VATSIM: stop RT polling first
      useRealTrafficStore.getState().stopPolling()

      // Start VATSIM polling
      const vatsimStore = useVatsimStore.getState()
      if (airport) {
        vatsimStore.setReferencePosition(airport.lat, airport.lon)
      }
      vatsimStore.startPolling()
    }
  }, [updateRealTrafficSettings])


  return (
    <>
      <CollapsibleSection title="Cesium Ion">
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
      </CollapsibleSection>

      <CollapsibleSection title="Data Source">
        <div className="setting-item">
          <label>Traffic Source</label>
          <div className="radio-group">
            <label>
              <input
                type="radio"
                name="dataSource"
                value="vatsim"
                checked={dataSource === 'vatsim'}
                onChange={() => handleDataSourceChange('vatsim')}
              />
              VATSIM (Virtual Network)
            </label>
            <label>
              <input
                type="radio"
                name="dataSource"
                value="realtraffic"
                checked={dataSource === 'realtraffic'}
                onChange={() => handleDataSourceChange('realtraffic')}
              />
              RealTraffic (Real-World ADS-B)
            </label>
          </div>
          <p className="setting-hint">
            VATSIM shows virtual pilots. RealTraffic shows real aircraft (requires license).
          </p>
        </div>

        {dataSource === 'realtraffic' && (
          <>
            <div className="setting-item">
              <label>License Key</label>
              <div className="token-input-row">
                <input
                  type="text"
                  value={rtLicenseInput}
                  onChange={(e) => setRtLicenseInput(e.target.value)}
                  placeholder="Enter your RealTraffic license key"
                  className="text-input token-input"
                  disabled={rtStatus === 'connected'}
                />
                {rtStatus !== 'connected' ? (
                  <button
                    className={`token-save-button ${rtLicenseSaved ? 'saved' : ''}`}
                    onClick={handleConnectRt}
                    disabled={!rtLicenseInput.trim() && !licenseKey}
                  >
                    {rtStatus === 'connecting' ? 'Connecting...' : 'Connect'}
                  </button>
                ) : (
                  <button
                    className="token-save-button"
                    onClick={handleDisconnectRt}
                  >
                    Disconnect
                  </button>
                )}
              </div>
              {rtStatus === 'connected' && (
                <p className="setting-hint" style={{ color: '#4caf50' }}>
                  Connected{rtIsPro ? ' (Pro License)' : ''} - Receiving real-time traffic data
                </p>
              )}
              {rtStatus === 'error' && rtError && (
                <p className="setting-hint" style={{ color: '#f44336' }}>
                  {rtError}
                </p>
              )}
              {rtStatus === 'disconnected' && (
                <p className="setting-hint">
                  Get a license at{' '}
                  <a
                    href="#"
                    onClick={(e) => { e.preventDefault(); shellApi.openExternal('https://www.flyrealtraffic.com') }}
                    className="external-link"
                  >
                    flyrealtraffic.com
                  </a>
                </p>
              )}
            </div>

            <div className="setting-item">
              <label>Query Radius</label>
              <div className="slider-with-value">
                <input
                  type="range"
                  min="10"
                  max="200"
                  value={radiusNm}
                  onChange={(e) => updateRealTrafficSettings({ radiusNm: Number(e.target.value) })}
                />
                <span>{radiusNm} NM</span>
              </div>
              <p className="setting-hint">
                Aircraft within this radius of the tower will be fetched.
              </p>
            </div>

            <div className="setting-item">
              <label>Max Parked Aircraft</label>
              <div className="slider-with-value">
                <input
                  type="range"
                  min="0"
                  max="200"
                  value={maxParkedAircraft}
                  onChange={(e) => updateRealTrafficSettings({ maxParkedAircraft: Number(e.target.value) })}
                />
                <span>{maxParkedAircraft}</span>
              </div>
              <p className="setting-hint">
                Parked aircraft to include (0 = disabled). Active aircraft have priority; parked fill remaining display slots.
              </p>
            </div>
          </>
        )}
      </CollapsibleSection>

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

      <CollapsibleSection title="Camera">
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
      </CollapsibleSection>

      <FSLTLImportPanel />

      <CollapsibleSection title="Import / Export Settings">
        <p className="setting-hint" style={{ marginBottom: '12px' }}>
          Migrating from the Electron version? Use Import to transfer your settings.
        </p>
        <div className="setting-item">
          <div className="import-export-buttons">
            <button className="control-button" onClick={onShowExportModal}>
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
      </CollapsibleSection>
    </>
  )
}

export default SettingsGeneralTab
