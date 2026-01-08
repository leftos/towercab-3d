import { useSettingsStore } from '../../stores/settingsStore'
import { useGlobalSettingsStore } from '../../stores/globalSettingsStore'
import CollapsibleSection from './settings/CollapsibleSection'
import type { GroundLabelMode } from '../../types'
import type { AircraftTintColor } from '../../types/settings'
import './ControlsBar.css'

function SettingsAircraftLabelsTab() {
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
  const orientationEmulation = useSettingsStore((state) => state.aircraft.orientationEmulation)
  const orientationIntensity = useSettingsStore((state) => state.aircraft.orientationIntensity)
  const datablockFontSize = useSettingsStore((state) => state.aircraft.datablockFontSize)
  const updateAircraftSettings = useSettingsStore((state) => state.updateAircraftSettings)

  const showAircraftPanel = useSettingsStore((state) => state.ui.showAircraftPanel)
  const updateUISettings = useSettingsStore((state) => state.updateUISettings)

  // Aircraft appearance settings
  const builtinModelBrightness = useSettingsStore((state) => state.graphics.builtinModelBrightness) ?? 1.7
  const builtinModelTintColor = useSettingsStore((state) => state.graphics.builtinModelTintColor) ?? 'lightBlue'
  const fsltlModelBrightness = useSettingsStore((state) => state.graphics.fsltlModelBrightness) ?? 1.0
  const enableAircraftSilhouettes = useSettingsStore((state) => state.graphics.enableAircraftSilhouettes)
  const updateGraphicsSettings = useSettingsStore((state) => state.updateGraphicsSettings)

  return (
    <>
      <CollapsibleSection title="Aircraft Visibility">
        <div className="setting-item">
          <label>Visibility Range</label>
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
          <p className="setting-hint">
            Maximum range for displaying aircraft and labels around the tower.
          </p>
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
      </CollapsibleSection>

      <CollapsibleSection title="Datablocks & Labels">
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
          <label>Leader Line Length</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="0.5"
              max="5"
              step="0.5"
              value={leaderDistance}
              onChange={(e) => updateDisplay({ leaderDistance: Number(e.target.value) })}
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
      </CollapsibleSection>

      <CollapsibleSection title="Aircraft Rendering">
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

        <div className="setting-item">
          <label>Built-in Model Brightness</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="0.5"
              max="3.0"
              step="0.1"
              value={builtinModelBrightness}
              onChange={(e) => updateGraphicsSettings({ builtinModelBrightness: Number(e.target.value) })}
            />
            <span>{(builtinModelBrightness * 100).toFixed(0)}%</span>
          </div>
          <p className="setting-hint">
            Brightness for built-in (FR24) models. Default: 170%.
          </p>
        </div>

        <div className="setting-item">
          <label>Built-in Model Tint</label>
          <select
            value={builtinModelTintColor}
            onChange={(e) => updateGraphicsSettings({ builtinModelTintColor: e.target.value as AircraftTintColor })}
          >
            <option value="white">White (Original)</option>
            <option value="lightBlue">Light Blue</option>
            <option value="tan">Tan/Beige</option>
            <option value="yellow">Yellow</option>
            <option value="orange">Orange</option>
            <option value="lightGray">Light Gray</option>
          </select>
          <p className="setting-hint">
            Tint color for built-in models. Light Blue contrasts with terrain for better visibility.
          </p>
        </div>

        <div className="setting-item">
          <label>FSLTL Model Brightness</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="0.5"
              max="3.0"
              step="0.1"
              value={fsltlModelBrightness}
              onChange={(e) => updateGraphicsSettings({ fsltlModelBrightness: Number(e.target.value) })}
            />
            <span>{(fsltlModelBrightness * 100).toFixed(0)}%</span>
          </div>
          <p className="setting-hint">
            Brightness for imported FSLTL models. Default: 100% (preserves livery colors).
          </p>
        </div>

        <div className="setting-item">
          <label>
            <input
              type="checkbox"
              checked={enableAircraftSilhouettes}
              onChange={(e) => updateGraphicsSettings({ enableAircraftSilhouettes: e.target.checked })}
            />
            Aircraft Outlines
          </label>
          <p className="setting-hint">
            Adds black edge outlines to built-in (FR24) aircraft models. High GPU cost (~20%) - use Aircraft Tint instead for better performance.
          </p>
        </div>
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

export default SettingsAircraftLabelsTab
