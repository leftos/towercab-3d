import { useSettingsStore } from '../../stores/settingsStore'
import './ControlsBar.css'

function SettingsDisplayTab() {
  // Settings store - Display (Aircraft group)
  const labelVisibilityDistance = useSettingsStore((state) => state.aircraft.labelVisibilityDistance)
  const maxAircraftDisplay = useSettingsStore((state) => state.aircraft.maxAircraftDisplay)
  const datablockMode = useSettingsStore((state) => state.aircraft.datablockMode)
  const showGroundTraffic = useSettingsStore((state) => state.aircraft.showGroundTraffic)
  const showAirborneTraffic = useSettingsStore((state) => state.aircraft.showAirborneTraffic)
  const orientationEmulation = useSettingsStore((state) => state.aircraft.orientationEmulation)
  const orientationIntensity = useSettingsStore((state) => state.aircraft.orientationIntensity)
  const autoAvoidOverlaps = useSettingsStore((state) => state.aircraft.autoAvoidOverlaps)
  const leaderDistance = useSettingsStore((state) => state.aircraft.leaderDistance)
  const defaultDatablockDirection = useSettingsStore((state) => state.aircraft.defaultDatablockDirection)
  const updateAircraftSettings = useSettingsStore((state) => state.updateAircraftSettings)
  const showAircraftPanel = useSettingsStore((state) => state.ui.showAircraftPanel)
  const updateUISettings = useSettingsStore((state) => state.updateUISettings)

  return (
    <>
      <div className="settings-section">
        <h3>Aircraft Display</h3>
        <div className="setting-item">
          <label>Max Nearby Aircraft Range</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="5"
              max="100"
              value={labelVisibilityDistance}
              onChange={(e) => updateAircraftSettings({ labelVisibilityDistance: Number(e.target.value) })}
            />
            <span>{labelVisibilityDistance} nm</span>
          </div>
        </div>

        <div className="setting-item">
          <label>Datablock Mode</label>
          <div className="radio-group-vertical">
            <label>
              <input
                type="radio"
                name="datablockMode"
                value="full"
                checked={datablockMode === 'full'}
                onChange={() => updateAircraftSettings({ datablockMode: 'full' })}
              />
              Full (callsign + type + altitude + speed)
            </label>
            <label>
              <input
                type="radio"
                name="datablockMode"
                value="airline"
                checked={datablockMode === 'airline'}
                onChange={() => updateAircraftSettings({ datablockMode: 'airline' })}
              />
              Airline Codes Only (ICAO code for airline flights)
            </label>
            <label>
              <input
                type="radio"
                name="datablockMode"
                value="none"
                checked={datablockMode === 'none'}
                onChange={() => updateAircraftSettings({ datablockMode: 'none' })}
              />
              None (hide labels, show cones only)
            </label>
          </div>
        </div>

        <div className="setting-item">
          <label>
            <input
              type="checkbox"
              checked={autoAvoidOverlaps}
              onChange={(e) => updateAircraftSettings({ autoAvoidOverlaps: e.target.checked })}
            />
            Auto-rearrange to Avoid Overlaps
          </label>
          <p className="setting-hint">
            Automatically shift datablocks to prevent them from overlapping each other.
          </p>
        </div>

        <div className="setting-item">
          <label>Leader Line Length</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="1"
              max="5"
              value={leaderDistance}
              onChange={(e) => updateAircraftSettings({ leaderDistance: Number(e.target.value) as 1 | 2 | 3 | 4 | 5 })}
            />
            <span>{leaderDistance}</span>
          </div>
          <p className="setting-hint">
            Length of leader lines connecting datablocks to aircraft. 1=short, 5=long.
          </p>
        </div>

        <div className="setting-item">
          <label>Default Datablock Direction</label>
          <select
            value={defaultDatablockDirection}
            onChange={(e) => updateAircraftSettings({ defaultDatablockDirection: Number(e.target.value) as 1 | 2 | 3 | 4 | 6 | 7 | 8 | 9 })}
          >
            <option value={7}>7 - Top-Left</option>
            <option value={8}>8 - Top</option>
            <option value={9}>9 - Top-Right</option>
            <option value={4}>4 - Left</option>
            <option value={6}>6 - Right</option>
            <option value={1}>1 - Bottom-Left</option>
            <option value={2}>2 - Bottom</option>
            <option value={3}>3 - Bottom-Right</option>
          </select>
          <p className="setting-hint">
            Default position for datablocks on new airports. Press 5+Enter to reset all datablocks to this default.
          </p>
        </div>
      </div>

      <div className="settings-section">
        <h3>Aircraft</h3>
        <div className="setting-item">
          <label>Max Aircraft Display</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="10"
              max="1000"
              step="10"
              value={maxAircraftDisplay}
              onChange={(e) => updateAircraftSettings({ maxAircraftDisplay: Number(e.target.value) })}
            />
            <span>{maxAircraftDisplay}</span>
          </div>
          <p className="setting-hint">Maximum number of aircraft to render.</p>
        </div>

        <div className="setting-item">
          <label>
            <input
              type="checkbox"
              checked={showGroundTraffic}
              onChange={(e) => updateAircraftSettings({ showGroundTraffic: e.target.checked })}
            />
            Show Ground Traffic
          </label>
        </div>

        <div className="setting-item">
          <label>
            <input
              type="checkbox"
              checked={showAirborneTraffic}
              onChange={(e) => updateAircraftSettings({ showAirborneTraffic: e.target.checked })}
            />
            Show Airborne Traffic
          </label>
        </div>

        <div className="setting-item">
          <label>
            <input
              type="checkbox"
              checked={orientationEmulation}
              onChange={(e) => updateAircraftSettings({ orientationEmulation: e.target.checked })}
            />
            Emulate Aircraft Pitch/Roll
          </label>
          <p className="setting-hint">
            Tilts aircraft based on climb/descent and turn rates.
          </p>
        </div>

        {orientationEmulation && (
          <div className="setting-item">
            <label>Orientation Intensity</label>
            <div className="slider-with-value">
              <input
                type="range"
                min="0.25"
                max="1.5"
                step="0.05"
                value={orientationIntensity}
                onChange={(e) => updateAircraftSettings({ orientationIntensity: Number(e.target.value) })}
              />
              <span>{Math.round(orientationIntensity * 100)}%</span>
            </div>
            <p className="setting-hint">
              100% = realistic. Lower for subtle, higher for exaggerated motion.
            </p>
          </div>
        )}
      </div>

      <div className="settings-section">
        <h3>UI</h3>
        <div className="setting-item">
          <label>
            <input
              type="checkbox"
              checked={showAircraftPanel}
              onChange={(e) => updateUISettings({ showAircraftPanel: e.target.checked })}
            />
            Show Aircraft Panel
          </label>
        </div>
      </div>
    </>
  )
}

export default SettingsDisplayTab
