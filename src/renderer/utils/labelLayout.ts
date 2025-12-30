/**
 * Label Layout Algorithm - Continuous Positioning
 *
 * Sophisticated algorithm for positioning aircraft datablocks to avoid overlaps
 * using continuous angles and distances, not limited to 8 fixed positions.
 *
 * Algorithm: Priority-Based Spiral Search
 *
 * 1. Sort labels by priority (followed > custom position > closer > airborne)
 * 2. For each label in priority order:
 *    a. Calculate preferred angle from user's numpad preference
 *    b. Search in a spiral pattern starting at preferred angle/distance
 *    c. Try positions at increasing distances if needed
 *    d. Pick the first non-overlapping position
 * 3. If no valid position exists, use preferred position (overlap better than hiding)
 *
 * Key features:
 * - Continuous angle search (not limited to 8 directions)
 * - Distance can extend beyond leader line setting if needed
 * - Respects user preference as starting point
 * - High-priority labels get best positions
 */

import type { DatablockPosition } from '../stores/datablockPositionStore'

/** Rectangle bounds for collision detection */
interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Aircraft data needed for label placement */
export interface LabelAircraftData {
  callsign: string
  aircraftScreenX: number  // Screen X of aircraft model center
  aircraftScreenY: number  // Screen Y for leader line attachment
  modelRadius: number      // Radius of aircraft model on screen
  preferredPosition: DatablockPosition  // User's numpad choice
  hasCustomPosition: boolean  // True if user explicitly set position for this aircraft
  isFollowed: boolean      // True if camera is following this aircraft
  isAirborne: boolean      // True if aircraft is in the air
  distanceMeters: number   // Distance from camera
}

/** Result of label placement */
export interface LabelPlacement {
  callsign: string
  aircraftX: number
  aircraftY: number
  labelX: number
  labelY: number
  offsetX: number
  offsetY: number
}

/** Configuration for the layout algorithm */
export interface LayoutConfig {
  labelWidth: number
  labelHeight: number
  labelGap: number       // Preferred gap (from leader line setting)
  labelMargin: number    // Margin between labels
  screenWidth: number
  screenHeight: number
}

/**
 * Convert numpad position to angle in radians
 * 0° = right, 90° = down (screen coordinates where Y increases downward)
 *
 * Numpad layout:
 * 7 8 9    →  135° 90° 45°  (top row, pointing up-left, up, up-right)
 * 4 . 6    →  180° -- 0°    (middle row, pointing left, right)
 * 1 2 3    →  225° 270° 315° (bottom row, pointing down-left, down, down-right)
 *
 * In screen coords (Y down): up = -90°, down = 90°, left = 180°, right = 0°
 */
function numpadToAngle(position: DatablockPosition): number {
  const angles: Record<DatablockPosition, number> = {
    9: -Math.PI / 4,      // Up-right: -45° (-π/4)
    6: 0,                  // Right: 0°
    3: Math.PI / 4,       // Down-right: 45° (π/4)
    8: -Math.PI / 2,      // Up: -90° (-π/2)
    2: Math.PI / 2,       // Down: 90° (π/2)
    7: -3 * Math.PI / 4,  // Up-left: -135° (-3π/4)
    4: Math.PI,           // Left: 180° (π)
    1: 3 * Math.PI / 4,   // Down-left: 135° (3π/4)
  }
  return angles[position] ?? -3 * Math.PI / 4  // Default to top-left
}

/**
 * Calculate the distance from label center to label edge in a given direction
 * Used to compute proper edge-to-edge spacing between aircraft and label
 */
function labelEdgeDistance(
  angle: number,
  labelWidth: number,
  labelHeight: number
): number {
  const halfW = labelWidth / 2
  const halfH = labelHeight / 2

  // Direction from label center toward aircraft (opposite of placement angle)
  const cosA = Math.abs(Math.cos(angle))
  const sinA = Math.abs(Math.sin(angle))

  // Find where ray hits the label rectangle
  // For a ray from center, it hits vertical edge at t = halfW/cos or horizontal edge at t = halfH/sin
  if (cosA < 0.001) {
    return halfH  // Vertical direction, hits top/bottom edge
  }
  if (sinA < 0.001) {
    return halfW  // Horizontal direction, hits left/right edge
  }

  const tVertical = halfW / cosA
  const tHorizontal = halfH / sinA

  return Math.min(tVertical, tHorizontal)
}

/**
 * Calculate label position given angle and distance from aircraft
 * Returns top-left corner of label rectangle
 */
