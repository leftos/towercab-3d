import { useState } from 'react'
import { shellApi } from '../../utils/tauriApi'
import './TokenPrompt.css'

interface TokenPromptProps {
  onClose: () => void
  onSave: (token: string) => Promise<void> | void
}

function TokenPrompt({ onClose, onSave }: TokenPromptProps) {
  const [tokenInput, setTokenInput] = useState('')

  const handleSave = async () => {
    const trimmed = tokenInput.trim()
    if (!trimmed) return
    await onSave(trimmed)
    onClose()
  }

  return (
    <div className="token-prompt-overlay">
      <div className="token-prompt-modal">
        <h2>Cesium Ion Access Token Required</h2>
        <p>TowerCab 3D uses Cesium Ion for terrain and satellite imagery. You need a free access token to continue.</p>
        <ol>
          <li>
            <button
              type="button"
              onClick={() => shellApi.openExternal('https://ion.cesium.com/signup/')}
              className="external-link"
            >
              Create a free Cesium Ion account
            </button>
          </li>
          <li>
            <button
              type="button"
              onClick={() => shellApi.openExternal('https://ion.cesium.com/tokens')}
              className="external-link"
            >
              Go to Access Tokens
            </button>{' '}
            and copy your default token
          </li>
          <li>Paste it below:</li>
        </ol>
        <input
          type="text"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder="Paste your Cesium Ion access token here"
          className="token-prompt-input"
        />
        <div className="token-prompt-buttons">
          <button type="button" className="token-button secondary" onClick={onClose}>
            Skip for now
          </button>
          <button type="button" className="token-button primary" onClick={handleSave} disabled={!tokenInput.trim()}>
            Save Token
          </button>
        </div>
      </div>
    </div>
  )
}

export default TokenPrompt
