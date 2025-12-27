import { useSettingsStore } from '../../../stores/settingsStore'
import CollapsibleSection from './CollapsibleSection'
import '../ControlsBar.css'

function RenderingSettings() {
  const maxFramerate = useSettingsStore((state) => state.graphics.maxFramerate) ?? 60
  const msaaSamples = useSettingsStore((state) => state.graphics.msaaSamples)
  const enableFxaa = useSettingsStore((state) => state.graphics.enableFxaa)
  const enableHdr = useSettingsStore((state) => state.graphics.enableHdr)
  const enableLogDepth = useSettingsStore((state) => state.graphics.enableLogDepth)
  const enableGroundAtmosphere = useSettingsStore((state) => state.graphics.enableGroundAtmosphere)
  const enableAmbientOcclusion = useSettingsStore((state) => state.graphics.enableAmbientOcclusion)
  const enableAircraftSilhouettes = useSettingsStore((state) => state.graphics.enableAircraftSilhouettes)
  const enableLighting = useSettingsStore((state) => state.cesium.enableLighting)
  const updateGraphicsSettings = useSettingsStore((state) => state.updateGraphicsSettings)
  const updateCesiumSettings = useSettingsStore((state) => state.updateCesiumSettings)

  return (
    <CollapsibleSection title="Rendering">
      <div className="setting-item">
        <label>Max Framerate</label>
        <select
          value={maxFramerate}
          onChange={(e) => updateGraphicsSettings({ maxFramerate: Number(e.target.value) })}
          className="select-input"
        >
          <option value={30}>30 FPS</option>
          <option value={60}>60 FPS (Default)</option>
          <option value={120}>120 FPS</option>
          <option value={144}>144 FPS</option>
          <option value={0}>Unlimited</option>
        </select>
        <p className="setting-hint">
          Limits rendering to reduce GPU usage and heat. Use 60 FPS for most displays.
        </p>
      </div>

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
    </CollapsibleSection>
  )
}

export default RenderingSettings
