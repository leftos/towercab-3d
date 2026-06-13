/**
 * MSFS Model Settings Panel
 *
 * UI component for configuring on-the-fly MSFS model conversion.
 * Allows users to:
 * - Set Community folder path for FSLTL/AIG detection
 * - Enable/disable FSLTL and AIG with priority ordering
 * - Import and order VMR files for model matching rules
 * - Configure cache settings (directory, size limit)
 *
 * @see MSFSModelConversionService - Backend service for model conversion
 * @see globalSettingsStore - Stores MSFS model settings
 */

import { useCallback, useEffect, useState } from 'react'
import { aircraftModelService } from '../../services/AircraftModelService'
import * as fsltlApi from '../../services/fsltlApi'
import { type MSFSDetectionResult, MSFSModelConversionService } from '../../services/MSFSModelConversionService'
import { useGlobalSettingsStore, useMsfsModelSettings } from '../../stores/globalSettingsStore'
import type { FSLTLTextureScale, MSFSModelSource } from '../../types'
import { MSFS_CACHE_LIMIT } from '../../types'
import { isMacOS } from '../../utils/deviceDetection'
import { isRemoteMode } from '../../utils/remoteMode'
import { isTauri } from '../../utils/tauriApi'
import CollapsibleSection from './settings/CollapsibleSection'
import './FSLTLImportPanel.css'

/**
 * Remote mode view - read-only status
 */
function MSFSModelSettingsPanelRemote() {
  const settings = useMsfsModelSettings()

  return (
    <CollapsibleSection title="MSFS Aircraft Models">
      <div className="fsltl-import-panel">
        <div className="fsltl-remote-notice">
          <p>
            MSFS model settings must be configured on the host PC. Connect from the desktop app to configure model
            sources.
          </p>
        </div>

        <div className="fsltl-section">
          <span>Status</span>
          <div className="fsltl-status-row">
            <span className="fsltl-status-value">
              {settings.enableFsltl ? 'FSLTL Enabled' : 'FSLTL Disabled'}
              {' | '}
              {settings.enableAig ? 'AIG Enabled' : 'AIG Disabled'}
            </span>
          </div>
        </div>
      </div>
    </CollapsibleSection>
  )
}

