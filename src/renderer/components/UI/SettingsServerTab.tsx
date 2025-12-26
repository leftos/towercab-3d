import { useState, useEffect, useCallback } from 'react'
import { useGlobalSettingsStore } from '../../stores/globalSettingsStore'
import { httpServerApi, type ServerStatus, isTauri } from '../../utils/tauriApi'
import './ControlsBar.css'

function SettingsServerTab() {
  // HTTP Server state
  const serverSettings = useGlobalSettingsStore((state) => state.server)
  const updateServer = useGlobalSettingsStore((state) => state.updateServer)
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [serverLoading, setServerLoading] = useState(false)

  // Get server status on mount (only in Tauri)
  useEffect(() => {
    if (!isTauri()) return

    httpServerApi.getStatus().then(setServerStatus).catch(console.error)
  }, [])

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

  // Show message for browser mode
  if (!isTauri()) {
    return (
      <div className="settings-section">
        <h3>Remote Browser Access</h3>
        <p className="setting-hint">
          You are currently viewing TowerCab 3D in remote browser mode.
          Server settings can only be configured from the desktop application.
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="settings-section">
        <h3>Remote Browser Access</h3>
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
      </div>
    </>
  )
}

export default SettingsServerTab
