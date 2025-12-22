import { useRef, useCallback } from 'react'
import * as GUI from '@babylonjs/gui'
import type { AircraftLabel, UseBabylonLabelsResult } from '@/types'

interface UseBabylonLabelsOptions {
  guiTexture: GUI.AdvancedDynamicTexture | null
}

// Memory diagnostic counters for label management
const memoryCounters = {
  guiControlsCreated: 0,
  guiControlsDisposed: 0
}

/**
 * Get memory diagnostic counters for label GUI controls.
 * @returns Object with created and disposed counts
 */
export function getLabelMemoryCounters() {
  return { ...memoryCounters }
}

/**
 * Converts RGB color (0-1 range) to hex color string.
 * @param r - Red component (0-1)
 * @param g - Green component (0-1)
 * @param b - Blue component (0-1)
 * @returns Hex color string (e.g., "#ff0000")
 */
function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

/**
 * Manages aircraft datablock labels and leader lines in Babylon.js GUI overlay.
 *
 * ## Responsibilities
 * - Create aircraft label GUI elements (rectangle container + text block)
 * - Create leader lines connecting labels to aircraft screen positions
 * - Update label text, colors, and followed aircraft highlighting
 * - Position labels with screen-space coordinates and calculate leader line endpoints
 * - Hide all labels (frame start) and show visible ones (after culling)
 * - Dispose label resources when aircraft disappear
 * - Track memory usage with diagnostic counters
 *
 * ## Dependencies
 * - Requires: GUI AdvancedDynamicTexture (from useBabylonScene)
 * - Writes: Creates and manages GUI.Rectangle, GUI.TextBlock, and GUI.Line controls
 *
 * ## Call Order
 * This hook should be called after useBabylonScene has created the GUI texture:
 * ```typescript
 * // 1. Initialize scene and GUI texture
 * const { guiTexture, sceneReady } = useBabylonScene({ canvas })
 *
 * // 2. Create label management (needs guiTexture)
 * const { updateLabel, updateLabelPosition, removeLabel } = useBabylonLabels({
 *   guiTexture
 * })
 *
 * // 3. Use in rendering loop
 * useEffect(() => {
 *   if (!sceneReady) return
 *   // Update labels each frame
 * }, [sceneReady])
 * ```
 *
 * ## Label Structure
 *
 * Each aircraft label consists of three GUI elements:
 *
 * ### 1. Label Container (GUI.Rectangle)
 * - **Purpose**: Container with background and border
 * - **Width/Height**: Auto-sized to fit text content
 * - **Background**: Black (normal) or dark blue (followed aircraft)
 * - **Border**: 1px, colored to match aircraft
 * - **Corner radius**: 4px for rounded corners
 * - **Alignment**: Top-left (positioned absolutely)
 * - **z-index**: 10 (renders on top of leader lines)
 *
 * ### 2. Text Block (GUI.TextBlock)
 * - **Purpose**: Displays aircraft information
 * - **Content**: Callsign, type, altitude, speed (newline-separated)
 * - **Font**: Monospace, bold, 12px
 * - **Color**: Matches aircraft color
 * - **Padding**: 4px horizontal, 2px vertical
 *
 * ### 3. Leader Line (GUI.Line)
 * - **Purpose**: Connects label to aircraft screen position
 * - **Width**: 3px
 * - **Color**: Matches aircraft color
 * - **z-index**: 1 (renders below labels)
 * - **Geometry**: Calculated to start at label edge, end near aircraft
 *
 * ## Label Creation and Updates
 *
 * The `updateLabel` function creates labels on first call and updates them on subsequent calls:
 *
 * ### First Call (Creation)
 * 1. Create GUI.Rectangle container
 * 2. Create GUI.TextBlock for text content
 * 3. Create GUI.Line for leader line
 * 4. Add all controls to GUI texture
 * 5. Store in labels map
 * 6. Increment memory counters
 *
 * ### Subsequent Calls (Updates)
 * 1. Update text content
 * 2. Update colors (border, text, line)
 * 3. Update background (highlight followed aircraft)
 * 4. Update scale (1.2x for followed aircraft)
 *
 * **Important:** Labels start hidden (`isVisible = false`) and are positioned
 * by `updateLabelPosition` before being shown.
 *
 * ## Label Positioning
 *
 * The `updateLabelPosition` function positions labels using screen coordinates:
 *
 * ### Input Parameters
 * - `callsign`: Aircraft identifier
 * - `screenX`, `screenY`: Aircraft screen position (from Cesium projection)
 * - `labelOffsetX`, `labelOffsetY`: Label offset from aircraft (in pixels)
 *
 * ### Positioning Algorithm
 * 1. Calculate label position: `(screenX + offsetX, screenY + offsetY)`
 * 2. Set label top-left corner to calculated position
 * 3. Make label visible
 *
 * ### Leader Line Calculation
 * The leader line connects the label to the aircraft position:
 *
 * 1. **Calculate label center:**
 *    ```typescript
 *    labelCenterX = labelX + labelWidth / 2
 *    labelCenterY = labelY + labelHeight / 2
 *    ```
 *
 * 2. **Calculate direction vector:**
 *    ```typescript
 *    dirX = screenX - labelCenterX
 *    dirY = screenY - labelCenterY
 *    normalize(dirX, dirY)
 *    ```
 *
 * 3. **Find start point (label edge):**
 *    - Cast ray from label center toward aircraft
 *    - Find intersection with label rectangle boundary
 *    - Add 3px gap from edge
 *
 * 4. **Find end point (near aircraft):**
 *    - Position 10px before aircraft screen position
 *    - Leaves small gap between line and aircraft
 *
 * 5. **Hide line if too close:**
 *    - If distance < 1px, hide leader line
 *    - Prevents overlapping label and line
 *
 * ## Followed Aircraft Highlighting
 *
 * Followed aircraft labels are visually distinct:
 * - **Background**: Dark blue `rgba(0, 50, 80, 0.85)` instead of black
 * - **Scale**: 1.2x larger (120% size)
 * - **Color**: Same aircraft color as normal labels
 *
 * This makes it easy to identify which aircraft is being followed by the camera.
 *
 * ## Label Visibility Management
 *
 * Labels follow a hide-then-show-visible pattern each frame:
 *
 * 1. **Frame start**: Call `hideAllLabels()` to hide everything
 * 2. **Culling**: Determine which aircraft are visible (distance, weather)
 * 3. **Update visible**: Call `updateLabelPosition()` for each visible aircraft
 * 4. **Render**: Labels that were positioned are now visible
 *
 * This pattern ensures only actively visible aircraft show labels, and stale
 * labels from aircraft that disappeared or moved out of range are hidden.
 *
 * ## Memory Management
 *
 * ### Resource Tracking
 * Each GUI control creation/disposal is tracked:
 * - `guiControlsCreated`: Incremented when Rectangle, TextBlock, or Line is created
 * - `guiControlsDisposed`: Incremented when controls are disposed
 *
 * Access counters via `getLabelMemoryCounters()`.
 *
 * ### Label Disposal
 * When removing a label:
 * 1. Dispose text block
 * 2. Dispose leader line
 * 3. Dispose label container
 * 4. Remove from labels map
 * 5. Increment disposal counters (3x for three controls)
 *
 * **Important:** GUI controls must be disposed manually. Babylon.js scene disposal
 * does NOT automatically dispose GUI controls from AdvancedDynamicTexture.
 *
 * ## Performance Considerations
 *
 * - **Label creation**: ~0.1ms per label (three GUI controls)
 * - **Label updates**: ~0.01ms per label (color/text changes)
 * - **Position updates**: ~0.02ms per label (geometry calculations)
 * - **Typical load**: 50-100 labels at 60Hz = 1-2ms per frame
 * - **Memory**: ~1KB per label (GUI controls + map entry)
 *
 * ## Common Patterns
 *
 * ### Rendering Loop Integration
 * ```typescript
 * const { hideAllLabels, updateLabel, updateLabelPosition } = useBabylonLabels({ guiTexture })
 *
 * // Each frame:
 * function renderFrame() {
 *   hideAllLabels()  // Hide all labels at frame start
 *
 *   filteredAircraft.forEach(aircraft => {
 *     // Update label data (creates if doesn't exist)
 *     updateLabel(
 *       aircraft.callsign,
 *       aircraft.color,
 *       aircraft.isFollowed,
 *       `${aircraft.callsign}\\n${aircraft.type}\\n${aircraft.altitude}\\n${aircraft.speed}`
 *     )
 *
 *     // Position label (makes visible)
 *     updateLabelPosition(
 *       aircraft.callsign,
 *       aircraft.screenX,
 *       aircraft.screenY,
 *       50,  // 50px offset X
 *       -20  // -20px offset Y (above aircraft)
 *     )
 *   })
 * }
 * ```
 *
 * ### Cleanup on Aircraft Removal
 * ```typescript
 * const { removeLabel, getAircraftCallsigns } = useBabylonLabels({ guiTexture })
 *
 * // Remove labels for aircraft that disappeared
 * const currentCallsigns = new Set(aircraft.map(a => a.callsign))
 * const labelCallsigns = getAircraftCallsigns()
 *
 * labelCallsigns.forEach(callsign => {
 *   if (!currentCallsigns.has(callsign)) {
 *     removeLabel(callsign)  // Dispose label resources
 *   }
 * })
 * ```
 *
 * @param options - Label management options
 * @param options.guiTexture - GUI AdvancedDynamicTexture for rendering labels (required)
 * @returns Label management functions
 *
 * @example
 * // Basic label management
 * const { updateLabel, updateLabelPosition, removeLabel } = useBabylonLabels({
 *   guiTexture
 * })
 *
 * // Create label with default text (callsign only)
 * updateLabel('AAL123', { r: 0, g: 1, b: 0 }, false)
 *
 * // Update with full datablock info
 * updateLabel(
 *   'AAL123',
 *   { r: 0, g: 1, b: 0 },
 *   false,
 *   'AAL123\\nA320\\n5000\\n250'
 * )
 *
 * // Position label on screen
 * updateLabelPosition('AAL123', 500, 300, 50, -20)
 *
 * // Remove when aircraft leaves range
 * removeLabel('AAL123')
 *
 * @example
 * // Highlighting followed aircraft
 * const followedCallsign = 'DAL456'
 *
 * aircraft.forEach(ac => {
 *   updateLabel(
 *     ac.callsign,
 *     ac.color,
 *     ac.callsign === followedCallsign,  // isFollowed = true for followed aircraft
 *     ac.datablockText
 *   )
 * })
 * // Followed aircraft label will have dark blue background and 1.2x scale
 *
 * @example
 * // Frame rendering pattern with visibility culling
 * function renderLabels(visibleAircraft: Aircraft[]) {
 *   // Hide all labels at frame start
 *   hideAllLabels()
 *
 *   // Update only visible aircraft labels
 *   visibleAircraft.forEach(aircraft => {
 *     updateLabel(aircraft.callsign, aircraft.color, aircraft.isFollowed, aircraft.text)
 *     updateLabelPosition(aircraft.callsign, aircraft.screenX, aircraft.screenY, 50, -20)
 *   })
 *
 *   // Labels not updated this frame remain hidden
 * }
 *
 * @see useBabylonScene - For GUI texture initialization
 * @see getLabelMemoryCounters - For memory diagnostic counters
 */
