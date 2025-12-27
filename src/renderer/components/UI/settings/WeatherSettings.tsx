import { useSettingsStore } from '../../../stores/settingsStore'
import { useWeatherStore } from '../../../stores/weatherStore'
import CollapsibleSection from './CollapsibleSection'
import '../ControlsBar.css'

function WeatherSettings() {
  // Settings store - Weather
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

  return (
    <CollapsibleSection title="Weather (METAR)">
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
  )
}

export default WeatherSettings
