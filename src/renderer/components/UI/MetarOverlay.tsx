import { useWeatherStore } from '../../stores/weatherStore'
import { useSettingsStore } from '../../stores/settingsStore'
import type { InterpolatedWeather, CloudLayer, FlightCategory } from '../../types'
import './MetarOverlay.css'

/**
 * Calculate flight category from visibility (SM) and cloud layers
 *
 * FAA/ICAO criteria:
 * - VFR: Ceiling >= 3000 ft AND visibility >= 5 SM
 * - MVFR: Ceiling 1000-3000 ft OR visibility 3-5 SM
 * - IFR: Ceiling 500-1000 ft OR visibility 1-3 SM
 * - LIFR: Ceiling < 500 ft OR visibility < 1 SM
 */
function calculateFlightCategory(visibilityStatuteMiles: number, cloudLayers: CloudLayer[]): FlightCategory {
  // Find ceiling (lowest BKN or OVC layer)
  const ceilingLayer = cloudLayers
    .filter(l => l.type === 'BKN' || l.type === 'OVC')
    .sort((a, b) => a.altitude - b.altitude)[0]

  // Convert ceiling from meters to feet (if exists)
  const ceilingFt = ceilingLayer ? ceilingLayer.altitude * 3.28084 : Infinity

  // Determine category based on worst condition
  if (ceilingFt < 500 || visibilityStatuteMiles < 1) {
    return 'LIFR'
  }
  if (ceilingFt < 1000 || visibilityStatuteMiles < 3) {
    return 'IFR'
  }
  if (ceilingFt < 3000 || visibilityStatuteMiles < 5) {
    return 'MVFR'
  }
  return 'VFR'
}

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
 * In orbit follow mode without an airport, shows only the interpolated
 * weather data.
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

  // Show overlay if we have either airport METAR or interpolated weather
  if (!showMetarOverlay || (!currentMetar && !interpolatedWeather)) {
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

  // Case 1: No airport METAR, only interpolated weather (e.g., orbit mode without airport)
  if (!currentMetar && interpolatedWeather) {
    const fltCat = calculateFlightCategory(interpolatedWeather.visibility, interpolatedWeather.cloudLayers)
    return (
      <div className={`metar-overlay ${getFlightCategoryClass(fltCat)}`}>
        <div className="metar-text metar-interpolated-primary">
          {formatInterpolatedMetar(interpolatedWeather)}
        </div>
        {sources && sources.length > 0 && (
          <div className="metar-interpolated-sources-standalone">
            ({sources.map(s => `${s.icao} ${Math.round(s.weight * 100)}%`).join(' | ')})
          </div>
        )}
      </div>
    )
  }

  // Case 2: Have airport METAR (normal case)
  return (
    <div className={`metar-overlay ${getFlightCategoryClass(currentMetar!.fltCat)}`}>
      <div className="metar-text">{currentMetar!.rawOb}</div>
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

  parts.push("Interpolated: ")

  // Wind: 270/12G18KT or VRB05KT
  const wind = weather.wind
  if (wind.isVariable && wind.speed < 7) {
    parts.push(`VRB${wind.speed.toString().padStart(2, '0')}KT`)
  } else {
    const dir = wind.direction.toString().padStart(3, '0')
    const spd = wind.speed.toString().padStart(2, '0')
    if (wind.gustSpeed) {
      parts.push(`${dir}${spd}G${wind.gustSpeed}KT`)
    } else {
      parts.push(`${dir}${spd}KT`)
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

  // Precipitation indicator (before clouds, matching real METAR format)
  if (weather.precipitation.active && weather.precipitation.types.length > 0) {
    parts.push(weather.precipitation.types.map(p => p.code).join(' '))
  }

  // Clouds - show significant layers
  const clouds = formatCloudLayers(weather.cloudLayers)
  if (clouds) {
    parts.push(clouds)
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
