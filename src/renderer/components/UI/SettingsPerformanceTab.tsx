import { useRef, useState } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useReplayStore } from '../../stores/replayStore'
import { useUIFeedbackStore } from '../../stores/uiFeedbackStore'
import { estimateReplayMemoryMB } from '../../constants/replay'
import CollapsibleSection from './settings/CollapsibleSection'
import './ControlsBar.css'

function SettingsPerformanceTab() {
  const importFileInputRef = useRef<HTMLInputElement>(null)
  const [isClearingCache, setIsClearingCache] = useState(false)

  // UI feedback store for cache clear
  const requestClearTerrainCache = useUIFeedbackStore((state) => state.requestClearTerrainCache)

  // Settings store - Performance (Memory group)
  const inMemoryTileCacheSize = useSettingsStore((state) => state.memory.inMemoryTileCacheSize)
  const diskCacheSizeGB = useSettingsStore((state) => state.memory.diskCacheSizeGB)
  const aircraftDataRadiusNM = useSettingsStore((state) => state.memory.aircraftDataRadiusNM)
  const maxReplayDurationMinutes = useSettingsStore((state) => state.memory.maxReplayDurationMinutes)
  const updateMemorySettings = useSettingsStore((state) => state.updateMemorySettings)

  // Aircraft display limit (per-device setting)
  const maxAircraftDisplay = useSettingsStore((state) => state.aircraft.maxAircraftDisplay)
  const updateAircraftSettings = useSettingsStore((state) => state.updateAircraftSettings)

  // Replay store
  const replaySnapshots = useReplayStore((state) => state.snapshots)
  const importedTimeRange = useReplayStore((state) => state.importedTimeRange)
  const importedAppState = useReplayStore((state) => state.importedAppState)
  const exportReplay = useReplayStore((state) => state.exportReplay)
  const importReplay = useReplayStore((state) => state.importReplay)
  const clearImportedReplay = useReplayStore((state) => state.clearImportedReplay)

  const handleImportFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    try {
      const text = await file.text()
      const data = JSON.parse(text)

      if (!data || typeof data !== 'object') {
        console.error('[Import] Invalid file: not a JSON object')
        alert('Invalid file: not a valid JSON object')
        return
      }

      const success = importReplay(data)
      if (!success) {
        alert('Invalid file format. Supported: .tc3d-replay.json and .tc3d-diag.json files.\nCheck console for details.')
      }
    } catch (error) {
      const message = error instanceof SyntaxError
        ? 'Invalid JSON format'
        : error instanceof Error ? error.message : 'Unknown error'
      console.error('[Import] Failed to read file:', error)
      alert(`Failed to read file: ${message}`)
    }

    // Reset input so same file can be selected again
    e.target.value = ''
  }

  const hasImportedData = importedTimeRange !== null

  return (
    <>
      <CollapsibleSection title="Display Limits">
        <div className="setting-item">
          <label>Max Aircraft Count</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="10"
              max="1000"
              step="10"
              value={maxAircraftDisplay}
              onChange={(e) => updateAircraftSettings({ maxAircraftDisplay: Number(e.target.value) })}
            />
            <span>{maxAircraftDisplay}</span>
          </div>
          <p className="setting-hint">
            Maximum number of aircraft to render simultaneously. Lower values improve performance on slower devices. (Per-device setting)
          </p>
        </div>

        <div className="setting-item">
          <label>Aircraft Data Radius</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="10"
              max="500"
              step="10"
              value={aircraftDataRadiusNM}
              onChange={(e) => updateMemorySettings({ aircraftDataRadiusNM: Number(e.target.value) })}
            />
            <span>{aircraftDataRadiusNM} nm</span>
          </div>
          <p className="setting-hint">
            Discard aircraft data beyond this radius to save memory. Should be larger than Visibility Range in Aircraft & Labels tab.
          </p>
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Tile Cache">
        <div className="setting-item">
          <label>In-Memory Tile Cache</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="50"
              max="5000"
              step="50"
              value={inMemoryTileCacheSize}
              onChange={(e) => updateMemorySettings({ inMemoryTileCacheSize: Number(e.target.value) })}
            />
            <span>{inMemoryTileCacheSize} tiles</span>
          </div>
          <p className="setting-hint">
            Higher values = smoother panning, more RAM usage.
          </p>
        </div>

        <div className="setting-item">
          <label>Disk Cache Size</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="0.1"
              max="10"
              step="0.1"
              value={diskCacheSizeGB}
              onChange={(e) => updateMemorySettings({ diskCacheSizeGB: Number(e.target.value) })}
            />
            <span>{diskCacheSizeGB.toFixed(1)} GB</span>
          </div>
          <p className="setting-hint">
            IndexedDB cache for satellite/terrain tiles.
          </p>
        </div>

        <div className="setting-item">
          <label>Clear Terrain Cache</label>
          <button
            className="control-button"
            onClick={() => {
              setIsClearingCache(true)
              requestClearTerrainCache()
              // Reset button state after a delay (actual clear happens in CesiumViewer)
              setTimeout(() => setIsClearingCache(false), 2000)
            }}
            disabled={isClearingCache}
            style={{ marginTop: '4px' }}
          >
            {isClearingCache ? (
              <>Clearing...</>
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                Clear Cache
              </>
            )}
          </button>
          <p className="setting-hint">
            Clears in-memory and disk terrain tile caches. Use this after toggling terrain flattening or if terrain appears corrupted.
          </p>
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Replay">
        <div className="setting-item">
          <label>Replay Buffer Duration</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="1"
              max="60"
              step="1"
              value={maxReplayDurationMinutes}
              onChange={(e) => updateMemorySettings({ maxReplayDurationMinutes: Number(e.target.value) })}
            />
            <span>{maxReplayDurationMinutes} min</span>
          </div>
          <p className="setting-hint">
            How far back you can scrub. Uses ~{estimateReplayMemoryMB(maxReplayDurationMinutes).toFixed(1)} MB memory.
            Currently recording {replaySnapshots.length} snapshots.
          </p>
        </div>

        <div className="setting-item">
          <div className="import-export-buttons">
            <button
              className="control-button"
              onClick={exportReplay}
              disabled={replaySnapshots.length === 0}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Export Replay
            </button>
            <button
              className="control-button"
              onClick={() => importFileInputRef.current?.click()}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Import Replay
            </button>
            <input
              ref={importFileInputRef}
              type="file"
              accept=".json"
              onChange={handleImportFileChange}
              style={{ display: 'none' }}
            />
          </div>
          <p className="setting-hint">
            Import accepts replay (.tc3d-replay.json) and diagnostic (.tc3d-diag.json) files.
            Export with Ctrl+Shift+D for diagnostic packages.
          </p>
        </div>

        {hasImportedData && (
          <div className="setting-item">
            <p className="setting-hint" style={{ color: '#ff9800' }}>
              Viewing imported data
              {importedAppState?.airport ? ` (${importedAppState.airport.icao})` : ''}
            </p>
            <button
              className="control-button"
              onClick={clearImportedReplay}
              style={{ marginTop: '8px' }}
            >
              Clear Imported Data
            </button>
          </div>
        )}
      </CollapsibleSection>
    </>
  )
}

export default SettingsPerformanceTab