function MSFSModelSettingsPanel() {
  // Check remote mode
  const inRemoteMode = isRemoteMode()

  // Settings from store
  const settings = useMsfsModelSettings()
  const updateMsfsModels = useGlobalSettingsStore((state) => state.updateMsfsModels)

  // Detection state
  const [detection, setDetection] = useState<MSFSDetectionResult | null>(null)
  const [isDetecting, setIsDetecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // VMR file management
  const [vmrFiles, setVmrFiles] = useState<string[]>(settings.vmrFiles || [])

  // Cache stats
  const [cacheStats, setCacheStats] = useState({ entryCount: 0, totalSizeMB: 0, limitMB: settings.cacheLimitMB })

  // Model counts (updated when indexing completes)
  const [modelCounts, setModelCounts] = useState({ fsltl: 0, aig: 0 })

  // Indexing state for showing progress
  const [indexingSource, setIndexingSource] = useState<MSFSModelSource | null>(null)
  const [indexingProgress, setIndexingProgress] = useState({ status: '', progress: 0 })

  // Initialize on mount
  useEffect(() => {
    if (inRemoteMode || !isTauri()) return

    // Get cached detection result
    const cached = MSFSModelConversionService.getDetectionResult()
    if (cached) {
      setDetection(cached)
    }

    // Update cache stats
    setCacheStats(MSFSModelConversionService.getCacheStats())

    // Update model counts
    setModelCounts(MSFSModelConversionService.getModelCounts())
  }, [inRemoteMode])

  // Sync VMR files with settings
  useEffect(() => {
    setVmrFiles(settings.vmrFiles || [])
  }, [settings.vmrFiles])

  // Handle Community folder selection
  const handleBrowseCommunity = useCallback(async () => {
    if (!isTauri()) return

    try {
      setError(null)
      const folder = await fsltlApi.pickFolder()

      if (!folder) return

      // Save the path
      await updateMsfsModels({ communityPath: folder })

      // Detect installations with progress tracking
      setIsDetecting(true)
      const result = await MSFSModelConversionService.detectInstallations(folder, (status, progress) => {
        setIndexingProgress({ status, progress: progress ?? 0 })
      })
      setDetection(result)

      // Update model counts after detection completes
      setModelCounts(MSFSModelConversionService.getModelCounts())

      // Invalidate aircraft model cache so existing aircraft can switch to MSFS models
      if (result.fsltlFound || result.aigFound) {
        aircraftModelService.clearCache()
        console.log('[MSFSSettings] Model cache invalidated - aircraft will re-match with MSFS models')
      }

      if (!result.fsltlFound && !result.aigFound) {
        setError('No FSLTL or AIG installation found in this folder')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to select folder')
    } finally {
      setIsDetecting(false)
      setIndexingProgress({ status: '', progress: 0 })
    }
  }, [updateMsfsModels])

  // Handle cache directory selection
  const handleBrowseCache = useCallback(async () => {
    if (!isTauri()) return

    try {
      setError(null)
      const folder = await fsltlApi.pickFolder()

      if (folder) {
        await updateMsfsModels({ cacheDirectory: folder })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to select folder')
    }
  }, [updateMsfsModels])

  // Handle VMR file import
  const handleImportVmr = useCallback(async () => {
    if (!isTauri()) return

    try {
      setError(null)
      const files = await fsltlApi.pickFiles('VMR Files', ['vmr'])

      if (!files || files.length === 0) return

      // Add new files (avoid duplicates)
      const existingSet = new Set(vmrFiles)
      const toAdd = files.filter((f) => !existingSet.has(f))

      if (toAdd.length > 0) {
        const updated = [...vmrFiles, ...toAdd]
        setVmrFiles(updated)
        await updateMsfsModels({ vmrFiles: updated })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import VMR files')
    }
  }, [vmrFiles, updateMsfsModels])

  // Handle VMR file removal
  const handleRemoveVmr = useCallback(
    async (index: number) => {
      const updated = vmrFiles.filter((_, i) => i !== index)
      setVmrFiles(updated)
      await updateMsfsModels({ vmrFiles: updated })
    },
    [vmrFiles, updateMsfsModels],
  )

  // Handle VMR reordering with up/down buttons
  const handleMoveVmr = async (index: number, direction: 'up' | 'down') => {
    const newIndex = direction === 'up' ? index - 1 : index + 1
    if (newIndex < 0 || newIndex >= vmrFiles.length) return

    const updated = [...vmrFiles]
    const [item] = updated.splice(index, 1)
    updated.splice(newIndex, 0, item)

    setVmrFiles(updated)
    await updateMsfsModels({ vmrFiles: updated })
  }

  // Handle source priority reordering with up/down buttons
  const handleMoveSource = async (index: number, direction: 'up' | 'down') => {
    const newIndex = direction === 'up' ? index - 1 : index + 1
    if (newIndex < 0 || newIndex >= settings.priority.length) return

    const updated = [...settings.priority]
    const [item] = updated.splice(index, 1)
    updated.splice(newIndex, 0, item)

    await updateMsfsModels({ priority: updated })

    // Invalidate model cache since priority affects which models are selected
    aircraftModelService.clearCache()
    console.log('[MSFSSettings] Model cache invalidated after priority change')
  }

  // Handle toggle changes
  const handleEnableToggle = async (source: MSFSModelSource, enabled: boolean) => {
    if (source === 'fsltl') {
      await updateMsfsModels({ enableFsltl: enabled })
    } else {
      await updateMsfsModels({ enableAig: enabled })
    }

    // If enabling a source, trigger indexing if not already indexed
    if (enabled) {
      const currentCounts = MSFSModelConversionService.getModelCounts()
      const needsIndexing = source === 'fsltl' ? currentCounts.fsltl === 0 : currentCounts.aig === 0

      if (needsIndexing) {
        setIndexingSource(source)
        try {
          await MSFSModelConversionService.indexSourceOnDemand(source)
          // Update model counts after indexing completes
          setModelCounts(MSFSModelConversionService.getModelCounts())
          // Invalidate model cache so aircraft can use the newly indexed models
          aircraftModelService.clearCache()
          console.log(`[MSFSSettings] Model cache invalidated after ${source} indexing`)
        } catch (err) {
          console.error(`[MSFSSettings] Failed to index ${source}:`, err)
        } finally {
          setIndexingSource(null)
        }
      }
    }

    // Invalidate cache when toggling sources (enabling or disabling)
    // This allows aircraft to re-match (either to newly available MSFS models or back to built-ins)
    aircraftModelService.clearCache()
    console.log(`[MSFSSettings] Model cache invalidated after ${enabled ? 'enabling' : 'disabling'} ${source}`)
  }

  // Handle cache limit change
  const handleCacheLimitChange = async (value: number | null) => {
    await updateMsfsModels({ cacheLimitMB: value })
    setCacheStats((prev) => ({ ...prev, limitMB: value }))
  }

  // Handle clear cache
  const handleClearCache = useCallback(async () => {
    await MSFSModelConversionService.clearCache()
    setCacheStats({ entryCount: 0, totalSizeMB: 0, limitMB: settings.cacheLimitMB })
  }, [settings.cacheLimitMB])

  // Handle texture scale change
  const handleTextureScaleChange = async (scale: FSLTLTextureScale) => {
    await updateMsfsModels({ textureScale: scale })
  }

  // Get filename from path
  const getFilename = (path: string) => {
    const parts = path.replace(/\\/g, '/').split('/')
    return parts[parts.length - 1]
  }

  // Remote mode
  if (inRemoteMode) {
    return <MSFSModelSettingsPanelRemote />
  }

  return (
    <CollapsibleSection title="MSFS Aircraft Models">
      <div className="fsltl-import-panel">
        {/* Community Folder Path */}
        <div className="fsltl-section">
          <span>MSFS Community Folder</span>
          <div className="fsltl-path-row">
            <span className="fsltl-path" title={settings.communityPath || ''}>
              {settings.communityPath || 'Not selected'}
            </span>
            <button type="button" className="control-button" onClick={handleBrowseCommunity} disabled={isDetecting}>
              {isDetecting ? 'Detecting...' : 'Browse...'}
            </button>
          </div>
          {isDetecting && indexingProgress.status && (
            <div className="msfs-indexing-progress">
              <div className="msfs-progress-bar">
                <div className="msfs-progress-fill" style={{ width: `${indexingProgress.progress}%` }} />
              </div>
              <span className="msfs-progress-text">
                {indexingProgress.status} ({indexingProgress.progress}%)
              </span>
            </div>
          )}
          <p className="setting-hint">
            {isMacOS()
              ? 'MSFS does not run on macOS — point this at a folder holding FSLTL/AIG models copied from a Windows MSFS Community folder to detect and convert them.'
              : 'Select your MSFS Community folder to auto-detect FSLTL and AIG installations.'}
          </p>
        </div>

        {/* Source Priority & Enable/Disable */}
        {settings.communityPath && (
          <div className="fsltl-section">
            <span>Model Sources (use arrows to reorder priority)</span>
            <div className="msfs-source-list">
              {settings.priority.map((source, index) => {
                const isEnabled = source === 'fsltl' ? settings.enableFsltl : settings.enableAig
                const count = source === 'fsltl' ? modelCounts.fsltl : modelCounts.aig
                const isFound = source === 'fsltl' ? (detection?.fsltlFound ?? false) : (detection?.aigFound ?? false)
                const isIndexing = indexingSource === source

                return (
                  <div key={source} className="msfs-source-item">
                    <div className="msfs-source-arrows">
                      <button
                        type="button"
                        className="msfs-arrow-btn"
                        onClick={() => handleMoveSource(index, 'up')}
                        disabled={index === 0 || isIndexing}
                        title="Move up"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        className="msfs-arrow-btn"
                        onClick={() => handleMoveSource(index, 'down')}
                        disabled={index === settings.priority.length - 1 || isIndexing}
                        title="Move down"
                      >
                        ▼
                      </button>
                    </div>
                    <label className="msfs-source-checkbox">
                      <input
                        type="checkbox"
                        checked={isEnabled}
                        onChange={(e) => handleEnableToggle(source, e.target.checked)}
                        disabled={!isFound || isIndexing}
                      />
                      <span>{source.toUpperCase()}</span>
                    </label>
                    <span className={`msfs-source-count ${isIndexing ? 'indexing' : ''}`}>
                      {!isFound ? 'Not installed' : isIndexing ? 'Indexing...' : `${count} indexed`}
                    </span>
                    <span className="msfs-source-priority">#{index + 1}</span>
                  </div>
                )
              })}
            </div>
            <p className="setting-hint">Higher priority sources are checked first for model matching.</p>
          </div>
        )}

        {/* VMR File Management */}
        <div className="fsltl-section">
          <span>VMR Files (use arrows to reorder priority)</span>
          {vmrFiles.length > 0 ? (
            <div className="msfs-vmr-list">
              {vmrFiles.map((file, index) => (
                <div key={file} className="msfs-vmr-item">
                  <div className="msfs-vmr-arrows">
                    <button
                      type="button"
                      className="msfs-arrow-btn"
                      onClick={() => handleMoveVmr(index, 'up')}
                      disabled={index === 0}
                      title="Move up"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      className="msfs-arrow-btn"
                      onClick={() => handleMoveVmr(index, 'down')}
                      disabled={index === vmrFiles.length - 1}
                      title="Move down"
                    >
                      ▼
                    </button>
                  </div>
                  <span className="msfs-vmr-name" title={file}>
                    #{index + 1} {getFilename(file)}
                  </span>
                  <button
                    type="button"
                    className="msfs-vmr-remove"
                    onClick={() => handleRemoveVmr(index)}
                    title="Remove VMR file"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="msfs-vmr-empty">No VMR files imported</p>
          )}
          <button type="button" className="control-button" onClick={handleImportVmr}>
            Import VMR Files...
          </button>
          <p className="setting-hint">
            VMR files define custom model matching rules. Higher priority files are checked first.
          </p>
        </div>

        {/* Skip Generic VMR Matches */}
        <div className="fsltl-section">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.skipGenericVmrMatches ?? false}
              onChange={(e) => {
                updateMsfsModels({ skipGenericVmrMatches: e.target.checked })
                // Invalidate model cache so aircraft re-match with new setting
                aircraftModelService.clearCache()
                console.log('[MSFSSettings] Model cache invalidated after skipGenericVmrMatches change')
              }}
            />
            <span>Skip generic VMR matches</span>
          </label>
          <p className="setting-hint">
            When enabled, VMR rules that map to generic models (e.g., FSLTL_B738_ZZZZ) are ignored. This allows the
            system to find an airline-liveried model and scale it instead of using a perfectly-sized generic white
            aircraft.
          </p>
        </div>

        {/* Texture Quality */}
        <div className="fsltl-section">
          <span>Texture Quality</span>
          <select
            value={settings.textureScale}
            onChange={(e) => handleTextureScaleChange(e.target.value as FSLTLTextureScale)}
          >
            <option value="full">Full (4K) - Largest files</option>
            <option value="2k">2K - High quality</option>
            <option value="1k">1K - Balanced (recommended)</option>
            <option value="512">512px - Smallest files</option>
          </select>
          <p className="setting-hint">
            Texture resolution for converted models. Lower settings reduce file size and memory usage.
          </p>
        </div>

        {/* Cache Settings */}
        <div className="fsltl-section">
          <span>Model Cache Directory</span>
          <div className="fsltl-path-row">
            <span className="fsltl-path" title={settings.cacheDirectory || ''}>
              {settings.cacheDirectory || 'Using default app data folder'}
            </span>
            <button type="button" className="control-button" onClick={handleBrowseCache}>
              Browse...
            </button>
            {settings.cacheDirectory && (
              <button
                type="button"
                className="control-button"
                onClick={() => updateMsfsModels({ cacheDirectory: null })}
                title="Reset to default"
              >
                Reset
              </button>
            )}
          </div>
          <p className="setting-hint">Converted models are cached to disk to avoid re-conversion.</p>
        </div>

        {/* Cache Limit */}
        <div className="fsltl-section">
          <span>Cache Size Limit</span>
          <div className="msfs-cache-limit-row">
            <select
              value={settings.cacheLimitMB === null ? 'unlimited' : settings.cacheLimitMB}
              onChange={(e) => {
                const val = e.target.value
                handleCacheLimitChange(val === 'unlimited' ? null : Number(val))
              }}
            >
              <option value={MSFS_CACHE_LIMIT.MIN_MB}>500 MB</option>
              <option value={1024}>1 GB</option>
              <option value={2048}>2 GB</option>
              <option value={MSFS_CACHE_LIMIT.DEFAULT_MB}>5 GB (default)</option>
              <option value={10240}>10 GB</option>
              <option value={MSFS_CACHE_LIMIT.MAX_MB}>20 GB</option>
              <option value="unlimited">Unlimited</option>
            </select>
          </div>
          <p className="setting-hint">Oldest models are automatically removed when the cache exceeds this limit.</p>
        </div>

        {/* Cache Stats */}
        <div className="fsltl-section">
          <span>Cache Status</span>
          <div className="msfs-cache-stats">
            <span>{cacheStats.entryCount} models cached</span>
            <span>{cacheStats.totalSizeMB} MB used</span>
            {cacheStats.limitMB !== null && <span>/ {cacheStats.limitMB} MB limit</span>}
          </div>
          <button type="button" className="control-button" onClick={handleClearCache}>
            Clear Cache
          </button>
        </div>

        {/* Error Display */}
        {error && <div className="fsltl-error">{error}</div>}
      </div>
    </CollapsibleSection>
  )
}

export default MSFSModelSettingsPanel