export function useBabylonLabels(
  options: UseBabylonLabelsOptions
): UseBabylonLabelsResult {
  const { guiTexture } = options

  const aircraftLabelsRef = useRef<Map<string, AircraftLabel>>(new Map())

  // Create or update aircraft label
  const updateLabel = useCallback((
    callsign: string,
    color: { r: number; g: number; b: number },
    isFollowed: boolean,
    labelText?: string
  ) => {
    if (!guiTexture) return

    let labelData = aircraftLabelsRef.current.get(callsign)

    if (!labelData) {
      // Create label container
      const label = new GUI.Rectangle(`${callsign}_label`)
      memoryCounters.guiControlsCreated++
      label.width = 'auto'
      label.height = 'auto'
      label.cornerRadius = 4
      label.thickness = 1
      label.background = isFollowed ? 'rgba(0, 50, 80, 0.85)' : 'rgba(0, 0, 0, 0.85)'
      label.color = rgbToHex(color.r, color.g, color.b)
      label.adaptWidthToChildren = true
      label.adaptHeightToChildren = true
      label.horizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_LEFT
      label.verticalAlignment = GUI.Control.VERTICAL_ALIGNMENT_TOP
      label.zIndex = 10
      label.isVisible = false
      guiTexture.addControl(label)

      // Create text block
      const text = new GUI.TextBlock(`${callsign}_text`)
      memoryCounters.guiControlsCreated++
      text.text = labelText || callsign
      text.color = rgbToHex(color.r, color.g, color.b)
      text.fontSize = 12
      text.fontFamily = 'monospace'
      text.fontWeight = 'bold'
      text.textHorizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_LEFT
      text.resizeToFit = true
      text.paddingLeft = '4px'
      text.paddingRight = '4px'
      text.paddingTop = '2px'
      text.paddingBottom = '2px'
      label.addControl(text)

      // Create leader line
      // Initialize coordinates off-screen to prevent dot appearing at center
      // (GUI.Line defaults to center alignment with x1=y1=x2=y2=0)
      const leaderLine = new GUI.Line(`${callsign}_leaderLine`)
      memoryCounters.guiControlsCreated++
      leaderLine.lineWidth = 3
      leaderLine.color = rgbToHex(color.r, color.g, color.b)
      leaderLine.zIndex = 1
      leaderLine.x1 = -10000
      leaderLine.y1 = -10000
      leaderLine.x2 = -10000
      leaderLine.y2 = -10000
      leaderLine.isVisible = false
      guiTexture.addControl(leaderLine)

      labelData = { label, labelText: text, leaderLine }
      aircraftLabelsRef.current.set(callsign, labelData)
    }

    // Update colors and text
    labelData.leaderLine.color = rgbToHex(color.r, color.g, color.b)
    labelData.labelText.text = labelText || callsign
    labelData.labelText.color = rgbToHex(color.r, color.g, color.b)
    labelData.label.color = rgbToHex(color.r, color.g, color.b)
    labelData.label.background = isFollowed ? 'rgba(0, 50, 80, 0.85)' : 'rgba(0, 0, 0, 0.85)'
    const scale = isFollowed ? 1.2 : 1.0
    labelData.label.scaleX = scale
    labelData.label.scaleY = scale
  }, [guiTexture])

  // Update label position and leader line
  const updateLabelPosition = useCallback((
    callsign: string,
    screenX: number,
    screenY: number,
    labelOffsetX: number,
    labelOffsetY: number
  ) => {
    const labelData = aircraftLabelsRef.current.get(callsign)
    if (!labelData) return

    // Position label with offset from model screen position
    const labelX = screenX + labelOffsetX
    const labelY = screenY + labelOffsetY

    labelData.label.left = labelX
    labelData.label.top = labelY

    // Get label dimensions for line endpoint calculation
    const labelW = labelData.label.widthInPixels || 80
    const labelH = labelData.label.heightInPixels || 24

    // Line from label center to model screen position
    const labelCenterX = labelX + labelW / 2
    const labelCenterY = labelY + labelH / 2

    // Calculate direction from label to model
    const dirX = screenX - labelCenterX
    const dirY = screenY - labelCenterY
    const dist = Math.sqrt(dirX * dirX + dirY * dirY)

    if (dist < 1) {
      // Too close, hide line but show label
      labelData.label.isVisible = true
      labelData.leaderLine.isVisible = false
      return
    }

    // Normalize direction
    const nx = dirX / dist
    const ny = dirY / dist

    // Line starts at label edge - calculate intersection with rectangle
    const tX = Math.abs(nx) > 0.001 ? (labelW / 2) / Math.abs(nx) : 10000
    const tY = Math.abs(ny) > 0.001 ? (labelH / 2) / Math.abs(ny) : 10000
    const tEdge = Math.min(tX, tY) + 3  // +3 pixel gap from edge

    const startX = labelCenterX + nx * tEdge
    const startY = labelCenterY + ny * tEdge

    // Line ends near model (leave small gap)
    const endX = screenX - nx * 3
    const endY = screenY - ny * 3

    // Set line coordinates BEFORE making visible to prevent flash at (0,0)
    labelData.leaderLine.x1 = startX
    labelData.leaderLine.y1 = startY
    labelData.leaderLine.x2 = endX
    labelData.leaderLine.y2 = endY

    // Now show label and leader line (coordinates already set)
    labelData.label.isVisible = true
    labelData.leaderLine.isVisible = true
  }, [])

  // Remove aircraft label
  const removeLabel = useCallback((callsign: string) => {
    const labelData = aircraftLabelsRef.current.get(callsign)
    if (labelData) {
      labelData.labelText.dispose()
      memoryCounters.guiControlsDisposed++
      labelData.leaderLine.dispose()
      memoryCounters.guiControlsDisposed++
      labelData.label.dispose()
      memoryCounters.guiControlsDisposed++
      aircraftLabelsRef.current.delete(callsign)
    }
  }, [])

  // Remove all aircraft labels
  const clearAllLabels = useCallback(() => {
    for (const [, labelData] of aircraftLabelsRef.current) {
      labelData.labelText.dispose()
      memoryCounters.guiControlsDisposed++
      labelData.leaderLine.dispose()
      memoryCounters.guiControlsDisposed++
      labelData.label.dispose()
      memoryCounters.guiControlsDisposed++
    }
    aircraftLabelsRef.current.clear()
  }, [])

  // Get label data for specific aircraft
  const getLabel = useCallback((callsign: string) => {
    return aircraftLabelsRef.current.get(callsign)
  }, [])

  // Get all current aircraft callsigns
  const getAircraftCallsigns = useCallback(() => {
    return Array.from(aircraftLabelsRef.current.keys())
  }, [])

  // Hide all labels (called at start of frame)
  const hideAllLabels = useCallback(() => {
    for (const [, labelData] of aircraftLabelsRef.current) {
      labelData.label.isVisible = false
      labelData.leaderLine.isVisible = false
    }
  }, [])

  return {
    updateLabel,
    updateLabelPosition,
    removeLabel,
    clearAllLabels,
    getLabel,
    getAircraftCallsigns,
    hideAllLabels
  }
}

export default useBabylonLabels
