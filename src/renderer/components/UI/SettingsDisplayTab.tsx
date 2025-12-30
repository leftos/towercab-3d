import { useSettingsStore } from '../../stores/settingsStore'
import { useGlobalSettingsStore } from '../../stores/globalSettingsStore'
import CollapsibleSection from './settings/CollapsibleSection'
import './ControlsBar.css'

import type { GroundLabelMode } from '../../types'

function SettingsDisplayTab() {
  // Global display settings (synced across all devices)
  const labelVisibilityDistance = useGlobalSettingsStore((state) => state.display.labelVisibilityDistance)
  const datablockMode = useGlobalSettingsStore((state) => state.display.datablockMode)
  const showGroundTraffic = useGlobalSettingsStore((state) => state.display.showGroundTraffic)
  const showAirborneTraffic = useGlobalSettingsStore((state) => state.display.showAirborneTraffic)
  const autoAvoidOverlaps = useGlobalSettingsStore((state) => state.display.autoAvoidOverlaps)
  const leaderDistance = useGlobalSettingsStore((state) => state.display.leaderDistance)
  const defaultDatablockDirection = useGlobalSettingsStore((state) => state.display.defaultDatablockDirection)
  const groundLabelMode = useGlobalSettingsStore((state) => state.display.groundLabelMode)
  const groundLabelMinSpeed = useGlobalSettingsStore((state) => state.display.groundLabelMinSpeed)
  const updateDisplay = useGlobalSettingsStore((state) => state.updateDisplay)

  // Local settings (per-device)
  const maxAircraftDisplay = useSettingsStore((state) => state.aircraft.maxAircraftDisplay)
  const orientationEmulation = useSettingsStore((state) => state.aircraft.orientationEmulation)
  const orientationIntensity = useSettingsStore((state) => state.aircraft.orientationIntensity)
  const datablockFontSize = useSettingsStore((state) => state.aircraft.datablockFontSize)
  const updateAircraftSettings = useSettingsStore((state) => state.updateAircraftSettings)
  const showAircraftPanel = useSettingsStore((state) => state.ui.showAircraftPanel)
  const updateUISettings = useSettingsStore((state) => state.updateUISettings)

  return (
    <>
      <CollapsibleSection title="Aircraft Display">
        <div className="setting-item">
          <label>Max Nearby Aircraft Range</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="5"
              max="100"
              value={labelVisibilityDistance}
              onChange={(e) => updateDisplay({ labelVisibilityDistance: Number(e.target.value) })}
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
                onChange={() => updateDisplay({ datablockMode: 'full' })}
              />
              Full (callsign + type + altitude + speed)
            </label>
            <label>
              <input
                type="radio"
                name="datablockMode"
                value="airline"
                checked={datablockMode === 'airline'}
                onChange={() => updateDisplay({ datablockMode: 'airline' })}
              />
              Airline Codes Only (ICAO code for airline flights)
            </label>
            <label>
              <input
                type="radio"
                name="datablockMode"
                value="none"
                checked={datablockMode === 'none'}
                onChange={() => updateDisplay({ datablockMode: 'none' })}
              />
              None (hide labels, show aircraft only)
            </label>
          </div>
        </div>

        <div className="setting-item">
          <label>
            <input
              type="checkbox"
              checked={autoAvoidOverlaps}
              onChange={(e) => updateDisplay({ autoAvoidOverlaps: e.target.checked })}
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
              onChange={(e) => updateDisplay({ leaderDistance: Number(e.target.value) as 1 | 2 | 3 | 4 | 5 })}
            />
            <span>{leaderDistance}</span>
          </div>
          <p className="setting-hint">
            Length of leader lines connecting datablocks to aircraft. 1=short, 5=long.
          </p>
        </div>

        <div className="setting-item">
          <label>Datablock Font Size</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="8"
              max="20"
              value={datablockFontSize}
              onChange={(e) => updateAircraftSettings({ datablockFontSize: Number(e.target.value) })}
            />
            <span>{datablockFontSize}px</span>
          </div>
          <p className="setting-hint">
            Font size for aircraft datablock labels. (Per-device setting)
          </p>
        </div>

        <div className="setting-item">
          <label>Default Datablock Direction</label>
          <select
            value={defaultDatablockDirection}
            onChange={(e) => updateDisplay({ defaultDatablockDirection: Number(e.target.value) as 1 | 2 | 3 | 4 | 6 | 7 | 8 | 9 })}
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
      </CollapsibleSection>

      <CollapsibleSection title="Aircraft">
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
          <p className="setting-hint">Maximum number of aircraft to render. (Per-device setting)</p>
        </div>

        <div className="setting-item">
          <label>
            <input
              type="checkbox"
              checked={showGroundTraffic}
              onChange={(e) => updateDisplay({ showGroundTraffic: e.target.checked })}
            />
            Show Ground Traffic
          </label>
        </div>

        {showGroundTraffic && (
          <>
            <div className="setting-item">
              <label>Ground Traffic Labels</label>
              <select
                value={groundLabelMode ?? 'all'}
                onChange={(e) => updateDisplay({ groundLabelMode: e.target.value as GroundLabelMode })}
              >
                <option value="all">All Ground Aircraft</option>
                <option value="moving">Moving Only (custom speed)</option>
                <option value="activeOnly">Active Only (&gt; 5 kts)</option>
                <option value="none">Hide All Ground Labels</option>
              </select>
              <p className="setting-hint">
                Reduce gate clutter by hiding labels for parked/stationary aircraft.
              </p>
            </div>

            {groundLabelMode === 'moving' && (
              <div className="setting-item">
                <label>Minimum Speed for Labels</label>
                <div className="slider-with-value">
                  <input
                    type="range"
                    min="1"
                    max="10"
                    value={groundLabelMinSpeed ?? 2}
                    onChange={(e) => updateDisplay({ groundLabelMinSpeed: Number(e.target.value) })}
                  />
                  <span>{groundLabelMinSpeed ?? 2} kts</span>
                </div>
                <p className="setting-hint">
                  Aircraft below this speed won&apos;t show labels (considered parked).
                </p>
              </div>
            )}
          </>
        )}

        <div className="setting-item">
          <label>
            <input
              type="checkbox"
              checked={showAirborneTraffic}
              onChange={(e) => updateDisplay({ showAirborneTraffic: e.target.checked })}
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
            Tilts aircraft based on climb/descent and turn rates. (Per-device setting)
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
      </CollapsibleSection>

      <CollapsibleSection title="UI">
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
      </CollapsibleSection>
    </>
  )
}

export default SettingsDisplayTab
