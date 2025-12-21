import { type ReactNode, useState } from 'react'
import { useViewportStore } from '../../stores/viewportStore'
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
  const [dismissedWarning, setDismissedWarning] = useState(false)

  // Main viewport is always the first one
  const mainViewport = viewports[0]
  // Inset viewports are all others
  const insetViewports = viewports.slice(1)

  // Show performance warning when many insets are active
  const showPerfWarning = !dismissedWarning && insetViewports.length >= PERF_WARNING_THRESHOLD
  const isAtLimit = insetViewports.length >= PERF_LIMIT_THRESHOLD

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
    </div>
  )
}

export default ViewportManager
