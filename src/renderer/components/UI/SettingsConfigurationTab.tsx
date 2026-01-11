import { useState, useEffect, useCallback } from 'react'
import { useGlobalSettingsStore } from '../../stores/globalSettingsStore'
import { useRealTrafficStore } from '../../stores/realTrafficStore'
import { useVatsimStore } from '../../stores/vatsimStore'
import { useVnasStore } from '../../stores/vnasStore'
import { useAirportStore } from '../../stores/airportStore'
import { useViewportStore } from '../../stores/viewportStore'
import { useAircraftTimelineStore } from '../../stores/aircraftTimelineStore'
import { shellApi, httpServerApi, type ServerStatus, isTauri } from '../../utils/tauriApi'
import MSFSModelSettingsPanel from './MSFSModelSettingsPanel'
import CollapsibleSection from './settings/CollapsibleSection'
import type { DataSourceType } from '../../types/realtraffic'
import type { VnasEnvironment } from '../../types/vnas'
import type { ImageryAdjustments } from '../../types/settings'
import { DEFAULT_IMAGERY_ADJUSTMENTS } from '../../types/settings'
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

  // Imagery provider settings
  const imagerySettings = useGlobalSettingsStore((state) => state.imagery)
  const updateImagery = useGlobalSettingsStore((state) => state.updateImagery)

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

  // vNAS store for real-time updates (supplements VATSIM data)
  const vnasStatus = useVnasStore((state) => state.status)
  const vnasTryConnect = useVnasStore((state) => state.tryConnectWithStoredTokens)
  const vnasStartAuth = useVnasStore((state) => state.startAuth)
  const vnasHandleOAuthCallback = useVnasStore((state) => state.handleOAuthCallback)
  const vnasDisconnect = useVnasStore((state) => state.disconnect)
  const vnasCheckAvailability = useVnasStore((state) => state.checkAvailability)

  // HTTP Server state
  const serverSettings = useGlobalSettingsStore((state) => state.server)
  const updateServer = useGlobalSettingsStore((state) => state.updateServer)
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [serverLoading, setServerLoading] = useState(false)

  // Local state for Cesium Ion token input
  const [tokenInput, setTokenInput] = useState('')
  const [tokenSaved, setTokenSaved] = useState(false)

  // Local state for Google Maps API key input
  const [googleApiKeyInput, setGoogleApiKeyInput] = useState('')
  const [googleApiKeySaved, setGoogleApiKeySaved] = useState(false)

  // Local state for RealTraffic license key input
  const [rtLicenseInput, setRtLicenseInput] = useState('')
  const [rtLicenseSaved, setRtLicenseSaved] = useState(false)

  // Local state for vNAS connection
  const [vnasSelectedEnv, setVnasSelectedEnv] = useState<VnasEnvironment>('live')
  const [vnasIsAuthenticating, setVnasIsAuthenticating] = useState(false)
  const [vnasCallbackUrl, setVnasCallbackUrl] = useState('')

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

  // Sync Google Maps API key input with store value
  useEffect(() => {
    setGoogleApiKeyInput(imagerySettings.googleMapsApiKey)
    setGoogleApiKeySaved(false)
  }, [imagerySettings.googleMapsApiKey])

  // Get server status on mount (only in Tauri)
  useEffect(() => {
    if (!isTauri()) return
    httpServerApi.getStatus().then(setServerStatus).catch(console.error)
  }, [])

  // Check vNAS availability on mount (only in Tauri)
  useEffect(() => {
    if (!isTauri()) return
    vnasCheckAvailability()
  }, [vnasCheckAvailability])

  const handleSaveToken = useCallback(async () => {
    if (tokenInput.trim() && tokenInput !== cesiumIonToken) {
      await setCesiumIonToken(tokenInput.trim())
      setTokenSaved(true)
      setTimeout(() => setTokenSaved(false), 2000)
    }
  }, [tokenInput, cesiumIonToken, setCesiumIonToken])

  const handleSaveGoogleApiKey = useCallback(async () => {
    if (googleApiKeyInput.trim() !== imagerySettings.googleMapsApiKey) {
      await updateImagery({ googleMapsApiKey: googleApiKeyInput.trim() })
      setGoogleApiKeySaved(true)
      setTimeout(() => setGoogleApiKeySaved(false), 2000)
    }
  }, [googleApiKeyInput, imagerySettings.googleMapsApiKey, updateImagery])

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

  // vNAS connection handlers
  const handleVnasStartAuth = useCallback(async () => {
    try {
      // First try to connect using stored tokens (avoids OAuth if possible)
      const connected = await vnasTryConnect(vnasSelectedEnv)
      if (connected) {
        console.log('[vNAS] Connected using stored tokens')
        return
      }

      // No valid tokens, start OAuth flow
      setVnasIsAuthenticating(true)
      setVnasCallbackUrl('')
      const authUrl = await vnasStartAuth(vnasSelectedEnv)
      console.log('[vNAS] Opening auth URL in browser:', authUrl)

      // Open auth URL in system browser using Tauri shell plugin
      const { open } = await import('@tauri-apps/plugin-shell')
      await open(authUrl)

      // Note: In production, the OAuth callback is handled by the deep-link handler in App.tsx
      // In dev mode, deep links don't work, so user needs to paste the callback URL manually
    } catch (error) {
      console.error('vNAS auth failed:', error)
      setVnasIsAuthenticating(false)
    }
  }, [vnasSelectedEnv, vnasTryConnect, vnasStartAuth])

  const handleVnasManualCallback = useCallback(async () => {
    if (!vnasCallbackUrl.trim()) return
    try {
      console.log('[vNAS] Processing manual callback URL:', vnasCallbackUrl)
      await vnasHandleOAuthCallback(vnasCallbackUrl.trim())
      setVnasCallbackUrl('')
      setVnasIsAuthenticating(false)
    } catch (error) {
      console.error('vNAS manual callback failed:', error)
    }
  }, [vnasCallbackUrl, vnasHandleOAuthCallback])

  const handleVnasCancelAuth = useCallback(() => {
    setVnasIsAuthenticating(false)
    setVnasCallbackUrl('')
    vnasDisconnect()
  }, [vnasDisconnect])

  const handleVnasDisconnect = useCallback(async () => {
    try {
      await vnasDisconnect()
    } catch (error) {
      console.error('vNAS disconnect failed:', error)
    }
  }, [vnasDisconnect])

  // Helper to get vNAS state label
  const getVnasStateLabel = useCallback(() => {
    switch (vnasStatus.state) {
      case 'disconnected': return 'Disconnected'
      case 'authenticating': return 'Authenticating...'
      case 'connecting': return 'Connecting...'
      case 'joiningSession': return 'Joining Session...'
      case 'waitingForSession': return 'Waiting for CRC...'
      case 'subscribing': return 'Ready for vNAS Airport...'
      case 'connected': return 'Connected'
      case 'unavailable': return 'Not Available'
      default: return vnasStatus.state
    }
  }, [vnasStatus.state])

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

      <CollapsibleSection title="Imagery Provider">
        <div className="setting-item">
          <label>Satellite Imagery Source</label>
          <div className="radio-group">
            <label>
              <input
                type="radio"
                name="imageryProvider"
                value="cesium"
                checked={imagerySettings.provider === 'cesium'}
                onChange={() => updateImagery({ provider: 'cesium' })}
              />
              Cesium Ion (Bing Maps)
            </label>
            <label>
              <input
                type="radio"
                name="imageryProvider"
                value="google"
                checked={imagerySettings.provider === 'google'}
                onChange={() => updateImagery({ provider: 'google' })}
              />
              Google Maps
            </label>
          </div>
          <p className="setting-hint">
            Cesium Ion uses Bing Maps satellite imagery (default). Google Maps requires your own API key.
          </p>
        </div>

        {imagerySettings.provider === 'google' && (
          <div className="setting-item">
            <label>Google Maps API Key</label>
            <div className="token-input-row">
              <input
                type="text"
                value={googleApiKeyInput}
                onChange={(e) => setGoogleApiKeyInput(e.target.value)}
                placeholder="Enter your Google Maps API key"
                className="text-input token-input"
              />
              <button
                className={`token-save-button ${googleApiKeySaved ? 'saved' : ''}`}
                onClick={handleSaveGoogleApiKey}
                disabled={googleApiKeyInput.trim() === imagerySettings.googleMapsApiKey}
              >
                {googleApiKeySaved ? 'Saved!' : 'Save'}
              </button>
            </div>
            <p className="setting-hint">
              Get a key at{' '}
              <a
                href="#"
                onClick={(e) => { e.preventDefault(); shellApi.openExternal('https://console.cloud.google.com/apis/credentials') }}
                className="external-link"
              >
                Google Cloud Console
              </a>
              . Enable the Map Tiles API for your project.
            </p>
          </div>
        )}

        {/* Color Adjustments for current provider */}
        <div className="setting-item">
          <label>
            Color Adjustments ({imagerySettings.provider === 'google' ? 'Google Maps' : 'Cesium Ion'})
          </label>
          <p className="setting-hint">
            Adjust colors for the current imagery provider. Each provider saves its own settings.
          </p>
        </div>

        {(() => {
          const currentAdjustments = imagerySettings.provider === 'google'
            ? imagerySettings.googleAdjustments
            : imagerySettings.cesiumAdjustments
          const adjustmentsKey = imagerySettings.provider === 'google'
            ? 'googleAdjustments'
            : 'cesiumAdjustments'

          const updateAdjustment = (field: keyof ImageryAdjustments, value: number) => {
            updateImagery({
              [adjustmentsKey]: {
                ...currentAdjustments,
                [field]: value
              }
            })
          }

          const resetAdjustments = () => {
            updateImagery({
              [adjustmentsKey]: DEFAULT_IMAGERY_ADJUSTMENTS
            })
          }

          return (
            <>
              <div className="setting-item slider-item">
                <label>Hue Shift: {currentAdjustments?.hueShift ?? 0}°</label>
                <input
                  type="range"
                  min="-180"
                  max="180"
                  step="5"
                  value={currentAdjustments?.hueShift ?? 0}
                  onChange={(e) => updateAdjustment('hueShift', Number(e.target.value))}
                  className="slider-input"
                />
                <p className="setting-hint">Shift colors warmer (positive) or cooler (negative)</p>
              </div>

              <div className="setting-item slider-item">
                <label>Saturation: {((currentAdjustments?.saturation ?? 1) * 100).toFixed(0)}%</label>
                <input
                  type="range"
                  min="0"
                  max="200"
                  step="5"
                  value={(currentAdjustments?.saturation ?? 1) * 100}
                  onChange={(e) => updateAdjustment('saturation', Number(e.target.value) / 100)}
                  className="slider-input"
                />
                <p className="setting-hint">Adjust color intensity (100% = default)</p>
              </div>

              <div className="setting-item slider-item">
                <label>Brightness: {((currentAdjustments?.brightness ?? 1) * 100).toFixed(0)}%</label>
                <input
                  type="range"
                  min="50"
                  max="150"
                  step="5"
                  value={(currentAdjustments?.brightness ?? 1) * 100}
                  onChange={(e) => updateAdjustment('brightness', Number(e.target.value) / 100)}
                  className="slider-input"
                />
                <p className="setting-hint">Adjust overall brightness (100% = default)</p>
              </div>

              <div className="setting-item slider-item">
                <label>Contrast: {((currentAdjustments?.contrast ?? 1) * 100).toFixed(0)}%</label>
                <input
                  type="range"
                  min="50"
                  max="150"
                  step="5"
                  value={(currentAdjustments?.contrast ?? 1) * 100}
                  onChange={(e) => updateAdjustment('contrast', Number(e.target.value) / 100)}
                  className="slider-input"
                />
                <p className="setting-hint">Adjust contrast between light and dark areas (100% = default)</p>
              </div>

              <div className="setting-item">
                <button
                  className="secondary-button"
                  onClick={resetAdjustments}
                >
                  Reset to Default
                </button>
              </div>
            </>
          )
        })()}
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

      {/* vNAS Real-Time Updates - only shown when VATSIM is selected and vNAS is available */}
      {dataSource === 'vatsim' && isTauri() && vnasStatus.available && (
        <CollapsibleSection title="Real-Time Updates (vNAS)">
          <p className="setting-hint" style={{ marginBottom: '12px' }}>
            vNAS provides 1-second position updates from the VATSIM network, improving aircraft smoothness within ~30NM of your position.
          </p>

          {/* Connection Status */}
          <div className="setting-item">
            <label>Status</label>
            <span style={{
              color: vnasStatus.state === 'connected' ? '#81c784' :
                     ['authenticating', 'connecting', 'joiningSession', 'waitingForSession', 'subscribing'].includes(vnasStatus.state) ? '#ffb74d' :
                     '#ef5350',
              fontWeight: 600
            }}>
              {getVnasStateLabel()}
              {vnasStatus.facilityId && vnasStatus.state === 'connected' && (
                <span style={{ color: '#4fc3f7', marginLeft: '8px' }}>({vnasStatus.facilityId})</span>
              )}
            </span>
          </div>

          {/* Error display */}
          {vnasStatus.error && (
            <div className="setting-item">
              <p className="setting-hint" style={{ color: '#f44336' }}>
                {vnasStatus.error}
              </p>
            </div>
          )}

          {/* Disconnected state - show connect controls */}
          {vnasStatus.state === 'disconnected' && !vnasIsAuthenticating && (
            <>
              <div className="setting-item">
                <label>Environment</label>
                <select
                  value={vnasSelectedEnv}
                  onChange={(e) => setVnasSelectedEnv(e.target.value as VnasEnvironment)}
                  className="text-input"
                  style={{ width: '150px' }}
                >
                  <option value="live">Live</option>
                  <option value="sweatbox1">Sweatbox 1</option>
                  <option value="sweatbox2">Sweatbox 2</option>
                </select>
              </div>

              <div className="setting-item">
                <button
                  className="control-button"
                  onClick={handleVnasStartAuth}
                >
                  Connect to vNAS
                </button>
                <p className="setting-hint" style={{ marginTop: '8px' }}>
                  You&apos;ll be redirected to VATSIM to authorize TowerCab 3D.
                </p>
              </div>
            </>
          )}

          {/* Authenticating state - show manual callback input (dev mode fallback) */}
          {vnasIsAuthenticating && (
            <>
              <p className="setting-hint" style={{ marginBottom: '8px' }}>
                Complete authorization in your browser. If the app doesn&apos;t automatically connect, paste the callback URL below:
              </p>
              <div className="setting-item">
                <input
                  type="text"
                  className="text-input"
                  placeholder="tc3d://oauth/callback?code=..."
                  value={vnasCallbackUrl}
                  onChange={(e) => setVnasCallbackUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleVnasManualCallback()}
                  style={{ width: '100%', marginBottom: '8px' }}
                />
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    className="control-button"
                    onClick={handleVnasManualCallback}
                    disabled={!vnasCallbackUrl.trim()}
                  >
                    Submit
                  </button>
                  <button
                    className="control-button"
                    onClick={handleVnasCancelAuth}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </>
          )}

          {/* Connected or connecting states - show disconnect button */}
          {['connecting', 'joiningSession', 'waitingForSession', 'subscribing', 'connected'].includes(vnasStatus.state) && (
            <div className="setting-item">
              <button
                className="control-button"
                onClick={handleVnasDisconnect}
                style={{ background: 'rgba(244, 67, 54, 0.2)', borderColor: 'rgba(244, 67, 54, 0.4)' }}
              >
                Disconnect
              </button>
            </div>
          )}
        </CollapsibleSection>
      )}

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
