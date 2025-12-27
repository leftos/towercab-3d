/**
 * FSLTL Import Panel
 *
 * UI component for managing FSLTL aircraft model import and conversion.
 * Simplified interface: select source folder, choose output location, convert all.
 *
 * Conversion state is managed by fsltlConversionStore to persist across
 * Settings panel open/close.
 *
 * @see FSLTLService - Backend service for model matching
 * @see fsltlApi - Tauri API wrapper for file operations
 * @see fsltlConversionStore - Conversion state management
 */

import { useState, useEffect, useCallback } from 'react'
import { shellApi } from '../../utils/tauriApi'
import { useGlobalSettingsStore } from '../../stores/globalSettingsStore'
import { useFsltlConversionStore, getConversionEta } from '../../stores/fsltlConversionStore'
import { fsltlService } from '../../services/FSLTLService'
import * as fsltlApi from '../../services/fsltlApi'
import { isRemoteMode } from '../../utils/remoteMode'
import CollapsibleSection from './settings/CollapsibleSection'
import './FSLTLImportPanel.css'

/**
 * Remote mode view for FSLTL settings
 * Shows read-only status of FSLTL models (conversion must happen on host)
 */
function FSLTLImportPanelRemote() {
  const fsltlSettings = useGlobalSettingsStore((state) => state.fsltl)
  const [modelCount, setModelCount] = useState(0)

  useEffect(() => {
    // Initialize service to get model count from API
    fsltlService.initialize().then(() => {
      setModelCount(fsltlService.getModelCount())
    })
  }, [])

  return (
    <CollapsibleSection title="FSLTL Aircraft Models">
      <div className="fsltl-import-panel">
        <div className="fsltl-remote-notice">
          <p>
            FSLTL model conversion must be done on the host PC.
            Connect from the desktop app to configure model conversion.
          </p>
        </div>

        <div className="fsltl-section">
          <label>Status</label>
          <div className="fsltl-status-row">
            <span className="fsltl-status-value">
              {modelCount > 0 ? `${modelCount} models available` : 'No models converted'}
            </span>
            <span className={`fsltl-status-badge ${fsltlSettings.enableFsltlModels ? 'enabled' : 'disabled'}`}>
              {fsltlSettings.enableFsltlModels ? 'Enabled' : 'Disabled'}
            </span>
          </div>
        </div>
      </div>
    </CollapsibleSection>
  )
}

