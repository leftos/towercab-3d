import { useSettingsStore } from '../../../stores/settingsStore'
import { formatTimeHour } from '../../../utils/formatting'
import CollapsibleSection from './CollapsibleSection'
import '../ControlsBar.css'

function LightingSettings() {
  const timeMode = useSettingsStore((state) => state.cesium.timeMode)
  const fixedTimeHour = useSettingsStore((state) => state.cesium.fixedTimeHour)
  const enableLighting = useSettingsStore((state) => state.cesium.enableLighting)
  const enableNightDarkening = useSettingsStore((state) => state.graphics.enableNightDarkening)
  const nightDarkeningIntensity = useSettingsStore((state) => state.graphics.nightDarkeningIntensity)
  const updateCesiumSettings = useSettingsStore((state) => state.updateCesiumSettings)
  const updateGraphicsSettings = useSettingsStore((state) => state.updateGraphicsSettings)

  return (
    <CollapsibleSection title="Lighting">
      <div className="setting-item">
        <label>Time of Day</label>
        <div className="radio-group">
          <label>
            <input
              type="radio"
              name="timeMode"
              value="real"
              checked={timeMode === 'real'}
              onChange={() => updateCesiumSettings({ timeMode: 'real' })}
            />
            Real Time
          </label>
          <label>
            <input
              type="radio"
              name="timeMode"
              value="fixed"
              checked={timeMode === 'fixed'}
              onChange={() => updateCesiumSettings({ timeMode: 'fixed' })}
            />
            Fixed Time
          </label>
        </div>
      </div>

      {timeMode === 'fixed' && (
        <div className="setting-item">
          <label>Local Time</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="0"
              max="24"
              step="0.5"
              value={fixedTimeHour}
              onChange={(e) => updateCesiumSettings({ fixedTimeHour: Number(e.target.value) })}
            />
            <span>{formatTimeHour(fixedTimeHour)}</span>
          </div>
        </div>
      )}

      <div className="setting-item">
        <label>
          <input
            type="checkbox"
            checked={enableNightDarkening}
            onChange={(e) => updateGraphicsSettings({ enableNightDarkening: e.target.checked })}
            disabled={!enableLighting}
          />
          Night-Time Darkening
        </label>
        <p className="setting-hint">
          Darkens satellite imagery at night based on sun position.
          {!enableLighting && ' (Requires Globe Lighting enabled)'}
        </p>
      </div>

      {enableNightDarkening && enableLighting && (
        <div className="setting-item">
          <label>Darkening Intensity</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={nightDarkeningIntensity}
              onChange={(e) => updateGraphicsSettings({ nightDarkeningIntensity: Number(e.target.value) })}
            />
            <span>{Math.round(nightDarkeningIntensity * 100)}%</span>
          </div>
          <p className="setting-hint">
            Higher values make nights darker.
          </p>
        </div>
      )}
    </CollapsibleSection>
  )
}

export default LightingSettings
