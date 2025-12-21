import { useState, useRef, useMemo } from 'react'
import {
  ExportData,
  readImportFile,
  getAirportsInExport,
  getAirportExportSummary,
  importData
} from '../../services/ExportImportService'
import './ImportModal.css'

interface ImportModalProps {
  onClose: () => void
  onSuccess: () => void
  onElectronImport: () => Promise<void>
}

type ImportStep = 'source' | 'select' | 'complete'

function ImportModal({ onClose, onSuccess, onElectronImport }: ImportModalProps) {
  const [step, setStep] = useState<ImportStep>('source')
  const [error, setError] = useState<string | null>(null)
  const [exportData, setExportData] = useState<ExportData | null>(null)
  const [selectedAirports, setSelectedAirports] = useState<Set<string>>(new Set())
  const [importGlobalSettings, setImportGlobalSettings] = useState(true)
  const [mergeMode, setMergeMode] = useState<'replace' | 'merge'>('merge')
  const [importResult, setImportResult] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const airports = useMemo(() => {
    if (!exportData) return []
    return getAirportsInExport(exportData)
  }, [exportData])

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      setError(null)
      const data = await readImportFile(file)
      setExportData(data)
      // Select all airports by default
      setSelectedAirports(new Set(getAirportsInExport(data)))
      setStep('select')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read file')
    }

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleToggleAirport = (icao: string) => {
    setSelectedAirports(prev => {
      const next = new Set(prev)
      if (next.has(icao)) {
        next.delete(icao)
      } else {
        next.add(icao)
      }
      return next
    })
  }

  const handleSelectAll = () => {
    setSelectedAirports(new Set(airports))
  }

  const handleSelectNone = () => {
    setSelectedAirports(new Set())
  }

  const handleImport = () => {
    if (!exportData) return

    const result = importData(exportData, {
      importGlobalSettings,
      selectedAirports: [...selectedAirports],
      mergeMode
    })

    if (result.success) {
      setImportResult(result.message)
      setStep('complete')
      setTimeout(() => {
        onSuccess()
        onClose()
      }, 2000)
    } else {
      setError(result.message)
    }
  }

  const handleElectronImport = async () => {
    try {
      setError(null)
      await onElectronImport()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import from Electron')
    }
  }

  return (
    <div className="settings-modal-overlay" onClick={onClose}>
      <div className="settings-modal import-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>
            {step === 'source' && 'Import Settings'}
            {step === 'select' && 'Select What to Import'}
            {step === 'complete' && 'Import Complete'}
          </h2>
          <button className="close-button" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="settings-content">
          {step === 'source' && (
            <div className="settings-section">
              <h3>Choose Import Source</h3>
              <p className="setting-hint" style={{ marginBottom: '12px' }}>
                Settings from the Electron version are automatically imported on first launch.
                Use these options to manually re-import or import from a file.
              </p>

              <div className="setting-item">
                <button
                  className="control-button import-source-button"
                  onClick={handleElectronImport}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                    <line x1="8" y1="21" x2="16" y2="21" />
                    <line x1="12" y1="17" x2="12" y2="21" />
                  </svg>
                  Re-import from Electron version
                </button>
                <p className="setting-hint" style={{ marginTop: '8px' }}>
                  Reads settings from the old Electron app data folder.
                </p>
              </div>

              <div className="setting-item" style={{ marginTop: '16px' }}>
                <button
                  className="control-button import-source-button"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="12" y1="18" x2="12" y2="12" />
                    <line x1="9" y1="15" x2="15" y2="15" />
                  </svg>
                  Import from exported file
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  onChange={handleFileSelect}
                  style={{ display: 'none' }}
                />
                <p className="setting-hint" style={{ marginTop: '8px' }}>
                  Select a previously exported towercab-export.json file.
                </p>
              </div>

              {error && (
                <div className="import-error">
                  {error}
                </div>
              )}
            </div>
          )}

          {step === 'select' && exportData && (
            <>
              <div className="settings-section">
                <h3>Global Settings</h3>
                <div className="setting-item">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={importGlobalSettings}
                      onChange={(e) => setImportGlobalSettings(e.target.checked)}
                    />
                    Import global settings (Cesium token, camera speed, graphics, etc.)
                  </label>
                </div>
              </div>

              <div className="settings-section">
                <h3>Per-Airport Data</h3>
                <div className="airport-selection-header">
                  <span>{selectedAirports.size} of {airports.length} airports selected</span>
                  <div className="selection-buttons">
                    <button onClick={handleSelectAll}>Select All</button>
                    <button onClick={handleSelectNone}>Select None</button>
                  </div>
                </div>

                <div className="airport-list">
                  {airports.map(icao => {
                    const summary = getAirportExportSummary(exportData, icao)
                    return (
                      <label key={icao} className="airport-item">
                        <input
                          type="checkbox"
                          checked={selectedAirports.has(icao)}
                          onChange={() => handleToggleAirport(icao)}
                        />
                        <span className="airport-icao">{icao}</span>
                        <span className="airport-details">
                          {summary.bookmarkCount > 0 && (
                            <span className="detail-badge">{summary.bookmarkCount} bookmarks</span>
                          )}
                          {summary.hasDefaultView && (
                            <span className="detail-badge">default view</span>
                          )}
                          {summary.viewportCount > 1 && (
                            <span className="detail-badge">{summary.viewportCount} viewports</span>
                          )}
                        </span>
                      </label>
                    )
                  })}
                </div>
              </div>

              <div className="settings-section">
                <h3>Import Mode</h3>
                <div className="setting-item">
                  <div className="radio-group-vertical">
                    <label>
                      <input
                        type="radio"
                        name="mergeMode"
                        value="merge"
                        checked={mergeMode === 'merge'}
                        onChange={() => setMergeMode('merge')}
                      />
                      Merge (keep existing bookmarks, add new ones)
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="mergeMode"
                        value="replace"
                        checked={mergeMode === 'replace'}
                        onChange={() => setMergeMode('replace')}
                      />
                      Replace (overwrite existing airport data)
                    </label>
                  </div>
                </div>
              </div>

              <div className="import-actions">
                <button className="control-button" onClick={() => setStep('source')}>
                  Back
                </button>
                <button
                  className="control-button primary"
                  onClick={handleImport}
                  disabled={!importGlobalSettings && selectedAirports.size === 0}
                >
                  Import {selectedAirports.size > 0 ? `${selectedAirports.size} Airport(s)` : 'Settings'}
                </button>
              </div>

              {error && (
                <div className="import-error">
                  {error}
                </div>
              )}
            </>
          )}

          {step === 'complete' && (
            <div className="import-success">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#4caf50" strokeWidth="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              <p>{importResult}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default ImportModal
