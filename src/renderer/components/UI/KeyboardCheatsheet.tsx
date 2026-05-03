import { useEffect, useMemo, useRef, useState } from 'react'
import { useUIFeedbackStore } from '../../stores/uiFeedbackStore'
import './KeyboardCheatsheet.css'

interface Row {
  keys: string[]
  label: string
  note?: string
}

interface Section {
  title: string
  rows: Row[]
}

const SECTIONS: Section[] = [
  {
    title: 'Camera',
    rows: [
      { keys: ['T'], label: 'Toggle 3D / top-down view' },
      { keys: ['R'], label: 'Reset camera offset to zero' },
      { keys: ['Shift', 'R'], label: 'Reset to your saved default view' },
      { keys: ['Home'], label: 'Load saved default view' },
      { keys: ['Shift', 'Home'], label: 'Reset to app defaults', note: 'ignores user-saved defaults' },
      { keys: ['O'], label: 'Toggle follow mode (tower / orbit)', note: 'while following an aircraft' },
      { keys: ['Esc'], label: 'Stop following aircraft' },
      { keys: ['W', 'A', 'S', 'D'], label: 'Move camera (forward / left / back / right)' },
      { keys: ['↑', '↓', '←', '→'], label: 'Move camera (alternative to WASD)' },
      { keys: ['Shift', '+', 'WASD'], label: 'Sprint (3× speed)' },
      { keys: ['Ctrl', '+', 'WASD'], label: 'Fine control (0.2× speed)' },
      { keys: ['Q', 'E'], label: 'Rotate heading left / right' },
      { keys: ['Z', 'C'], label: 'Pitch down / up' },
      { keys: ['Wheel'], label: 'Zoom / altitude / distance', note: 'behaviour depends on view mode' },
    ],
  },
  {
    title: 'Bookmarks',
    rows: [
      { keys: ['Ctrl', '+', '0', '–', '9'], label: 'Quick-load bookmark slot 0–9' },
      { keys: ['Ctrl', '+', 'B'], label: 'Open Bookmark Manager' },
      { keys: ['.NN'], label: 'Load bookmark from slot NN (00–99)', note: 'press . then type slot, then Enter' },
      { keys: ['.NN.'], label: 'Save bookmark to slot NN', note: 'leading and trailing period' },
      { keys: ['.NN.NAME.'], label: 'Save named bookmark', note: 'e.g. .05.Tower South.' },
    ],
  },
  {
    title: 'Tools & UI',
    rows: [
      { keys: ['?'], label: 'Open this cheatsheet' },
      { keys: ['Ctrl', '+', ','], label: 'Open Settings' },
      { keys: ['Ctrl', '+', 'K'], label: 'Open Global Aircraft Search' },
      { keys: ['M'], label: 'Toggle Measuring Tool' },
      { keys: ['Ctrl', '+', 'M'], label: 'Toggle METAR overlay' },
    ],
  },
  {
    title: 'Debug overlays',
    rows: [
      { keys: ['F1'], label: 'Toggle Performance HUD' },
      { keys: ['F3'], label: 'Toggle Model Matching modal' },
      { keys: ['F4'], label: 'Toggle Timeline Debug modal' },
    ],
  },
  {
    title: 'Replay',
    rows: [
      { keys: ['Space'], label: 'Play / pause' },
      { keys: ['←'], label: 'Step backward 15 s' },
      { keys: ['→'], label: 'Step forward 15 s' },
    ],
  },
  {
    title: 'Datablock positioning',
    rows: [
      { keys: ['Numpad 1', '–', '9'], label: 'Set datablock direction', note: '5 = reset to app default' },
      { keys: ['Enter'], label: 'Apply position globally', note: 'or click an aircraft to position one' },
      { keys: ['Esc'], label: 'Cancel datablock positioning' },
    ],
  },
  {
    title: 'Tower positioning (wizard)',
    rows: [
      { keys: ['Tab'], label: 'Toggle model / camera control' },
      {
        keys: ['W', 'A', 'S', 'D'],
        label: 'Move model N / E / S / W (model mode)',
        note: 'Shift = 10 m, Ctrl = 0.1 m',
      },
      { keys: ['Q', 'E'], label: 'Move model up / down (model mode)' },
      { keys: ['Z', 'X'], label: 'Rotate model CCW / CW', note: 'Shift = 45°, Ctrl = 1°' },
      { keys: ['R'], label: 'Reset model offset to zero' },
      { keys: ['Enter'], label: 'Proceed to next step / save' },
      { keys: ['Esc'], label: 'Cancel tower positioning' },
    ],
  },
  {
    title: 'Mouse & globe gestures',
    rows: [
      { keys: ['Right-drag'], label: 'Rotate camera (heading + pitch)' },
      { keys: ['Middle-drag'], label: 'Rotate camera', note: 'alternative to right-drag' },
      { keys: ['Left-drag'], label: 'Pan map', note: 'top-down mode only' },
      { keys: ['Wheel'], label: 'Zoom / altitude / distance' },
    ],
  },
  {
    title: 'Touch gestures',
    rows: [
      { keys: ['Joystick'], label: 'Camera movement (WASD equivalent)' },
      { keys: ['Pinch'], label: 'Zoom (Cesium native)' },
      { keys: ['Two-finger drag'], label: 'Orbit / rotate (Cesium native)' },
    ],
  },
]

