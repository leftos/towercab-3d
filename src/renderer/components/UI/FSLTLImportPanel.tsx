/**
 * FSLTL Import Panel
 *
 * UI component for managing FSLTL aircraft model import and conversion.
 * Simplified interface: select source folder, choose output location, convert all.
 *
 * @see FSLTLService - Backend service for model matching
 * @see fsltlApi - Tauri API wrapper for file operations
 */

import { useState, useEffect, useRef } from 'react'
import { open as openExternal } from '@tauri-apps/plugin-shell'
import { useSettingsStore } from '../../stores/settingsStore'
import { fsltlService } from '../../services/FSLTLService'
import * as fsltlApi from '../../services/fsltlApi'
import type { ConversionProgress } from '../../types/fsltl'
import './FSLTLImportPanel.css'

type PanelState = 'setup' | 'ready' | 'converting' | 'complete'

function FSLTLImportPanel() {
  // Settings
  const fsltlSettings = useSettingsStore((state) => state.fsltl)
  const updateFSLTLSettings = useSettingsStore((state) => state.updateFSLTLSettings)

  // Ref to track polling interval for cleanup
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Panel state
  const [panelState, setPanelState] = useState<PanelState>('setup')
  const [error, setError] = useState<string | null>(null)
  const [isValidating, setIsValidating] = useState(false)

  // Output path state
  const [outputPath, setOutputPath] = useState<string | null>(null)
  const [defaultOutputPath, setDefaultOutputPath] = useState<string | null>(null)

  // Conversion progress
  const [progress, setProgress] = useState<ConversionProgress>({
    status: 'idle',
    total: 0,
    completed: 0,
    current: null,
    errors: []
  })
  const [conversionStartTime, setConversionStartTime] = useState<number | null>(null)

  // Stats
  const [convertedCount, setConvertedCount] = useState(0)
  const [availableCount, setAvailableCount] = useState(0)

  // Initialize on mount
  useEffect(() => {
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
        setConvertedCount(fsltlService.getModelCount())

        // If source path is already set, validate it and load VMR rules
        if (sourcePath) {
          const isValid = await fsltlApi.validateFsltlSource(sourcePath)
          if (isValid) {
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
            setPanelState('ready')
          }
        }
      } catch (err) {
        console.error('[FSLTLImportPanel] Init error:', err)
      }
    }
    init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Cleanup polling interval on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }
  }, [])

  // Handle source folder selection
  const handleBrowseSource = async () => {
    try {
      setError(null)
      const folder = await fsltlApi.pickFolder()
      if (!folder) return

      setIsValidating(true)
      const isValid = await fsltlApi.validateFsltlSource(folder)

      if (!isValid) {
        setError('Invalid FSLTL folder. Must contain FSLTL_Rules.vmr and SimObjects/Airplanes')
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

      setPanelState('ready')
      setIsValidating(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to select folder')
      setIsValidating(false)
    }
  }

  // Handle output folder selection
  const handleBrowseOutput = async () => {
    try {
      setError(null)
      const folder = await fsltlApi.pickFolder()
      if (!folder) return

      setOutputPath(folder)
      updateFSLTLSettings({ outputPath: folder })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to select folder')
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
  const handleCancelConversion = async () => {
    try {
      // Stop polling
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }

      // Kill the converter process
      await fsltlApi.cancelFsltlConversion()

      setProgress({
        status: 'idle',
        total: 0,
        completed: 0,
        current: null,
        errors: []
      })
      setPanelState('ready')
    } catch (err) {
      console.warn('[FSLTLImportPanel] Cancel failed (process may have already finished):', err)
      // Still reset state even if cancel fails
      setPanelState('ready')
    }
  }

  // Start conversion (converts ALL models)
  const handleStartConversion = async () => {
    if (!fsltlSettings.sourcePath || !outputPath) return

    try {
      setError(null)
      setPanelState('converting')

      // Create unique progress file path with timestamp
      // Use backslash for Windows path separator
      const timestamp = Date.now()
      const progressFile = `${outputPath}\\conversion_progress_${timestamp}.json`

      // Track start time for ETA calculation
      setConversionStartTime(Date.now())

      // Start conversion with empty models array = convert all
      await fsltlApi.startFsltlConversion(
        fsltlSettings.sourcePath,
        outputPath,
        fsltlSettings.textureScale,
        [], // Empty = convert all
        progressFile
      )

      console.log('[FSLTLImportPanel] Started conversion, polling progress file:', progressFile)

      // Poll for progress
      pollIntervalRef.current = setInterval(async () => {
        try {
          const currentProgress = await fsltlApi.readConversionProgress(progressFile)
          console.log('[FSLTLImportPanel] Progress:', currentProgress.completed, '/', currentProgress.total, currentProgress.status)
          setProgress(currentProgress)

          if (currentProgress.status === 'complete' || currentProgress.status === 'error') {
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current)
              pollIntervalRef.current = null
            }

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

            setPanelState('complete')
          }
        } catch (pollErr) {
          // Progress file may not exist yet - log for debugging
          console.log('[FSLTLImportPanel] Poll error (may be normal):', pollErr)
        }
      }, 1000)

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.error('[FSLTLImportPanel] Conversion start failed:', errorMessage)
      setError(`Failed to start conversion: ${errorMessage}`)
      setPanelState('ready')
    }
  }

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

  // Calculate ETA based on progress
  const getEtaString = () => {
    if (!conversionStartTime || progress.completed === 0 || progress.total === 0) {
      return 'Calculating...'
    }

    const elapsedMs = Date.now() - conversionStartTime
    const msPerModel = elapsedMs / progress.completed
    const remaining = progress.total - progress.completed
    const remainingMs = remaining * msPerModel

    // Format time
    const totalSeconds = Math.round(remainingMs / 1000)
    if (totalSeconds < 60) {
      return `~${totalSeconds}s remaining`
    }
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    if (minutes < 60) {
      return `~${minutes}m ${seconds}s remaining`
    }
    const hours = Math.floor(minutes / 60)
    const mins = minutes % 60
    return `~${hours}h ${mins}m remaining`
  }

  return (
    <div className="fsltl-import-panel">
      <h3>FSLTL Aircraft Models</h3>

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
            disabled={isValidating || panelState === 'converting'}
          >
            {isValidating ? 'Validating...' : 'Browse...'}
          </button>
        </div>
        <p className="setting-hint">
          Select the fsltl-traffic-base folder from your MSFS Community folder.
          Get FSLTL from <a
            href="#"
            onClick={(e) => { e.preventDefault(); openExternal('https://fslivetrafficliveries.com/') }}
            className="external-link"
          >fslivetrafficliveries.com</a>
        </p>
      </div>

      {/* Output Path - only show when source is valid */}
      {panelState !== 'setup' && (
        <div className="fsltl-section">
          <label>Output Location</label>
          <div className="fsltl-path-row">
            <span className="fsltl-path" title={outputPath || ''}>
              {outputPath || 'Not set'}
            </span>
            <button
              className="control-button"
              onClick={handleBrowseOutput}
              disabled={panelState === 'converting'}
            >
              Change...
            </button>
            {isCustomOutputPath && (
              <button
                className="control-button"
                onClick={handleResetOutputPath}
                disabled={panelState === 'converting'}
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
          disabled={panelState === 'converting'}
        >
          <option value="full">Full (4K) - Largest files</option>
          <option value="2k">2K - High quality</option>
          <option value="1k">1K - Balanced (recommended)</option>
          <option value="512">512px - Smallest files</option>
        </select>
      </div>

      {/* Ready Panel - Show convert button */}
      {panelState === 'ready' && (
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
      {panelState === 'converting' && (
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
            {getEtaString()}
          </div>
          {progress.current && (
            <div className="fsltl-progress-current">
              {progress.current}
            </div>
          )}
          <button
            className="control-button fsltl-cancel-button"
            onClick={handleCancelConversion}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Complete Panel */}
      {panelState === 'complete' && (
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
            onClick={() => setPanelState('ready')}
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
  )
}

export default FSLTLImportPanel
