import { useCallback, useRef, useState, useEffect } from 'react'

/**
 * Provides drag-to-move and resize functionality for inset viewports with normalized coordinates.
 *
 * ## Responsibilities
 * - Tracks pointer events (down/move/up) for dragging and resizing
 * - Converts between pixel coordinates and normalized (0-1) viewport coordinates
 * - Enforces minimum size constraints and viewport boundary limits
 * - Prevents echo loops when position/size changes propagate back from store
 * - Provides props for drag handles and resize handles (8 directions)
 *
 * ## Dependencies
 * - Requires: `.viewport-manager` container element in DOM (for bounds calculations)
 * - Reads: Position/size props (from parent component, typically from `viewportStore`)
 * - Writes: Calls callbacks (`onPositionChange`, `onSizeChange`, `onDragEnd`) during drag/resize
 *
 * ## Call Order
 * This hook should be called in components that render draggable/resizable inset viewports:
 * ```typescript
 * function InsetViewport({ viewportId }) {
 *   const viewport = useViewportStore(state =>
 *     state.viewports.find(v => v.id === viewportId)
 *   )
 *
 *   const { position, size, dragHandleProps, getResizeHandleProps } = useDragResize({
 *     initialPosition: viewport.position,
 *     initialSize: viewport.size,
 *     onDragEnd: (pos, size) => {
 *       // Persist to store when drag/resize ends
 *       viewportStore.getState().updateViewportLayout(viewportId, pos, size)
 *     }
 *   })
 *
 *   return (
 *     <div style={{ left: `${position.x * 100}%`, width: `${size.width * 100}%` }}>
 *       <div {...dragHandleProps}>Drag Handle</div>
 *       <div {...getResizeHandleProps('se')}>SE Resize Handle</div>
 *     </div>
 *   )
 * }
 * ```
 *
 * ## Coordinate System
 *
 * This hook uses **normalized coordinates** (0-1 range) rather than pixels:
 * - `position.x = 0.0` = left edge of container
 * - `position.x = 1.0` = right edge of container
 * - `size.width = 0.5` = 50% of container width
 *
 * **Why normalized coordinates?**
 * - Viewport layout remains consistent across different screen sizes
 * - Easy to persist to localStorage (no pixel values tied to specific monitor)
 * - Simple percentage-based CSS positioning (`left: ${x * 100}%`)
 *
 * **Conversion:**
 * - Pixel → Normalized: `normalized = pixels / containerDimension`
 * - Normalized → Pixel: `pixels = normalized * containerDimension`
 *
 * ## Drag Behavior
 *
 * When user drags the handle:
 * 1. **Pointer Down**: Record start mouse position and current viewport position
 * 2. **Pointer Move**: Calculate delta in pixels, convert to normalized delta, apply to position
 * 3. **Boundary Constraints**: Clamp position so viewport stays within container bounds
 * 4. **Real-time Updates**: Call `onPositionChange()` on every move event
 * 5. **Pointer Up**: Call `onDragEnd()` with final position/size
 *
 * ## Resize Behavior
 *
 * When user drags a resize handle (8 directions: n/s/e/w/ne/nw/se/sw):
 * 1. **Pointer Down**: Record start mouse position, current position/size, and resize direction
 * 2. **Pointer Move**: Calculate delta based on direction:
 *    - East (`e`): Increase width, keep position fixed
 *    - West (`w`): Move left edge (adjust position AND width)
 *    - South (`s`): Increase height, keep position fixed
 *    - North (`n`): Move top edge (adjust position AND height)
 *    - Corners (e.g., `se`): Combine horizontal and vertical logic
 * 3. **Minimum Size**: Enforce `minSize` constraints (default 200×150 pixels)
 * 4. **Boundary Constraints**: Prevent viewport from extending outside container
 * 5. **Real-time Updates**: Call `onPositionChange()` and `onSizeChange()` on every move event
 * 6. **Pointer Up**: Call `onDragEnd()` with final position/size
 *
 * ## Echo Loop Prevention
 *
 * **Problem:** When position/size changes are committed to store, store updates trigger prop changes,
 * which would cause the hook to re-apply those same changes, creating an infinite loop.
 *
 * **Solution:** Track the last committed values in refs (`lastCommittedPositionRef`, `lastCommittedSizeRef`):
 * - When drag/resize ends, save committed values to refs BEFORE calling `onDragEnd()`
 * - When props change, only apply if difference > 0.001 (prevents echoing our own commits)
 * - This allows external changes (e.g., viewport reset) to still update the hook
 *
 * ## Pointer Capture
 *
 * This hook uses `setPointerCapture()` to ensure smooth dragging:
 * - All pointer move events route to the original target, even if cursor leaves element
 * - Prevents losing drag/resize if user moves mouse quickly
 * - Automatically released on pointer up
 *
 * ## Resize Handle Cursors
 *
 * Each resize direction has an appropriate cursor:
 * - `n`, `s`: `ns-resize` (vertical)
 * - `e`, `w`: `ew-resize` (horizontal)
 * - `ne`, `sw`: `nesw-resize` (diagonal)
 * - `nw`, `se`: `nwse-resize` (diagonal)
 * - Drag handle: `move` cursor
 *
 * @param options - Configuration options
 * @param options.initialPosition - Initial position in normalized coordinates (0-1)
 * @param options.initialSize - Initial size in normalized coordinates (0-1)
 * @param options.minSize - Minimum size in pixels (default: 200×150)
 * @param options.onPositionChange - Called during drag with new position (optional)
 * @param options.onSizeChange - Called during resize with new size (optional)
 * @param options.onDragEnd - Called when drag/resize ends with final position and size (optional)
 * @returns Drag/resize state and handle props
 *
 * @example
 * // Basic draggable viewport with SE resize handle
 * const { position, size, isDragging, dragHandleProps, getResizeHandleProps } = useDragResize({
 *   initialPosition: { x: 0.7, y: 0.7 },
 *   initialSize: { width: 0.25, height: 0.25 },
 *   minSize: { width: 300, height: 200 },
 *   onDragEnd: (pos, size) => {
 *     console.log('Final position:', pos, 'size:', size)
 *     saveToStore(pos, size)
 *   }
 * })
 *
 * return (
 *   <div style={{
 *     position: 'absolute',
 *     left: `${position.x * 100}%`,
 *     top: `${position.y * 100}%`,
 *     width: `${size.width * 100}%`,
 *     height: `${size.height * 100}%`
 *   }}>
 *     <div {...dragHandleProps}>Drag Me</div>
 *     <div {...getResizeHandleProps('se')} style={{ position: 'absolute', right: 0, bottom: 0 }}>
 *       ↘
 *     </div>
 *   </div>
 * )
 *
 * @example
 * // Viewport with all 8 resize handles
 * const handles: ResizeDirection[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
 *
 * return (
 *   <div className="viewport">
 *     <div {...dragHandleProps}>Title Bar</div>
 *     {handles.map(dir => (
 *       <div key={dir} {...getResizeHandleProps(dir)} className={`resize-${dir}`} />
 *     ))}
 *   </div>
 * )
 *
 * @see viewportStore - For viewport position/size persistence
 * @see ViewportContainer.tsx - For usage in inset viewport rendering
 */
