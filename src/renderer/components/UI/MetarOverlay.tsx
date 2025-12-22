import { useWeatherStore } from '../../stores/weatherStore'
import { useSettingsStore } from '../../stores/settingsStore'
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
 * Toggle with Ctrl+M
 */
export function MetarOverlay() {
  const currentMetar = useWeatherStore((state) => state.currentMetar)
  const showMetarOverlay = useSettingsStore((state) => state.ui.showMetarOverlay)

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

  return (
    <div className={`metar-overlay ${getFlightCategoryClass(currentMetar.fltCat)}`}>
      {currentMetar.rawOb}
    </div>
  )
}

export default MetarOverlay
