import { useSettingsStore } from '../../../stores/settingsStore'
import CollapsibleSection from './CollapsibleSection'
import '../ControlsBar.css'

function ShadowSettings() {
  const enableShadows = useSettingsStore((state) => state.graphics.enableShadows)
  const shadowMapSize = useSettingsStore((state) => state.graphics.shadowMapSize)
  const shadowMaxDistance = useSettingsStore((state) => state.graphics.shadowMaxDistance)
  const shadowDarkness = useSettingsStore((state) => state.graphics.shadowDarkness)
  const shadowSoftness = useSettingsStore((state) => state.graphics.shadowSoftness)
  const shadowFadingEnabled = useSettingsStore((state) => state.graphics.shadowFadingEnabled)
  const shadowNormalOffset = useSettingsStore((state) => state.graphics.shadowNormalOffset)
  const aircraftShadowsOnly = useSettingsStore((state) => state.graphics.aircraftShadowsOnly)
  const shadowDepthBias = useSettingsStore((state) => state.graphics.shadowDepthBias) ?? 0.0004
  const shadowPolygonOffsetFactor = useSettingsStore((state) => state.graphics.shadowPolygonOffsetFactor) ?? 1.1
  const shadowPolygonOffsetUnits = useSettingsStore((state) => state.graphics.shadowPolygonOffsetUnits) ?? 4.0
  const cameraNearPlane = useSettingsStore((state) => state.graphics.cameraNearPlane) ?? 0.1
  const updateGraphicsSettings = useSettingsStore((state) => state.updateGraphicsSettings)

  return (
    <CollapsibleSection title="Shadows">
      <div className="setting-item">
        <label>
          <input
            type="checkbox"
            checked={enableShadows}
            onChange={(e) => updateGraphicsSettings({ enableShadows: e.target.checked })}
          />
          Enable Shadows
        </label>
        <p className="setting-hint">
          Enables shadow casting for terrain and 3D models. Performance impact.
        </p>
      </div>

      <div className={`shadow-settings-group ${!enableShadows ? 'disabled' : ''}`}>
        <div className="setting-item">
          <label>
            <input
              type="checkbox"
              checked={aircraftShadowsOnly}
              onChange={(e) => updateGraphicsSettings({ aircraftShadowsOnly: e.target.checked })}
            />
            Aircraft Shadows Only
          </label>
          <p className="setting-hint">
            Only aircraft cast shadows. Disables terrain self-shadowing for better performance.
          </p>
        </div>

        <div className="setting-item">
          <label>Shadow Map Size</label>
          <select
            value={shadowMapSize}
            onChange={(e) => updateGraphicsSettings({ shadowMapSize: Number(e.target.value) as 1024 | 2048 | 4096 | 8192 })}
            className="select-input"
          >
            <option value={1024}>1024 (Low)</option>
            <option value={2048}>2048 (Medium)</option>
            <option value={4096}>4096 (High)</option>
            <option value={8192}>8192 (Ultra)</option>
          </select>
          <p className="setting-hint">
            Shadow texture resolution. Higher = sharper shadows, more VRAM. 8192 uses ~256MB VRAM.
          </p>
        </div>

        <div className="setting-item">
          <label>Shadow Max Distance</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="100"
              max="20000"
              step="100"
              value={shadowMaxDistance}
              onChange={(e) => updateGraphicsSettings({ shadowMaxDistance: Number(e.target.value) })}
            />
            <span>{shadowMaxDistance}m</span>
          </div>
          <p className="setting-hint">
            Maximum distance for rendering shadows. Higher values reduce banding but may impact performance. Default: 10000m (10km).
          </p>
        </div>

        <div className="setting-item">
          <label>Shadow Darkness</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={shadowDarkness}
              onChange={(e) => updateGraphicsSettings({ shadowDarkness: Number(e.target.value) })}
            />
            <span>{(shadowDarkness * 100).toFixed(0)}%</span>
          </div>
          <p className="setting-hint">
            Shadow intensity. 0% = invisible, 100% = black.
          </p>
        </div>

        <div className="setting-item">
          <label>
            <input
              type="checkbox"
              checked={shadowSoftness}
              onChange={(e) => updateGraphicsSettings({ shadowSoftness: e.target.checked })}
            />
            Soft Shadows
          </label>
          <p className="setting-hint">
            Blur shadow edges. Disable for sharper (but potentially aliased) shadows.
          </p>
        </div>

        <div className="setting-item">
          <label>
            <input
              type="checkbox"
              checked={shadowFadingEnabled}
              onChange={(e) => updateGraphicsSettings({ shadowFadingEnabled: e.target.checked })}
            />
            Shadow Fading
          </label>
          <p className="setting-hint">
            Fade shadows at the edge of shadow distance.
          </p>
        </div>

        <div className="setting-item">
          <label>
            <input
              type="checkbox"
              checked={shadowNormalOffset}
              onChange={(e) => updateGraphicsSettings({ shadowNormalOffset: e.target.checked })}
            />
            Normal Offset
          </label>
          <p className="setting-hint">
            Reduces shadow acne artifacts. Try disabling if you see banding.
          </p>
        </div>

        <div className="setting-item">
          <label>Shadow Depth Bias</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="0.00001"
              max="0.01"
              step="0.00001"
              value={shadowDepthBias}
              onChange={(e) => updateGraphicsSettings({ shadowDepthBias: Number(e.target.value) })}
            />
            <span>{shadowDepthBias.toFixed(5)}</span>
          </div>
          <p className="setting-hint">
            Reduces shadow banding. Increase if you see striped shadows.
          </p>
        </div>

        <div className="setting-item">
          <label>Polygon Offset Factor</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="0.1"
              max="5"
              step="0.1"
              value={shadowPolygonOffsetFactor}
              onChange={(e) => updateGraphicsSettings({ shadowPolygonOffsetFactor: Number(e.target.value) })}
            />
            <span>{shadowPolygonOffsetFactor.toFixed(1)}</span>
          </div>
          <p className="setting-hint">
            Shadow depth offset multiplier based on polygon slope.
          </p>
        </div>

        <div className="setting-item">
          <label>Polygon Offset Units</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="0.1"
              max="10"
              step="0.1"
              value={shadowPolygonOffsetUnits}
              onChange={(e) => updateGraphicsSettings({ shadowPolygonOffsetUnits: Number(e.target.value) })}
            />
            <span>{shadowPolygonOffsetUnits.toFixed(1)}</span>
          </div>
          <p className="setting-hint">
            Constant shadow depth offset.
          </p>
        </div>

        <div className="setting-item">
          <label>Camera Near Plane</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="0.1"
              max="10"
              step="0.1"
              value={cameraNearPlane}
              onChange={(e) => updateGraphicsSettings({ cameraNearPlane: Number(e.target.value) })}
            />
            <span>{cameraNearPlane.toFixed(1)}m</span>
          </div>
          <p className="setting-hint">
            Minimum render distance. Higher values improve shadow/depth precision but clip nearby objects.
          </p>
        </div>
      </div>
    </CollapsibleSection>
  )
}

export default ShadowSettings
