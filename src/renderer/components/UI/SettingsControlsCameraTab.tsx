import { useSettingsStore } from '../../stores/settingsStore'
import CollapsibleSection from './settings/CollapsibleSection'
import './ControlsBar.css'

function SettingsControlsCameraTab() {
  // Camera settings
  const defaultFov = useSettingsStore((state) => state.camera.defaultFov)
  const cameraSpeed = useSettingsStore((state) => state.camera.cameraSpeed)
  const mouseSensitivity = useSettingsStore((state) => state.camera.mouseSensitivity)
  const joystickSensitivity = useSettingsStore((state) => state.camera.joystickSensitivity)
  const enableAutoAirportSwitch = useSettingsStore((state) => state.camera.enableAutoAirportSwitch ?? false)
  const orbitCameraLag = useSettingsStore((state) => state.camera.orbitCameraLag ?? 50)
  const updateCameraSettings = useSettingsStore((state) => state.updateCameraSettings)

  return (
    <>
      <CollapsibleSection title="Camera Behavior">
        <div className="setting-item">
          <label>Default FOV</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="10"
              max="120"
              value={defaultFov}
              onChange={(e) => updateCameraSettings({ defaultFov: Number(e.target.value) })}
            />
            <span>{defaultFov}°</span>
          </div>
          <p className="setting-hint">Field of view used when resetting camera.</p>
        </div>

        <div className="setting-item">
          <label>
            <input
              type="checkbox"
              checked={enableAutoAirportSwitch}
              onChange={(e) => updateCameraSettings({ enableAutoAirportSwitch: e.target.checked })}
            />
            Auto-Switch to Nearest Airport
          </label>
          <p className="setting-hint">Automatically switch to the nearest airport as you move the camera.</p>
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Input Sensitivity">
        <div className="setting-item">
          <label>Camera Speed</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="1"
              max="10"
              value={cameraSpeed}
              onChange={(e) => updateCameraSettings({ cameraSpeed: Number(e.target.value) })}
            />
            <span>{cameraSpeed}</span>
          </div>
          <p className="setting-hint">WASD movement speed multiplier.</p>
        </div>

        <div className="setting-item">
          <label>Mouse Sensitivity</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="0.1"
              max="2"
              step="0.1"
              value={mouseSensitivity}
              onChange={(e) => updateCameraSettings({ mouseSensitivity: Number(e.target.value) })}
            />
            <span>{mouseSensitivity.toFixed(1)}</span>
          </div>
          <p className="setting-hint">Right-click drag sensitivity for camera rotation.</p>
        </div>

        <div className="setting-item">
          <label>Joystick Sensitivity</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="1"
              max="10"
              value={joystickSensitivity}
              onChange={(e) => updateCameraSettings({ joystickSensitivity: Number(e.target.value) })}
            />
            <span>{joystickSensitivity}</span>
          </div>
          <p className="setting-hint">Virtual joystick movement speed on touch devices.</p>
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Orbit Camera">
        <div className="setting-item">
          <label>Camera Lag (Cinematic)</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="0"
              max="100"
              value={orbitCameraLag}
              onChange={(e) => updateCameraSettings({ orbitCameraLag: Number(e.target.value) })}
            />
            <span>{orbitCameraLag}%</span>
          </div>
          <p className="setting-hint">
            {orbitCameraLag === 0
              ? 'Instant response (no lag)'
              : orbitCameraLag < 30
                ? 'Quick response with slight smoothing'
                : orbitCameraLag < 70
                  ? 'Balanced cinematic effect'
                  : 'Maximum cinematic lag (video game style)'}
          </p>
          <p className="setting-hint">
            Controls how quickly the orbit camera reacts to aircraft heading and altitude changes. Higher values create
            a more cinematic &ldquo;chase camera&rdquo; feel.
          </p>
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Camera Controls">
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
      </CollapsibleSection>

      <CollapsibleSection title="Aircraft Following">
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
            <span className="keys">WASD (orbit mode)</span>
            <span className="action">Exit orbit, look at aircraft</span>
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
      </CollapsibleSection>

      <CollapsibleSection title="Bookmarks">
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
      </CollapsibleSection>

      <CollapsibleSection title="Datablock Position">
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
          Position layout: 7=top-left, 8=top, 9=top-right, 4=left, 5=center, 6=right, 1=bottom-left, 2=bottom,
          3=bottom-right
        </p>
      </CollapsibleSection>
    </>
  )
}

export default SettingsControlsCameraTab
