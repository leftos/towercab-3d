import { useSettingsStore } from '../../../stores/settingsStore'
import type { AircraftTintColor } from '../../../types/settings'
import CollapsibleSection from './CollapsibleSection'
import '../ControlsBar.css'

function ModelAppearanceSettings() {
  const builtinModelBrightness = useSettingsStore((state) => state.graphics.builtinModelBrightness) ?? 1.7
  const builtinModelTintColor = useSettingsStore((state) => state.graphics.builtinModelTintColor) ?? 'lightBlue'
  const fsltlModelBrightness = useSettingsStore((state) => state.graphics.fsltlModelBrightness) ?? 1.0
  const updateGraphicsSettings = useSettingsStore((state) => state.updateGraphicsSettings)

  return (
    <CollapsibleSection title="Model Appearance">
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
    </CollapsibleSection>
  )
}

export default ModelAppearanceSettings
