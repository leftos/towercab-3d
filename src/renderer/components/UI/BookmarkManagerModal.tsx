import { useState, useEffect, useCallback, useRef } from 'react'
import { useViewportStore } from '../../stores/viewportStore'
import { useUIFeedbackStore } from '../../stores/uiFeedbackStore'
import type { CameraBookmark } from '../../types'
import './BookmarkManagerModal.css'

interface BookmarkManagerModalProps {
  onClose: () => void
}

function BookmarkManagerModal({ onClose }: BookmarkManagerModalProps) {
  const loadBookmark = useViewportStore((state) => state.loadBookmark)
  const deleteBookmark = useViewportStore((state) => state.deleteBookmark)
  const renameBookmark = useViewportStore((state) => state.renameBookmark)
  const currentAirportIcao = useViewportStore((state) => state.currentAirportIcao)
  const showFeedback = useUIFeedbackStore((state) => state.showFeedback)

  // Subscribe directly to bookmarks data so component re-renders on changes
  const bookmarks = useViewportStore((state) => {
    const icao = state.currentAirportIcao
    if (!icao) return undefined
    return state.airportViewportConfigs[icao]?.bookmarks
  })

  const [selectedSlot, setSelectedSlot] = useState<number>(0)
  const [editingSlot, setEditingSlot] = useState<number | null>(null)
  const [editingName, setEditingName] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Generate all 100 slots with bookmark data
  const slots = Array.from({ length: 100 }, (_, i) => ({
    slot: i,
    bookmark: bookmarks?.[i]
  }))

  const handleSaveRename = useCallback(() => {
    if (editingSlot === null) return
    const bookmark = bookmarks?.[editingSlot]
    if (bookmark) {
      renameBookmark(editingSlot, editingName.trim() || undefined)
      showFeedback(`Renamed bookmark .${editingSlot.toString().padStart(2, '0')}`, 'success')
    }
    setEditingSlot(null)
  }, [editingSlot, editingName, bookmarks, renameBookmark, showFeedback])

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // If editing, handle edit-specific keys
      if (editingSlot !== null) {
        if (e.key === 'Enter') {
          e.preventDefault()
          handleSaveRename()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          setEditingSlot(null)
        }
        return
      }

      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault()
          setSelectedSlot(s => Math.max(0, s - 1))
          break
        case 'ArrowDown':
          e.preventDefault()
          setSelectedSlot(s => Math.min(99, s + 1))
          break
        case 'PageUp':
          e.preventDefault()
          setSelectedSlot(s => Math.max(0, s - 10))
          break
        case 'PageDown':
          e.preventDefault()
          setSelectedSlot(s => Math.min(99, s + 10))
          break
        case 'Home':
          e.preventDefault()
          setSelectedSlot(0)
          break
        case 'End':
          e.preventDefault()
          setSelectedSlot(99)
          break
        case 'Enter':
          // If a button is focused, let it handle Enter natively
          if (document.activeElement instanceof HTMLButtonElement) {
            return
          }
          e.preventDefault()
          if (bookmarks?.[selectedSlot]) {
            loadBookmark(selectedSlot)
            showFeedback(`Loaded bookmark .${selectedSlot.toString().padStart(2, '0')}`, 'success')
            onClose()
          }
          break
        case 'Delete':
        case 'Backspace':
          e.preventDefault()
          if (bookmarks?.[selectedSlot]) {
            deleteBookmark(selectedSlot)
            showFeedback(`Deleted bookmark .${selectedSlot.toString().padStart(2, '0')}`, 'success')
          }
          break
        case 'r':
        case 'R':
          e.preventDefault()
          if (bookmarks?.[selectedSlot]) {
            setEditingSlot(selectedSlot)
            setEditingName(bookmarks[selectedSlot].name || '')
          }
          break
        case 'Escape':
          e.preventDefault()
          onClose()
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedSlot, editingSlot, bookmarks, loadBookmark, deleteBookmark, showFeedback, onClose, handleSaveRename])

  // Scroll selected slot into view
  useEffect(() => {
    const selectedElement = listRef.current?.querySelector(`[data-slot="${selectedSlot}"]`)
    selectedElement?.scrollIntoView({ block: 'nearest' })
  }, [selectedSlot])

  // Focus input when editing
  useEffect(() => {
    if (editingSlot !== null) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editingSlot])

  const handleLoad = (slot: number) => {
    if (bookmarks?.[slot]) {
      loadBookmark(slot)
      showFeedback(`Loaded bookmark .${slot.toString().padStart(2, '0')}`, 'success')
      onClose()
    }
  }

  const handleDelete = (slot: number, e: React.MouseEvent) => {
    e.stopPropagation()
    deleteBookmark(slot)
    showFeedback(`Deleted bookmark .${slot.toString().padStart(2, '0')}`, 'success')
  }

  const handleRename = (slot: number, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingSlot(slot)
    setEditingName(bookmarks?.[slot]?.name || '')
  }

  const formatViewMode = (bookmark: CameraBookmark) => {
    return bookmark.viewMode === '3d' ? '3D' : '2D'
  }

  const formatHeading = (heading: number) => {
    return Math.round(((heading % 360) + 360) % 360).toString().padStart(3, '0') + '\u00B0'
  }

  const formatPitch = (pitch: number) => {
    return (pitch >= 0 ? '+' : '') + Math.round(pitch) + '\u00B0'
  }

  // Count saved bookmarks
  const savedCount = slots.filter(s => s.bookmark).length

  return (
    <div className="settings-modal-overlay" onClick={onClose}>
      <div className="settings-modal bookmark-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Bookmarks - {currentAirportIcao}</h2>
          <span className="bookmark-count">{savedCount}/100 saved</span>
          <button className="close-button" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="bookmark-keyboard-hints">
          <span><kbd>&uarr;</kbd><kbd>&darr;</kbd> Navigate</span>
          <span><kbd>Enter</kbd> Load</span>
          <span><kbd>R</kbd> Rename</span>
          <span><kbd>Del</kbd> Delete</span>
          <span><kbd>Esc</kbd> Close</span>
        </div>

        <div className="settings-content bookmark-list" ref={listRef}>
          {slots.map(({ slot, bookmark }) => (
            <div
              key={slot}
              data-slot={slot}
              className={`bookmark-item ${selectedSlot === slot ? 'selected' : ''} ${bookmark ? 'has-bookmark' : 'empty'}`}
              onClick={() => setSelectedSlot(slot)}
              onDoubleClick={() => bookmark && handleLoad(slot)}
            >
              <span className="bookmark-slot">.{slot.toString().padStart(2, '0')}</span>

              {editingSlot === slot ? (
                <input
                  ref={inputRef}
                  type="text"
                  className="bookmark-name-input"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={handleSaveRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleSaveRename()
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      setEditingSlot(null)
                    }
                    e.stopPropagation()
                  }}
                  placeholder="Enter name..."
                />
              ) : (
                <span className="bookmark-name">
                  {bookmark?.name || (bookmark ? 'Unnamed' : '(empty)')}
                </span>
              )}

              {bookmark && (
                <>
                  <span className="bookmark-preview">
                    {formatViewMode(bookmark)} | HDG {formatHeading(bookmark.heading)} | PIT {formatPitch(bookmark.pitch)} | FOV {Math.round(bookmark.fov)}&deg;
                  </span>

                  <div className="bookmark-actions">
                    <button
                      className="bookmark-action-btn"
                      onClick={(e) => { e.stopPropagation(); handleLoad(slot) }}
                      title="Load (Enter)"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                    </button>
                    <button
                      className="bookmark-action-btn"
                      onClick={(e) => handleRename(slot, e)}
                      title="Rename (R)"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                    </button>
                    <button
                      className="bookmark-action-btn delete"
                      onClick={(e) => handleDelete(slot, e)}
                      title="Delete (Del)"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default BookmarkManagerModal
