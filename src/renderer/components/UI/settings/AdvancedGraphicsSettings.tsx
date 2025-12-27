import { useSettingsStore } from '../../../stores/settingsStore'
import type { AircraftTintColor } from '../../../types/settings'
import '../ControlsBar.css'

function AdvancedGraphicsSettings() {
  // Settings store - Experimental Graphics (Graphics group)
  const msaaSamples = useSettingsStore((state) => state.graphics.msaaSamples)
  const enableFxaa = useSettingsStore((state) => state.graphics.enableFxaa)
  const enableHdr = useSettingsStore((state) => state.graphics.enableHdr)
  const enableLogDepth = useSettingsStore((state) => state.graphics.enableLogDepth)
  const enableGroundAtmosphere = useSettingsStore((state) => state.graphics.enableGroundAtmosphere)
  const enableAmbientOcclusion = useSettingsStore((state) => state.graphics.enableAmbientOcclusion)
  const enableAircraftSilhouettes = useSettingsStore((state) => state.graphics.enableAircraftSilhouettes)
  const enableLighting = useSettingsStore((state) => state.cesium.enableLighting)
  const enableShadows = useSettingsStore((state) => state.graphics.enableShadows)
  const shadowMapSize = useSettingsStore((state) => state.graphics.shadowMapSize)
  const shadowMaxDistance = useSettingsStore((state) => state.graphics.shadowMaxDistance)
  const shadowDarkness = useSettingsStore((state) => state.graphics.shadowDarkness)
  const shadowSoftness = useSettingsStore((state) => state.graphics.shadowSoftness)
  const shadowFadingEnabled = useSettingsStore((state) => state.graphics.shadowFadingEnabled)
  const shadowNormalOffset = useSettingsStore((state) => state.graphics.shadowNormalOffset)
  const aircraftShadowsOnly = useSettingsStore((state) => state.graphics.aircraftShadowsOnly)
  // New shadow bias settings - use defaults if not yet migrated in localStorage
  const shadowDepthBias = useSettingsStore((state) => state.graphics.shadowDepthBias) ?? 0.0004
  const shadowPolygonOffsetFactor = useSettingsStore((state) => state.graphics.shadowPolygonOffsetFactor) ?? 1.1
  const shadowPolygonOffsetUnits = useSettingsStore((state) => state.graphics.shadowPolygonOffsetUnits) ?? 4.0
  const cameraNearPlane = useSettingsStore((state) => state.graphics.cameraNearPlane) ?? 0.1
  const builtinModelBrightness = useSettingsStore((state) => state.graphics.builtinModelBrightness) ?? 1.7
  const fsltlModelBrightness = useSettingsStore((state) => state.graphics.fsltlModelBrightness) ?? 1.0
  const builtinModelTintColor = useSettingsStore((state) => state.graphics.builtinModelTintColor) ?? 'lightBlue'
  const updateGraphicsSettings = useSettingsStore((state) => state.updateGraphicsSettings)
  const updateCesiumSettings = useSettingsStore((state) => state.updateCesiumSettings)

  return (
    <div className="settings-section">
      <h3>Advanced Graphics (Experimental)</h3>
      <p className="setting-hint" style={{ marginBottom: '12px' }}>
        Adjust these settings to troubleshoot terrain texture banding or visual artifacts.
      </p>

      <div className="setting-item">
        <label>MSAA Samples</label>
        <select
          value={msaaSamples}
          onChange={(e) => updateGraphicsSettings({ msaaSamples: Number(e.target.value) as 1 | 2 | 4 | 8 })}
          className="select-input"
        >
          <option value={1}>1 (Off)</option>
          <option value={2}>2x</option>
          <option value={4}>4x (Default)</option>
          <option value={8}>8x</option>
        </select>
        <p className="setting-hint">
          Multisample anti-aliasing. Changing this will briefly reload the 3D view.
        </p>
      </div>

      <div className="setting-item">
        <label>
          <input
            type="checkbox"
            checked={enableFxaa}
            onChange={(e) => updateGraphicsSettings({ enableFxaa: e.target.checked })}
          />
          FXAA (Fast Approximate Anti-Aliasing)
        </label>
        <p className="setting-hint">
          Post-process anti-aliasing. Works with MSAA for smoother edges.
        </p>
      </div>

      <div className="setting-item">
        <label>
          <input
            type="checkbox"
            checked={enableHdr}
            onChange={(e) => updateGraphicsSettings({ enableHdr: e.target.checked })}
          />
          HDR (High Dynamic Range)
        </label>
        <p className="setting-hint">
          Enables high dynamic range rendering. May cause color banding on some GPUs.
        </p>
      </div>

      <div className="setting-item">
        <label>
          <input
            type="checkbox"
            checked={enableLogDepth}
            onChange={(e) => updateGraphicsSettings({ enableLogDepth: e.target.checked })}
          />
          Logarithmic Depth Buffer
        </label>
        <p className="setting-hint">
          Improves depth precision at large distances. Reduces z-fighting artifacts.
        </p>
      </div>

      <div className="setting-item">
        <label>
          <input
            type="checkbox"
            checked={enableGroundAtmosphere}
            onChange={(e) => updateGraphicsSettings({ enableGroundAtmosphere: e.target.checked })}
          />
          Ground Atmosphere
        </label>
        <p className="setting-hint">
          Adds atmospheric haze effect to distant terrain.
        </p>
      </div>

      <div className="setting-item">
        <label>
          <input
            type="checkbox"
            checked={enableAmbientOcclusion}
            onChange={(e) => updateGraphicsSettings({ enableAmbientOcclusion: e.target.checked })}
          />
          Ambient Occlusion (HBAO)
        </label>
        <p className="setting-hint">
          Darkens creases and corners for depth. Can cause visible banding artifacts - disable if you see dark bands.
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

      <div className="setting-item">
        <label>
          <input
            type="checkbox"
            checked={enableLighting}
            onChange={(e) => updateCesiumSettings({ enableLighting: e.target.checked })}
          />
          Globe Lighting
        </label>
        <p className="setting-hint">
          Enables sun-based lighting on terrain. Affects day/night cycle.
        </p>
      </div>

      <h4 style={{ marginTop: '16px', marginBottom: '8px', opacity: 0.8 }}>Model Appearance</h4>

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

      <h4 style={{ marginTop: '16px', marginBottom: '8px', opacity: 0.8 }}>Shadows</h4>

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
            Shadow brightness. 0% = black shadows, 100% = invisible shadows.
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
    </div>
  )
}

export default AdvancedGraphicsSettings
