import { useCallback, useEffect, useState } from 'react'
import { customVMRService } from '../../services/CustomVMRService'
import {
  type AircraftModInfo,
  getCameraPositionFromManifest,
  type ModError,
  type ModLoadingResult,
  modService,
  type TowerModInfo,
} from '../../services/ModService'
import { useAirportStore } from '../../stores/airportStore'
import { useGlobalSettingsStore } from '../../stores/globalSettingsStore'
import { useTowerPositioningStore } from '../../stores/towerPositioningStore'
import { useUIFeedbackStore } from '../../stores/uiFeedbackStore'
import { useViewportStore } from '../../stores/viewportStore'
import { type GitUpdateAllResult, isTauri, joinPath, modApi } from '../../utils/tauriApi'
import CollapsibleSection from './settings/CollapsibleSection'
import './ControlsBar.css'

interface SettingsModsTabProps {
  onRequestClose?: () => void
}

function SettingsModsTab({ onRequestClose }: SettingsModsTabProps) {
  const [modResult, setModResult] = useState<ModLoadingResult | null>(null)
  const [pendingChanges, setPendingChanges] = useState<Set<string>>(new Set())
  const [isUpdatingRepos, setIsUpdatingRepos] = useState(false)
  const [updateResult, setUpdateResult] = useState<GitUpdateAllResult | null>(null)

  const disabledMods = useGlobalSettingsStore((state) => state.disabledMods)
  const updateDisabledMods = useGlobalSettingsStore((state) => state.updateDisabledMods)
  const airports = useAirportStore((state) => state.airports)
  const selectAirport = useAirportStore((state) => state.selectAirport)
  const showFeedback = useUIFeedbackStore((state) => state.showFeedback)
  const startPositioning = useTowerPositioningStore((state) => state.startPositioning)

  // Load mod info on mount
  useEffect(() => {
    if (modService.isLoaded()) {
      setModResult(modService.getModLoadingResult())
    }
  }, [])

  // Check if a mod is disabled (in either saved state or pending changes)
  const isModDisabled = useCallback(
    (path: string): boolean => {
      const normalizedPath = path.toLowerCase().replace(/\\/g, '/')
      if (pendingChanges.has(normalizedPath)) {
        // Pending change - inverts the saved state
        return !disabledMods.includes(normalizedPath)
      }
      return disabledMods.includes(normalizedPath)
    },
    [disabledMods, pendingChanges],
  )

  // Toggle mod enabled state (marks as pending change)
  const toggleMod = useCallback((path: string) => {
    const normalizedPath = path.toLowerCase().replace(/\\/g, '/')
    setPendingChanges((prev) => {
      const next = new Set(prev)
      if (next.has(normalizedPath)) {
        next.delete(normalizedPath)
      } else {
        next.add(normalizedPath)
      }
      return next
    })
  }, [])

  // Apply pending changes
  const applyChanges = useCallback(async () => {
    const newDisabledMods = new Set(disabledMods.map((p) => p.toLowerCase().replace(/\\/g, '/')))

    for (const path of pendingChanges) {
      if (newDisabledMods.has(path)) {
        newDisabledMods.delete(path)
      } else {
        newDisabledMods.add(path)
      }
    }

    await updateDisabledMods([...newDisabledMods])
    setPendingChanges(new Set())
  }, [disabledMods, pendingChanges, updateDisabledMods])

  // Handle starting tower positioning mode
  const handleStartPositioning = useCallback(
    async (tower: TowerModInfo) => {
      if (!tower.placement) {
        showFeedback('No position data available for this tower', 'error')
        return
      }

      const icao = tower.icao.toUpperCase()
      const manifestPath = await joinPath(tower.path, 'manifest.json')

      // Get model position from placement
      const modelPosition = {
        lat: tower.placement.lat,
        lon: tower.placement.lon,
        height: tower.placement.height,
        rotation: tower.placement.rotation,
      }

      // Get camera position from manifest (if available)
      const cameraPos = getCameraPositionFromManifest(tower.manifest)
      const cameraPosition = cameraPos
        ? {
            lat: cameraPos.lat,
            lon: cameraPos.lon,
            height: cameraPos.height,
            heading: cameraPos.heading,
            pitch: 0, // Default pitch
          }
        : null

      // Switch to the tower's airport (only if not already there)
      const airport = airports.get(icao)
      if (!airport) {
        showFeedback(`Airport ${icao} not found`, 'error')
        return
      }

      // Check if we need to switch airports (don't reset camera if already there)
      const currentIcao = useViewportStore.getState().currentAirportIcao
      if (currentIcao?.toUpperCase() !== icao) {
        selectAirport(icao)
        // Note: We don't reset camera position - user wants to keep their current view
      }

      // Close the settings modal
      onRequestClose?.()

      // Sample terrain height at tower position (for accurate model placement)
      // The positioning store will use 0 initially, and useTowerModel will update it
      const terrainHeight = 0 // Will be updated by useTowerModel

      // Start the positioning wizard
      startPositioning(icao, manifestPath, modelPosition, cameraPosition, terrainHeight)
      showFeedback(`Positioning mode started for ${icao}`, 'success')
    },
    [airports, selectAirport, showFeedback, startPositioning, onRequestClose],
  )

  // Handle updating all git repos
  const handleUpdateRepos = useCallback(async () => {
    setIsUpdatingRepos(true)
    setUpdateResult(null)

    try {
      const result = await modApi.updateModRepos()
      setUpdateResult(result)

      if (result.total === 0) {
        showFeedback('No git repositories found in mods folder', 'success')
      } else if (result.updated > 0) {
        showFeedback(`Updated ${result.updated} of ${result.total} repositories. Restart to apply changes.`, 'success')
      } else if (result.failed > 0) {
        showFeedback(`${result.failed} repositories failed to update`, 'error')
      } else {
        showFeedback('All repositories are up to date', 'success')
      }
    } catch (error) {
      showFeedback(`Failed to update repositories: ${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      setIsUpdatingRepos(false)
    }
  }, [showFeedback])

  // Get VMR stats
  const vmrStats = customVMRService.getStats()
  const vmrFiles = customVMRService.getLoadedFiles()

  const hasPendingChanges = pendingChanges.size > 0

  // Count git repos (unique repo names)
  const gitRepoNames = new Set<string>()
  modResult?.towers.forEach((t) => {
    if (t.gitInfo?.repoName) gitRepoNames.add(t.gitInfo.repoName)
  })
  modResult?.aircraft.forEach((a) => {
    if (a.gitInfo?.repoName) gitRepoNames.add(a.gitInfo.repoName)
  })
  const gitRepoCount = gitRepoNames.size

  return (
    <>
      {/* Tower Models Section */}
      <CollapsibleSection title={`Tower Models (${modResult?.towers.length ?? 0})`} defaultExpanded>
        {modResult?.towers.length === 0 ? (
          <p className="setting-hint">No tower mods installed</p>
        ) : (
          <div className="mods-list">
            {modResult?.towers.map((tower) => (
              <TowerModItem
                key={tower.path}
                tower={tower}
                isDisabled={isModDisabled(tower.path)}
                onToggle={() => toggleMod(tower.path)}
                onPosition={() => handleStartPositioning(tower)}
                hasPendingChange={pendingChanges.has(tower.path.toLowerCase().replace(/\\/g, '/'))}
              />
            ))}
          </div>
        )}
      </CollapsibleSection>

      {/* Aircraft Models Section */}
      <CollapsibleSection title={`Aircraft Models (${modResult?.aircraft.length ?? 0})`}>
        {modResult?.aircraft.length === 0 ? (
          <p className="setting-hint">No aircraft mods installed</p>
        ) : (
          <div className="mods-list">
            {modResult?.aircraft.map((aircraft) => (
              <AircraftModItem
                key={aircraft.path}
                aircraft={aircraft}
                isDisabled={isModDisabled(aircraft.path)}
                onToggle={() => toggleMod(aircraft.path)}
                hasPendingChange={pendingChanges.has(aircraft.path.toLowerCase().replace(/\\/g, '/'))}
              />
            ))}
          </div>
        )}
      </CollapsibleSection>

      {/* VMR Files Section */}
      <CollapsibleSection title={`VMR Files (${vmrStats.vmrFiles})`}>
        {vmrStats.vmrFiles === 0 ? (
          <p className="setting-hint">No VMR files installed</p>
        ) : (
          <div className="mods-list">
            <div className="mod-item">
              <div className="mod-details">
                <span className="mod-stats">
                  {vmrStats.defaultRules} default rules, {vmrStats.airlineRules} airline rules
                </span>
              </div>
              <div className="mod-details">
                {vmrFiles.map((file) => (
                  <span key={file} className="vmr-file">
                    {file}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </CollapsibleSection>

      {/* Git Repositories Section - Desktop app only */}
      {isTauri() && gitRepoCount > 0 && (
        <CollapsibleSection title={`Git Repositories (${gitRepoCount})`}>
          <div className="git-repos-section">
            <p className="setting-hint">
              Found {gitRepoCount} git {gitRepoCount === 1 ? 'repository' : 'repositories'} in mods folder. Update to
              pull latest changes from remote.
            </p>
            <button
              type="button"
              className="control-button update-repos-button"
              onClick={handleUpdateRepos}
              disabled={isUpdatingRepos}
            >
              {isUpdatingRepos ? 'Updating...' : 'Update All Repositories'}
            </button>
            {updateResult && (
              <div className="update-result">
                {updateResult.results.map((r) => (
                  <div
                    key={r.repoName}
                    className={`update-result-item ${r.success ? (r.updated ? 'updated' : 'up-to-date') : 'failed'}`}
                  >
                    <span className="update-repo-name">{r.repoName}</span>
                    <span className="update-status">{r.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CollapsibleSection>
      )}

      {/* Tower Positions Section */}
      <CollapsibleSection title={`Tower Positions (${modResult?.towerPositions.builtin ?? 0})`}>
        <div className="mod-item">
          <div className="mod-details">
            <span className="mod-stats">Built-in: {modResult?.towerPositions.builtin ?? 0} airports</span>
          </div>
          {modResult?.towerPositions.custom && modResult.towerPositions.custom.length > 0 && (
            <div className="mod-details">
              <span className="mod-stats">
                Custom: {modResult.towerPositions.custom.length} airports (
                {modResult.towerPositions.custom.slice(0, 10).join(', ')}
                {modResult.towerPositions.custom.length > 10 ? '...' : ''})
              </span>
            </div>
          )}
        </div>
      </CollapsibleSection>

      {/* Errors Section */}
      {modResult?.errors && modResult.errors.length > 0 && (
        <CollapsibleSection title={`Errors (${modResult.errors.length})`} defaultExpanded>
          <div className="mods-list errors-list">
            {modResult.errors.map((error) => (
              <ErrorItem key={error.path} error={error} />
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* Pending Changes Notice */}
      {hasPendingChanges && (
        <div className="pending-changes-bar">
          <span className="pending-notice">Changes require app restart to take effect</span>
          <button type="button" className="control-button primary" onClick={applyChanges}>
            Save Changes
          </button>
        </div>
      )}

      <style>{`
        .mods-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .mod-item {
          background: var(--bg-secondary, #1a1a2e);
          border: 1px solid var(--border-color, #333);
          border-radius: 4px;
          padding: 10px 12px;
        }
        .mod-header-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .mod-checkbox {
          display: flex;
          align-items: center;
          gap: 8px;
          cursor: pointer;
          flex: 1;
        }
        .mod-checkbox input {
          margin: 0;
        }
        .position-button {
          font-size: 12px;
          padding: 4px 10px;
          flex-shrink: 0;
        }
        .position-button:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        .mod-name {
          font-weight: 500;
          color: var(--text-primary, #fff);
        }
        .pending-badge {
          color: var(--warning-color, #ffc107);
          font-weight: bold;
          margin-left: 4px;
        }
        .mod-details {
          margin-top: 4px;
          margin-left: 24px;
          font-size: 0.85em;
          color: var(--text-secondary, #888);
        }
        .mod-author {
          margin-right: 8px;
        }
        .mod-version {
          opacity: 0.7;
        }
        .mod-repo-badge {
          background: var(--accent-color, #4a90d9);
          color: white;
          font-size: 0.75em;
          padding: 2px 6px;
          border-radius: 3px;
          margin-left: 8px;
          font-weight: 500;
        }
        .mod-path-row {
          margin-top: 6px;
          margin-left: 24px;
        }
        .mod-path {
          font-family: monospace;
          font-size: 0.8em;
          color: var(--text-tertiary, #a0a0a0);
          word-break: break-all;
        }
        .mod-icao {
          font-weight: 600;
          margin-right: 8px;
          color: var(--accent-color, #4a90d9);
        }
        .mod-types, .mod-stats {
          display: block;
        }
        .mod-position {
          font-family: monospace;
          font-size: 0.9em;
        }
        .position-source {
          opacity: 0.7;
          font-style: italic;
        }
        .vmr-file {
          display: block;
          font-family: monospace;
          font-size: 0.85em;
          word-break: break-all;
        }
        .errors-list .mod-item {
          border-color: var(--error-color, #dc3545);
          background: rgba(220, 53, 69, 0.1);
        }
        .error-icon {
          color: var(--error-color, #dc3545);
          margin-right: 8px;
        }
        .error-path {
          font-family: monospace;
          font-size: 0.9em;
          word-break: break-all;
        }
        .error-message {
          margin-top: 4px;
          color: var(--error-color, #dc3545);
        }
        .pending-changes-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px;
          background: var(--bg-secondary, #1a1a2e);
          border: 1px solid var(--warning-color, #ffc107);
          border-radius: 4px;
          margin-top: 16px;
        }
        .pending-notice {
          color: var(--warning-color, #ffc107);
          font-size: 0.9em;
        }
        .control-button.primary {
          background: var(--accent-color, #4a90d9);
          border-color: var(--accent-color, #4a90d9);
        }
        .control-button.primary:hover {
          background: var(--accent-hover, #5a9fe9);
        }
        .git-repos-section {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .update-repos-button {
          align-self: flex-start;
        }
        .update-repos-button:disabled {
          opacity: 0.6;
          cursor: wait;
        }
        .update-result {
          display: flex;
          flex-direction: column;
          gap: 6px;
          margin-top: 8px;
        }
        .update-result-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 6px 10px;
          border-radius: 4px;
          font-size: 0.9em;
        }
        .update-result-item.updated {
          background: rgba(40, 167, 69, 0.15);
          border: 1px solid var(--success-color, #28a745);
        }
        .update-result-item.up-to-date {
          background: var(--bg-secondary, #1a1a2e);
          border: 1px solid var(--border-color, #333);
        }
        .update-result-item.failed {
          background: rgba(220, 53, 69, 0.15);
          border: 1px solid var(--error-color, #dc3545);
        }
        .update-repo-name {
          font-weight: 500;
          font-family: monospace;
        }
        .update-status {
          color: var(--text-secondary, #888);
          font-size: 0.9em;
        }
        .update-result-item.updated .update-status {
          color: var(--success-color, #28a745);
        }
        .update-result-item.failed .update-status {
          color: var(--error-color, #dc3545);
        }
      `}</style>
    </>
  )
}

/**
 * Tower mod item component
 */
function TowerModItem({
  tower,
  isDisabled,
  onToggle,
  onPosition,
  hasPendingChange,
}: {
  tower: TowerModInfo
  isDisabled: boolean
  onToggle: () => void
  onPosition: () => void
  hasPendingChange: boolean
}) {
  const placementText = tower.placement
    ? `${tower.placement.lat.toFixed(4)}, ${tower.placement.lon.toFixed(4)}`
    : 'no position'

  // Display name: use manifest name, fall back to ICAO if no name
  const displayName = tower.manifest.name || tower.icao || 'Unnamed'

  return (
    <div className="mod-item">
      <div className="mod-header-row">
        <label className="mod-checkbox">
          <input type="checkbox" checked={!isDisabled} onChange={onToggle} />
          <span className="mod-name">{displayName}</span>
          {tower.gitInfo?.isGitRepo && tower.gitInfo.repoName && (
            <span className="mod-repo-badge" title="From git repository">
              {tower.gitInfo.repoName}
            </span>
          )}
          {hasPendingChange && <span className="pending-badge">*</span>}
        </label>
        <button
          type="button"
          className="control-button position-button"
          onClick={onPosition}
          disabled={!tower.placement}
          title={tower.placement ? 'Reposition this tower model' : 'No position data available'}
        >
          Reposition
        </button>
      </div>
      <div className="mod-details">
        {tower.manifest.author && <span className="mod-author">by {tower.manifest.author}</span>}
        {tower.manifest.version && <span className="mod-version">v{tower.manifest.version}</span>}
      </div>
      <div className="mod-path-row">
        <span className="mod-path">{tower.path}</span>
      </div>
      <div className="mod-details">
        <span className="mod-position">
          Position: {placementText}
          {tower.placement && <span className="position-source"> ({tower.placement.source})</span>}
        </span>
      </div>
    </div>
  )
}

/**
 * Aircraft mod item component
 */
function AircraftModItem({
  aircraft,
  isDisabled,
  onToggle,
  hasPendingChange,
}: {
  aircraft: AircraftModInfo
  isDisabled: boolean
  onToggle: () => void
  hasPendingChange: boolean
}) {
  return (
    <div className="mod-item">
      <label className="mod-checkbox">
        <input type="checkbox" checked={!isDisabled} onChange={onToggle} />
        <span className="mod-name">{aircraft.manifest.name || 'Unnamed'}</span>
        {aircraft.gitInfo?.isGitRepo && aircraft.gitInfo.repoName && (
          <span className="mod-repo-badge" title="From git repository">
            {aircraft.gitInfo.repoName}
          </span>
        )}
        {hasPendingChange && <span className="pending-badge">*</span>}
      </label>
      <div className="mod-details">
        {aircraft.manifest.author && <span className="mod-author">by {aircraft.manifest.author}</span>}
        {aircraft.manifest.version && <span className="mod-version">v{aircraft.manifest.version}</span>}
      </div>
      <div className="mod-details">
        <span className="mod-types">Types: {aircraft.aircraftTypes.join(', ')}</span>
      </div>
    </div>
  )
}

/**
 * Error item component
 */
function ErrorItem({ error }: { error: ModError }) {
  return (
    <div className="mod-item">
      <div>
        <span className="error-icon">⚠</span>
        <span className="error-path">{error.path}</span>
      </div>
      <div className="error-message">{error.error}</div>
    </div>
  )
}

export default SettingsModsTab
