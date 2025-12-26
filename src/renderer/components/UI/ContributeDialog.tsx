import { open as openExternal } from '@tauri-apps/plugin-shell'
import { useSettingsStore } from '../../stores/settingsStore'
import './ControlsBar.css'

export interface ContributeDialogData {
  icao: string
  viewLabel: string
  fileContent: Record<string, unknown>
}

interface ContributeDialogProps {
  data: ContributeDialogData
  onClose: () => void
}

function ContributeDialog({ data, onClose }: ContributeDialogProps) {
  const updateUISettings = useSettingsStore((state) => state.updateUISettings)

  const handleContribute = async () => {
    // Clean up undefined values for cleaner JSON
    const cleanContent = JSON.parse(JSON.stringify(data.fileContent))
    const jsonContent = JSON.stringify(cleanContent, null, 2)
    const encodedContent = encodeURIComponent(jsonContent)
    const filename = `contributions/tower-positions/${data.icao}.json`
    const githubUrl = `https://github.com/leftos/towercab-3d/new/main?filename=${filename}&value=${encodedContent}`

    await openExternal(githubUrl)
    onClose()
  }

  const handleDontAskAgain = () => {
    updateUISettings({ askToContributePositions: false })
    onClose()
  }

  return (
    <div className="settings-modal-overlay" onClick={onClose}>
      <div className="settings-modal contribute-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Share Tower Position</h2>
          <button className="close-button" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="settings-content">
          <div className="settings-section">
            <p style={{ marginBottom: '16px', lineHeight: 1.5 }}>
              {data.viewLabel} tower position saved to{' '}
              <code style={{ background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px' }}>
                mods/tower-positions/{data.icao}.json
              </code>
            </p>
            <p style={{ marginBottom: '20px', lineHeight: 1.5 }}>
              Would you like to contribute this position to the project on GitHub?
              This helps other users get accurate tower positions for {data.icao}.
            </p>
            <div className="contribute-dialog-buttons">
              <button className="control-button primary" onClick={handleContribute}>
                Contribute to GitHub
              </button>
              <button className="control-button" onClick={onClose}>
                Skip
              </button>
              <button className="control-button secondary" onClick={handleDontAskAgain}>
                Don&apos;t Ask Again
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default ContributeDialog
