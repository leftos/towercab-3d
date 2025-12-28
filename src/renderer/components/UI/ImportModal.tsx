import { useState, useRef, useMemo, useEffect } from 'react'
import {
  ExportData,
  readImportFile,
  importData,
  isSelectiveExportData
} from '../../services/ExportImportService'
import type { SelectiveExportData } from '@/types/exportImport'
import { buildImportTree, getAllLeafIds } from '../../services/SettingsTreeBuilder'
import SettingsTreeView from './SettingsTreeView'
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
  const [exportData, setExportData] = useState<ExportData | SelectiveExportData | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [mergeMode, setMergeMode] = useState<'replace' | 'merge'>('merge')
  const [importResult, setImportResult] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Build tree from import data
  const treeNodes = useMemo(() => {
    if (!exportData) return []

    // Handle v3 (SelectiveExportData) format
    if (isSelectiveExportData(exportData)) {
      return buildImportTree({
        localSettings: exportData.localSettings as Record<string, unknown>,
        globalSettings: exportData.globalSettings as Record<string, unknown>,
        airports: exportData.airports as Record<string, unknown>
      })
    }

    // Handle v2 (ExportData) format - globalSettings contains all local settings
    // Convert v2 airports format to the expected structure
    const airportsForTree: Record<string, unknown> = {}
    for (const [icao, data] of Object.entries(exportData.airports)) {
      // v2 wraps airport config in viewports property
      if (data.viewports) {
        airportsForTree[icao] = data.viewports
      } else if (data.camera) {
        // v1 legacy format - convert camera to viewport format
        airportsForTree[icao] = {
          bookmarks: data.camera.bookmarks,
          default3d: data.camera.default3d,
          default2d: data.camera.defaultTopdown
        }
      }
    }

    return buildImportTree({
      localSettings: exportData.globalSettings as Record<string, unknown>,
      globalSettings: undefined, // v2 doesn't have separate global settings
      airports: airportsForTree
    })
  }, [exportData])

  // Get all leaf IDs for default selection
  const allLeafIds = useMemo(() => getAllLeafIds(treeNodes), [treeNodes])

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      setError(null)
      const data = await readImportFile(file)
      setExportData(data)
      // Selection will be set after tree is built (via useEffect)
      setStep('select')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read file')
    }

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  // Select all items by default when tree changes
  useEffect(() => {
    if (allLeafIds.length > 0 && step === 'select') {
      setSelectedIds(new Set(allLeafIds))
    }
  }, [allLeafIds, step])

  const handleImport = () => {
    if (!exportData) return

    // Extract selected airports and global settings flag from selectedIds
    const selectedAirports: string[] = []
    let importGlobalSettings = false

    for (const id of selectedIds) {
      if (id.startsWith('global.') || id.startsWith('local.')) {
        importGlobalSettings = true
      } else if (id.startsWith('airports.')) {
        const parts = id.split('.')
        if (parts.length >= 2) {
          const icao = parts[1]
          if (!selectedAirports.includes(icao)) {
            selectedAirports.push(icao)
          }
        }
      }
    }

    const result = importData(exportData, {
      importGlobalSettings,
      selectedAirports,
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

  // Close modal on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

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
              <div className="import-tree-section">
                <p className="step-description">
                  Select which settings and airport data to import from the file.
                </p>
                <SettingsTreeView
                  nodes={treeNodes}
                  selectedIds={selectedIds}
                  onSelectionChange={setSelectedIds}
                  mode="import"
                  maxHeight="280px"
                />
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
                  disabled={selectedIds.size === 0}
                >
                  Import Selected
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
