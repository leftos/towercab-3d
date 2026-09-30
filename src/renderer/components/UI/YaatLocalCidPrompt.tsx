/**
 * YAAT Local CID Prompt
 *
 * Asks for a VATSIM CID when YAAT Local sign-in has none: no CID was saved and
 * TowerCab has no stored VATSIM login. The store saves the CID and signs in with it.
 */

import { useState } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useVnasStore } from '../../stores/vnasStore'
import './YaatLocalCidPrompt.css'

interface YaatLocalCidPromptProps {
  /** Called when sign-in finished without an error */
  onSignedIn?: () => void
}

export function YaatLocalCidPrompt({ onSignedIn }: YaatLocalCidPromptProps) {
  const savedCid = useSettingsStore((state) => state.vnas.yaatLocalCid)
  const signInYaatLocalWithCid = useVnasStore((state) => state.signInYaatLocalWithCid)
  const [cid, setCid] = useState(savedCid)
  const [isSigningIn, setIsSigningIn] = useState(false)

  const canSubmit = cid.trim() !== '' && !isSigningIn

  const handleSignIn = async () => {
    if (!canSubmit) return
    setIsSigningIn(true)
    try {
      await signInYaatLocalWithCid(cid)
    } finally {
      setIsSigningIn(false)
    }
    if (!useVnasStore.getState().status.error) {
      onSignedIn?.()
    }
  }

  return (
    <div className="yaat-cid-prompt">
      <input
        type="text"
        inputMode="numeric"
        className="yaat-cid-prompt-input"
        placeholder="VATSIM CID"
        aria-label="VATSIM CID"
        value={cid}
        onChange={(e) => setCid(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleSignIn()}
      />
      <button type="button" className="yaat-cid-prompt-button" onClick={handleSignIn} disabled={!canSubmit}>
        Sign in
      </button>
    </div>
  )
}
