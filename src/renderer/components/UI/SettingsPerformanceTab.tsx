import { useRef } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useReplayStore } from '../../stores/replayStore'
import { estimateReplayMemoryMB } from '../../constants/replay'
import type { ReplayExportData } from '../../types/replay'
import CollapsibleSection from './settings/CollapsibleSection'
import './ControlsBar.css'

function SettingsPerformanceTab() {
  const replayFileInputRef = useRef<HTMLInputElement>(null)

  // Settings store - Performance (Memory group)
  const inMemoryTileCacheSize = useSettingsStore((state) => state.memory.inMemoryTileCacheSize)
  const diskCacheSizeGB = useSettingsStore((state) => state.memory.diskCacheSizeGB)
  const aircraftDataRadiusNM = useSettingsStore((state) => state.memory.aircraftDataRadiusNM)
  const maxReplayDurationMinutes = useSettingsStore((state) => state.memory.maxReplayDurationMinutes)
  const updateMemorySettings = useSettingsStore((state) => state.updateMemorySettings)

  // Replay store
  const replaySnapshots = useReplayStore((state) => state.snapshots)
  const importedSnapshots = useReplayStore((state) => state.importedSnapshots)
  const exportReplay = useReplayStore((state) => state.exportReplay)
  const importReplay = useReplayStore((state) => state.importReplay)
  const clearImportedReplay = useReplayStore((state) => state.clearImportedReplay)

  const handleReplayFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    try {
      const text = await file.text()
      const data = JSON.parse(text)

      // Validate basic structure before passing to importReplay
      if (!data || typeof data !== 'object') {
        console.error('[Replay Import] Invalid file: not a JSON object')
        alert('Invalid replay file: not a valid JSON object')
        return
      }

      const success = importReplay(data as ReplayExportData)
      if (!success) {
        alert('Invalid replay file format. Check console for details.')
      }
    } catch (error) {
      const message = error instanceof SyntaxError
        ? 'Invalid JSON format'
        : error instanceof Error ? error.message : 'Unknown error'
      console.error('[Replay Import] Failed to read file:', error)
      alert(`Failed to read replay file: ${message}`)
    }

    // Reset input so same file can be selected again
    e.target.value = ''
  }

  return (
    <>
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
      </CollapsibleSection>

      <CollapsibleSection title="Data">
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
            Only keep aircraft data within this radius of tower.
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
              onClick={() => replayFileInputRef.current?.click()}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Import Replay
            </button>
            <input
              ref={replayFileInputRef}
              type="file"
              accept=".json"
              onChange={handleReplayFileChange}
              style={{ display: 'none' }}
            />
          </div>
        </div>

        {importedSnapshots && (
          <div className="setting-item">
            <p className="setting-hint" style={{ color: '#ff9800' }}>
              Viewing imported replay ({importedSnapshots.length} snapshots)
            </p>
            <button
              className="control-button"
              onClick={clearImportedReplay}
              style={{ marginTop: '8px' }}
            >
              Clear Imported Replay
            </button>
          </div>
        )}
      </CollapsibleSection>
    </>
  )
}

export default SettingsPerformanceTab
