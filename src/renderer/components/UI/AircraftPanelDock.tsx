import { useAircraftFiltering } from '../../hooks/useAircraftFiltering'
import { useAircraftInterpolation } from '../../hooks/useAircraftInterpolation'
import { markAircraftPanelDockUserOverride } from '../../hooks/useTabletDockBehavior'
import { useSettingsStore } from '../../stores/settingsStore'
import './AircraftPanelDock.css'

function AircraftPanelDock() {
  const showAircraftPanel = useSettingsStore((state) => state.ui.showAircraftPanel)
  const edgeDocked = useSettingsStore((state) => state.ui.aircraftPanelEdgeDocked)
  const dockSide = useSettingsStore((state) => state.ui.aircraftPanelDockSide)
  const updateUISettings = useSettingsStore((state) => state.updateUISettings)

  const interpolatedAircraft = useAircraftInterpolation()
  const { filtered } = useAircraftFiltering(interpolatedAircraft)
  const count = Math.min(filtered.length, 50)

  if (!showAircraftPanel || !edgeDocked) return null

  const handleExpand = () => {
    markAircraftPanelDockUserOverride()
    updateUISettings({ aircraftPanelEdgeDocked: false })
  }

  return (
    <button
      type="button"
      className="aircraft-panel-dock"
      data-dock-side={dockSide}
      onClick={handleExpand}
      title="Expand aircraft panel"
      aria-label={`Expand aircraft panel (${count} aircraft)`}
    >
      <svg
        className="aircraft-panel-dock-icon"
        aria-hidden="true"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z" />
      </svg>
      <span className="aircraft-panel-dock-count">{count}</span>
      <svg
        className="aircraft-panel-dock-chevron"
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {dockSide === 'right' ? <polyline points="15 18 9 12 15 6" /> : <polyline points="9 18 15 12 9 6" />}
      </svg>
    </button>
  )
}

export default AircraftPanelDock
