import { useState, useEffect, useCallback, useRef } from 'react'
import { useViewportStore } from '../../stores/viewportStore'
import './CommandInput.css'

/**
 * CommandInput component - provides a terminal-style command input overlay
 *
 * Commands:
 * - `.XX.` - Save camera bookmark to slot XX (00-99)
 * - `.XX` - Load camera bookmark from slot XX (00-99)
 */
function CommandInput() {
  const [isActive, setIsActive] = useState(false)
  const [inputBuffer, setInputBuffer] = useState('')
  const [feedback, setFeedback] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const feedbackTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const saveBookmark = useViewportStore((state) => state.saveBookmark)
  const loadBookmark = useViewportStore((state) => state.loadBookmark)
  const currentAirportIcao = useViewportStore((state) => state.currentAirportIcao)

  // Show feedback message briefly
  const showFeedback = useCallback((message: string, type: 'success' | 'error') => {
    if (feedbackTimeoutRef.current) {
      clearTimeout(feedbackTimeoutRef.current)
    }
    setFeedback({ message, type })
    feedbackTimeoutRef.current = setTimeout(() => {
      setFeedback(null)
    }, 2000)
  }, [])

  // Process the command when Enter is pressed
  const processCommand = useCallback((command: string) => {
    // Match save bookmark pattern: .XX. (e.g., .00., .42., .99.)
    const saveMatch = command.match(/^\.(\d{1,2})\.?$/)
    if (saveMatch && command.endsWith('.')) {
      const slot = parseInt(saveMatch[1], 10)
      if (slot >= 0 && slot <= 99) {
        if (!currentAirportIcao) {
          showFeedback('No airport selected', 'error')
          return
        }
        saveBookmark(slot)
        showFeedback(`Saved bookmark .${slot.toString().padStart(2, '0')}`, 'success')
        return
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

        // Only allow digits and period for bookmark commands
        if (/^[\d.]$/.test(key)) {
          // Limit buffer length to prevent abuse
          if (inputBuffer.length < 10) {
            setInputBuffer(prev => prev + key)
          }
          event.preventDefault()
          return
        }

        // Any other key cancels
        setIsActive(false)
        setInputBuffer('')
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isActive, inputBuffer, processCommand])

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (feedbackTimeoutRef.current) {
        clearTimeout(feedbackTimeoutRef.current)
      }
    }
  }, [])

  // Don't render if not active and no feedback
  if (!isActive && !feedback) {
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
      {feedback && (
        <div className={`command-feedback ${feedback.type}`}>
          {feedback.message}
        </div>
      )}
    </div>
  )
}

export default CommandInput
