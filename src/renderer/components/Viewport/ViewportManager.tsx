import { type ReactNode, useState } from 'react'
import { useViewportStore } from '../../stores/viewportStore'
import { useAirportStore } from '../../stores/airportStore'
import ViewportContainer from './ViewportContainer'
import InsetCesiumViewer from './InsetCesiumViewer'
import './ViewportManager.css'

// Performance warning thresholds
const PERF_WARNING_THRESHOLD = 3  // Show warning at this many insets
const PERF_LIMIT_THRESHOLD = 6    // Suggest limiting at this many insets

interface ViewportManagerProps {
  /** The main viewport content (CesiumViewer + overlays) */
  mainViewportContent: ReactNode
  /** Other UI elements to render alongside viewports (CommandInput, AircraftPanel) */
  children?: ReactNode
}

/**
 * Manages all viewports - the main viewport and any inset viewports.
 * Handles viewport layout and provides UI for adding/managing insets.
 */
function ViewportManager({ mainViewportContent, children }: ViewportManagerProps) {
  const viewports = useViewportStore((state) => state.viewports)
  const addViewport = useViewportStore((state) => state.addViewport)
  const currentAirport = useAirportStore((state) => state.currentAirport)
  const [dismissedWarning, setDismissedWarning] = useState(false)

  // Main viewport is always the first one
  const mainViewport = viewports[0]
  // Inset viewports are all others
  const insetViewports = viewports.slice(1)

  // Show performance warning when many insets are active
  const showPerfWarning = !dismissedWarning && insetViewports.length >= PERF_WARNING_THRESHOLD
  const isAtLimit = insetViewports.length >= PERF_LIMIT_THRESHOLD

  const handleAddInset = () => {
    addViewport()
  }

  return (
    <div className="viewport-manager">
      {/* Main viewport */}
      {mainViewport && (
        <ViewportContainer viewportId={mainViewport.id} isInset={false}>
          {mainViewportContent}
        </ViewportContainer>
      )}

      {/* Other UI elements (CommandInput, AircraftPanel) */}
      {children}

      {/* Inset viewports layer */}
      {insetViewports.length > 0 && (
        <div className="inset-viewport-layer">
          {insetViewports.map((viewport) => (
            <ViewportContainer key={viewport.id} viewportId={viewport.id} isInset={true}>
              <InsetCesiumViewer viewportId={viewport.id} />
            </ViewportContainer>
          ))}
        </div>
      )}

      {/* Performance warning */}
      {showPerfWarning && (
        <div className={`viewport-perf-warning ${isAtLimit ? 'severe' : ''}`}>
          <span className="warning-icon">⚠</span>
          <span className="warning-text">
            {isAtLimit
              ? `${insetViewports.length} inset viewports may impact performance. Consider closing some.`
              : `Multiple inset viewports (${insetViewports.length}) active. Each uses significant GPU memory.`
            }
          </span>
          <button
            className="warning-dismiss"
            onClick={() => setDismissedWarning(true)}
            title="Dismiss warning"
          >
            ×
          </button>
        </div>
      )}

      {/* Add inset button - only shown when an airport is selected */}
      {currentAirport && (
        <button
          className="add-inset-button"
          onClick={handleAddInset}
          title={isAtLimit ? 'Adding more viewports may impact performance' : 'Add a new inset viewport'}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="12" y1="8" x2="12" y2="16" />
            <line x1="8" y1="12" x2="16" y2="12" />
          </svg>
          Add Inset
        </button>
      )}
    </div>
  )
}

export default ViewportManager
