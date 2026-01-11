import { useSettingsStore } from '../../stores/settingsStore'
import { useWeatherStore } from '../../stores/weatherStore'
import { formatTimeHour } from '../../utils/formatting'
import CollapsibleSection from './settings/CollapsibleSection'
import type { BuildingQuality, InsetMsaaPreset, InsetTerrainPreset, InsetCachePreset } from '../../types'
import './ControlsBar.css'

function SettingsGraphicsWeatherTab() {
  // Rendering quality settings
  const maxFramerate = useSettingsStore((state) => state.graphics.maxFramerate) ?? 60
  const msaaSamples = useSettingsStore((state) => state.graphics.msaaSamples)
  const enableFxaa = useSettingsStore((state) => state.graphics.enableFxaa)
  const enableHdr = useSettingsStore((state) => state.graphics.enableHdr)
  const enableLogDepth = useSettingsStore((state) => state.graphics.enableLogDepth)
  const insetGraphics = useSettingsStore((state) => state.graphics.insetGraphics)
  const updateGraphicsSettings = useSettingsStore((state) => state.updateGraphicsSettings)

  // Terrain settings
  const terrainQuality = useSettingsStore((state) => state.cesium.terrainQuality)
  const show3DBuildings = useSettingsStore((state) => state.cesium.show3DBuildings)
  const buildingQuality = useSettingsStore((state) => state.cesium.buildingQuality)
  const enableTerrainFlattening = useSettingsStore((state) => state.cesium.enableTerrainFlattening)
  const terrainBlendDistance = useSettingsStore((state) => state.cesium.terrainBlendDistance)
  const updateCesiumSettings = useSettingsStore((state) => state.updateCesiumSettings)

  // Lighting & atmosphere settings
  const timeMode = useSettingsStore((state) => state.cesium.timeMode)
  const fixedTimeHour = useSettingsStore((state) => state.cesium.fixedTimeHour)
  const enableLighting = useSettingsStore((state) => state.cesium.enableLighting)
  const enableNightDarkening = useSettingsStore((state) => state.graphics.enableNightDarkening)
  const nightDarkeningIntensity = useSettingsStore((state) => state.graphics.nightDarkeningIntensity)
  const aircraftNightVisibility = useSettingsStore((state) => state.graphics.aircraftNightVisibility)
  const enableGroundAtmosphere = useSettingsStore((state) => state.graphics.enableGroundAtmosphere)

  // Shadow settings
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

  // Weather settings
  const showWeatherEffects = useSettingsStore((state) => state.weather.showWeatherEffects)
  const showCesiumFog = useSettingsStore((state) => state.weather.showCesiumFog)
  const showBabylonFog = useSettingsStore((state) => state.weather.showBabylonFog)
  const showClouds = useSettingsStore((state) => state.weather.showClouds)
  const cloudOpacity = useSettingsStore((state) => state.weather.cloudOpacity)
  const fogIntensity = useSettingsStore((state) => state.weather.fogIntensity)
  const visibilityScale = useSettingsStore((state) => state.weather.visibilityScale)
  const showPrecipitation = useSettingsStore((state) => state.weather.showPrecipitation ?? true)
  const precipitationIntensity = useSettingsStore((state) => state.weather.precipitationIntensity ?? 1.0)
  const showLightning = useSettingsStore((state) => state.weather.showLightning ?? true)
  const enableWeatherInterpolation = useSettingsStore((state) => state.weather.enableWeatherInterpolation ?? true)
  const updateWeatherSettings = useSettingsStore((state) => state.updateWeatherSettings)

  // Weather store
  const currentMetar = useWeatherStore((state) => state.currentMetar)
  const interpolatedWeather = useWeatherStore((state) => state.interpolatedWeather)
  const isLoadingWeather = useWeatherStore((state) => state.isLoading)

  // Post-processing
  const enableAmbientOcclusion = useSettingsStore((state) => state.graphics.enableAmbientOcclusion)

  return (
    <>
      <CollapsibleSection title="Rendering Quality">
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
              checked={insetGraphics.enabled}
              onChange={(e) => updateGraphicsSettings({
                insetGraphics: { ...insetGraphics, enabled: e.target.checked }
              })}
            />
            Enhanced Inset Rendering
          </label>
          <p className="setting-hint">
            Enable customizable graphics quality for inset viewports. When disabled, insets use performance mode (minimal quality).
          </p>
        </div>

        {insetGraphics.enabled && (
          <div className="inset-settings-group">
            <p className="setting-hint" style={{ marginBottom: '12px', color: '#ffa500' }}>
              Each inset viewport uses separate GPU resources. Enable features sparingly with multiple insets.
            </p>

            <div className="setting-item">
              <label>
                <input
                  type="checkbox"
                  checked={insetGraphics.buildings}
                  onChange={(e) => updateGraphicsSettings({
                    insetGraphics: { ...insetGraphics, buildings: e.target.checked }
                  })}
                />
                3D Buildings in Insets
              </label>
              <p className="setting-hint">
                Show OSM 3D buildings in insets (requires main 3D Buildings enabled). Impact: Medium
              </p>
            </div>

            <div className="setting-item">
              <label>
                <input
                  type="checkbox"
                  checked={insetGraphics.shadows}
                  onChange={(e) => updateGraphicsSettings({
                    insetGraphics: { ...insetGraphics, shadows: e.target.checked }
                  })}
                />
                Shadows in Insets
              </label>
              <p className="setting-hint">
                Enable shadow rendering in insets. Impact: High
              </p>
            </div>

            <div className="setting-item">
              <label>
                <input
                  type="checkbox"
                  checked={insetGraphics.silhouettes}
                  onChange={(e) => updateGraphicsSettings({
                    insetGraphics: { ...insetGraphics, silhouettes: e.target.checked }
                  })}
                />
                Aircraft Silhouettes in Insets
              </label>
              <p className="setting-hint">
                Show edge outlines on aircraft models. Impact: Medium-High
              </p>
            </div>

            <div className="setting-item">
              <label>Inset MSAA Quality</label>
              <select
                value={insetGraphics.msaa}
                onChange={(e) => updateGraphicsSettings({
                  insetGraphics: { ...insetGraphics, msaa: e.target.value as InsetMsaaPreset }
                })}
                className="select-input"
              >
                <option value="low">Low (2x MSAA)</option>
                <option value="medium">Medium (4x MSAA)</option>
                <option value="match">Match Main Viewport</option>
              </select>
              <p className="setting-hint">
                Anti-aliasing quality for inset viewports.
              </p>
            </div>

            <div className="setting-item">
              <label>Inset Terrain Detail</label>
              <select
                value={insetGraphics.terrain}
                onChange={(e) => updateGraphicsSettings({
                  insetGraphics: { ...insetGraphics, terrain: e.target.value as InsetTerrainPreset }
                })}
                className="select-input"
              >
                <option value="low">Low (fast loading)</option>
                <option value="medium">Medium (balanced)</option>
                <option value="match">Match Main Viewport</option>
              </select>
              <p className="setting-hint">
                Terrain tile quality and loading priority.
              </p>
            </div>

            <div className="setting-item">
              <label>Inset Tile Caching</label>
              <select
                value={insetGraphics.cache}
                onChange={(e) => updateGraphicsSettings({
                  insetGraphics: { ...insetGraphics, cache: e.target.value as InsetCachePreset }
                })}
                className="select-input"
              >
                <option value="minimal">Minimal (50 tiles)</option>
                <option value="standard">Standard (200 tiles)</option>
                <option value="match">Match Main Viewport</option>
              </select>
              <p className="setting-hint">
                How many terrain/imagery tiles to cache in memory.
              </p>
            </div>

            <div className="setting-item">
              <label>
                <input
                  type="checkbox"
                  checked={insetGraphics.preloadTiles}
                  onChange={(e) => updateGraphicsSettings({
                    insetGraphics: { ...insetGraphics, preloadTiles: e.target.checked }
                  })}
                />
                Preload Tiles in Insets
              </label>
              <p className="setting-hint">
                Preload nearby tiles for smoother camera movement. Impact: Low-Medium
              </p>
            </div>
          </div>
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Terrain & Buildings">
        <div className="setting-item">
          <label>Terrain Quality</label>
          <div className="slider-with-value">
            <input
              type="range"
              min="1"
              max="5"
              step="1"
              value={terrainQuality}
              onChange={(e) => updateCesiumSettings({ terrainQuality: Number(e.target.value) as 1 | 2 | 3 | 4 | 5 })}
            />
            <span>{['Low', 'Medium', 'High', 'Very High', 'Ultra'][terrainQuality - 1]}</span>
          </div>
          <p className="setting-hint">
            Lower quality loads faster. Higher quality shows more detail at distance.
          </p>
        </div>

        <div className="setting-item">
          <label>
            <input
              type="checkbox"
              checked={show3DBuildings}
              onChange={(e) => updateCesiumSettings({ show3DBuildings: e.target.checked })}
            />
            Show 3D Buildings (OSM)
          </label>
          <p className="setting-hint">
            Display OpenStreetMap 3D buildings. May impact performance.
          </p>
        </div>

        {show3DBuildings && (
          <div className="setting-item">
            <label>Building Quality</label>
            <select
              value={buildingQuality ?? 'low'}
              onChange={(e) => updateCesiumSettings({ buildingQuality: e.target.value as BuildingQuality })}
            >
              <option value="low">Low (save memory)</option>
              <option value="medium">Medium (balanced)</option>
              <option value="high">High (stay visible when zoomed out)</option>
            </select>
            <p className="setting-hint">
              Higher quality keeps buildings visible at greater zoom distances but uses more memory.
            </p>
          </div>
        )}

        <div className="setting-item">
          <label>
            <input
              type="checkbox"
              checked={enableTerrainFlattening}
              onChange={(e) => updateCesiumSettings({ enableTerrainFlattening: e.target.checked })}
            />
            Flatten Airport Runways
          </label>
          <p className="setting-hint">
            Flattens runway surfaces to their proper elevations. Prevents aircraft from bouncing on uneven terrain.
          </p>
        </div>

        {enableTerrainFlattening && (
          <div className="setting-item">
            <label>Runway Edge Blend Distance</label>
            <div className="slider-with-value">
              <input
                type="range"
                min="25"
                max="100"
                step="5"
                value={terrainBlendDistance}
                onChange={(e) => updateCesiumSettings({ terrainBlendDistance: Number(e.target.value) })}
              />
              <span>{terrainBlendDistance}m</span>
            </div>
            <p className="setting-hint">
              Smooth transition zone between flat runway and natural terrain. Higher = smoother edges.
            </p>
          </div>
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Lighting & Atmosphere">
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
              checked={enableLighting}
              onChange={(e) => updateCesiumSettings({ enableLighting: e.target.checked })}
            />
            Globe Lighting
          </label>
          <p className="setting-hint">
            Enables sun-based lighting on terrain. Affects day/night cycle.
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
          <>
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

            <div className="setting-item">
              <label>Aircraft Night Visibility</label>
              <div className="slider-with-value">
                <input
                  type="range"
                  min="1"
                  max="3"
                  step="0.1"
                  value={aircraftNightVisibility}
                  onChange={(e) => updateGraphicsSettings({ aircraftNightVisibility: Number(e.target.value) })}
                />
                <span>{aircraftNightVisibility.toFixed(1)}x</span>
              </div>
              <p className="setting-hint">
                Boosts aircraft brightness at night. 1.0 = no boost, 1.5 = moderate, 2.0+ = bright.
              </p>
            </div>
          </>
        )}
      </CollapsibleSection>

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

      <CollapsibleSection title="Weather Effects (METAR)">
        <div className="setting-item">
          <label>
            <input
              type="checkbox"
              checked={showWeatherEffects}
              onChange={(e) => updateWeatherSettings({ showWeatherEffects: e.target.checked })}
            />
            Enable Weather Effects
          </label>
          <p className="setting-hint">
            Fetches real weather data for the current airport.
          </p>
        </div>

        <div className="setting-item">
          <label>
            <input
              type="checkbox"
              checked={enableWeatherInterpolation}
              onChange={(e) => updateWeatherSettings({ enableWeatherInterpolation: e.target.checked })}
              disabled={!showWeatherEffects}
            />
            Interpolate Weather from Nearby Stations
          </label>
          <p className="setting-hint">
            Blend weather from the 3 nearest METAR stations based on camera position.
          </p>
          {showWeatherEffects && enableWeatherInterpolation && interpolatedWeather &&
            interpolatedWeather.sourceStations.length > 1 && (
            <p className="setting-hint" style={{ marginTop: '4px', opacity: 0.8 }}>
              Sources: {interpolatedWeather.sourceStations.map(s =>
                `${s.icao} (${Math.round(s.weight * 100)}%)`
              ).join(', ')}
            </p>
          )}
        </div>

        {showWeatherEffects && (
          <>
            <div className="setting-item">
              <label>
                <input
                  type="checkbox"
                  checked={showCesiumFog}
                  onChange={(e) => updateWeatherSettings({ showCesiumFog: e.target.checked })}
                />
                Cesium Fog (Distance Fade)
              </label>
              <p className="setting-hint">
                Reduces terrain/imagery draw distance based on visibility.
              </p>
            </div>

            <div className="setting-item">
              <label>
                <input
                  type="checkbox"
                  checked={showBabylonFog}
                  onChange={(e) => updateWeatherSettings({ showBabylonFog: e.target.checked })}
                />
                Babylon Fog (Visual Atmosphere)
              </label>
              <p className="setting-hint">
                Adds visible fog effect to aircraft and overlays.
              </p>
            </div>

            <div className="setting-item">
              <label>
                <input
                  type="checkbox"
                  checked={showClouds}
                  onChange={(e) => updateWeatherSettings({ showClouds: e.target.checked })}
                />
                Show Cloud Layers
              </label>
            </div>

            <div className="setting-item">
              <label>Cloud Opacity</label>
              <div className="slider-with-value">
                <input
                  type="range"
                  min="0.3"
                  max="0.8"
                  step="0.1"
                  value={cloudOpacity}
                  onChange={(e) => updateWeatherSettings({ cloudOpacity: Number(e.target.value) })}
                />
                <span>{Math.round(cloudOpacity * 100)}%</span>
              </div>
            </div>

            <div className="setting-item">
              <label>Fog Intensity</label>
              <div className="slider-with-value">
                <input
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.1"
                  value={fogIntensity}
                  onChange={(e) => updateWeatherSettings({ fogIntensity: Number(e.target.value) })}
                  disabled={!showBabylonFog}
                />
                <span>{fogIntensity.toFixed(1)}x</span>
              </div>
              <p className="setting-hint">
                How opaque the fog dome appears. Lower = clearer.
              </p>
            </div>

            <div className="setting-item">
              <label>Visibility Scale</label>
              <div className="slider-with-value">
                <input
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.1"
                  value={visibilityScale}
                  onChange={(e) => updateWeatherSettings({ visibilityScale: Number(e.target.value) })}
                  disabled={!showBabylonFog}
                />
                <span>{visibilityScale.toFixed(1)}x</span>
              </div>
              <p className="setting-hint">
                Multiplier for fog distance. 2.0 = see twice as far as METAR visibility.
              </p>
            </div>

            <div className="setting-item">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={showPrecipitation}
                  onChange={(e) => updateWeatherSettings({ showPrecipitation: e.target.checked })}
                />
                Show Precipitation (Rain/Snow)
              </label>
            </div>

            <div className="setting-item">
              <label>Precipitation Intensity</label>
              <div className="slider-with-value">
                <input
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.1"
                  value={precipitationIntensity}
                  onChange={(e) => updateWeatherSettings({ precipitationIntensity: Number(e.target.value) })}
                  disabled={!showPrecipitation}
                />
                <span>{precipitationIntensity.toFixed(1)}x</span>
              </div>
              <p className="setting-hint">
                Particle density for rain and snow effects.
              </p>
            </div>

            <div className="setting-item">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={showLightning}
                  onChange={(e) => updateWeatherSettings({ showLightning: e.target.checked })}
                  disabled={!showPrecipitation}
                />
                Show Lightning (Thunderstorms)
              </label>
            </div>

            <div className="setting-item weather-status">
              {isLoadingWeather ? (
                <span className="loading">Loading weather...</span>
              ) : currentMetar ? (
                <span>
                  <strong>{currentMetar.fltCat}</strong> - Vis {currentMetar.visib}SM
                  {currentMetar.clouds.length > 0 && (
                    <> | {currentMetar.clouds.map(c => `${c.cover}${Math.round(c.base / 100).toString().padStart(3, '0')}`).join(' ')}</>
                  )}
                </span>
              ) : (
                <span className="no-data">No weather data available</span>
              )}
            </div>
          </>
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Post-Processing">
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
      </CollapsibleSection>
    </>
  )
}

export default SettingsGraphicsWeatherTab
