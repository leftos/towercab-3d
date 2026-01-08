import { useState, useEffect } from 'react'
import { useUIFeedbackStore } from '../../stores/uiFeedbackStore'
import SettingsConfigurationTab from './SettingsConfigurationTab'
import SettingsAircraftLabelsTab from './SettingsAircraftLabelsTab'
import SettingsGraphicsWeatherTab from './SettingsGraphicsWeatherTab'
import SettingsControlsCameraTab from './SettingsControlsCameraTab'
import SettingsPerformanceTab from './SettingsPerformanceTab'
import SettingsAdvancedTab from './SettingsAdvancedTab'
import './ControlsBar.css'

type SettingsTab = 'configuration' | 'aircraft' | 'graphics' | 'controls' | 'performance' | 'advanced'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
  onShowImportModal: () => void
  onShowExportModal: () => void
  importStatus: 'idle' | 'success' | 'error'
}

function SettingsModal({ isOpen, onClose, onShowImportModal, onShowExportModal, importStatus }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('configuration')
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
            className={`tab-button ${activeTab === 'configuration' ? 'active' : ''}`}
            onClick={() => setActiveTab('configuration')}
          >
            Configuration
          </button>
          <button
            className={`tab-button ${activeTab === 'aircraft' ? 'active' : ''}`}
            onClick={() => setActiveTab('aircraft')}
          >
            Aircraft & Labels
          </button>
          <button
            className={`tab-button ${activeTab === 'graphics' ? 'active' : ''}`}
            onClick={() => setActiveTab('graphics')}
          >
            Graphics & Weather
          </button>
          <button
            className={`tab-button ${activeTab === 'controls' ? 'active' : ''}`}
            onClick={() => setActiveTab('controls')}
          >
            Controls & Camera
          </button>
          <button
            className={`tab-button ${activeTab === 'performance' ? 'active' : ''}`}
            onClick={() => setActiveTab('performance')}
          >
            Performance
          </button>
          <button
            className={`tab-button ${activeTab === 'advanced' ? 'active' : ''}`}
            onClick={() => setActiveTab('advanced')}
          >
            Advanced
          </button>
        </div>

        <div className="settings-content">
          {activeTab === 'configuration' && (
            <SettingsConfigurationTab
              onShowImportModal={onShowImportModal}
              onShowExportModal={onShowExportModal}
              importStatus={importStatus}
            />
          )}
          {activeTab === 'aircraft' && <SettingsAircraftLabelsTab />}
          {activeTab === 'graphics' && <SettingsGraphicsWeatherTab />}
          {activeTab === 'controls' && <SettingsControlsCameraTab />}
          {activeTab === 'performance' && <SettingsPerformanceTab />}
          {activeTab === 'advanced' && <SettingsAdvancedTab />}
        </div>
      </div>
    </div>
  )
}

export default SettingsModal
