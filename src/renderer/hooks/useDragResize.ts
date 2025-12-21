import { useCallback, useRef, useState, useEffect } from 'react'

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

  // Update position/size when props change (e.g., from store)
  useEffect(() => {
    setPosition(initialPosition)
  }, [initialPosition])

  useEffect(() => {
    setSize(initialSize)
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