export type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

interface Position {
  x: number
  y: number
}

interface Size {
  width: number
  height: number
}

interface UseDragResizeOptions {
  /** Initial position (normalized 0-1) */
  initialPosition: Position
  /** Initial size (normalized 0-1) */
  initialSize: Size
  /** Minimum size in pixels */
  minSize?: { width: number; height: number }
  /** Called when position changes */
  onPositionChange?: (position: Position) => void
  /** Called when size changes */
  onSizeChange?: (size: Size) => void
  /** Called when drag/resize ends */
  onDragEnd?: (position: Position, size: Size) => void
}

interface UseDragResizeReturn {
  /** Current position (normalized 0-1) */
  position: Position
  /** Current size (normalized 0-1) */
  size: Size
  /** Whether currently dragging */
  isDragging: boolean
  /** Whether currently resizing */
  isResizing: boolean
  /** Props to spread on drag handle element */
  dragHandleProps: {
    onPointerDown: (e: React.PointerEvent) => void
    style: { cursor: string }
  }
  /** Get props for a resize handle */
  getResizeHandleProps: (direction: ResizeDirection) => {
    onPointerDown: (e: React.PointerEvent) => void
    style: { cursor: string }
  }
}

const RESIZE_CURSORS: Record<ResizeDirection, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize'
}

