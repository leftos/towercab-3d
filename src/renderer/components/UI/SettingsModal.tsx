import { useState, useEffect } from 'react'
import { useUIFeedbackStore } from '../../stores/uiFeedbackStore'
import SettingsGeneralTab from './SettingsGeneralTab'
import SettingsDisplayTab from './SettingsDisplayTab'
import SettingsGraphicsTab from './SettingsGraphicsTab'
import SettingsPerformanceTab from './SettingsPerformanceTab'
import SettingsServerTab from './SettingsServerTab'
import SettingsHelpTab from './SettingsHelpTab'
import './ControlsBar.css'

type SettingsTab = 'general' | 'display' | 'graphics' | 'performance' | 'server' | 'help'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
  onShowImportModal: () => void
  onShowExportModal: () => void
  importStatus: 'idle' | 'success' | 'error'
}

function SettingsModal({ isOpen, onClose, onShowImportModal, onShowExportModal, importStatus }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const pushModal = useUIFeedbackStore((state) => state.pushModal)
  const popModal = useUIFeedbackStore((state) => state.popModal)

  // Close settings modal on Escape key
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  // Register modal with UI feedback store for keyboard blocking
  useEffect(() => {
    if (isOpen) {
      pushModal()
      return () => popModal()
    }
  }, [isOpen, pushModal, popModal])

  if (!isOpen) return null

  return (
    <div className={`settings-modal-overlay ${activeTab === 'graphics' ? 'no-blur' : ''}`}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="close-button" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="settings-tabs">
          <button
            className={`tab-button ${activeTab === 'general' ? 'active' : ''}`}
            onClick={() => setActiveTab('general')}
          >
            General
          </button>
          <button
            className={`tab-button ${activeTab === 'display' ? 'active' : ''}`}
            onClick={() => setActiveTab('display')}
          >
            Display
          </button>
          <button
            className={`tab-button ${activeTab === 'graphics' ? 'active' : ''}`}
            onClick={() => setActiveTab('graphics')}
          >
            Graphics
          </button>
          <button
            className={`tab-button ${activeTab === 'performance' ? 'active' : ''}`}
            onClick={() => setActiveTab('performance')}
          >
            Performance
          </button>
          <button
            className={`tab-button ${activeTab === 'server' ? 'active' : ''}`}
            onClick={() => setActiveTab('server')}
          >
            Server
          </button>
          <button
            className={`tab-button ${activeTab === 'help' ? 'active' : ''}`}
            onClick={() => setActiveTab('help')}
          >
            Help
          </button>
        </div>

        <div className="settings-content">
          {activeTab === 'general' && (
            <SettingsGeneralTab
              onShowImportModal={onShowImportModal}
              onShowExportModal={onShowExportModal}
              importStatus={importStatus}
            />
          )}
          {activeTab === 'display' && <SettingsDisplayTab />}
          {activeTab === 'graphics' && <SettingsGraphicsTab />}
          {activeTab === 'performance' && <SettingsPerformanceTab />}
          {activeTab === 'server' && <SettingsServerTab />}
          {activeTab === 'help' && <SettingsHelpTab />}
        </div>
      </div>
    </div>
  )
}

export default SettingsModal
