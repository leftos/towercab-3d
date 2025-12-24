/**
 * Landing Gear Animation Controller
 *
 * Controls landing gear animations for Cesium glTF models based on aircraft state.
 * Uses Cesium's animationTime callback to set specific animation frames.
 *
 * ## Animation Progress
 * - 0.0 = Gear fully retracted (up)
 * - 1.0 = Gear fully extended (down)
 *
 * ## Gear State Logic
 * Aircraft should have gear DOWN when:
 * - On the ground
 * - Below 5,000 ft AGL (approach phase)
 * - Below 25,000 ft AND ground speed < 250 knots
 *
 * @see https://cesium.com/blog/2019/06/05/timeline-independent-animations/
 */

import * as Cesium from 'cesium'

/** Gear animation state */
export type GearState = 'up' | 'extending' | 'down' | 'retracting'

/** Configuration for gear animation behavior */
export interface GearAnimationConfig {
  /** Altitude below which gear is always down (feet MSL) */
  alwaysDownAltitude: number
  /** Maximum altitude for gear extension (feet MSL) */
  maxExtensionAltitude: number
  /** Maximum speed for gear extension (knots) */
  maxExtensionSpeed: number
  /** Time for gear to fully extend/retract (seconds) */
  transitionTime: number
}

/** Default gear animation configuration */
export const DEFAULT_GEAR_CONFIG: GearAnimationConfig = {
  alwaysDownAltitude: 5000,      // Below 5000ft, always gear down
  maxExtensionAltitude: 25000,   // Can't extend above 25000ft
  maxExtensionSpeed: 250,        // Can't extend above 250kt
  transitionTime: 5.0            // 5 seconds to extend/retract
}

/** Per-aircraft gear animation state */
interface GearAnimationState {
  /** Current gear progress (0 = up, 1 = down) */
  progress: number
  /** Target gear progress */
  targetProgress: number
  /** Timestamp when transition started */
  transitionStartTime: number
  /** Progress when transition started */
  transitionStartProgress: number
  /** Whether currently transitioning */
  isTransitioning: boolean
}

/** Gear animation states keyed by callsign */
const gearStates = new Map<string, GearAnimationState>()

/**
 * Get or create gear animation state for an aircraft
 */
function getGearState(callsign: string): GearAnimationState {
  let state = gearStates.get(callsign)
  if (!state) {
    state = {
      progress: 1.0,  // Start with gear down (safer default)
      targetProgress: 1.0,
      transitionStartTime: 0,
      transitionStartProgress: 1.0,
      isTransitioning: false
    }
    gearStates.set(callsign, state)
  }
  return state
}

/**
 * Determine target gear state based on aircraft conditions
 *
 * @param altitude - Altitude in feet MSL
 * @param groundSpeed - Ground speed in knots
 * @param isOnGround - Whether aircraft is on the ground
 * @param config - Gear animation configuration
 * @returns Target gear progress (0 = up, 1 = down)
 */
export function calculateTargetGearProgress(
  altitude: number,
  groundSpeed: number,
  isOnGround: boolean,
  config: GearAnimationConfig = DEFAULT_GEAR_CONFIG
): number {
  // Always gear down when on ground
  if (isOnGround) {
    return 1.0
  }

  // Always gear down below approach altitude
  if (altitude < config.alwaysDownAltitude) {
    return 1.0
  }

  // Gear down if below max extension altitude AND below max extension speed
  if (altitude < config.maxExtensionAltitude && groundSpeed < config.maxExtensionSpeed) {
    return 1.0
  }

  // Otherwise gear up
  return 0.0
}

/**
 * Update gear animation state for an aircraft
 * Should be called each frame for aircraft with animations
 *
 * @param callsign - Aircraft callsign
 * @param altitude - Current altitude in feet MSL
 * @param groundSpeed - Current ground speed in knots
 * @param isOnGround - Whether aircraft is on ground
 * @param currentTime - Current time in milliseconds (Date.now())
 * @param config - Gear animation configuration
 * @returns Current gear progress (0-1)
 */