function calculateLabelPosition(
  aircraftX: number,
  aircraftY: number,
  angle: number,
  distance: number,
  labelWidth: number,
  labelHeight: number
): { x: number; y: number; offsetX: number; offsetY: number } {
  // Calculate center point of label at given angle/distance
  const centerX = aircraftX + Math.cos(angle) * distance
  const centerY = aircraftY + Math.sin(angle) * distance

  // Convert to top-left corner
  const x = centerX - labelWidth / 2
  const y = centerY - labelHeight / 2

  return {
    x,
    y,
    offsetX: x - aircraftX,
    offsetY: y - aircraftY
  }
}

/**
 * Check if two rectangles overlap with margin
 */
function rectsOverlap(a: Rect, b: Rect, margin: number): boolean {
  return !(
    a.x + a.width + margin <= b.x ||
    b.x + b.width + margin <= a.x ||
    a.y + a.height + margin <= b.y ||
    b.y + b.height + margin <= a.y
  )
}

/**
 * Check if a label overlaps with an aircraft model (circle)
 */
function labelOverlapsAircraft(
  labelX: number,
  labelY: number,
  labelWidth: number,
  labelHeight: number,
  aircraftX: number,
  aircraftY: number,
  modelRadius: number
): boolean {
  // Find closest point on rectangle to circle center
  const closestX = Math.max(labelX, Math.min(aircraftX, labelX + labelWidth))
  const closestY = Math.max(labelY, Math.min(aircraftY, labelY + labelHeight))

  const distX = aircraftX - closestX
  const distY = aircraftY - closestY

  return (distX * distX + distY * distY) < (modelRadius * modelRadius)
}

/**
 * Calculate priority for label placement
 * Higher priority = placed first, gets best positions
 */
function calculatePriority(data: LabelAircraftData): number {
  let priority = 0

  // Followed aircraft gets highest priority
  if (data.isFollowed) priority += 10000

  // Custom position (user explicitly set) gets high priority
  if (data.hasCustomPosition) priority += 1000

  // Airborne aircraft get priority over ground
  if (data.isAirborne) priority += 100

  // Closer aircraft get higher priority (inverse distance)
  const distanceScore = Math.max(0, 50 - data.distanceMeters / 1000)
  priority += distanceScore

  return priority
}

/**
 * Check if a position is valid (no overlaps)
 */
function isValidPosition(
  labelX: number,
  labelY: number,
  config: LayoutConfig,
  placedLabels: LabelPlacement[],
  allAircraft: LabelAircraftData[],
  currentCallsign: string
): boolean {
  const labelRect: Rect = {
    x: labelX,
    y: labelY,
    width: config.labelWidth,
    height: config.labelHeight
  }

  // Check overlap with already placed labels
  for (const placed of placedLabels) {
    const placedRect: Rect = {
      x: placed.labelX,
      y: placed.labelY,
      width: config.labelWidth,
      height: config.labelHeight
    }

    if (rectsOverlap(labelRect, placedRect, config.labelMargin)) {
      return false
    }
  }

  // Check overlap with all aircraft models (including other aircraft, not just own)
  for (const aircraft of allAircraft) {
    // Skip own aircraft - we handle that separately with modelRadius in distance calculation
    if (aircraft.callsign === currentCallsign) continue

    if (labelOverlapsAircraft(
      labelX,
      labelY,
      config.labelWidth,
      config.labelHeight,
      aircraft.aircraftScreenX,
      aircraft.aircraftScreenY,
      aircraft.modelRadius
    )) {
      return false
    }
  }

  return true
}

/**
 * Find best position for a label using spiral search
 *
 * Starts at preferred angle and distance, then searches outward in a spiral pattern
 * trying nearby angles at each distance tier before moving further out.
 */
