import { useWeatherStore } from '../../stores/weatherStore'
import { useSettingsStore } from '../../stores/settingsStore'
import type { InterpolatedWeather, CloudLayer } from '../../types'
import './MetarOverlay.css'

/**
 * METAR overlay component that displays raw METAR at top of viewport
 *
 * Color-coded by flight category:
 * - Green: VFR
 * - Blue: MVFR
 * - Red: IFR
 * - Purple: LIFR
 *
 * When weather interpolation is enabled with multiple stations,
 * shows interpolated weather in METAR-style format below.
 *
 * Toggle with Ctrl+M
 */
export function MetarOverlay() {
  const currentMetar = useWeatherStore((state) => state.currentMetar)
  const interpolatedWeather = useWeatherStore((state) => state.interpolatedWeather)
  const showMetarOverlay = useSettingsStore((state) => state.ui.showMetarOverlay)
  const enableWeatherInterpolation = useSettingsStore(
    (state) => state.weather.enableWeatherInterpolation ?? true
  )

  if (!showMetarOverlay || !currentMetar) {
    return null
  }

  // Determine color based on flight category
  const getFlightCategoryClass = (fltCat: string): string => {
    switch (fltCat.toUpperCase()) {
      case 'VFR':
        return 'metar-vfr'
      case 'MVFR':
        return 'metar-mvfr'
      case 'IFR':
        return 'metar-ifr'
      case 'LIFR':
        return 'metar-lifr'
      default:
        return 'metar-vfr'
    }
  }

  // Check if we're actually interpolating from multiple sources
  const sources = interpolatedWeather?.sourceStations
  const isActuallyInterpolating =
    enableWeatherInterpolation &&
    sources &&
    sources.length > 1

  return (
    <div className={`metar-overlay ${getFlightCategoryClass(currentMetar.fltCat)}`}>
      <div className="metar-text">{currentMetar.rawOb}</div>
      {isActuallyInterpolating && interpolatedWeather && (
        <div className="metar-interpolated">
          <span className="metar-interpolated-data">
            {formatInterpolatedMetar(interpolatedWeather)}
          </span>
          <span className="metar-interpolated-sources">
            ({sources.map(s => `${s.icao} ${Math.round(s.weight * 100)}%`).join(' | ')})
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * Format interpolated weather data in METAR-style format
 */
function formatInterpolatedMetar(weather: InterpolatedWeather): string {
  const parts: string[] = []

  // Wind: 270/12G18KT or VRB05KT
  const wind = weather.wind
  if (wind.isVariable && wind.speed < 7) {
    parts.push(`VRB${wind.speed.toString().padStart(2, '0')}KT`)
  } else {
    const dir = wind.direction.toString().padStart(3, '0')
    const spd = wind.speed.toString().padStart(2, '0')
    if (wind.gustSpeed) {
      parts.push(`${dir}/${spd}G${wind.gustSpeed}KT`)
    } else {
      parts.push(`${dir}/${spd}KT`)
    }
  }

  // Visibility in SM (convert from meters, weather.visibility is in statute miles)
  const vis = weather.visibility
  if (vis >= 10) {
    parts.push('10SM')
  } else if (vis >= 1) {
    parts.push(`${Math.round(vis)}SM`)
  } else if (vis >= 0.5) {
    parts.push('1/2SM')
  } else if (vis >= 0.25) {
    parts.push('1/4SM')
  } else {
    parts.push('<1/4SM')
  }

  // Clouds - show significant layers
  const clouds = formatCloudLayers(weather.cloudLayers)
  if (clouds) {
    parts.push(clouds)
  }

  // Precipitation indicator
  if (weather.precipitation.active && weather.precipitation.types.length > 0) {
    parts.push(weather.precipitation.types.join(''))
  }

  return parts.join(' ')
}

/**
 * Format cloud layers in METAR style (e.g., "SCT025 BKN045 OVC080")
 */
function formatCloudLayers(layers: CloudLayer[]): string {
  if (layers.length === 0) return 'CLR'

  // Sort by altitude and take up to 3 most significant layers
  const sorted = [...layers].sort((a, b) => a.altitude - b.altitude)
  const significant = sorted.slice(0, 3)

  return significant.map(layer => {
    // Convert altitude from meters to hundreds of feet
    const altHundreds = Math.round(layer.altitude * 3.28084 / 100)
    const altStr = altHundreds.toString().padStart(3, '0')
    return `${layer.type}${altStr}`
  }).join(' ')
}

export default MetarOverlay
