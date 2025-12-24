/**
 * FSLTL Import Panel
 *
 * UI component for managing FSLTL aircraft model import and conversion.
 * Allows users to:
 * - Select FSLTL source folder (fsltl-traffic-base)
 * - Choose texture quality/scaling
 * - Select specific airlines and aircraft types to convert
 * - Monitor conversion progress
 *
 * @see FSLTLService - Backend service for model matching
 * @see fsltlApi - Tauri API wrapper for file operations
 */

import { useState, useEffect, useCallback } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { fsltlService } from '../../services/FSLTLService'
import * as fsltlApi from '../../services/fsltlApi'
import type { ConversionProgress, FSLTLAirlineInfo, FSLTLTypeInfo } from '../../types/fsltl'
import './FSLTLImportPanel.css'

type PanelState = 'setup' | 'selection' | 'converting' | 'complete'

function FSLTLImportPanel() {
  // Settings
  const fsltlSettings = useSettingsStore((state) => state.fsltl)
  const updateFSLTLSettings = useSettingsStore((state) => state.updateFSLTLSettings)

  // Panel state
  const [panelState, setPanelState] = useState<PanelState>('setup')
  const [error, setError] = useState<string | null>(null)
  const [isValidating, setIsValidating] = useState(false)

  // VMR and selection state
  const [vmrLoaded, setVmrLoaded] = useState(false)
  const [airlines, setAirlines] = useState<FSLTLAirlineInfo[]>([])
  const [types, setTypes] = useState<FSLTLTypeInfo[]>([])
  const [selectedAirlines, setSelectedAirlines] = useState<Set<string>>(new Set())
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set())

  // Conversion progress
  const [progress, setProgress] = useState<ConversionProgress>({
    status: 'idle',
    total: 0,
    completed: 0,
    current: null,
    errors: []
  })

  // Stats
  const [convertedCount, setConvertedCount] = useState(0)
  const [outputPath, setOutputPath] = useState<string | null>(null)

  // Initialize on mount - intentionally runs once with captured values
  useEffect(() => {
    const sourcePath = fsltlSettings.sourcePath
    const init = async () => {
      try {
        // Get output path
        const path = await fsltlApi.getFsltlOutputPath()
        setOutputPath(path)

        // Initialize FSLTL service (loads registry from IndexedDB)
        await fsltlService.initialize()
        setConvertedCount(fsltlService.getModelCount())

        // If source path is already set, validate and load VMR
        if (sourcePath) {
          const isValid = await fsltlApi.validateFsltlSource(sourcePath)
          if (isValid) {
            const vmrPath = `${sourcePath}/FSLTL_Rules.vmr`
            const vmrContent = await fsltlApi.readTextFile(vmrPath)
            fsltlService.parseVMRContent(vmrContent)
            setAirlines(fsltlService.getAvailableAirlines())
            setTypes(fsltlService.getAvailableTypes())
            setVmrLoaded(true)

            // Pre-select common types
            const commonTypes = ['A320', 'B738', 'B737', 'A321', 'A319', 'E190', 'CRJ9']
            const preselected = new Set(commonTypes.filter(t =>
              fsltlService.getAvailableTypes().some(info => info.typeCode === t)
            ))
            setSelectedTypes(preselected)
          }
        }
      } catch (err) {
        console.error('[FSLTLImportPanel] Init error:', err)
      }
    }
    init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load and parse VMR file
  const loadVMR = useCallback(async (sourcePath: string) => {
    try {
      const vmrPath = `${sourcePath}/FSLTL_Rules.vmr`
      const vmrContent = await fsltlApi.readTextFile(vmrPath)
      fsltlService.parseVMRContent(vmrContent)

      setAirlines(fsltlService.getAvailableAirlines())
      setTypes(fsltlService.getAvailableTypes())
      setVmrLoaded(true)

      // Pre-select common types
      const commonTypes = ['A320', 'B738', 'B737', 'A321', 'A319', 'E190', 'CRJ9']
      const preselected = new Set(commonTypes.filter(t =>
        fsltlService.getAvailableTypes().some(info => info.typeCode === t)
      ))
      setSelectedTypes(preselected)
    } catch (err) {
      console.error('[FSLTLImportPanel] Failed to load VMR:', err)
      setError('Failed to load FSLTL rules file')
    }
  }, [])

  // Handle folder selection
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
      await loadVMR(folder)
      setPanelState('selection')
      setIsValidating(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to select folder')
      setIsValidating(false)
    }
  }

  // Toggle airline selection
  const handleToggleAirline = (code: string) => {
    setSelectedAirlines(prev => {
      const next = new Set(prev)
      if (next.has(code)) {
        next.delete(code)
      } else {
        next.add(code)
      }
      return next
    })
  }

  // Toggle type selection
  const handleToggleType = (typeCode: string) => {
    setSelectedTypes(prev => {
      const next = new Set(prev)
      if (next.has(typeCode)) {
        next.delete(typeCode)
      } else {
        next.add(typeCode)
      }
      return next
    })
  }

  // Select/deselect all airlines
  const handleSelectAllAirlines = () => {
    setSelectedAirlines(new Set(airlines.map(a => a.code)))
  }
  const handleClearAirlines = () => {
    setSelectedAirlines(new Set())
  }

  // Select/deselect all types
  const handleSelectAllTypes = () => {
    setSelectedTypes(new Set(types.map(t => t.typeCode)))
  }
  const handleClearTypes = () => {
    setSelectedTypes(new Set())
  }

  // Get models to convert based on selection
  const getSelectedModels = (): string[] => {
    return fsltlService.getModelsToConvert(
      Array.from(selectedAirlines),
      Array.from(selectedTypes)
    )
  }

  // Start conversion
  const handleStartConversion = async () => {
    if (!fsltlSettings.sourcePath || !outputPath) return

    const models = getSelectedModels()
    if (models.length === 0) {
      setError('No models selected. Select at least one airline or type.')
      return
    }

    try {
      setError(null)
      setPanelState('converting')

      // Create temp progress file path
      const progressFile = `${outputPath}/conversion_progress.json`

      // Start conversion
      await fsltlApi.startFsltlConversion(
        fsltlSettings.sourcePath,
        outputPath,
        fsltlSettings.textureScale,
        models,
        progressFile
      )

      // Poll for progress
      const pollInterval = setInterval(async () => {
        try {
          const currentProgress = await fsltlApi.readConversionProgress(progressFile)
          setProgress(currentProgress)

          if (currentProgress.status === 'complete' || currentProgress.status === 'error') {
            clearInterval(pollInterval)

            // Reload registry and trigger model refresh
            await fsltlService.loadRegistry()
            setConvertedCount(fsltlService.getModelCount())
            fsltlService.triggerModelRefresh()

            setPanelState('complete')
          }
        } catch {
          // Progress file may not exist yet
        }
      }, 1000)

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start conversion')
      setPanelState('selection')
    }
  }

  // Estimate disk space
  const estimateDiskSpace = (): string => {
    const count = getSelectedModels().length
    // Rough estimate: ~5MB per model at 1K textures, scales with quality
    const baseSize = 5
    const qualityMultiplier = {
      'full': 4,
      '2k': 2,
      '1k': 1,
      '512': 0.5
    }
    const sizeMB = count * baseSize * qualityMultiplier[fsltlSettings.textureScale]
    if (sizeMB >= 1024) {
      return `~${(sizeMB / 1024).toFixed(1)} GB`
    }
    return `~${Math.round(sizeMB)} MB`
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
        </p>
      </div>

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

      {/* Selection Panel */}
      {vmrLoaded && panelState === 'selection' && (
        <>
          {/* Aircraft Types */}
          <div className="fsltl-section">
            <div className="fsltl-section-header">
              <label>Aircraft Types ({selectedTypes.size} selected)</label>
              <div className="fsltl-selection-buttons">
                <button onClick={handleSelectAllTypes}>All</button>
                <button onClick={handleClearTypes}>None</button>
              </div>
            </div>
            <div className="fsltl-checkbox-grid">
              {types.slice(0, 20).map(type => (
                <label key={type.typeCode} className="fsltl-checkbox-item">
                  <input
                    type="checkbox"
                    checked={selectedTypes.has(type.typeCode)}
                    onChange={() => handleToggleType(type.typeCode)}
                  />
                  <span>{type.typeCode}</span>
                  <span className="fsltl-item-count">({type.airlines.length})</span>
                </label>
              ))}
              {types.length > 20 && (
                <span className="fsltl-more">+{types.length - 20} more</span>
              )}
            </div>
          </div>

          {/* Airlines */}
          <div className="fsltl-section">
            <div className="fsltl-section-header">
              <label>Airlines ({selectedAirlines.size} selected)</label>
              <div className="fsltl-selection-buttons">
                <button onClick={handleSelectAllAirlines}>All</button>
                <button onClick={handleClearAirlines}>None</button>
              </div>
            </div>
            <div className="fsltl-checkbox-grid">
              {airlines.slice(0, 30).map(airline => (
                <label key={airline.code} className="fsltl-checkbox-item">
                  <input
                    type="checkbox"
                    checked={selectedAirlines.has(airline.code)}
                    onChange={() => handleToggleAirline(airline.code)}
                  />
                  <span>{airline.code}</span>
                  <span className="fsltl-item-count">({airline.variantCount})</span>
                </label>
              ))}
              {airlines.length > 30 && (
                <span className="fsltl-more">+{airlines.length - 30} more</span>
              )}
            </div>
          </div>

          {/* Conversion Stats */}
          <div className="fsltl-stats">
            <span>Selected: {getSelectedModels().length} models</span>
            <span>Est. size: {estimateDiskSpace()}</span>
          </div>

          {/* Convert Button */}
          <button
            className="control-button primary fsltl-convert-button"
            onClick={handleStartConversion}
            disabled={getSelectedModels().length === 0}
          >
            Convert Selected Models
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
          {progress.current && (
            <div className="fsltl-progress-current">
              {progress.current}
            </div>
          )}
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
            onClick={() => setPanelState('selection')}
          >
            Convert More
          </button>
        </div>
      )}

      {/* Status */}
      <div className="fsltl-status">
        <span>Converted models: {convertedCount}</span>
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