function findBestPosition(
  data: LabelAircraftData,
  config: LayoutConfig,
  placedLabels: LabelPlacement[],
  allAircraft: LabelAircraftData[]
): LabelPlacement {
  const preferredAngle = numpadToAngle(data.preferredPosition)

  // Angle search parameters
  const angleStep = Math.PI / 12  // 15° increments
  const maxAngleOffset = Math.PI  // Search up to 180° from preferred

  // Distance tiers: start at preferred gap, extend if needed
  // Base distance accounts for label edge (varies by angle) + model radius + user's gap
  const baseGap = config.labelGap
  const maxGap = baseGap * 6  // Allow extending up to 6x the preferred gap
  const gapStep = Math.max(3, baseGap * 0.5)  // Step by half the gap or minimum 3px

  // Try distance tiers
  for (let gap = baseGap; gap <= maxGap; gap += gapStep) {
    // At each gap level, search angles starting from preferred
    // Alternate between positive and negative offsets from preferred angle
    for (let angleOffset = 0; angleOffset <= maxAngleOffset; angleOffset += angleStep) {
      const anglesToTry = angleOffset === 0
        ? [preferredAngle]
        : [preferredAngle + angleOffset, preferredAngle - angleOffset]

      for (const angle of anglesToTry) {
        // Calculate distance from aircraft center to label center
        // = model radius + gap + distance from label center to label edge
        const edgeDist = labelEdgeDistance(angle, config.labelWidth, config.labelHeight)
        const distance = data.modelRadius + gap + edgeDist

        const pos = calculateLabelPosition(
          data.aircraftScreenX,
          data.aircraftScreenY,
          angle,
          distance,
          config.labelWidth,
          config.labelHeight
        )

        // Check screen bounds (allow partial off-screen but not completely)
        const margin = 10
        if (pos.x + config.labelWidth < margin ||
            pos.x > config.screenWidth - margin ||
            pos.y + config.labelHeight < margin ||
            pos.y > config.screenHeight - margin) {
          continue
        }

        // Check for overlaps
        if (isValidPosition(pos.x, pos.y, config, placedLabels, allAircraft, data.callsign)) {
          return {
            callsign: data.callsign,
            aircraftX: data.aircraftScreenX,
            aircraftY: data.aircraftScreenY,
            labelX: pos.x,
            labelY: pos.y,
            offsetX: pos.offsetX,
            offsetY: pos.offsetY
          }
        }
      }
    }
  }

  // No valid position found - use preferred position anyway (overlap is better than hiding)
  const fallbackEdgeDist = labelEdgeDistance(preferredAngle, config.labelWidth, config.labelHeight)
  const fallbackDistance = data.modelRadius + baseGap + fallbackEdgeDist
  const fallbackPos = calculateLabelPosition(
    data.aircraftScreenX,
    data.aircraftScreenY,
    preferredAngle,
    fallbackDistance,
    config.labelWidth,
    config.labelHeight
  )

  return {
    callsign: data.callsign,
    aircraftX: data.aircraftScreenX,
    aircraftY: data.aircraftScreenY,
    labelX: fallbackPos.x,
    labelY: fallbackPos.y,
    offsetX: fallbackPos.offsetX,
    offsetY: fallbackPos.offsetY
  }
}

/**
 * Main layout function - positions all labels avoiding overlaps
 * Uses continuous angles and distances, not limited to 8 positions
 *
 * @param aircraftData - Array of aircraft needing labels
 * @param config - Layout configuration
 * @returns Array of label placements
 */
export function layoutLabels(
  aircraftData: LabelAircraftData[],
  config: LayoutConfig
): LabelPlacement[] {
  if (aircraftData.length === 0) return []

  // Sort by priority (highest first - they get placed first and get best positions)
  const sortedAircraft = [...aircraftData]
    .map(data => ({ data, priority: calculatePriority(data) }))
    .sort((a, b) => b.priority - a.priority)

  const placements: LabelPlacement[] = []

  // Place each label in priority order
  for (const { data } of sortedAircraft) {
    const placement = findBestPosition(data, config, placements, aircraftData)
    placements.push(placement)
  }

  return placements
}

/**
 * Simple layout without overlap avoidance - just use preferred positions
 */
export function layoutLabelsSimple(
  aircraftData: LabelAircraftData[],
  config: LayoutConfig
): LabelPlacement[] {
  return aircraftData.map(data => {
    const preferredAngle = numpadToAngle(data.preferredPosition)
    // Distance = model radius + user's gap + label edge distance (varies by angle)
    const edgeDist = labelEdgeDistance(preferredAngle, config.labelWidth, config.labelHeight)
    const distance = data.modelRadius + config.labelGap + edgeDist

    const pos = calculateLabelPosition(
      data.aircraftScreenX,
      data.aircraftScreenY,
      preferredAngle,
      distance,
      config.labelWidth,
      config.labelHeight
    )

    return {
      callsign: data.callsign,
      aircraftX: data.aircraftScreenX,
      aircraftY: data.aircraftScreenY,
      labelX: pos.x,
      labelY: pos.y,
      offsetX: pos.offsetX,
      offsetY: pos.offsetY
    }
  })
}
