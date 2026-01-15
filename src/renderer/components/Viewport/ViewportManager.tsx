import type { ReactNode } from 'react'
import { useViewportStore } from '../../stores/viewportStore'
import ViewportContainer from './ViewportContainer'
import InsetCesiumViewer from './InsetCesiumViewer'
import './ViewportManager.css'

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

  // Main viewport is always the first one
  const mainViewport = viewports[0]
  // Inset viewports are all others
  const insetViewports = viewports.slice(1)

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
    </div>
  )
}

export default ViewportManager
