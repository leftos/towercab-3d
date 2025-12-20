import { useCallback, useMemo, useRef, type ReactNode, type MouseEvent } from 'react'
import { useViewportStore } from '../../stores/viewportStore'
import { useDragResize, type ResizeDirection } from '../../hooks/useDragResize'
import './ViewportContainer.css'

interface ViewportContainerProps {
  viewportId: string
  isInset?: boolean
  children: ReactNode
}

// Resize handle directions for corners and edges
const RESIZE_HANDLES: ResizeDirection[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

/**
 * Container component that wraps a viewport (Cesium + Babylon).
 * Handles activation on click and displays active state border.
 * For insets, also handles drag and resize.
 */
function ViewportContainer({ viewportId, isInset = false, children }: ViewportContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  const activeViewportId = useViewportStore((state) => state.activeViewportId)
  const setActiveViewport = useViewportStore((state) => state.setActiveViewport)
  const bringToFront = useViewportStore((state) => state.bringToFront)
  const updateViewportLayout = useViewportStore((state) => state.updateViewportLayout)
  const viewports = useViewportStore((state) => state.viewports)

  // Find viewport from the viewports array - memoized to prevent unnecessary recalculations
  const viewport = useMemo(
    () => viewports.find(v => v.id === viewportId),
    [viewports, viewportId]
  )

  const isActive = activeViewportId === viewportId

  // Drag and resize functionality for inset viewports
  const { position, size, isDragging, isResizing, dragHandleProps, getResizeHandleProps } = useDragResize({
    initialPosition: { x: viewport?.layout.x ?? 0, y: viewport?.layout.y ?? 0 },
    initialSize: { width: viewport?.layout.width ?? 0.3, height: viewport?.layout.height ?? 0.3 },
    minSize: { width: 200, height: 150 },
    onDragEnd: (newPosition, newSize) => {
      // Update the store when drag/resize ends
      updateViewportLayout(viewportId, {
        x: newPosition.x,
        y: newPosition.y,
        width: newSize.width,
        height: newSize.height
      })
    }
  })

  const handleClick = useCallback((e: MouseEvent) => {
    // Don't activate if clicking on interactive elements within the viewport
    const target = e.target as HTMLElement
    if (target.tagName === 'BUTTON' || target.tagName === 'INPUT' || target.closest('button') || target.closest('input')) {
      return
    }

    if (!isActive) {
      setActiveViewport(viewportId)
      if (isInset) {
        bringToFront(viewportId)
      }
    }
  }, [isActive, viewportId, isInset, setActiveViewport, bringToFront])

  // For insets, use position/size from drag hook (live updates during drag)
  // For main viewport, no positioning needed
  const insetStyle = isInset && viewport ? {
    left: `${(isDragging || isResizing ? position.x : viewport.layout.x) * 100}%`,
    top: `${(isDragging || isResizing ? position.y : viewport.layout.y) * 100}%`,
    width: `${(isDragging || isResizing ? size.width : viewport.layout.width) * 100}%`,
    height: `${(isDragging || isResizing ? size.height : viewport.layout.height) * 100}%`,
    zIndex: viewport.layout.zIndex
  } : undefined

  return (
    <div
      ref={containerRef}
      className={`viewport-container ${isActive ? 'active' : 'inactive'} ${isInset ? 'inset' : 'main'} ${isDragging ? 'dragging' : ''} ${isResizing ? 'resizing' : ''}`}
      style={insetStyle}
      onClick={handleClick}
      data-viewport-id={viewportId}
    >
      {isInset && (
        <div className="viewport-header" {...dragHandleProps}>
          <span className="viewport-label">{viewport?.label || 'Inset'}</span>
          <button
            className="viewport-close-button"
            onClick={(e) => {
              e.stopPropagation()
              useViewportStore.getState().removeViewport(viewportId)
            }}
            title="Close viewport"
          >
            ×
          </button>
        </div>
      )}
      <div className="viewport-content">
        {children}
      </div>
      {isActive && <div className="active-indicator" />}

      {/* Resize handles for inset viewports */}
      {isInset && RESIZE_HANDLES.map((direction) => (
        <div
          key={direction}
          className={`resize-handle resize-${direction}`}
          {...getResizeHandleProps(direction)}
        />
      ))}
    </div>
  )
}

export default ViewportContainer
