/**
 * Export Wizard Modal
 *
 * A VS-style wizard for selectively exporting settings with a tree view.
 * Step 1: Select what to export using a hierarchical tree view
 * Step 2: Review summary and download the export file
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import SettingsTreeView from './SettingsTreeView'
import { buildExportTree, getAllLeafIds } from '../../services/SettingsTreeBuilder'
import { exportSelectiveData, downloadExport } from '../../services/ExportImportService'
import './ExportWizardModal.css'

interface ExportWizardModalProps {
  onClose: () => void
}

type WizardStep = 'select' | 'summary'

function ExportWizardModal({ onClose }: ExportWizardModalProps) {
  const [step, setStep] = useState<WizardStep>('select')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [isExporting, setIsExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  // Build the tree on mount
  const treeNodes = useMemo(() => buildExportTree(), [])

  // Get all leaf IDs for default selection
  const allLeafIds = useMemo(() => getAllLeafIds(treeNodes), [treeNodes])

  // Initialize with all items selected on mount
  useEffect(() => {
    setSelectedIds(new Set(allLeafIds))
  }, [allLeafIds])

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Calculate summary statistics
  const summary = useMemo(() => {
    const localCategories = new Set<string>()
    const globalItems = new Set<string>()
    const airports = new Set<string>()
    let bookmarkCount = 0
    let viewportCount = 0

    for (const id of selectedIds) {
      if (id.startsWith('local.')) {
        const parts = id.split('.')
        if (parts.length >= 2) {
          localCategories.add(parts[1])
        }
      } else if (id.startsWith('global.')) {
        const parts = id.split('.')
        if (parts.length >= 2) {
          globalItems.add(parts[1])
        }
      } else if (id.startsWith('airports.')) {
        const parts = id.split('.')
        if (parts.length >= 2) {
          airports.add(parts[1])
        }
        if (id.includes('.bookmarks')) {
          bookmarkCount++
        }
        if (id.includes('.viewports')) {
          viewportCount++
        }
      }
    }

    return {
      localCategoryCount: localCategories.size,
      globalItemCount: globalItems.size,
      airportCount: airports.size,
      bookmarkCount,
      viewportCount,
      totalSelections: selectedIds.size
    }
  }, [selectedIds])

  const handleExport = useCallback(async () => {
    setIsExporting(true)
    setExportError(null)
    try {
      const data = exportSelectiveData(selectedIds)
      downloadExport(data)
      // Brief delay to show success state
      await new Promise(resolve => setTimeout(resolve, 500))
      onClose()
    } catch (error) {
      console.error('Export failed:', error)
      setExportError(error instanceof Error ? error.message : 'Export failed. Please try again.')
    } finally {
      setIsExporting(false)
    }
  }, [selectedIds, onClose])

  return (
    <div className="settings-modal-overlay" onClick={onClose}>
      <div
        className="settings-modal export-wizard-modal"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="settings-header">
          <h2>Export Settings</h2>
          <button className="close-button" onClick={onClose}>
            &times;
          </button>
        </div>

        {/* Step Indicator */}
        <div className="wizard-steps">
          <div className={`wizard-step ${step === 'select' ? 'active' : ''} ${step === 'summary' ? 'completed' : ''}`}>
            <span className="wizard-step-number">1</span>
            <span className="wizard-step-label">Select</span>
          </div>
          <div className="wizard-step-connector" />
          <div className={`wizard-step ${step === 'summary' ? 'active' : ''}`}>
            <span className="wizard-step-number">2</span>
            <span className="wizard-step-label">Export</span>
          </div>
        </div>

        {/* Content */}
        <div className="settings-content">
          {step === 'select' && (
            <div className="export-select-step">
              <p className="step-description">
                Choose which settings and airport data to include in the export file.
              </p>
              <SettingsTreeView
                nodes={treeNodes}
                selectedIds={selectedIds}
                onSelectionChange={setSelectedIds}
                mode="export"
                maxHeight="350px"
              />
            </div>
          )}

          {step === 'summary' && (
            <div className="export-summary-step">
              <div className="export-summary">
                <h3>Export Summary</h3>
                <div className="summary-grid">
                  {summary.localCategoryCount > 0 && (
                    <div className="summary-item">
                      <span className="summary-icon">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M12 2L2 7l10 5 10-5-10-5z" />
                          <path d="M2 17l10 5 10-5" />
                          <path d="M2 12l10 5 10-5" />
                        </svg>
                      </span>
                      <span className="summary-label">Local Settings</span>
                      <span className="summary-value">{summary.localCategoryCount} categories</span>
                    </div>
                  )}
                  {summary.globalItemCount > 0 && (
                    <div className="summary-item">
                      <span className="summary-icon">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="12" cy="12" r="10" />
                          <line x1="2" y1="12" x2="22" y2="12" />
                          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                        </svg>
                      </span>
                      <span className="summary-label">Global Settings</span>
                      <span className="summary-value">{summary.globalItemCount} items</span>
                    </div>
                  )}
                  {summary.airportCount > 0 && (
                    <div className="summary-item">
                      <span className="summary-icon">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 16v-2a4 4 0 00-4-4H7a4 4 0 00-4 4v2" />
                          <path d="M12 3v7" />
                          <path d="M7 10l5 3 5-3" />
                        </svg>
                      </span>
                      <span className="summary-label">Airports</span>
                      <span className="summary-value">{summary.airportCount} airports</span>
                    </div>
                  )}
                  {summary.viewportCount > 0 && (
                    <div className="summary-item">
                      <span className="summary-icon">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                          <line x1="8" y1="21" x2="16" y2="21" />
                          <line x1="12" y1="17" x2="12" y2="21" />
                        </svg>
                      </span>
                      <span className="summary-label">Viewport Layouts</span>
                      <span className="summary-value">{summary.viewportCount}</span>
                    </div>
                  )}
                </div>
              </div>

              <p className="export-info">
                The export file will be saved as <code>towercab-export-{new Date().toISOString().slice(0, 10)}.json</code>
              </p>

              {exportError && (
                <div className="export-error">
                  {exportError}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="wizard-actions">
          {step === 'select' && (
            <>
              <button className="control-button" onClick={onClose}>
                Cancel
              </button>
              <button
                className="control-button primary"
                onClick={() => setStep('summary')}
                disabled={selectedIds.size === 0}
              >
                Next
              </button>
            </>
          )}

          {step === 'summary' && (
            <>
              <button className="control-button" onClick={() => setStep('select')}>
                Back
              </button>
              <button
                className="control-button primary"
                onClick={handleExport}
                disabled={isExporting}
              >
                {isExporting ? (
                  <>
                    <svg className="spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" opacity="0.25" />
                      <path d="M12 2a10 10 0 0 1 10 10" />
                    </svg>
                    Exporting...
                  </>
                ) : (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    Download Export
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default ExportWizardModal