export function updateGearAnimation(
  callsign: string,
  altitude: number,
  groundSpeed: number,
  isOnGround: boolean,
  currentTime: number,
  config: GearAnimationConfig = DEFAULT_GEAR_CONFIG
): number {
  const state = getGearState(callsign)
  const targetProgress = calculateTargetGearProgress(altitude, groundSpeed, isOnGround, config)

  // Check if target changed
  if (Math.abs(targetProgress - state.targetProgress) > 0.01) {
    // Start new transition
    state.targetProgress = targetProgress
    state.transitionStartTime = currentTime
    state.transitionStartProgress = state.progress
    state.isTransitioning = true
  }

  // Update progress if transitioning
  if (state.isTransitioning) {
    const elapsed = (currentTime - state.transitionStartTime) / 1000 // Convert to seconds
    const transitionProgress = Math.min(elapsed / config.transitionTime, 1.0)

    // Ease in-out for smooth animation
    const easedProgress = easeInOutCubic(transitionProgress)

    // Interpolate between start and target
    state.progress = state.transitionStartProgress +
      (state.targetProgress - state.transitionStartProgress) * easedProgress

    // Check if transition complete
    if (transitionProgress >= 1.0) {
      state.progress = state.targetProgress
      state.isTransitioning = false
    }
  }

  return state.progress
}

/**
 * Apply gear animation to a Cesium model
 * Finds and controls landing gear animations by name
 *
 * @param model - Cesium Model instance
 * @param gearProgress - Gear progress (0 = up, 1 = down)
 */
export function applyGearAnimation(
  model: Cesium.Model,
  gearProgress: number
): void {
  if (!model.ready || !model.activeAnimations) {
    return
  }

  // Clamp progress to valid range
  const progress = Math.max(0, Math.min(1, gearProgress))

  // Try to find gear animation by common names
  const gearAnimationNames = [
    'LandingGear',
    'landing_gear',
    'Gear',
    'gear',
    'LG',
    'lg',
    // MSFS-specific names
    'LANDING_GEAR_Center',
    'LANDING_GEAR_Left',
    'LANDING_GEAR_Right',
    'c_gear',
    'l_gear',
    'r_gear'
  ]

  // Get all animations and find gear-related ones
  try {
    // If no animations are playing, try to add one
    if (model.activeAnimations.length === 0) {
      // Try each potential gear animation name
      for (const name of gearAnimationNames) {
        try {
          const anim = model.activeAnimations.add({
            name: name,
            loop: Cesium.ModelAnimationLoop.NONE,
            multiplier: 0 // Don't play automatically
          })
          if (anim) {
            // Successfully added, set the time
            setAnimationProgress(anim, progress)
            break
          }
        } catch {
          // Animation name not found, try next
        }
      }

      // If still no animations, try adding by index
      if (model.activeAnimations.length === 0) {
        try {
          const anim = model.activeAnimations.add({
            index: 0,
            loop: Cesium.ModelAnimationLoop.NONE,
            multiplier: 0
          })
          if (anim) {
            setAnimationProgress(anim, progress)
          }
        } catch {
          // No animations available
        }
      }
    } else {
      // Update existing animations
      for (let i = 0; i < model.activeAnimations.length; i++) {
        const anim = model.activeAnimations.get(i)
        if (anim) {
          setAnimationProgress(anim, progress)
        }
      }
    }
  } catch (error) {
    // Model may not have animations, silently ignore
    console.debug('[GearAnimation] Could not apply animation:', error)
  }
}

/**
 * Set animation to a specific progress point
 * @param animation - Cesium ModelAnimation
 * @param progress - Progress from 0 to 1
 */
function setAnimationProgress(animation: Cesium.ModelAnimation, progress: number): void {
  // Use animationTime callback to set specific frame
  // The callback receives (duration, seconds) and should return the animation time
  const targetTime = progress // Normalized 0-1

  animation.animationTime = function(_duration: number, _seconds: number): number {
    // Return normalized time (0-1 maps to full animation duration)
    return targetTime
  }
}

/**
 * Cubic ease in-out function for smooth transitions
 */
function easeInOutCubic(t: number): number {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/**
 * Clear gear state for an aircraft (when it leaves the scene)
 */
export function clearGearState(callsign: string): void {
  gearStates.delete(callsign)
}

/**
 * Clear all gear states
 */
export function clearAllGearStates(): void {
  gearStates.clear()
}

/**
 * Get current gear state for debugging
 */
export function getGearStateDebug(callsign: string): GearAnimationState | undefined {
  return gearStates.get(callsign)
}