export function useDragResize({
  initialPosition,
  initialSize,
  minSize = { width: 200, height: 150 },
  onPositionChange,
  onSizeChange,
  onDragEnd
}: UseDragResizeOptions): UseDragResizeReturn {
  const [position, setPosition] = useState<Position>(initialPosition)
  const [size, setSize] = useState<Size>(initialSize)
  const [isDragging, setIsDragging] = useState(false)
  const [isResizing, setIsResizing] = useState(false)

  // Refs for tracking drag/resize state
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; startX: number; startY: number } | null>(null)
  const resizeStartRef = useRef<{
    mouseX: number
    mouseY: number
    startX: number
    startY: number
    startWidth: number
    startHeight: number
    direction: ResizeDirection
  } | null>(null)
  const containerRef = useRef<HTMLElement | null>(null)

  // Track last values we committed to store to avoid echo loops
  const lastCommittedPositionRef = useRef(initialPosition)
  const lastCommittedSizeRef = useRef(initialSize)

  // Update position/size when props change (e.g., from store)
  useEffect(() => {
    // Only update if props changed meaningfully (not just echoing our commit)
    const posChanged =
      Math.abs(initialPosition.x - lastCommittedPositionRef.current.x) > 0.001 ||
      Math.abs(initialPosition.y - lastCommittedPositionRef.current.y) > 0.001

    if (posChanged) {
      setPosition(initialPosition)
      lastCommittedPositionRef.current = initialPosition
    }
  }, [initialPosition])

  useEffect(() => {
    // Only update if props changed meaningfully (not just echoing our commit)
    const sizeChanged =
      Math.abs(initialSize.width - lastCommittedSizeRef.current.width) > 0.001 ||
      Math.abs(initialSize.height - lastCommittedSizeRef.current.height) > 0.001

    if (sizeChanged) {
      setSize(initialSize)
      lastCommittedSizeRef.current = initialSize
    }
  }, [initialSize])

  // Get container dimensions for converting between pixels and normalized values
  const getContainerRect = useCallback(() => {
    // Find the viewport manager container (parent of inset layer)
    const container = document.querySelector('.viewport-manager')
    if (container) {
      containerRef.current = container as HTMLElement
      return container.getBoundingClientRect()
    }
    return null
  }, [])

  // Handle drag start
  const handleDragStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const rect = getContainerRect()
    if (!rect) return

    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startX: position.x,
      startY: position.y
    }

    setIsDragging(true)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [position.x, position.y, getContainerRect])

  // Handle resize start
  const handleResizeStart = useCallback((direction: ResizeDirection) => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const rect = getContainerRect()
    if (!rect) return

    resizeStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startX: position.x,
      startY: position.y,
      startWidth: size.width,
      startHeight: size.height,
      direction
    }

    setIsResizing(true)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [position.x, position.y, size.width, size.height, getContainerRect])

  // Handle pointer move (drag or resize)
  const handlePointerMove = useCallback((e: PointerEvent) => {
    const rect = getContainerRect()
    if (!rect) return

    if (isDragging && dragStartRef.current) {
      const deltaX = (e.clientX - dragStartRef.current.mouseX) / rect.width
      const deltaY = (e.clientY - dragStartRef.current.mouseY) / rect.height

      // Calculate new position with bounds checking
      let newX = dragStartRef.current.startX + deltaX
      let newY = dragStartRef.current.startY + deltaY

      // Constrain to container bounds
      newX = Math.max(0, Math.min(1 - size.width, newX))
      newY = Math.max(0, Math.min(1 - size.height, newY))

      const newPosition = { x: newX, y: newY }
      setPosition(newPosition)
      onPositionChange?.(newPosition)
    }

    if (isResizing && resizeStartRef.current) {
      const { direction, startX, startY, startWidth, startHeight, mouseX, mouseY } = resizeStartRef.current
      const deltaX = (e.clientX - mouseX) / rect.width
      const deltaY = (e.clientY - mouseY) / rect.height

      let newX = startX
      let newY = startY
      let newWidth = startWidth
      let newHeight = startHeight

      // Calculate minimum size in normalized units
      const minWidthNorm = minSize.width / rect.width
      const minHeightNorm = minSize.height / rect.height

      // Handle horizontal resizing
      if (direction.includes('e')) {
        newWidth = Math.max(minWidthNorm, Math.min(1 - startX, startWidth + deltaX))
      }
      if (direction.includes('w')) {
        const maxDeltaX = startWidth - minWidthNorm
        const constrainedDeltaX = Math.max(-startX, Math.min(maxDeltaX, deltaX))
        newX = startX + constrainedDeltaX
        newWidth = startWidth - constrainedDeltaX
      }

      // Handle vertical resizing
      if (direction.includes('s')) {
        newHeight = Math.max(minHeightNorm, Math.min(1 - startY, startHeight + deltaY))
      }
      if (direction.includes('n')) {
        const maxDeltaY = startHeight - minHeightNorm
        const constrainedDeltaY = Math.max(-startY, Math.min(maxDeltaY, deltaY))
        newY = startY + constrainedDeltaY
        newHeight = startHeight - constrainedDeltaY
      }

      const newPosition = { x: newX, y: newY }
      const newSize = { width: newWidth, height: newHeight }

      setPosition(newPosition)
      setSize(newSize)
      onPositionChange?.(newPosition)
      onSizeChange?.(newSize)
    }
  }, [isDragging, isResizing, size.width, size.height, minSize, getContainerRect, onPositionChange, onSizeChange])

  // Handle pointer up (end drag/resize)
  const handlePointerUp = useCallback(() => {
    if (isDragging || isResizing) {
      // Update refs before calling callback to prevent echo loops
      lastCommittedPositionRef.current = position
      lastCommittedSizeRef.current = size
      onDragEnd?.(position, size)
    }
    setIsDragging(false)
    setIsResizing(false)
    dragStartRef.current = null
    resizeStartRef.current = null
  }, [isDragging, isResizing, position, size, onDragEnd])

  // Add/remove global event listeners
  useEffect(() => {
    if (isDragging || isResizing) {
      window.addEventListener('pointermove', handlePointerMove)
      window.addEventListener('pointerup', handlePointerUp)
      return () => {
        window.removeEventListener('pointermove', handlePointerMove)
        window.removeEventListener('pointerup', handlePointerUp)
      }
    }
  }, [isDragging, isResizing, handlePointerMove, handlePointerUp])

  const dragHandleProps = {
    onPointerDown: handleDragStart,
    style: { cursor: 'move' }
  }

  const getResizeHandleProps = useCallback((direction: ResizeDirection) => ({
    onPointerDown: handleResizeStart(direction),
    style: { cursor: RESIZE_CURSORS[direction] }
  }), [handleResizeStart])

  return {
    position,
    size,
    isDragging,
    isResizing,
    dragHandleProps,
    getResizeHandleProps
  }
}

export default useDragResize
