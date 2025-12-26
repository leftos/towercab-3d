import { useUpdateStore } from '../../stores/updateStore'
import { checkForUpdates } from '../../services/UpdateService'
import './ControlsBar.css'

function SettingsHelpTab() {
  const updateStatus = useUpdateStore((state) => state.status)

  return (
    <>
      <div className="settings-section">
        <h3>Camera Controls</h3>
        <div className="shortcuts-list">
          <div className="shortcut">
            <span className="keys">Right-click + Drag</span>
            <span className="action">Look around</span>
          </div>
          <div className="shortcut">
            <span className="keys">WASD</span>
            <span className="action">Move position</span>
          </div>
          <div className="shortcut">
            <span className="keys">Arrow Keys</span>
            <span className="action">Pan/Tilt camera</span>
          </div>
          <div className="shortcut">
            <span className="keys">Scroll Wheel</span>
            <span className="action">Zoom (FOV/Altitude)</span>
          </div>
          <div className="shortcut">
            <span className="keys">T</span>
            <span className="action">Toggle 3D/2D view</span>
          </div>
          <div className="shortcut">
            <span className="keys">r</span>
            <span className="action">Reset position</span>
          </div>
          <div className="shortcut">
            <span className="keys">Shift+R / Home</span>
            <span className="action">Reset to default view</span>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h3>Aircraft Following</h3>
        <div className="shortcuts-list">
          <div className="shortcut">
            <span className="keys">Click target icon</span>
            <span className="action">Follow aircraft</span>
          </div>
          <div className="shortcut">
            <span className="keys">Ctrl+K</span>
            <span className="action">Global aircraft search</span>
          </div>
          <div className="shortcut">
            <span className="keys">O</span>
            <span className="action">Toggle orbit mode</span>
          </div>
          <div className="shortcut">
            <span className="keys">Scroll (following)</span>
            <span className="action">Adjust zoom/distance</span>
          </div>
          <div className="shortcut">
            <span className="keys">Escape</span>
            <span className="action">Stop following</span>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h3>Bookmarks</h3>
        <div className="shortcuts-list">
          <div className="shortcut">
            <span className="keys">.XX</span>
            <span className="action">Load bookmark (e.g., .00, .42)</span>
          </div>
          <div className="shortcut">
            <span className="keys">.XX.</span>
            <span className="action">Save bookmark (e.g., .00., .42.)</span>
          </div>
          <div className="shortcut">
            <span className="keys">.XX.NAME.</span>
            <span className="action">Save named bookmark</span>
          </div>
          <div className="shortcut">
            <span className="keys">Ctrl+0-9</span>
            <span className="action">Quick load bookmarks 0-9</span>
          </div>
          <div className="shortcut">
            <span className="keys">Ctrl+B</span>
            <span className="action">Open bookmark manager</span>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h3>Datablock Position</h3>
        <div className="shortcuts-list">
          <div className="shortcut">
            <span className="keys">1-9</span>
            <span className="action">Select position (numpad layout)</span>
          </div>
          <div className="shortcut">
            <span className="keys">Enter</span>
            <span className="action">Apply to all datablocks</span>
          </div>
          <div className="shortcut">
            <span className="keys">Click aircraft</span>
            <span className="action">Apply to that aircraft only</span>
          </div>
          <div className="shortcut">
            <span className="keys">Escape</span>
            <span className="action">Cancel position selection</span>
          </div>
        </div>
        <p className="setting-hint" style={{ marginTop: '8px' }}>
          Position layout: 7=top-left, 8=top, 9=top-right, 4=left, 5=center, 6=right, 1=bottom-left, 2=bottom, 3=bottom-right
        </p>
      </div>

      <div className="settings-section">
        <h3>Updates</h3>
        <div className="setting-row">
          <button
            className="control-button"
            onClick={() => checkForUpdates()}
            disabled={updateStatus === 'checking' || updateStatus === 'downloading'}
          >
            {updateStatus === 'checking' ? 'Checking...' : 'Check for Updates'}
          </button>
        </div>
        <p className="setting-hint" style={{ marginTop: '8px' }}>
          Current version: v{APP_VERSION}
        </p>
      </div>
    </>
  )
}

export default SettingsHelpTab
