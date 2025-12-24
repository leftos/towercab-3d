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
 * ## Gear State Logic (with hysteresis)
 * Gear EXTENDS when:
 * - On the ground
 * - Descending below 2,000 ft AGL
 *
 * Gear RETRACTS when:
 * - Climbing above 500 ft AGL
 *
 * The hysteresis prevents gear cycling during level flight near thresholds.
 *
 * @see https://cesium.com/blog/2019/06/05/timeline-independent-animations/
 */

import * as Cesium from 'cesium'

/** Gear animation state */
export type GearState = 'up' | 'extending' | 'down' | 'retracting'

/** Configuration for gear animation behavior */
export interface GearAnimationConfig {
  /** Altitude below which gear extends when descending (feet AGL) */
  extendAltitude: number
  /** Altitude above which gear retracts when climbing (feet AGL) */
  retractAltitude: number
  /** Vertical rate threshold to consider aircraft "descending" (ft/min, negative) */
  descentRateThreshold: number
  /** Vertical rate threshold to consider aircraft "climbing" (ft/min, positive) */
  climbRateThreshold: number
  /** Time for gear to fully extend/retract (seconds) */
  transitionTime: number
}

/** Default gear animation configuration */
export const DEFAULT_GEAR_CONFIG: GearAnimationConfig = {
  extendAltitude: 2000,          // Extend gear when descending below 2000ft AGL
  retractAltitude: 500,          // Retract gear when climbing above 500ft AGL
  descentRateThreshold: -100,    // ft/min - consider descending if < -100 ft/min
  climbRateThreshold: 100,       // ft/min - consider climbing if > 100 ft/min
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
 * Uses hysteresis to prevent gear cycling:
 * - Gear extends when descending below extendAltitude (2000ft default)
 * - Gear retracts when climbing above retractAltitude (500ft default)
 * - Between thresholds, gear maintains current state
 *
 * @param altitude - Altitude in feet AGL
 * @param verticalRate - Vertical rate in feet per minute (positive = climbing)
 * @param isOnGround - Whether aircraft is on the ground
 * @param currentGearDown - Current gear state (true = down, false = up)
 * @param config - Gear animation configuration
 * @returns Target gear progress (0 = up, 1 = down)
 */
export function calculateTargetGearProgress(
  altitude: number,
  verticalRate: number,
  isOnGround: boolean,
  currentGearDown: boolean,
  config: GearAnimationConfig = DEFAULT_GEAR_CONFIG
): number {
  // Always gear down when on ground
  if (isOnGround) {
    return 1.0
  }

  const isDescending = verticalRate < config.descentRateThreshold
  const isClimbing = verticalRate > config.climbRateThreshold

  // Extend gear when descending below extend altitude
  if (altitude < config.extendAltitude && isDescending) {
    return 1.0
  }

  // Retract gear when climbing above retract altitude
  if (altitude > config.retractAltitude && isClimbing) {
    return 0.0
  }

  // Very low altitude - always gear down for safety
  if (altitude < config.retractAltitude) {
    return 1.0
  }

  // Between thresholds or level flight - maintain current state (hysteresis)
  return currentGearDown ? 1.0 : 0.0
}

/**
 * Update gear animation state for an aircraft
 * Should be called each frame for aircraft with animations
 *
 * @param callsign - Aircraft callsign
 * @param altitude - Current altitude in feet AGL
 * @param verticalRate - Vertical rate in feet per minute (positive = climbing)
 * @param isOnGround - Whether aircraft is on ground
 * @param currentTime - Current time in milliseconds (Date.now())
 * @param config - Gear animation configuration
 * @returns Current gear progress (0-1)
 */
export function updateGearAnimation(
  callsign: string,
  altitude: number,
  verticalRate: number,
  isOnGround: boolean,
  currentTime: number,
  config: GearAnimationConfig = DEFAULT_GEAR_CONFIG
): number {
  const state = getGearState(callsign)
  const currentGearDown = state.progress > 0.5  // Consider gear "down" if more than halfway
  const targetProgress = calculateTargetGearProgress(altitude, verticalRate, isOnGround, currentGearDown, config)

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

/** Track which models have been initialized with gear animations */
const initializedModels = new WeakSet<Cesium.Model>()

/**
 * Apply gear animation to a Cesium model
 * Finds and controls landing gear animations by name
 *
 * FSLTL models use pattern: custom_anim_GEAR_ANIMATION_POSITION_X_NN
 * where X is 0 (nose), 1 (left main), 2 (right main)
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

  // Keywords that identify gear-related animations
  const gearKeywords = [
    'GEAR_ANIMATION_POSITION',  // FSLTL pattern
    'LandingGear',
    'landing_gear',
    'Gear',
    'gear',
    'LG'
  ]

  // Initialize gear animations if not already done
  if (!initializedModels.has(model)) {
    initializedModels.add(model)

    // Try to find and add all gear animations by iterating through indices
    // FSLTL models typically have 15-25 animations; we check first 50 to be safe
    for (let idx = 0; idx < 50; idx++) {
      try {
        const anim = model.activeAnimations.add({
          index: idx,
          loop: Cesium.ModelAnimationLoop.NONE,
          multiplier: 0  // Don't play automatically
        })
        if (anim) {
          // Check if this is a gear animation
          const isGearAnim = gearKeywords.some(kw =>
            anim.name.toUpperCase().includes(kw.toUpperCase())
          )
          if (!isGearAnim) {
            // Not a gear animation, remove it
            model.activeAnimations.remove(anim)
          }
        }
      } catch {
        // Index out of range or other error - stop trying
        break
      }
    }
  }

  // Update all active gear animations to the target progress
  for (let i = 0; i < model.activeAnimations.length; i++) {
    const anim = model.activeAnimations.get(i)
    if (anim) {
      setAnimationProgress(anim, progress)
    }
  }
}

/**
 * Set animation to a specific progress point
 * @param animation - Cesium ModelAnimation
 * @param progress - Progress from 0 to 1 (0 = gear up/retracted, 1 = gear down/extended)
 */
function setAnimationProgress(animation: Cesium.ModelAnimation, progress: number): void {
  // Use animationTime callback to set specific frame
  // The callback receives (duration, seconds) and should return the animation time in seconds
  // FSLTL gear animations: progress 0 = gear up (start), progress 1 = gear down (end)
  const targetProgress = progress

  animation.animationTime = function(duration: number, _seconds: number): number {
    // Scale progress (0-1) to animation duration (0-duration seconds)
    return targetProgress * duration
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