interface Props {
  isOpen: boolean
  onClose: () => void
}

function KeyboardCheatsheet({ isOpen, onClose }: Props) {
  const [query, setQuery] = useState('')
  const overlayRef = useRef<HTMLDivElement>(null)
  const pushModal = useUIFeedbackStore((state) => state.pushModal)
  const popModal = useUIFeedbackStore((state) => state.popModal)

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  useEffect(() => {
    if (isOpen) {
      pushModal()
      return () => popModal()
    }
  }, [isOpen, pushModal, popModal])

  useEffect(() => {
    if (!isOpen) setQuery('')
  }, [isOpen])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return SECTIONS
    return SECTIONS.map((section) => ({
      ...section,
      rows: section.rows.filter((row) => {
        const haystack = `${section.title} ${row.keys.join(' ')} ${row.label} ${row.note ?? ''}`.toLowerCase()
        return haystack.includes(q)
      }),
    })).filter((section) => section.rows.length > 0)
  }, [query])

  if (!isOpen) return null

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === overlayRef.current) onClose()
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal overlay backdrop
    <div ref={overlayRef} className="kbd-cheatsheet-overlay" role="presentation" onClick={handleBackdropClick}>
      <div className="kbd-cheatsheet-modal" role="dialog" aria-label="Keyboard shortcuts">
        <div className="kbd-cheatsheet-header">
          <h2 className="kbd-cheatsheet-title">Keyboard shortcuts</h2>
          <button type="button" className="kbd-cheatsheet-close" onClick={onClose} aria-label="Close cheatsheet">
            ×
          </button>
        </div>

        <input
          type="text"
          className="kbd-cheatsheet-search"
          placeholder="Filter shortcuts…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // biome-ignore lint/a11y/noAutofocus: search field is the primary interaction in a help dialog
          autoFocus
        />

        <div className="kbd-cheatsheet-body">
          {filtered.length === 0 ? (
            <p className="kbd-cheatsheet-empty">No shortcuts match &quot;{query}&quot;.</p>
          ) : (
            filtered.map((section) => (
              <section key={section.title} className="kbd-cheatsheet-section">
                <h3 className="kbd-cheatsheet-section-title">{section.title}</h3>
                <ul className="kbd-cheatsheet-rows">
                  {section.rows.map((row) => (
                    <li key={`${section.title}-${row.label}`} className="kbd-cheatsheet-row">
                      <span className="kbd-cheatsheet-keys">
                        {row.keys.map((key, i) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: keys array is static, repeats like "+" are positional
                          <kbd key={`${key}-${i}`} className="kbd-cheatsheet-key">
                            {key}
                          </kbd>
                        ))}
                      </span>
                      <span className="kbd-cheatsheet-label">
                        {row.label}
                        {row.note ? <span className="kbd-cheatsheet-note"> — {row.note}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

export default KeyboardCheatsheet
