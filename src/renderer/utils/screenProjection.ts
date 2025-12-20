// Screen projection and label positioning utilities

/**
 * Screen position with visibility flag
 */
export interface ScreenPosition {
  x: number
  y: number
  visible: boolean
}

/**
 * Smoothed screen position state for tracking between frames
 */
export interface SmoothedScreenPosition {
  smoothedX: number
  smoothedY: number
}

/**
 * Apply exponential smoothing to reduce jitter in screen positions.
 * Used for stabilizing label positions in orbit follow mode.
 *
 * @param rawX - Raw X position from projection
 * @param rawY - Raw Y position from projection
 * @param previousState - Previous smoothed position (or undefined for first frame)
 * @param smoothingFactor - How responsive the smoothing is (0.1 = smooth, 0.5 = responsive)
 * @param jumpThreshold - Distance threshold to snap instead of smooth (for large jumps)
 */
export function applyExponentialSmoothing(
  rawX: number,
  rawY: number,
  previousState: SmoothedScreenPosition | undefined,
  smoothingFactor: number = 0.4,
  jumpThreshold: number = 100
): SmoothedScreenPosition {
  if (!previousState) {
    // First time - initialize with raw position
    return { smoothedX: rawX, smoothedY: rawY }
  }

  // Check if the position jumped significantly
  const dx = Math.abs(rawX - previousState.smoothedX)
  const dy = Math.abs(rawY - previousState.smoothedY)

  if (dx > jumpThreshold || dy > jumpThreshold) {
    // Large jump - snap to new position
    return { smoothedX: rawX, smoothedY: rawY }
  }

  // Apply exponential smoothing: new = old + factor * (raw - old)
  return {
    smoothedX: previousState.smoothedX + smoothingFactor * (rawX - previousState.smoothedX),
    smoothedY: previousState.smoothedY + smoothingFactor * (rawY - previousState.smoothedY)
  }
}

/**
 * Rectangle bounds for overlap detection
 */
export interface Rectangle {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Check if two rectangles overlap
 *
 * @param a - First rectangle
 * @param b - Second rectangle
 * @param margin - Additional margin around rectangles (default 0)
 */
export function rectanglesOverlap(a: Rectangle, b: Rectangle, margin: number = 0): boolean {
  return (
    a.left < b.right + margin &&
    a.right > b.left - margin &&
    a.top < b.bottom + margin &&
    a.bottom > b.top - margin
  )
}

/**
 * Create a rectangle from position and size
 */
export function createRectangle(x: number, y: number, width: number, height: number): Rectangle {
  return {
    left: x,
    top: y,
    right: x + width,
    bottom: y + height
  }
}

/**
 * Label position data for overlap detection
 */
export interface LabelPosition {
  callsign: string
  coneX: number
  coneY: number
  labelX: number
  labelY: number
  offsetX: number
  offsetY: number
}

/**
 * Alternative label offset positions to try when avoiding overlaps
 */
export const LABEL_OFFSET_ALTERNATIVES = [
  { x: 0, y: 0 },      // Default: top-left of cone (will be adjusted below)
  { x: 30, y: -40 },   // Top-right
  { x: -90, y: 0 },    // Left
  { x: 30, y: 0 },     // Right
  { x: 0, y: 40 },     // Below
  { x: -90, y: 40 },   // Bottom-left
  { x: 30, y: 40 },    // Bottom-right
  { x: -90, y: -40 }   // Top-left (far)
] as const

/**
 * Calculate label offset avoiding overlap with cone and other labels
 *
 * @param screenPos - Screen position of the cone
 * @param labelWidth - Width of the label
 * @param labelHeight - Height of the label
 * @param coneRadius - Radius of the cone on screen
 * @param labelGap - Gap between label and cone
 * @param existingLabels - Array of existing label positions to avoid
 */
export function calculateLabelOffset(
  screenPos: { x: number; y: number },
  labelWidth: number,
  labelHeight: number,
  coneRadius: number,
  labelGap: number,
  existingLabels: LabelPosition[]
): { offsetX: number; offsetY: number } {
  // Default offset: top-left of cone
  let offsetX = -labelWidth - labelGap
  let offsetY = -labelHeight - labelGap

  // Check for overlap with cone itself
  const labelLeft = screenPos.x + offsetX
  const labelTop = screenPos.y + offsetY
  const labelRight = labelLeft + labelWidth
  const labelBottom = labelTop + labelHeight

  // If label overlaps cone area, push it further out
  if (
    labelRight > screenPos.x - coneRadius &&
    labelLeft < screenPos.x + coneRadius &&
    labelBottom > screenPos.y - coneRadius &&
    labelTop < screenPos.y + coneRadius
  ) {
    offsetX = -labelWidth - coneRadius - labelGap
    offsetY = -labelHeight - coneRadius - labelGap
  }

  // Check for overlap with other labels
  const margin = 5
  for (const existing of existingLabels) {
    const existingRect = createRectangle(existing.labelX, existing.labelY, labelWidth, labelHeight)
    const newLabelX = screenPos.x + offsetX
    const newLabelY = screenPos.y + offsetY
    const newRect = createRectangle(newLabelX, newLabelY, labelWidth, labelHeight)

    // Check if labels overlap
    if (rectanglesOverlap(newRect, existingRect, margin)) {
      // Try alternative positions
      const alternatives = LABEL_OFFSET_ALTERNATIVES.map((alt) => ({
        x: alt.x - labelWidth - labelGap,
        y: alt.y - labelHeight - labelGap
      }))

      for (const alt of alternatives) {
        const testX = screenPos.x + alt.x
        const testY = screenPos.y + alt.y
        const testRect = createRectangle(testX, testY, labelWidth, labelHeight)
        let overlaps = false

        // Check against all existing labels
        for (const check of existingLabels) {
          const checkRect = createRectangle(check.labelX, check.labelY, labelWidth, labelHeight)
          if (rectanglesOverlap(testRect, checkRect, margin)) {
            overlaps = true
            break
          }
        }

        if (!overlaps) {
          offsetX = alt.x
          offsetY = alt.y
          break
        }
      }
      break // Only need to resolve the first overlap
    }
  }

  return { offsetX, offsetY }
}

/**
 * Calculate leader line endpoints from label to cone
 * The line connects the edge of the label closest to the cone to the cone position
 *
 * @param labelX - Label X position
 * @param labelY - Label Y position
 * @param labelWidth - Label width
 * @param labelHeight - Label height
 * @param coneX - Cone X position
 * @param coneY - Cone Y position
 * @param coneRadius - Radius of the cone on screen
 */
export function calculateLeaderLineEndpoints(
  labelX: number,
  labelY: number,
  labelWidth: number,
  labelHeight: number,
  coneX: number,
  coneY: number,
  coneRadius: number
): { startX: number; startY: number; endX: number; endY: number } {
  const labelCenterX = labelX + labelWidth / 2
  const labelCenterY = labelY + labelHeight / 2

  // Find the edge of the label closest to the cone
  let startX = labelCenterX
  let startY = labelCenterY

  // Horizontal edge
  if (coneX < labelX) {
    startX = labelX
  } else if (coneX > labelX + labelWidth) {
    startX = labelX + labelWidth
  }

  // Vertical edge
  if (coneY < labelY) {
    startY = labelY
  } else if (coneY > labelY + labelHeight) {
    startY = labelY + labelHeight
  }

  // End point is at the edge of the cone towards the label
  const angle = Math.atan2(startY - coneY, startX - coneX)
  const endX = coneX + Math.cos(angle) * coneRadius
  const endY = coneY + Math.sin(angle) * coneRadius

  return { startX, startY, endX, endY }
}
