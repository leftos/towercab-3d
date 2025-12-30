/**
 * Touch Controls Component
 *
 * Provides virtual controls for touch devices:
 * - Virtual joystick for WASD movement
 * - Command input button for bookmark recall (via MobileToolsFlyout)
 * - Debug overlay buttons (Performance HUD, Model Matching) (via MobileToolsFlyout)
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import { useViewportStore } from '../../stores/viewportStore'
import { useUIFeedbackStore } from '../../stores/uiFeedbackStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { isTouchDevice } from '../../utils/deviceDetection'
import './TouchControls.css'

interface JoystickState {
  active: boolean
  deltaX: number
  deltaY: number
  startX: number
  startY: number
}

/**
 * Virtual command input modal for touch devices
 */
function TouchCommandInput({
  isOpen,
  onClose
}: {
  isOpen: boolean
  onClose: () => void
}) {
  const [inputValue, setInputValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const saveBookmark = useViewportStore((state) => state.saveBookmark)
  const loadBookmark = useViewportStore((state) => state.loadBookmark)
  const currentAirportIcao = useViewportStore((state) => state.currentAirportIcao)
  const showFeedback = useUIFeedbackStore((state) => state.showFeedback)

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      // Small delay to ensure modal is rendered
      setTimeout(() => {
        inputRef.current?.focus()
      }, 100)
    }
  }, [isOpen])

  const processCommand = useCallback((command: string) => {
    // Ensure command starts with a period
    const normalizedCommand = command.startsWith('.') ? command : '.' + command

    // Match save bookmark pattern: .XX. or .XX.NAME.
    if (normalizedCommand.endsWith('.')) {
      const saveMatch = normalizedCommand.match(/^\.(\d{1,2})\.(.*)$/)
      if (saveMatch) {
        const slot = parseInt(saveMatch[1], 10)
        const namePart = saveMatch[2]
        const name = namePart.slice(0, -1).trim() || undefined

        if (slot >= 0 && slot <= 99) {
          if (!currentAirportIcao) {
            showFeedback('No airport selected', 'error')
            return
          }
          saveBookmark(slot, name)
          const slotStr = slot.toString().padStart(2, '0')
          const displayName = name ? ` "${name}"` : ''
          showFeedback(`Saved bookmark .${slotStr}${displayName}`, 'success')
          return
        }
      }
    }

    // Match load bookmark pattern: .XX
    const loadMatch = normalizedCommand.match(/^\.(\d{1,2})$/)
    if (loadMatch) {
      const slot = parseInt(loadMatch[1], 10)
      if (slot >= 0 && slot <= 99) {
        if (!currentAirportIcao) {
          showFeedback('No airport selected', 'error')
          return
        }
        const success = loadBookmark(slot)
        if (success) {
          showFeedback(`Loaded bookmark .${slot.toString().padStart(2, '0')}`, 'success')
        } else {
          showFeedback(`No bookmark at .${slot.toString().padStart(2, '0')}`, 'error')
        }
        return
      }
    }

    if (command.length > 0) {
      showFeedback(`Unknown command: ${normalizedCommand}`, 'error')
    }
  }, [saveBookmark, loadBookmark, currentAirportIcao, showFeedback])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (inputValue.trim()) {
      processCommand(inputValue.trim())
    }
    setInputValue('')
    onClose()
  }

  const handleQuickBookmark = (slot: number) => {
    if (!currentAirportIcao) {
      showFeedback('No airport selected', 'error')
      return
    }
    const success = loadBookmark(slot)
    if (success) {
      showFeedback(`Loaded bookmark .${slot.toString().padStart(2, '0')}`, 'success')
    } else {
      showFeedback(`No bookmark at .${slot.toString().padStart(2, '0')}`, 'error')
    }
    onClose()
  }

  if (!isOpen) return null

  return (
    <div className="touch-command-overlay" onClick={onClose}>
      <div className="touch-command-modal" onClick={(e) => e.stopPropagation()}>
        <div className="touch-command-header">
          <span>Command Input</span>
          <button className="touch-command-close" onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit} className="touch-command-form">
          <div className="touch-command-input-wrapper">
            <span className="touch-command-prefix">.</span>
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="01 to load, 01. to save"
              className="touch-command-input"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
            />
          </div>
          <button type="submit" className="touch-command-submit">
            Go
          </button>
        </form>

        <div className="touch-command-quickslots">
          <div className="touch-command-quickslots-label">Quick Load:</div>
          <div className="touch-command-quickslots-grid">
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((slot) => (
              <button
                key={slot}
                className="touch-command-quickslot"
                onClick={() => handleQuickBookmark(slot)}
              >
                .{slot.toString().padStart(2, '0')}
              </button>
            ))}
          </div>
        </div>

        <div className="touch-command-help">
          <p><strong>.XX</strong> - Load bookmark (e.g., .01)</p>
          <p><strong>.XX.</strong> - Save bookmark (e.g., .01.)</p>
          <p><strong>.XX.Name.</strong> - Save named bookmark</p>
        </div>
      </div>
    </div>
  )
}

