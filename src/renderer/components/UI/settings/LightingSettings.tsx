import { useSettingsStore } from '../../../stores/settingsStore'
import { formatTimeHour } from '../../../utils/formatting'
import '../ControlsBar.css'

function LightingSettings() {
  const timeMode = useSettingsStore((state) => state.cesium.timeMode)
  const fixedTimeHour = useSettingsStore((state) => state.cesium.fixedTimeHour)
  const updateCesiumSettings = useSettingsStore((state) => state.updateCesiumSettings)

  return (
    <div className="settings-section">
      <h3>Lighting</h3>
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
    </div>
  )
}

export default LightingSettings
