/**
 * Landing Gear Animation Controller
 *
 * Controls landing gear animations for Cesium glTF models based on aircraft state.
 * Uses direct node transforms (model.getNode().matrix) for reliable animation control.
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
 * ## Implementation Notes
 * We bypass Cesium's built-in animation system (which has issues with animationTime
 * callbacks) and instead parse glTF animation data directly, then apply node
 * transforms via model.getNode().matrix. This approach is based on the
 * Cesium-ModelAnimationPlayer library.
 *
 * @see https://github.com/ProminentEdge/Cesium-ModelAnimationPlayer
 */

import * as Cesium from 'cesium'
import { parseAnimationSetFromUrl, applyGearAnimationsPercent, type AnimationSet } from './gltfAnimationParser'

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
  retractAltitude: 150,          // Retract gear when climbing above 150ft AGL
  descentRateThreshold: -100,    // ft/min - consider descending if < -100 ft/min
  climbRateThreshold: 100,       // ft/min - consider climbing if > 100 ft/min
  transitionTime: 12.0           // 12 seconds to extend/retract (realistic timing)
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
 * Initialize gear state for a newly-appeared aircraft based on its current conditions.
 *
 * Unlike getGearState() which always defaults to gear-down, this function sets the
 * initial gear position based on the aircraft's current state:
 * - Ground aircraft: gear down
 * - Low altitude or descending aircraft: gear down
 * - High altitude cruising/climbing aircraft: gear up
 *
 * This prevents unrealistic scenarios like aircraft spawning at cruise altitude
 * with gear down.
 *
 * @param callsign - Aircraft callsign
 * @param altitude - Current altitude in feet AGL
 * @param verticalRate - Vertical rate in feet per minute (positive = climbing)
 * @param isOnGround - Whether aircraft is on the ground
 * @param config - Gear animation configuration
 */
export function initializeGearState(
  callsign: string,
  altitude: number,
  verticalRate: number,
  isOnGround: boolean,
  config: GearAnimationConfig = DEFAULT_GEAR_CONFIG
): void {
  // For NEW aircraft (verticalRate=0 indicates no history), be more conservative about gear state.
  // VATSIM can report high groundspeed for ground aircraft (landing roll, stale data, reconnects),
  // and altitude may be miscalculated before terrain sampling completes.
  //
  // Conservative approach: if vertical rate is 0 (new aircraft) and altitude isn't clearly
  // at cruise level (>3000ft), assume gear should be DOWN. This prevents the jarring visual
  // of ground aircraft spawning with gear up.
  const isNewAircraft = Math.abs(verticalRate) < 1 // No vertical rate history
  const clearlyCruising = altitude > 3000 // Well above pattern altitude

  // For new aircraft, only assume gear UP if clearly at cruise altitude
  // For aircraft with vertical rate history, use normal logic
  const assumeGearDown = isNewAircraft
    ? !clearlyCruising
    : (isOnGround || altitude < config.extendAltitude)

  // Calculate what the gear state should be based on current aircraft conditions
  const initialProgress = calculateTargetGearProgress(
    altitude,
    verticalRate,
    isOnGround,
    assumeGearDown,
    config
  )

  const state: GearAnimationState = {
    progress: initialProgress,
    targetProgress: initialProgress,
    transitionStartTime: 0,
    transitionStartProgress: initialProgress,
    isTransitioning: false
  }
  gearStates.set(callsign, state)
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

/** Animation sets that have been loaded or are pending */
const animationSetsLoading = new Set<string>()
const animationSets = new Map<string, AnimationSet>()

/**
 * Apply gear animation to a Cesium model using direct node transforms.
 *
 * This bypasses Cesium's built-in animation system (which doesn't work reliably
 * with animationTime callbacks) and instead:
 * 1. Parses the glTF animation data directly
 * 2. Interpolates keyframes based on gear progress
 * 3. Applies transforms directly via model.getNode().matrix
 *
 * FSLTL models use pattern: custom_anim_GEAR_ANIMATION_POSITION_X_NN
 * where X is 0 (nose), 1 (left main), 2 (right main)
 *
 * @param model - Cesium Model instance
 * @param gearProgress - Gear progress (0 = up, 1 = down)
 * @param callsign - Aircraft callsign (for tracking initialization state)
 * @param modelUrl - Model URL (to detect model swaps requiring reinitialization)
 * @param knownAnimationCount - Optional animation count (unused, kept for API compatibility)
 */
export function applyGearAnimation(
  model: Cesium.Model,
  gearProgress: number,
  callsign: string,
  modelUrl: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  knownAnimationCount?: number
): void {
  if (!model.ready) {
    return
  }

  // Clamp progress to valid range
  const progress = Math.max(0, Math.min(1, gearProgress))

  // Check if animations need to be loaded for this model URL
  if (!animationSets.has(modelUrl) && !animationSetsLoading.has(modelUrl)) {
    animationSetsLoading.add(modelUrl)

    // Start async parse of animation data
    parseAnimationSetFromUrl(modelUrl).then(animSet => {
      animationSetsLoading.delete(modelUrl)
      if (animSet) {
        animationSets.set(modelUrl, animSet)
      }
    })
    return
  }

  // Get cached animation set
  const animSet = animationSets.get(modelUrl)
  if (!animSet) {
    return // Still loading or no animations
  }

  // Apply gear animations using direct node transforms (with caching by modelUrl)
  applyGearAnimationsPercent(model, animSet, progress, modelUrl)
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
  animationSets.clear()
  animationSetsLoading.clear()
}

/**
 * Get current gear state for debugging
 */
export function getGearStateDebug(callsign: string): GearAnimationState | undefined {
  return gearStates.get(callsign)
}

/**
 * Get current gear progress for an aircraft (0 = retracted, 1 = extended)
 * Returns 1.0 (gear down) as default if no state exists
 */
export function getCurrentGearProgress(callsign: string): number {
  const state = gearStates.get(callsign)
  return state?.progress ?? 1.0
}
