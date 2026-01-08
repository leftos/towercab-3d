import { useState, useEffect, useCallback } from 'react'
import { useGlobalSettingsStore } from '../../stores/globalSettingsStore'
import { useRealTrafficStore } from '../../stores/realTrafficStore'
import { useVatsimStore } from '../../stores/vatsimStore'
import { useAirportStore } from '../../stores/airportStore'
import { useViewportStore } from '../../stores/viewportStore'
import { useAircraftTimelineStore } from '../../stores/aircraftTimelineStore'
import { shellApi, httpServerApi, type ServerStatus, isTauri } from '../../utils/tauriApi'
import MSFSModelSettingsPanel from './MSFSModelSettingsPanel'
import CollapsibleSection from './settings/CollapsibleSection'
import type { DataSourceType } from '../../types/realtraffic'
import './ControlsBar.css'

interface SettingsConfigurationTabProps {
  onShowImportModal: () => void
  onShowExportModal: () => void
  importStatus: 'idle' | 'success' | 'error'
}

function SettingsConfigurationTab({ onShowImportModal, onShowExportModal, importStatus }: SettingsConfigurationTabProps) {
  // Cesium token from global settings
  const cesiumIonToken = useGlobalSettingsStore((state) => state.cesiumIonToken)
  const setCesiumIonToken = useGlobalSettingsStore((state) => state.setCesiumIonToken)

  // Traffic source settings
  const dataSource = useGlobalSettingsStore((state) => state.realtraffic.dataSource)
  const licenseKey = useGlobalSettingsStore((state) => state.realtraffic.licenseKey)
  const radiusNm = useGlobalSettingsStore((state) => state.realtraffic.radiusNm)
  const maxParkedAircraft = useGlobalSettingsStore((state) => state.realtraffic.maxParkedAircraft)
  const updateRealTrafficSettings = useGlobalSettingsStore((state) => state.updateRealTraffic)

  // RealTraffic store for connection state
  const rtStatus = useRealTrafficStore((state) => state.status)
  const rtIsPro = useRealTrafficStore((state) => state.isPro)
  const rtError = useRealTrafficStore((state) => state.error)
  const rtAuthenticate = useRealTrafficStore((state) => state.authenticate)
  const rtDisconnect = useRealTrafficStore((state) => state.disconnect)

  // HTTP Server state
  const serverSettings = useGlobalSettingsStore((state) => state.server)
  const updateServer = useGlobalSettingsStore((state) => state.updateServer)
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [serverLoading, setServerLoading] = useState(false)

  // Local state for Cesium Ion token input
  const [tokenInput, setTokenInput] = useState('')
  const [tokenSaved, setTokenSaved] = useState(false)

  // Local state for RealTraffic license key input
  const [rtLicenseInput, setRtLicenseInput] = useState('')
  const [rtLicenseSaved, setRtLicenseSaved] = useState(false)

  // Sync token input with store value
  useEffect(() => {
    setTokenInput(cesiumIonToken)
    setTokenSaved(false)
  }, [cesiumIonToken])

  // Sync RealTraffic license input with store value
  useEffect(() => {
    setRtLicenseInput(licenseKey)
    setRtLicenseSaved(false)
  }, [licenseKey])

  // Get server status on mount (only in Tauri)
  useEffect(() => {
    if (!isTauri()) return
    httpServerApi.getStatus().then(setServerStatus).catch(console.error)
  }, [])

  const handleSaveToken = useCallback(async () => {
    if (tokenInput.trim() && tokenInput !== cesiumIonToken) {
      await setCesiumIonToken(tokenInput.trim())
      setTokenSaved(true)
      setTimeout(() => setTokenSaved(false), 2000)
    }
  }, [tokenInput, cesiumIonToken, setCesiumIonToken])

  const handleConnectRt = useCallback(async () => {
    const keyToUse = rtLicenseInput.trim() || licenseKey
    if (keyToUse) {
      if (rtLicenseInput.trim() && rtLicenseInput !== licenseKey) {
        updateRealTrafficSettings({ licenseKey: rtLicenseInput.trim() })
      }
      const success = await rtAuthenticate(keyToUse)
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
      useVatsimStore.getState().stopPolling()
      const rtStore = useRealTrafficStore.getState()
      if (airport) {
        rtStore.setReferencePosition(airport.lat, airport.lon)
      }
      if (rtStore.status === 'connected') {
        rtStore.startPolling()
      } else {
        const storedLicenseKey = useGlobalSettingsStore.getState().realtraffic.licenseKey
        if (storedLicenseKey) {
          rtStore.authenticate(storedLicenseKey).then((success) => {
            if (success) {
              rtStore.startPolling()
            }
          })
        }
      }
    } else {
      useRealTrafficStore.getState().stopPolling()
      const vatsimStore = useVatsimStore.getState()
      vatsimStore.resetTimestamp()
      if (airport) {
        vatsimStore.setReferencePosition(airport.lat, airport.lon)
      }
      vatsimStore.startPolling()
    }
  }, [updateRealTrafficSettings])

  const handleToggleServer = useCallback(async () => {
    if (!isTauri()) return

    setServerLoading(true)
    setServerError(null)

    try {
      if (serverStatus?.running) {
        await httpServerApi.stop()
        setServerStatus({ running: false, port: serverSettings.port, localUrl: null, lanUrl: null })
        await updateServer({ enabled: false })
      } else {
        const status = await httpServerApi.start(serverSettings.port)
        setServerStatus(status)
        await updateServer({ enabled: true })
      }
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err))
    } finally {
      setServerLoading(false)
    }
  }, [serverStatus, serverSettings.port, updateServer])

  const handleCopyUrl = useCallback((url: string) => {
    navigator.clipboard.writeText(url).catch(console.error)
  }, [])

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

      <CollapsibleSection title="Traffic Source">
        <div className="setting-item">
          <label>Aircraft Data Source</label>
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

      <MSFSModelSettingsPanel />

      {isTauri() && (
        <CollapsibleSection title="Remote Browser Access">
          <p className="setting-hint" style={{ marginBottom: '12px' }}>
            Enable the HTTP server to access TowerCab 3D from other devices (iPad, phone, etc.) on your local network.
          </p>
          <div className="setting-item">
            <label>
              <input
                type="checkbox"
                checked={serverSettings.enabled}
                onChange={(e) => updateServer({ enabled: e.target.checked })}
              />
              Start server automatically on app launch
            </label>
            <p className="setting-hint">
              When enabled, the HTTP server will start automatically when TowerCab 3D opens.
            </p>
          </div>
          <div className="setting-item">
            <label>Server Port</label>
            <div className="slider-with-value">
              <input
                type="number"
                min="1024"
                max="65535"
                value={serverSettings.port}
                onChange={(e) => updateServer({ port: Number(e.target.value) })}
                className="text-input"
                style={{ width: '100px' }}
                disabled={serverStatus?.running}
              />
            </div>
            <p className="setting-hint">Port for the HTTP server (default: 8765). Change requires restart.</p>
          </div>
          <div className="setting-item">
            <button
              className={`control-button ${serverStatus?.running ? 'active' : ''}`}
              onClick={handleToggleServer}
              disabled={serverLoading}
              style={{ minWidth: '120px' }}
            >
              {serverLoading ? 'Starting...' : serverStatus?.running ? 'Stop Server' : 'Start Server'}
            </button>
            {serverError && (
              <p className="setting-hint" style={{ color: '#f44336', marginTop: '8px' }}>
                Error: {serverError}
              </p>
            )}
          </div>
          {serverStatus?.running && (
            <div className="setting-item" style={{ marginTop: '12px' }}>
              <label>Server URLs</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
                {serverStatus.localUrl && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <code style={{ background: 'rgba(255,255,255,0.1)', padding: '4px 8px', borderRadius: '4px' }}>
                      {serverStatus.localUrl}
                    </code>
                    <button
                      className="control-button"
                      onClick={() => handleCopyUrl(serverStatus.localUrl!)}
                      style={{ padding: '4px 8px' }}
                    >
                      Copy
                    </button>
                  </div>
                )}
                {serverStatus.lanUrl && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <code style={{ background: 'rgba(255,255,255,0.1)', padding: '4px 8px', borderRadius: '4px' }}>
                      {serverStatus.lanUrl}
                    </code>
                    <button
                      className="control-button"
                      onClick={() => handleCopyUrl(serverStatus.lanUrl!)}
                      style={{ padding: '4px 8px' }}
                    >
                      Copy
                    </button>
                    <span className="setting-hint" style={{ marginLeft: '4px' }}>(Use this for other devices)</span>
                  </div>
                )}
              </div>
              <p className="setting-hint" style={{ marginTop: '8px' }}>
                Open one of these URLs in Safari on your iPad to access TowerCab 3D remotely.
              </p>
            </div>
          )}
        </CollapsibleSection>
      )}

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

export default SettingsConfigurationTab
