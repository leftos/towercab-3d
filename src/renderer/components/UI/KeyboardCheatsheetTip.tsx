import { useEffect, useState } from 'react'
import { useAirportStore } from '../../stores/airportStore'
import { useSettingsStore } from '../../stores/settingsStore'
import './KeyboardCheatsheetTip.css'

const SHOW_DELAY_MS = 5000
const AUTO_FADE_MS = 30_000

interface Props {
  onShow: () => void
}

function KeyboardCheatsheetTip({ onShow }: Props) {
  const dismissed = useSettingsStore((state) => state.ui.keyboardCheatsheetDismissed)
  const updateUISettings = useSettingsStore((state) => state.updateUISettings)
  const currentAirport = useAirportStore((state) => state.currentAirport)

  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (dismissed || !currentAirport) {
      setVisible(false)
      return
    }
    const showTimer = setTimeout(() => setVisible(true), SHOW_DELAY_MS)
    const fadeTimer = setTimeout(() => {
      setVisible(false)
      updateUISettings({ keyboardCheatsheetDismissed: true })
    }, SHOW_DELAY_MS + AUTO_FADE_MS)
    return () => {
      clearTimeout(showTimer)
      clearTimeout(fadeTimer)
    }
  }, [dismissed, currentAirport, updateUISettings])

  if (!visible) return null

  const handleShow = () => {
    setVisible(false)
    updateUISettings({ keyboardCheatsheetDismissed: true })
    onShow()
  }

  const handleDismiss = () => {
    setVisible(false)
    updateUISettings({ keyboardCheatsheetDismissed: true })
  }

  return (
    <div className="kbd-tip" role="status" aria-live="polite">
      <div className="kbd-tip-text">
        Press <kbd className="kbd-tip-key">?</kbd> for keyboard shortcuts
      </div>
      <div className="kbd-tip-actions">
        <button type="button" className="kbd-tip-btn kbd-tip-btn-primary" onClick={handleShow}>
          Show me
        </button>
        <button type="button" className="kbd-tip-btn kbd-tip-btn-secondary" onClick={handleDismiss}>
          Got it
        </button>
      </div>
    </div>
  )
}

export default KeyboardCheatsheetTip
