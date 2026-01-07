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

import { useState, useEffect, useCallback } from 'react'
import { useGlobalSettingsStore, useMsfsModelSettings } from '../../stores/globalSettingsStore'
import { MSFSModelConversionService, type MSFSDetectionResult } from '../../services/MSFSModelConversionService'
import { isTauri } from '../../utils/tauriApi'
import { isRemoteMode } from '../../utils/remoteMode'
import * as fsltlApi from '../../services/fsltlApi'
import CollapsibleSection from './settings/CollapsibleSection'
import type { MSFSModelSource, FSLTLTextureScale } from '../../types'
import { MSFS_CACHE_LIMIT } from '../../types'
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
            MSFS model settings must be configured on the host PC.
            Connect from the desktop app to configure model sources.
          </p>
        </div>

        <div className="fsltl-section">
          <label>Status</label>
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
  const [draggedVmrIndex, setDraggedVmrIndex] = useState<number | null>(null)

  // Source priority drag state
  const [draggedSourceIndex, setDraggedSourceIndex] = useState<number | null>(null)

  // Cache stats
  const [cacheStats, setCacheStats] = useState({ entryCount: 0, totalSizeMB: 0, limitMB: settings.cacheLimitMB })

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

      // Detect installations
      setIsDetecting(true)
      const result = await MSFSModelConversionService.detectInstallations(folder)
      setDetection(result)

      if (!result.fsltlFound && !result.aigFound) {
        setError('No FSLTL or AIG installation found in this folder')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to select folder')
    } finally {
      setIsDetecting(false)
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
  const handleRemoveVmr = useCallback(async (index: number) => {
    const updated = vmrFiles.filter((_, i) => i !== index)
    setVmrFiles(updated)
    await updateMsfsModels({ vmrFiles: updated })
  }, [vmrFiles, updateMsfsModels])

  // Handle VMR reordering via drag and drop
  const handleVmrDragStart = (index: number) => {
    setDraggedVmrIndex(index)
  }

  const handleVmrDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    if (draggedVmrIndex === null || draggedVmrIndex === index) return
  }

  const handleVmrDrop = async (index: number) => {
    if (draggedVmrIndex === null || draggedVmrIndex === index) {
      setDraggedVmrIndex(null)
      return
    }

    const updated = [...vmrFiles]
    const [dragged] = updated.splice(draggedVmrIndex, 1)
    updated.splice(index, 0, dragged)

    setVmrFiles(updated)
    setDraggedVmrIndex(null)
    await updateMsfsModels({ vmrFiles: updated })
  }

  // Handle source priority reordering
  const handleSourceDragStart = (index: number) => {
    setDraggedSourceIndex(index)
  }

  const handleSourceDragOver = (e: React.DragEvent) => {
    e.preventDefault()
  }

  const handleSourceDrop = async (index: number) => {
    if (draggedSourceIndex === null || draggedSourceIndex === index) {
      setDraggedSourceIndex(null)
      return
    }

    const updated = [...settings.priority]
    const [dragged] = updated.splice(draggedSourceIndex, 1)
    updated.splice(index, 0, dragged)

    setDraggedSourceIndex(null)
    await updateMsfsModels({ priority: updated })
  }

  // Handle toggle changes
  const handleEnableToggle = async (source: MSFSModelSource, enabled: boolean) => {
    if (source === 'fsltl') {
      await updateMsfsModels({ enableFsltl: enabled })
    } else {
      await updateMsfsModels({ enableAig: enabled })
    }
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

  const modelCounts = MSFSModelConversionService.getModelCounts()

  return (
    <CollapsibleSection title="MSFS Aircraft Models">
      <div className="fsltl-import-panel">
        {/* Community Folder Path */}
        <div className="fsltl-section">
          <label>MSFS Community Folder</label>
          <div className="fsltl-path-row">
            <span className="fsltl-path" title={settings.communityPath || ''}>
              {settings.communityPath || 'Not selected'}
            </span>
            <button
              className="control-button"
              onClick={handleBrowseCommunity}
              disabled={isDetecting}
            >
              {isDetecting ? 'Detecting...' : 'Browse...'}
            </button>
          </div>
          <p className="setting-hint">
            Select your MSFS Community folder to auto-detect FSLTL and AIG installations.
          </p>
        </div>

        {/* Detection Status */}
        {detection && (
          <div className="fsltl-section">
            <label>Detected Sources</label>
            <div className="msfs-detection-status">
              <div className={`msfs-source-badge ${detection.fsltlFound ? 'found' : 'not-found'}`}>
                FSLTL: {detection.fsltlFound ? `${detection.fsltlModelCount || 0} models` : 'Not found'}
              </div>
              <div className={`msfs-source-badge ${detection.aigFound ? 'found' : 'not-found'}`}>
                AIG: {detection.aigFound ? `${detection.aigModelCount || 0} models` : 'Not found'}
              </div>
            </div>
          </div>
        )}

        {/* Source Priority & Enable/Disable */}
        {settings.communityPath && (
          <div className="fsltl-section">
            <label>Model Sources (drag to reorder priority)</label>
            <div className="msfs-source-list">
              {settings.priority.map((source, index) => {
                const isEnabled = source === 'fsltl' ? settings.enableFsltl : settings.enableAig
                const count = source === 'fsltl' ? modelCounts.fsltl : modelCounts.aig
                const isFound = source === 'fsltl'
                  ? (detection?.fsltlFound ?? false)
                  : (detection?.aigFound ?? false)

                return (
                  <div
                    key={source}
                    className={`msfs-source-item ${draggedSourceIndex === index ? 'dragging' : ''}`}
                    draggable
                    onDragStart={() => handleSourceDragStart(index)}
                    onDragOver={handleSourceDragOver}
                    onDrop={() => handleSourceDrop(index)}
                  >
                    <span className="msfs-source-drag-handle">⋮⋮</span>
                    <label className="msfs-source-checkbox">
                      <input
                        type="checkbox"
                        checked={isEnabled}
                        onChange={(e) => handleEnableToggle(source, e.target.checked)}
                        disabled={!isFound}
                      />
                      <span>{source.toUpperCase()}</span>
                    </label>
                    <span className="msfs-source-count">
                      {isFound ? `${count} indexed` : 'Not installed'}
                    </span>
                    <span className="msfs-source-priority">#{index + 1}</span>
                  </div>
                )
              })}
            </div>
            <p className="setting-hint">
              Higher priority sources are checked first for model matching.
            </p>
          </div>
        )}

        {/* VMR File Management */}
        <div className="fsltl-section">
          <label>VMR Files (drag to reorder priority)</label>
          {vmrFiles.length > 0 ? (
            <div className="msfs-vmr-list">
              {vmrFiles.map((file, index) => (
                <div
                  key={file}
                  className={`msfs-vmr-item ${draggedVmrIndex === index ? 'dragging' : ''}`}
                  draggable
                  onDragStart={() => handleVmrDragStart(index)}
                  onDragOver={(e) => handleVmrDragOver(e, index)}
                  onDrop={() => handleVmrDrop(index)}
                >
                  <span className="msfs-vmr-drag-handle">⋮⋮</span>
                  <span className="msfs-vmr-name" title={file}>
                    #{index + 1} {getFilename(file)}
                  </span>
                  <button
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
          <button className="control-button" onClick={handleImportVmr}>
            Import VMR Files...
          </button>
          <p className="setting-hint">
            VMR files define custom model matching rules. Higher priority files are checked first.
          </p>
        </div>

        {/* Texture Quality */}
        <div className="fsltl-section">
          <label>Texture Quality</label>
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
          <label>Model Cache Directory</label>
          <div className="fsltl-path-row">
            <span className="fsltl-path" title={settings.cacheDirectory || ''}>
              {settings.cacheDirectory || 'Using default app data folder'}
            </span>
            <button className="control-button" onClick={handleBrowseCache}>
              Browse...
            </button>
            {settings.cacheDirectory && (
              <button
                className="control-button"
                onClick={() => updateMsfsModels({ cacheDirectory: null })}
                title="Reset to default"
              >
                Reset
              </button>
            )}
          </div>
          <p className="setting-hint">
            Converted models are cached to disk to avoid re-conversion.
          </p>
        </div>

        {/* Cache Limit */}
        <div className="fsltl-section">
          <label>Cache Size Limit</label>
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
          <p className="setting-hint">
            Oldest models are automatically removed when the cache exceeds this limit.
          </p>
        </div>

        {/* Cache Stats */}
        <div className="fsltl-section">
          <label>Cache Status</label>
          <div className="msfs-cache-stats">
            <span>{cacheStats.entryCount} models cached</span>
            <span>{cacheStats.totalSizeMB} MB used</span>
            {cacheStats.limitMB !== null && (
              <span>/ {cacheStats.limitMB} MB limit</span>
            )}
          </div>
          <button className="control-button" onClick={handleClearCache}>
            Clear Cache
          </button>
        </div>

        {/* Error Display */}
        {error && (
          <div className="fsltl-error">
            {error}
          </div>
        )}
      </div>
    </CollapsibleSection>
  )
}

export default MSFSModelSettingsPanel
