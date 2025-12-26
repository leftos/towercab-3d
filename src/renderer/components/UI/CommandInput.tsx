import { useState, useEffect, useCallback } from 'react'
import { useViewportStore } from '../../stores/viewportStore'
import { useUIFeedbackStore } from '../../stores/uiFeedbackStore'
import { useDatablockPositionStore } from '../../stores/datablockPositionStore'
import './CommandInput.css'

/** Map numpad position to direction label (5 = reset to default) */
const POSITION_LABELS: Record<number, string> = {
  7: 'Top-Left',
  8: 'Top',
  9: 'Top-Right',
  4: 'Left',
  5: 'Default',
  6: 'Right',
  1: 'Bottom-Left',
  2: 'Bottom',
  3: 'Bottom-Right'
}

/**
 * CommandInput component - provides a terminal-style command input overlay
 *
 * Commands:
 * - `.XX.` - Save camera bookmark to slot XX (00-99)
 * - `.XX.NAME.` - Save named camera bookmark to slot XX (00-99)
 * - `.XX` - Load camera bookmark from slot XX (00-99)
 *
 * Also displays the datablock position indicator when numpad keys 1-9 are pressed
 */
function CommandInput() {
  const [isActive, setIsActive] = useState(false)
  const [inputBuffer, setInputBuffer] = useState('')

  const saveBookmark = useViewportStore((state) => state.saveBookmark)
  const loadBookmark = useViewportStore((state) => state.loadBookmark)
  const currentAirportIcao = useViewportStore((state) => state.currentAirportIcao)

  const feedback = useUIFeedbackStore((state) => state.feedback)
  const showFeedback = useUIFeedbackStore((state) => state.showFeedback)
  const setCommandInputActive = useUIFeedbackStore((state) => state.setCommandInputActive)

  // Datablock position mode
  const pendingDirection = useDatablockPositionStore((state) => state.pendingDirection)

  // Sync isActive state with the global store so other components can check it
  useEffect(() => {
    setCommandInputActive(isActive)
  }, [isActive, setCommandInputActive])

  // Process the command when Enter is pressed
  const processCommand = useCallback((command: string) => {
    // Match save bookmark pattern with optional name: .XX. or .XX.NAME.
    // Pattern: .{1-2 digits}.{optional name ending with period}
    if (command.endsWith('.')) {
      const saveMatch = command.match(/^\.(\d{1,2})\.(.*)$/)
      if (saveMatch) {
        const slot = parseInt(saveMatch[1], 10)
        const namePart = saveMatch[2]

        // Name is everything before the final period (which we know exists)
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

    // Match load bookmark pattern: .XX (e.g., .00, .42, .99) - no trailing dot
    const loadMatch = command.match(/^\.(\d{1,2})$/)
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

    // Unknown command
    if (command.length > 0) {
      showFeedback(`Unknown command: ${command}`, 'error')
    }
  }, [saveBookmark, loadBookmark, currentAirportIcao, showFeedback])

  // Handle keyboard input
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Ignore if typing in an input field
      if (event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement ||
          event.target instanceof HTMLSelectElement) {
        return
      }

      // Check if the key is a command-triggering character
      const key = event.key

      // Activate on period (start of command)
      if (key === '.' && !isActive) {
        setIsActive(true)
        setInputBuffer('.')
        event.preventDefault()
        return
      }

      // If active, handle input
      if (isActive) {
        if (key === 'Escape') {
          // Cancel input
          setIsActive(false)
          setInputBuffer('')
          event.preventDefault()
          return
        }

        if (key === 'Enter') {
          // Process command
          processCommand(inputBuffer)
          setIsActive(false)
          setInputBuffer('')
          event.preventDefault()
          return
        }

        if (key === 'Backspace') {
          // Delete last character
          if (inputBuffer.length > 1) {
            setInputBuffer(prev => prev.slice(0, -1))
          } else {
            // If only the initial character, cancel
            setIsActive(false)
            setInputBuffer('')
          }
          event.preventDefault()
          return
        }

        // Check if we're in "name typing" mode (after .XX.)
        const isTypingName = /^\.(\d{1,2})\./.test(inputBuffer)

        if (isTypingName) {
          // In name typing mode, allow most printable characters
          // Only disallow control keys (handled above) and limit length
          if (key.length === 1 && inputBuffer.length < 50) {
            setInputBuffer(prev => prev + key)
            event.preventDefault()
            return
          }
        } else {
          // Not in name mode: only allow digits and period for slot selection
          if (/^[\d.]$/.test(key)) {
            // Limit buffer length to prevent abuse
            if (inputBuffer.length < 10) {
              setInputBuffer(prev => prev + key)
            }
            event.preventDefault()
            return
          }
        }

        // Any other key cancels (unless we're typing a name)
        if (!isTypingName) {
          setIsActive(false)
          setInputBuffer('')
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isActive, inputBuffer, processCommand])

  // Don't render if not active, no feedback, and no pending direction
  if (!isActive && !feedback && !pendingDirection) {
    return null
  }

  return (
    <div className="command-input-container">
      {isActive && (
        <div className="command-input-bar">
          <span className="command-prompt">&gt;</span>
          <span className="command-text">{inputBuffer}</span>
          <span className="command-cursor">_</span>
        </div>
      )}
      {pendingDirection && (
        <div className="command-input-bar datablock-mode">
          <span className="command-prompt">Datablock</span>
          <span className="command-text datablock-position">
            {pendingDirection} ({POSITION_LABELS[pendingDirection]})
          </span>
          <span className="datablock-hint">
            Enter=All | Click=Aircraft | Esc=Cancel
          </span>
        </div>
      )}
      {feedback && (
        <div className={`command-feedback ${feedback.type}`}>
          {feedback.message}
        </div>
      )}
    </div>
  )
}

export default CommandInput