function FSLTLImportPanel() {
  // Check remote mode (value is constant for entire session)
  const inRemoteMode = isRemoteMode()

  // FSLTL settings from global settings (shared across browsers)
  const fsltlSettings = useGlobalSettingsStore((state) => state.fsltl)
  const updateFSLTLSettings = useGlobalSettingsStore((state) => state.updateFsltl)

  // Conversion state from store (persists across Settings open/close)
  const conversionState = useFsltlConversionStore((state) => state.conversionState)
  const progress = useFsltlConversionStore((state) => state.progress)
  const conversionStartTime = useFsltlConversionStore((state) => state.conversionStartTime)
  const isCancelling = useFsltlConversionStore((state) => state.isCancelling)
  const storeError = useFsltlConversionStore((state) => state.error)
  const startConversion = useFsltlConversionStore((state) => state.startConversion)
  const updateProgress = useFsltlConversionStore((state) => state.updateProgress)
  const completeConversion = useFsltlConversionStore((state) => state.completeConversion)
  const cancelConversion = useFsltlConversionStore((state) => state.cancelConversion)
  const setStoreError = useFsltlConversionStore((state) => state.setError)
  const resetConversion = useFsltlConversionStore((state) => state.reset)
  const setPollInterval = useFsltlConversionStore((state) => state.setPollInterval)

  // Local UI state (not conversion-related)
  const [localError, setLocalError] = useState<string | null>(null)
  const [isValidating, setIsValidating] = useState(false)
  const [isSourceValid, setIsSourceValid] = useState(false)

  // Output path state
  const [outputPath, setOutputPath] = useState<string | null>(null)
  const [defaultOutputPath, setDefaultOutputPath] = useState<string | null>(null)

  // Stats
  const [convertedCount, setConvertedCount] = useState(0)
  const [availableCount, setAvailableCount] = useState(0)

  // Combined error display
  const error = localError || storeError

  // Initialize on mount (skip in remote mode)
  useEffect(() => {
    if (inRemoteMode) return

    const sourcePath = fsltlSettings.sourcePath
    const savedOutputPath = fsltlSettings.outputPath

    const init = async () => {
      try {
        // Get default output path
        const [defaultPath] = await fsltlApi.getFsltlDefaultOutputPath()
        setDefaultOutputPath(defaultPath)

        // Use saved output path or default
        const effectiveOutputPath = savedOutputPath || defaultPath
        setOutputPath(effectiveOutputPath)

        // Initialize FSLTL service (loads registry from IndexedDB)
        await fsltlService.initialize()

        // Scan output directory for existing models and rebuild registry
        // This ensures we pick up models even if the output path changed
        if (effectiveOutputPath) {
          try {
            const scannedCount = await fsltlService.scanAndRebuildRegistry(effectiveOutputPath)
            console.log(`[FSLTLImportPanel] Scanned ${scannedCount} models from output path`)
          } catch (scanErr) {
            console.warn('[FSLTLImportPanel] Failed to scan output path:', scanErr)
          }
        }

        setConvertedCount(fsltlService.getModelCount())

        // If source path is already set, validate it and load VMR rules
        if (sourcePath) {
          const isValid = await fsltlApi.validateFsltlSource(sourcePath)
          if (isValid) {
            setIsSourceValid(true)

            // Load VMR rules for model matching
            try {
              const vmrContent = await fsltlApi.readVmrFile(sourcePath)
              fsltlService.parseVMRContent(vmrContent)
              console.log('[FSLTLImportPanel] Loaded VMR rules from saved source path')
            } catch (vmrErr) {
              console.warn('[FSLTLImportPanel] Failed to load VMR:', vmrErr)
            }

            // Count available models
            const aircraft = await fsltlApi.listFsltlAircraft(sourcePath)
            setAvailableCount(aircraft.length)
          }
        }
      } catch (err) {
        console.error('[FSLTLImportPanel] Init error:', err)
      }
    }
    init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Handle source folder selection
  const handleBrowseSource = async () => {
    try {
      setLocalError(null)
      const folder = await fsltlApi.pickFolder()
      if (!folder) return

      setIsValidating(true)
      const isValid = await fsltlApi.validateFsltlSource(folder)

      if (!isValid) {
        setLocalError('Invalid FSLTL folder. Must contain FSLTL_Rules.vmr and SimObjects/Airplanes')
        setIsValidating(false)
        return
      }

      updateFSLTLSettings({ sourcePath: folder })

      // Load VMR rules for model matching
      try {
        const vmrContent = await fsltlApi.readVmrFile(folder)
        fsltlService.parseVMRContent(vmrContent)
        console.log('[FSLTLImportPanel] Loaded VMR rules')
      } catch (vmrErr) {
        console.warn('[FSLTLImportPanel] Failed to load VMR:', vmrErr)
      }

      // Count available models
      const aircraft = await fsltlApi.listFsltlAircraft(folder)
      setAvailableCount(aircraft.length)

      setIsSourceValid(true)
      setIsValidating(false)
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to select folder')
      setIsValidating(false)
    }
  }

  // Handle output folder selection
  const handleBrowseOutput = async () => {
    try {
      setLocalError(null)
      const folder = await fsltlApi.pickFolder()
      if (!folder) return

      setOutputPath(folder)
      updateFSLTLSettings({ outputPath: folder })

      // Scan the new output path for existing models
      try {
        const scannedCount = await fsltlService.scanAndRebuildRegistry(folder)
        setConvertedCount(fsltlService.getModelCount())
        if (scannedCount > 0) {
          console.log(`[FSLTLImportPanel] Found ${scannedCount} existing models in new output path`)
        }
      } catch (scanErr) {
        console.warn('[FSLTLImportPanel] Failed to scan new output path:', scanErr)
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to select folder')
    }
  }

  // Reset output to default
  const handleResetOutputPath = () => {
    if (defaultOutputPath) {
      setOutputPath(defaultOutputPath)
      updateFSLTLSettings({ outputPath: null })
    }
  }

  // Cancel running conversion
  const handleCancelConversion = useCallback(async () => {
    await cancelConversion()
  }, [cancelConversion])

  // Start conversion (converts ALL models)
  const handleStartConversion = useCallback(async () => {
    if (!fsltlSettings.sourcePath || !outputPath) return

    try {
      setLocalError(null)
      setStoreError(null)

      // Create unique progress file path with timestamp
      // Use backslash for Windows path separator
      const timestamp = Date.now()
      const progressFile = `${outputPath}\\conversion_progress_${timestamp}.json`

      // Start conversion in store
      startConversion(progressFile)

      // Start conversion with empty models array = convert all
      await fsltlApi.startFsltlConversion(
        fsltlSettings.sourcePath,
        outputPath,
        fsltlSettings.textureScale,
        [], // Empty = convert all
        progressFile
      )

      console.log('[FSLTLImportPanel] Started conversion, polling progress file:', progressFile)

      // Poll for progress with failure detection
      let pollFailureCount = 0
      const MAX_POLL_FAILURES = 10 // Allow 10 seconds for converter to start
      const intervalId = setInterval(async () => {
        try {
          const currentProgress = await fsltlApi.readConversionProgress(progressFile)
          pollFailureCount = 0 // Reset on successful read
          console.log('[FSLTLImportPanel] Progress:', currentProgress.completed, '/', currentProgress.total, currentProgress.status)
          updateProgress(currentProgress)

          // Check for startup error (converter failed before starting work)
          if (currentProgress.startup_error) {
            console.error('[FSLTLImportPanel] Converter startup error:', currentProgress.startup_error)
            setStoreError(`Converter failed to start:\n${currentProgress.startup_error}`)
            resetConversion()

            // Clean up progress file
            try {
              await fsltlApi.deleteFile(progressFile)
            } catch {
              // Ignore cleanup errors
            }
            return
          }

          if (currentProgress.status === 'complete' || currentProgress.status === 'error') {
            // Register newly converted models
            if (currentProgress.converted && currentProgress.converted.length > 0) {
              const newModels = currentProgress.converted.map(info => ({
                aircraftType: info.aircraftType,
                airlineCode: info.airlineCode,
                modelName: info.modelName,
                modelPath: info.modelPath,
                textureSize: info.textureSize,
                hasAnimations: info.hasAnimations,
                fileSize: info.fileSize,
                convertedAt: info.convertedAt
              }))
              fsltlService.registerModels(newModels)
              console.log(`[FSLTLImportPanel] Registered ${newModels.length} new models`)

              // Auto-enable FSLTL models after successful conversion
              updateFSLTLSettings({ enableFsltlModels: true })
            }

            // Show errors if status is error
            if (currentProgress.status === 'error' && currentProgress.errors.length > 0) {
              console.error('[FSLTLImportPanel] Conversion errors:', currentProgress.errors)
            }

            // Clean up progress file
            try {
              await fsltlApi.deleteFile(progressFile)
            } catch {
              // Ignore cleanup errors
            }

            // Update count and trigger model refresh
            setConvertedCount(fsltlService.getModelCount())
            fsltlService.triggerModelRefresh()

            completeConversion()
          }
        } catch (pollErr) {
          // Progress file doesn't exist yet or read failed
          pollFailureCount++
          console.log(`[FSLTLImportPanel] Poll attempt ${pollFailureCount}/${MAX_POLL_FAILURES}:`, pollErr)

          if (pollFailureCount >= MAX_POLL_FAILURES) {
            // Converter appears to have died without creating progress file
            console.error('[FSLTLImportPanel] Converter failed to start (no progress file after', MAX_POLL_FAILURES, 'seconds)')
            setStoreError(
              'Converter process failed to start. This may be caused by:\n' +
              '• Missing dependencies (numpy, Pillow)\n' +
              '• Corrupted converter executable\n' +
              '• Antivirus blocking the process\n\n' +
              'Try running "npm run build:converter" to rebuild.'
            )
            resetConversion()
          }
        }
      }, 1000)

      // Store interval ID for cleanup
      setPollInterval(intervalId)

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.error('[FSLTLImportPanel] Conversion start failed:', errorMessage)
      setStoreError(`Failed to start conversion: ${errorMessage}`)
      resetConversion()
    }
  }, [fsltlSettings.sourcePath, fsltlSettings.textureScale, outputPath, startConversion, updateProgress, completeConversion, setPollInterval, setStoreError, resetConversion, updateFSLTLSettings])

  // Estimate disk space for all models
  const getEstimatedDiskSpace = () => {
    const count = availableCount
    // Rough estimate: ~5MB per model at 1K textures, scales with quality
    const baseSize = 5
    const qualityMultiplier: Record<string, number> = {
      'full': 4,
      '2k': 2,
      '1k': 1,
      '512': 0.5
    }
    const sizeMB = count * baseSize * (qualityMultiplier[fsltlSettings.textureScale] ?? 1)
    if (sizeMB >= 1024) {
      return `~${(sizeMB / 1024).toFixed(1)} GB`
    }
    return `~${Math.round(sizeMB)} MB`
  }

  const isCustomOutputPath = outputPath !== defaultOutputPath && fsltlSettings.outputPath !== null

  // Derive panel display state from store state
  const isConverting = conversionState === 'converting'
  const isComplete = conversionState === 'complete'
  const isReady = isSourceValid && !isConverting && !isComplete

  // Show remote mode view if running in browser
  if (inRemoteMode) {
    return <FSLTLImportPanelRemote />
  }

  return (
    <CollapsibleSection title="FSLTL Aircraft Models">
      <div className="fsltl-import-panel">
        {/* Enable/Disable Toggle - only show if converted models are available */}
      {convertedCount > 0 && (
        <div className="fsltl-section">
          <label className="setting-checkbox-label">
            <input
              type="checkbox"
              checked={fsltlSettings.enableFsltlModels}
              onChange={(e) => {
                updateFSLTLSettings({ enableFsltlModels: e.target.checked })
                // Trigger model refresh when toggling so aircraft update immediately
                fsltlService.triggerModelRefresh()
              }}
            />
            <span>Use FSLTL Models</span>
          </label>
          <p className="setting-hint">
            When disabled, falls back to built-in (FR24) models. Useful for testing.
          </p>
        </div>
      )}

      {/* Source Path */}
      <div className="fsltl-section">
        <label>FSLTL Package Location</label>
        <div className="fsltl-path-row">
          <span className="fsltl-path">
            {fsltlSettings.sourcePath || 'Not selected'}
          </span>
          <button
            className="control-button"
            onClick={handleBrowseSource}
            disabled={isValidating || isConverting}
          >
            {isValidating ? 'Validating...' : 'Browse...'}
          </button>
        </div>
        <p className="setting-hint">
          Select the fsltl-traffic-base folder from your MSFS Community folder.
          Get FSLTL from <a
            href="#"
            onClick={(e) => { e.preventDefault(); shellApi.openExternal('https://fslivetrafficliveries.com/') }}
            className="external-link"
          >fslivetrafficliveries.com</a>
        </p>
      </div>

      {/* Output Path - only show when source is valid */}
      {isSourceValid && (
        <div className="fsltl-section">
          <label>Output Location</label>
          <div className="fsltl-path-row">
            <span className="fsltl-path" title={outputPath || ''}>
              {outputPath || 'Not set'}
            </span>
            <button
              className="control-button"
              onClick={handleBrowseOutput}
              disabled={isConverting}
            >
              Change...
            </button>
            {isCustomOutputPath && (
              <button
                className="control-button"
                onClick={handleResetOutputPath}
                disabled={isConverting}
                title="Reset to default location"
              >
                Reset
              </button>
            )}
          </div>
          <p className="setting-hint">
            Where converted GLB models will be saved. Default is the app&apos;s mods folder.
          </p>
        </div>
      )}

      {/* Texture Quality */}
      <div className="fsltl-section">
        <label>Texture Quality</label>
        <select
          value={fsltlSettings.textureScale}
          onChange={(e) => updateFSLTLSettings({ textureScale: e.target.value as 'full' | '2k' | '1k' | '512' })}
          disabled={isConverting}
        >
          <option value="full">Full (4K) - Largest files</option>
          <option value="2k">2K - High quality</option>
          <option value="1k">1K - Balanced (recommended)</option>
          <option value="512">512px - Smallest files</option>
        </select>
      </div>

      {/* Ready Panel - Show convert button */}
      {isReady && (
        <>
          <div className="fsltl-stats">
            <span>Available: {availableCount} models</span>
            <span>Est. size: {getEstimatedDiskSpace()}</span>
          </div>

          <button
            className="control-button primary fsltl-convert-button"
            onClick={handleStartConversion}
            disabled={availableCount === 0}
          >
            Convert All Models
          </button>
        </>
      )}

      {/* Progress Panel */}
      {isConverting && (
        <div className="fsltl-progress-section">
          <div className="fsltl-progress-bar">
            <div
              className="fsltl-progress-fill"
              style={{ width: `${progress.total > 0 ? (progress.completed / progress.total) * 100 : 0}%` }}
            />
          </div>
          <div className="fsltl-progress-text">
            Converting: {progress.completed} / {progress.total}
          </div>
          <div className="fsltl-progress-eta">
            {getConversionEta(conversionStartTime, progress.completed, progress.total)}
          </div>
          {progress.current && (
            <div className="fsltl-progress-current">
              {progress.current}
            </div>
          )}
          <button
            className="control-button fsltl-cancel-button"
            onClick={handleCancelConversion}
            disabled={isCancelling}
          >
            {isCancelling ? 'Stopping...' : 'Cancel'}
          </button>
          {isCancelling && (
            <div className="fsltl-cancelling-hint">
              Please wait, finishing current model...
            </div>
          )}
        </div>
      )}

      {/* Complete Panel */}
      {isComplete && (
        <div className="fsltl-complete-section">
          <div className="fsltl-success-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#4caf50" strokeWidth="2">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          </div>
          <p>Conversion complete! {progress.completed} models converted.</p>
          <button
            className="control-button"
            onClick={resetConversion}
          >
            Done
          </button>
        </div>
      )}

      {/* Status */}
      <div className="fsltl-status">
        <span>Converted models available: {convertedCount}</span>
      </div>

      {/* Error Display */}
      {error && (
        <div className="fsltl-error">
          {error}
        </div>
      )}

      {progress.errors.length > 0 && (
        <div className="fsltl-error">
          <strong>Errors:</strong>
          <ul>
            {progress.errors.slice(0, 5).map((err, i) => (
              <li key={i}>{err}</li>
            ))}
            {progress.errors.length > 5 && (
              <li>...and {progress.errors.length - 5} more</li>
            )}
          </ul>
        </div>
      )}
      </div>
    </CollapsibleSection>
  )
}

export default FSLTLImportPanel
