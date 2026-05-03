import { useState } from 'react'
import { type CesiumTokenValidationResult, validateCesiumIonToken } from '../../services/CesiumIonValidator'
import { shellApi } from '../../utils/tauriApi'
import './TokenPrompt.css'

interface TokenPromptProps {
  onClose: () => void
  onSave: (token: string) => Promise<void> | void
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'validating' }
  | { kind: 'invalid'; message: string }
  | { kind: 'unverified'; message: string }

const SIGNUP_URL = 'https://ion.cesium.com/signup/'
const TOKENS_URL = 'https://ion.cesium.com/tokens'

function openExternal(url: string) {
  return (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    void shellApi.openExternal(url)
  }
}

function TokenPrompt({ onClose, onSave }: TokenPromptProps) {
  const [tokenInput, setTokenInput] = useState('')
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' })

  const persistAndClose = async (token: string) => {
    await onSave(token)
    onClose()
  }

  const handleSave = async () => {
    const trimmed = tokenInput.trim()
    if (!trimmed) return
    setSaveState({ kind: 'validating' })
    const result: CesiumTokenValidationResult = await validateCesiumIonToken(trimmed)
    if (result.status === 'valid') {
      await persistAndClose(trimmed)
      return
    }
    setSaveState({ kind: result.status, message: result.message })
  }

  const handleSaveAnyway = async () => {
    const trimmed = tokenInput.trim()
    if (!trimmed) return
    await persistAndClose(trimmed)
  }

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTokenInput(e.target.value)
    if (saveState.kind !== 'idle') {
      setSaveState({ kind: 'idle' })
    }
  }

  const isBusy = saveState.kind === 'validating'
  const canSave = tokenInput.trim().length > 0 && !isBusy
  const showSaveAnyway = saveState.kind === 'unverified'

  return (
    <div className="token-prompt-overlay">
      <div className="token-prompt-modal" role="dialog" aria-labelledby="token-prompt-title">
        <h2 id="token-prompt-title">Cesium Ion Access Token Required</h2>
        <p>TowerCab 3D uses Cesium Ion for terrain and satellite imagery. You need a free access token to continue.</p>
        <ol>
          <li>
            <a href={SIGNUP_URL} className="external-link" onClick={openExternal(SIGNUP_URL)}>
              Create a free Cesium Ion account
            </a>
          </li>
          <li>
            <a href={TOKENS_URL} className="external-link" onClick={openExternal(TOKENS_URL)}>
              Go to Access Tokens
            </a>{' '}
            and copy your default token
          </li>
          <li>Paste it below:</li>
        </ol>
        <input
          type="text"
          value={tokenInput}
          onChange={onInputChange}
          placeholder="Paste your Cesium Ion access token here"
          className="token-prompt-input"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          aria-invalid={saveState.kind === 'invalid'}
          aria-describedby={saveState.kind === 'idle' ? undefined : 'token-prompt-status'}
        />
        <div id="token-prompt-status" className={`token-prompt-status status-${saveState.kind}`}>
          {saveState.kind === 'validating' && <span>Verifying token with Cesium Ion…</span>}
          {saveState.kind === 'invalid' && <span>{saveState.message}</span>}
          {saveState.kind === 'unverified' && <span>{saveState.message}</span>}
        </div>
        <div className="token-prompt-actions">
          <div className="token-prompt-skip">
            <button type="button" className="token-button secondary" onClick={onClose}>
              Skip for now
            </button>
            <p className="token-prompt-warning">Terrain and imagery won't load without a token.</p>
          </div>
          <div className="token-prompt-save">
            {showSaveAnyway ? (
              <button type="button" className="token-button primary" onClick={handleSaveAnyway} disabled={!canSave}>
                Save anyway
              </button>
            ) : (
              <button type="button" className="token-button primary" onClick={handleSave} disabled={!canSave}>
                {isBusy ? 'Verifying…' : 'Save Token'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default TokenPrompt
