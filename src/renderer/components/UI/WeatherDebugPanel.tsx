import { useState } from 'react'
import { useWeatherStore } from '@/stores/weatherStore'
import type { PrecipitationType, CloudLayer } from '@/types'
import './WeatherDebugPanel.css'

type PrecipIntensity = 'none' | 'light' | 'moderate' | 'heavy'
type PrecipType = 'rain' | 'snow'
type CloudCoverage = 'CLR' | 'FEW' | 'SCT' | 'BKN' | 'OVC'

interface DebugCloudLayer {
  coverage: CloudCoverage
  altitudeHundreds: number // Altitude in hundreds of feet AGL
}

/** Convert coverage code to numeric value */
function coverageToValue(coverage: CloudCoverage): number {
  const map: Record<CloudCoverage, number> = {
    'CLR': 0,
    'FEW': 0.1875,
    'SCT': 0.4375,
    'BKN': 0.6875,
    'OVC': 1.0
  }
  return map[coverage]
}

/**
 * Dev-only panel for overriding METAR weather settings
 * to test precipitation effects without waiting for real weather
 */
export function WeatherDebugPanel() {
  const [isOpen, setIsOpen] = useState(false)
  const [precipType, setPrecipType] = useState<PrecipType>('rain')
  const [precipIntensity, setPrecipIntensity] = useState<PrecipIntensity>('none')
  const [windSpeed, setWindSpeed] = useState(10)
  const [windGust, setWindGust] = useState(0)
  const [windDirection, setWindDirection] = useState(270)
  const [hasThunderstorm, setHasThunderstorm] = useState(false)

  // Cloud layer override state
  const [cloudLayersOverride, setCloudLayersOverride] = useState<DebugCloudLayer[]>([])

  const setPrecipitation = useWeatherStore((state) => state.setPrecipitation)
  const setWind = useWeatherStore((state) => state.setWind)
  const setCloudLayers = useWeatherStore((state) => state.setCloudLayers)
  const setDebugOverriding = useWeatherStore((state) => state.setDebugOverriding)
  const triggerInstantUpdate = useWeatherStore((state) => state.triggerInstantUpdate)
  const isDebugOverriding = useWeatherStore((state) => state.isDebugOverriding)
  const currentCloudLayers = useWeatherStore((state) => state.cloudLayers)

  // Apply all weather overrides (precipitation, wind, and clouds)
  const applyOverride = () => {
    // Build precipitation data
    const types: { type: PrecipitationType; intensity: 'light' | 'moderate' | 'heavy'; code: string }[] = []

    if (precipIntensity !== 'none') {
      // Build METAR-style code: '-RA', 'RA', '+RA', etc.
      const intensityPrefix = precipIntensity === 'light' ? '-' : precipIntensity === 'heavy' ? '+' : ''
      const typeCode = precipType === 'rain' ? 'RA' : 'SN'
      types.push({
        type: precipType,
        intensity: precipIntensity as 'light' | 'moderate' | 'heavy',
        code: `${intensityPrefix}${typeCode}`
      })
    }

    const precipState = {
      active: precipIntensity !== 'none',
      types,
      hasThunderstorm,
      visibilityFactor: precipIntensity === 'heavy' ? 2.0 : precipIntensity === 'moderate' ? 1.0 : 0.5
    }
    setPrecipitation(precipState)

    setWind({
      speed: windSpeed,
      direction: windDirection,
      gustSpeed: windGust > 0 ? windGust : null,
      isVariable: false
    })

    // Apply cloud layers
    const layers: CloudLayer[] = cloudLayersOverride
      .filter(l => l.coverage !== 'CLR')
      .map(l => ({
        type: l.coverage,
        coverage: coverageToValue(l.coverage),
        altitude: l.altitudeHundreds * 100 * 0.3048 // Convert hundreds of feet to meters
      }))
      .sort((a, b) => a.altitude - b.altitude)

    setCloudLayers(layers)

    // Enable debug override mode to prevent METAR updates from overwriting
    setDebugOverriding(true)

    // Trigger instant update to bypass smoothing
    triggerInstantUpdate()
  }

  const clearOverride = () => {
    // Clear local UI state
    setPrecipIntensity('none')
    setHasThunderstorm(false)
    setWindSpeed(10)
    setWindGust(0)
    setWindDirection(270)
    setCloudLayersOverride([])

    // Disable debug override mode - this will restore weather from METAR
    setDebugOverriding(false)
  }

  // Cloud layer management
  const addCloudLayer = () => {
    if (cloudLayersOverride.length >= 4) return // Max 4 layers
    setCloudLayersOverride([
      ...cloudLayersOverride,
      { coverage: 'SCT', altitudeHundreds: 30 }
    ])
  }

  const removeCloudLayer = (index: number) => {
    setCloudLayersOverride(cloudLayersOverride.filter((_, i) => i !== index))
  }

  const updateCloudLayer = (index: number, updates: Partial<DebugCloudLayer>) => {
    setCloudLayersOverride(cloudLayersOverride.map((layer, i) =>
      i === index ? { ...layer, ...updates } : layer
    ))
  }

  if (!isOpen) {
    return (
      <button
        className="weather-debug-toggle"
        onClick={() => setIsOpen(true)}
        title="Weather Debug Panel"
      >
        WX
      </button>
    )
  }

  return (
    <div className="weather-debug-panel">
      <div className="weather-debug-header">
        <span>Weather Debug</span>
        <button onClick={() => setIsOpen(false)}>X</button>
      </div>

      <div className="weather-debug-content">
        <div className="weather-debug-row">
          <label>Precipitation</label>
          <select
            value={precipType}
            onChange={(e) => setPrecipType(e.target.value as PrecipType)}
          >
            <option value="rain">Rain</option>
            <option value="snow">Snow</option>
          </select>
        </div>

        <div className="weather-debug-row">
          <label>Intensity</label>
          <select
            value={precipIntensity}
            onChange={(e) => setPrecipIntensity(e.target.value as PrecipIntensity)}
          >
            <option value="none">None</option>
            <option value="light">Light (-)</option>
            <option value="moderate">Moderate</option>
            <option value="heavy">Heavy (+)</option>
          </select>
        </div>

        <div className="weather-debug-row">
          <label>Wind Dir: {windDirection}°</label>
          <input
            type="range"
            min="0"
            max="360"
            step="10"
            value={windDirection}
            onChange={(e) => setWindDirection(Number(e.target.value))}
          />
        </div>

        <div className="weather-debug-row">
          <label>Wind: {windSpeed} kt</label>
          <input
            type="range"
            min="0"
            max="50"
            step="1"
            value={windSpeed}
            onChange={(e) => setWindSpeed(Number(e.target.value))}
          />
        </div>

        <div className="weather-debug-row">
          <label>Gust: {windGust > 0 ? `${windGust} kt` : 'None'}</label>
          <input
            type="range"
            min="0"
            max="60"
            step="1"
            value={windGust}
            onChange={(e) => setWindGust(Number(e.target.value))}
          />
        </div>

        <div className="weather-debug-row">
          <label>
            <input
              type="checkbox"
              checked={hasThunderstorm}
              onChange={(e) => setHasThunderstorm(e.target.checked)}
            />
            Thunderstorm (TS)
          </label>
        </div>

        {/* Cloud Layers Section */}
        <div className="weather-debug-section">
          <div className="weather-debug-section-header">
            <span>Cloud Layers</span>
            <button
              onClick={addCloudLayer}
              disabled={cloudLayersOverride.length >= 4}
              title="Add cloud layer"
            >
              +
            </button>
          </div>

          {/* Current METAR clouds display */}
          {!isDebugOverriding && currentCloudLayers.length > 0 && (
            <div className="weather-debug-metar-clouds">
              <span className="weather-debug-label">From METAR:</span>
              {currentCloudLayers.map((layer, i) => (
                <span key={i} className="weather-debug-cloud-tag">
                  {layer.type}{String(Math.round(layer.altitude / 0.3048 / 100)).padStart(3, '0')}
                </span>
              ))}
            </div>
          )}

          {/* Override cloud layers */}
          {cloudLayersOverride.map((layer, index) => (
            <div key={index} className="weather-debug-cloud-layer">
              <select
                value={layer.coverage}
                onChange={(e) => updateCloudLayer(index, { coverage: e.target.value as CloudCoverage })}
              >
                <option value="CLR">CLR</option>
                <option value="FEW">FEW</option>
                <option value="SCT">SCT</option>
                <option value="BKN">BKN</option>
                <option value="OVC">OVC</option>
              </select>
              <input
                type="number"
                min="1"
                max="500"
                value={layer.altitudeHundreds}
                onChange={(e) => updateCloudLayer(index, { altitudeHundreds: Number(e.target.value) })}
                title="Altitude in hundreds of feet AGL"
              />
              <span className="weather-debug-altitude-label">00 ft</span>
              <button
                onClick={() => removeCloudLayer(index)}
                className="weather-debug-remove"
                title="Remove layer"
              >
                ×
              </button>
            </div>
          ))}
        </div>

        {/* Unified Apply/Clear buttons at the bottom */}
        <div className="weather-debug-buttons">
          <button
            className={isDebugOverriding ? 'active' : ''}
            onClick={applyOverride}
          >
            Apply
          </button>
          <button onClick={clearOverride}>
            Clear
          </button>
        </div>

        {isDebugOverriding && (
          <div className="weather-debug-status">
            Override active (METAR will not overwrite)
          </div>
        )}
      </div>
    </div>
  )
}