/**
 * Virtual joystick component for WASD movement
 */
function VirtualJoystick({
  onMove
}: {
  onMove: (deltaX: number, deltaY: number) => void
}) {
  const joystickRef = useRef<HTMLDivElement>(null)
  const knobRef = useRef<HTMLDivElement>(null)
  const stateRef = useRef<JoystickState>({
    active: false,
    deltaX: 0,
    deltaY: 0,
    startX: 0,
    startY: 0
  })
  const animationRef = useRef<number | null>(null)

  const JOYSTICK_RADIUS = 50 // Max distance knob can move from center
  const DEAD_ZONE = 0.15 // 15% dead zone

  // Animation loop to continuously apply movement
  useEffect(() => {
    const animate = () => {
      const state = stateRef.current
      if (state.active && (Math.abs(state.deltaX) > DEAD_ZONE || Math.abs(state.deltaY) > DEAD_ZONE)) {
        onMove(state.deltaX, state.deltaY)
      }
      animationRef.current = requestAnimationFrame(animate)
    }

    animationRef.current = requestAnimationFrame(animate)

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [onMove])

  const handleTouchStart = (e: React.TouchEvent) => {
    e.preventDefault()
    const touch = e.touches[0]
    const rect = joystickRef.current?.getBoundingClientRect()
    if (!rect) return

    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2

    stateRef.current = {
      active: true,
      deltaX: 0,
      deltaY: 0,
      startX: centerX,
      startY: centerY
    }

    updateKnobPosition(touch.clientX - centerX, touch.clientY - centerY)
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    e.preventDefault()
    if (!stateRef.current.active) return

    const touch = e.touches[0]
    const state = stateRef.current

    const dx = touch.clientX - state.startX
    const dy = touch.clientY - state.startY

    updateKnobPosition(dx, dy)
  }

  const handleTouchEnd = (e: React.TouchEvent) => {
    e.preventDefault()
    stateRef.current.active = false
    stateRef.current.deltaX = 0
    stateRef.current.deltaY = 0

    // Reset knob to center
    if (knobRef.current) {
      knobRef.current.style.transform = 'translate(-50%, -50%)'
    }
  }

  const updateKnobPosition = (dx: number, dy: number) => {
    // Calculate distance from center
    const distance = Math.sqrt(dx * dx + dy * dy)

    // Clamp to max radius
    let clampedX = dx
    let clampedY = dy
    if (distance > JOYSTICK_RADIUS) {
      const scale = JOYSTICK_RADIUS / distance
      clampedX = dx * scale
      clampedY = dy * scale
    }

    // Normalize to -1 to 1 range
    stateRef.current.deltaX = clampedX / JOYSTICK_RADIUS
    stateRef.current.deltaY = clampedY / JOYSTICK_RADIUS

    // Apply dead zone
    if (Math.abs(stateRef.current.deltaX) < DEAD_ZONE) stateRef.current.deltaX = 0
    if (Math.abs(stateRef.current.deltaY) < DEAD_ZONE) stateRef.current.deltaY = 0

    // Update visual position
    if (knobRef.current) {
      knobRef.current.style.transform = `translate(calc(-50% + ${clampedX}px), calc(-50% + ${clampedY}px))`
    }
  }

  return (
    <div
      ref={joystickRef}
      className="virtual-joystick"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      <div className="joystick-base">
        <div ref={knobRef} className="joystick-knob" />
      </div>
      <div className="joystick-labels">
        <span className="joystick-label-up">W</span>
        <span className="joystick-label-down">S</span>
        <span className="joystick-label-left">A</span>
        <span className="joystick-label-right">D</span>
      </div>
    </div>
  )
}

/**
 * Zoom buttons component for touch devices
 * Adjusts zoom based on current camera mode (tower follow, orbit, or free)
 */
function ZoomButtons() {
  const followingCallsign = useViewportStore((state) => state.getActiveCameraState().followingCallsign)
  const followMode = useViewportStore((state) => state.getActiveCameraState().followMode)
  const adjustFollowZoom = useViewportStore((state) => state.adjustFollowZoom)
  const adjustOrbitDistance = useViewportStore((state) => state.adjustOrbitDistance)
  const adjustFov = useViewportStore((state) => state.adjustFov)

  // Determine which zoom function to use based on camera mode
  const handleZoom = useCallback((direction: 'in' | 'out') => {
    const delta = direction === 'in' ? 0.2 : -0.2

    if (followingCallsign && followMode !== 'orbit') {
      // Tower follow mode: adjust zoom level (higher = more zoomed in)
      adjustFollowZoom(delta)
    } else if (followMode === 'orbit') {
      // Orbit mode: adjust distance (negative = closer, positive = farther)
      // Flip the sign since distance is inverse of zoom
      adjustOrbitDistance(-delta * 50) // Scale for orbit distance units
    } else {
      // Free camera: adjust FOV (negative = zoom in, positive = zoom out)
      adjustFov(-delta * 10) // Scale for FOV degrees
    }
  }, [followingCallsign, followMode, adjustFollowZoom, adjustOrbitDistance, adjustFov])

  return (
    <div className="touch-zoom-buttons">
      <button
        className="touch-zoom-btn zoom-in"
        onTouchStart={(e) => { e.preventDefault(); handleZoom('in') }}
        onClick={() => handleZoom('in')}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      <button
        className="touch-zoom-btn zoom-out"
        onTouchStart={(e) => { e.preventDefault(); handleZoom('out') }}
        onClick={() => handleZoom('out')}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>
  )
}

/**
 * Main touch controls component
 *
 * Only renders the virtual joystick on touch devices.
 * The MobileToolsFlyout is now rendered separately in App.tsx
 * based on window size (works on both touch and small desktop windows).
 */
function TouchControls() {
  const [isJoystickVisible, setIsJoystickVisible] = useState(true)

  // Viewport store actions
  const moveForward = useViewportStore((state) => state.moveForward)
  const moveRight = useViewportStore((state) => state.moveRight)

  // Settings
  const joystickSensitivity = useSettingsStore((state) => state.camera.joystickSensitivity)

  // Handle joystick movement
  const handleJoystickMove = useCallback((deltaX: number, deltaY: number) => {
    // Scale movement speed based on sensitivity setting (1-10 maps to 1-10 speed)
    const speed = joystickSensitivity

    // Note: deltaY is inverted (up on joystick = forward = negative Y in screen coords)
    moveForward(-deltaY * speed)
    moveRight(deltaX * speed)
  }, [moveForward, moveRight, joystickSensitivity])

  // Don't render on non-touch devices (joystick only makes sense with touch)
  if (!isTouchDevice()) {
    return null
  }

  return (
    <>
      {/* Toggle button to show/hide joystick */}
      <button
        className={`touch-controls-toggle ${isJoystickVisible ? 'active' : ''}`}
        onClick={() => setIsJoystickVisible(!isJoystickVisible)}
        title={isJoystickVisible ? 'Hide joystick' : 'Show joystick'}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
        </svg>
      </button>

      {/* Virtual joystick (left side) with zoom buttons */}
      {isJoystickVisible && (
        <div className="touch-controls-container">
          <div className="touch-controls-left">
            <VirtualJoystick onMove={handleJoystickMove} />
            <ZoomButtons />
          </div>
        </div>
      )}
    </>
  )
}

export default TouchControls
export { TouchCommandInput }
