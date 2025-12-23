import { useState } from 'react'
import { useWeatherStore } from '@/stores/weatherStore'
import type { PrecipitationType } from '@/types'
import './WeatherDebugPanel.css'

type PrecipIntensity = 'none' | 'light' | 'moderate' | 'heavy'
type PrecipType = 'rain' | 'snow'

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
  const [isOverriding, setIsOverriding] = useState(false)

  const setPrecipitation = useWeatherStore((state) => state.setPrecipitation)
  const setWind = useWeatherStore((state) => state.setWind)

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
    console.log('[WeatherDebug] Setting precipitation:', precipState)
    setPrecipitation(precipState)

    setWind({
      speed: windSpeed,
      direction: windDirection,
      gustSpeed: windGust > 0 ? windGust : null,
      isVariable: false
    })

    setIsOverriding(true)
  }

  const clearOverride = () => {
    // Reset to no precipitation
    setPrecipitation({
      active: false,
      types: [],
      hasThunderstorm: false,
      visibilityFactor: 1.0
    })
    setWind({
      speed: 0,
      direction: 0,
      gustSpeed: null,
      isVariable: false
    })
    setIsOverriding(false)
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

        <div className="weather-debug-buttons">
          <button
            className={isOverriding ? 'active' : ''}
            onClick={applyOverride}
          >
            Apply
          </button>
          <button onClick={clearOverride}>
            Clear
          </button>
        </div>

        {isOverriding && (
          <div className="weather-debug-status">
            Override active
          </div>
        )}
      </div>
    </div>
  )
}
