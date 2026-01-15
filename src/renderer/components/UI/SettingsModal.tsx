import { useState, useEffect, useRef, useCallback } from 'react'
import { useUIFeedbackStore } from '../../stores/uiFeedbackStore'
import { useSettingsStore } from '../../stores/settingsStore'
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

  // Drag state
  const storedPosition = useSettingsStore((state) => state.ui.settingsModalPosition)
  const updateUISettings = useSettingsStore((state) => state.updateUISettings)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; posX: number; posY: number } | null>(null)
  const modalRef = useRef<HTMLDivElement>(null)

  // Constrain position to keep modal within window bounds
  const constrainPosition = useCallback((pos: { x: number; y: number }) => {
    if (!modalRef.current) return pos

    const modal = modalRef.current
    const rect = modal.getBoundingClientRect()
    const modalWidth = rect.width
    const modalHeight = rect.height
    const windowWidth = window.innerWidth
    const windowHeight = window.innerHeight

    // The modal is centered by CSS, so position (0,0) means centered
    // Calculate the centered position
    const centeredLeft = (windowWidth - modalWidth) / 2
    const centeredTop = (windowHeight - modalHeight) / 2

    // Calculate actual position with offset
    const actualLeft = centeredLeft + pos.x
    const actualTop = centeredTop + pos.y

    // Calculate bounds (with small margin)
    const margin = 10
    const minLeft = margin
    const maxLeft = windowWidth - modalWidth - margin
    const minTop = margin
    const maxTop = windowHeight - modalHeight - margin

    // Constrain actual position
    const constrainedLeft = Math.max(minLeft, Math.min(maxLeft, actualLeft))
    const constrainedTop = Math.max(minTop, Math.min(maxTop, actualTop))

    // Convert back to offset from center
    return {
      x: constrainedLeft - centeredLeft,
      y: constrainedTop - centeredTop
    }
  }, [])

  // Sync position from store when modal opens (with constraint check)
  useEffect(() => {
    if (isOpen) {
      const initialPosition = storedPosition ?? { x: 0, y: 0 }
      // Use requestAnimationFrame to ensure modal is rendered and sized
      requestAnimationFrame(() => {
        setPosition(constrainPosition(initialPosition))
      })
    }
  }, [isOpen, storedPosition, constrainPosition])

  // Handle mouse move during drag
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging || !dragStartRef.current) return

    const deltaX = e.clientX - dragStartRef.current.mouseX
    const deltaY = e.clientY - dragStartRef.current.mouseY

    const newPos = {
      x: dragStartRef.current.posX + deltaX,
      y: dragStartRef.current.posY + deltaY
    }

    setPosition(constrainPosition(newPos))
  }, [isDragging, constrainPosition])

  // Handle mouse up to end drag
  const handleMouseUp = useCallback(() => {
    if (isDragging) {
      setIsDragging(false)
      dragStartRef.current = null
      // Persist the position
      updateUISettings({ settingsModalPosition: position })
    }
  }, [isDragging, position, updateUISettings])

  // Add/remove global mouse listeners for dragging
  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
      return () => {
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [isDragging, handleMouseMove, handleMouseUp])

  // Re-constrain position when modal size changes (e.g., section expanded)
  useEffect(() => {
    if (!isOpen || !modalRef.current) return

    const observer = new ResizeObserver(() => {
      setPosition(prev => constrainPosition(prev))
    })

    observer.observe(modalRef.current)
    return () => observer.disconnect()
  }, [isOpen, constrainPosition])

  // Re-constrain position when window is resized
  useEffect(() => {
    if (!isOpen) return

    const handleResize = () => {
      setPosition(prev => constrainPosition(prev))
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [isOpen, constrainPosition])

  // Start dragging on header mouse down
  const handleHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    // Only drag on left click and not on the close button
    if (e.button !== 0 || (e.target as HTMLElement).closest('.close-button')) return

    e.preventDefault()
    setIsDragging(true)
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      posX: position.x,
      posY: position.y
    }
  }, [position])

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
      <div
        ref={modalRef}
        className="settings-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          transform: `translate(${position.x}px, ${position.y}px)`,
          cursor: isDragging ? 'grabbing' : undefined
        }}
      >
        <div
          className="settings-header"
          onMouseDown={handleHeaderMouseDown}
          style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
        >
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
