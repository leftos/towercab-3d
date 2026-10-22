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
 * ## Gear State Logic
 * Gear EXTENDS when:
 * - In ground contact
 * - Descending below 2,000 ft AGL
 *
 * Gear RETRACTS when:
 * - Climbing after 2 s out of ground contact (positive rate confirmed)
 * - Climbing above 150 ft AGL, for an aircraft not in contact since it was drawn
 *
 * Otherwise the gear keeps its state, so level flight does not cycle it.
 * Each transition takes 8 s on an ease-out curve.
 *
 * ## Implementation Notes
 * We bypass Cesium's built-in animation system (which has issues with animationTime
 * callbacks) and instead parse glTF animation data directly, then apply node
 * transforms via model.getNode().matrix. This approach is based on the
 * Cesium-ModelAnimationPlayer library.
 *
 * @see https://github.com/ProminentEdge/Cesium-ModelAnimationPlayer
 */

import type * as Cesium from 'cesium'
import type { GearContact, GearFrameInput } from '@/types'
import { clearAllSurfaceStates, type SurfacePose } from '@/utils/surfaceAnimationController'
import { geoidService } from '../services/GeoidService'
import {
  type AnimationSet,
  applyClipAnimationsPercent,
  applyWheelSpin,
  parseAnimationSetFromUrl,
} from './gltfAnimationParser'

/**
 * Height of an aircraft above the ground, in one datum, for the gear rules.
 * The aircraft altitude is an ellipsoidal height while the ground elevation is MSL, so the
 * ground is converted to an ellipsoidal height at the aircraft's position before subtracting.
 *
 * @param ellipsoidalAltitude - Aircraft altitude in meters above the WGS84 ellipsoid
 * @param groundElevationMslMeters - Ground elevation in meters MSL
 * @param lat - Aircraft latitude in degrees
 * @param lon - Aircraft longitude in degrees
 * @returns Height above the ground in meters
 */
export function gearHeightAboveGroundMeters(
  ellipsoidalAltitude: number,
  groundElevationMslMeters: number,
  lat: number,
  lon: number,
): number {
  return ellipsoidalAltitude - geoidService.mslToEllipsoidal(lat, lon, groundElevationMslMeters)
}

/** Gear animation state */
export type GearState = 'up' | 'extending' | 'down' | 'retracting'

/** Configuration for gear animation behavior */
export interface GearAnimationConfig {
  /** Altitude below which gear extends when descending (feet AGL) */
  extendAltitude: number
  /** Altitude above which an aircraft not in contact since it was drawn retracts when climbing (feet AGL) */
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
  extendAltitude: 2000, // Extend gear when descending below 2000ft AGL
  retractAltitude: 150, // Without a liftoff seen, retract when climbing above 150ft AGL
  descentRateThreshold: -100, // ft/min - consider descending if < -100 ft/min
  climbRateThreshold: 100, // ft/min - consider climbing if > 100 ft/min
  transitionTime: 8.0, // 8 seconds to extend/retract (737-800: 8-10 s)
}

/** Seconds out of ground contact before a climbing aircraft retracts its gear (positive rate confirmed) */
export const GEAR_RETRACT_MIN_AIRBORNE_SECONDS = 2

/** Per-aircraft gear animation state */
interface GearAnimationState {
  /** Data-source time of the last frame in ground contact, or null when not in contact since it was drawn */
  lastContactTime: number | null
  /**
   * Whether the leave-contact retract has been commanded since the last contact. While set and out of contact the
   * gear holds its state (bar the extension when descending), so a later climb below retractAltitude does not retract.
   */
  leaveContactRetractDone: boolean
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
      lastContactTime: null,
      leaveContactRetractDone: false,
      progress: 1.0, // Start with gear down (safer default)
      targetProgress: 1.0,
      transitionStartTime: 0,
      transitionStartProgress: 1.0,
      isTransitioning: false,
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
 * @param inContact - Whether the aircraft is in ground contact
 * @param config - Gear animation configuration
 */
export function initializeGearState(
  callsign: string,
  altitude: number,
  verticalRate: number,
  inContact: boolean,
  config: GearAnimationConfig = DEFAULT_GEAR_CONFIG,
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
  const assumeGearDown = isNewAircraft ? !clearlyCruising : inContact || altitude < config.extendAltitude

  // Calculate what the gear state should be based on current aircraft conditions
  const contact: GearContact = { inContact, secondsSinceContact: inContact ? 0 : null }
  const initialProgress = calculateTargetGearProgress(altitude, verticalRate, contact, assumeGearDown, config)

  const state: GearAnimationState = {
    lastContactTime: null,
    leaveContactRetractDone: false,
    progress: initialProgress,
    targetProgress: initialProgress,
    transitionStartTime: 0,
    transitionStartProgress: initialProgress,
    isTransitioning: false,
  }
  gearStates.set(callsign, state)
}

/**
 * Determine target gear state based on aircraft conditions
 *
 * - Gear is down while in ground contact
 * - Gear extends when descending below extendAltitude (2000ft default)
 * - After leaving contact, gear retracts once climbing and out of contact for
 *   GEAR_RETRACT_MIN_AIRBORNE_SECONDS (positive rate confirmed)
 * - An aircraft not in contact since it was drawn (airborne spawn, go-around without touchdown) retracts when
 *   climbing above retractAltitude and stays down below it
 * - Otherwise the gear keeps its current state, so level flight does not cycle it
 *
 * @param altitude - Altitude in feet AGL
 * @param verticalRate - Vertical rate in feet per minute (positive = climbing)
 * @param contact - Ground contact and the time since the aircraft was last in contact
 * @param currentGearDown - Current gear state (true = down, false = up)
 * @param config - Gear animation configuration
 * @returns Target gear progress (0 = up, 1 = down)
 */
export function calculateTargetGearProgress(
  altitude: number,
  verticalRate: number,
  contact: GearContact,
  currentGearDown: boolean,
  config: GearAnimationConfig = DEFAULT_GEAR_CONFIG,
): number {
  if (contact.inContact) {
    return 1.0
  }

  const isClimbing = verticalRate > config.climbRateThreshold
  const hold = currentGearDown ? 1.0 : 0.0

  if (isExtendingOnDescent(altitude, verticalRate, config)) {
    return 1.0
  }

  if (contact.secondsSinceContact === null) {
    return targetWithoutContactSeen(altitude, isClimbing, hold, config)
  }

  if (isLeaveContactRetract(verticalRate, contact, config)) {
    return 0.0
  }

  return hold
}

/** Whether the aircraft is descending below extendAltitude, where the gear extends. */
function isExtendingOnDescent(altitude: number, verticalRate: number, config: GearAnimationConfig): boolean {
  return altitude < config.extendAltitude && verticalRate < config.descentRateThreshold
}

/** Whether the leave-contact retract applies: out of contact for the minimum time and climbing (positive rate). */
function isLeaveContactRetract(verticalRate: number, contact: GearContact, config: GearAnimationConfig): boolean {
  return (
    !contact.inContact &&
    contact.secondsSinceContact !== null &&
    contact.secondsSinceContact >= GEAR_RETRACT_MIN_AIRBORNE_SECONDS &&
    verticalRate > config.climbRateThreshold
  )
}

/**
 * Target gear progress for an aircraft not in contact since it was drawn (airborne spawn, go-around without
 * touchdown): up when climbing above retractAltitude, down below it, else held.
 */
function targetWithoutContactSeen(
  altitude: number,
  isClimbing: boolean,
  hold: number,
  config: GearAnimationConfig,
): number {
  if (altitude > config.retractAltitude && isClimbing) {
    return 0.0
  }
  return altitude < config.retractAltitude ? 1.0 : hold
}

/**
 * Keep the remembered last contact for this frame: a contact records its time and clears the leave-contact retract;
 * passing retractAltitude out of contact or a seek back past the last contact (replay scrub) forgets both, so the
 * aircraft takes the retractAltitude rule until its next contact and the time out of contact never runs negative.
 */
function updateRememberedContact(state: GearAnimationState, frame: GearFrameInput, config: GearAnimationConfig): void {
  const seekedBack = state.lastContactTime !== null && frame.dataTime < state.lastContactTime
  if (frame.inContact) {
    state.lastContactTime = frame.dataTime
    state.leaveContactRetractDone = false
  } else if (seekedBack || frame.altitudeFt > config.retractAltitude) {
    state.lastContactTime = null
    state.leaveContactRetractDone = false
  }
}

/**
 * Update gear animation state for an aircraft
 * Should be called each frame for aircraft with animations
 *
 * @param callsign - Aircraft callsign
 * @param frame - This frame's altitude, vertical rate, ground contact and data-source time
 * @param currentTime - Current time in milliseconds (Date.now()), the clock the transition runs on
 * @param config - Gear animation configuration
 * @returns Current gear progress (0-1)
 */
export function updateGearAnimation(
  callsign: string,
  frame: GearFrameInput,
  currentTime: number,
  config: GearAnimationConfig = DEFAULT_GEAR_CONFIG,
): number {
  const state = getGearState(callsign)
  updateRememberedContact(state, frame, config)
  const contact: GearContact = {
    inContact: frame.inContact,
    secondsSinceContact: state.lastContactTime === null ? null : (frame.dataTime - state.lastContactTime) / 1000,
  }
  const currentGearDown = state.progress > 0.5 // Consider gear "down" if more than halfway
  let targetProgress: number
  if (state.leaveContactRetractDone && !frame.inContact) {
    // Hold the commanded target, not the progress: the retract has just started while the gear is still down
    const extending = isExtendingOnDescent(frame.altitudeFt, frame.verticalRateFpm, config)
    targetProgress = extending ? 1.0 : state.targetProgress
  } else {
    targetProgress = calculateTargetGearProgress(
      frame.altitudeFt,
      frame.verticalRateFpm,
      contact,
      currentGearDown,
      config,
    )
    state.leaveContactRetractDone = isLeaveContactRetract(frame.verticalRateFpm, contact, config)
  }

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

    // Ease out: the gear moves at once and slows into its stop
    const easedProgress = easeOutCubic(transitionProgress)

    // Interpolate between start and target
    state.progress =
      state.transitionStartProgress + (state.targetProgress - state.transitionStartProgress) * easedProgress

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
  _callsign: string,
  modelUrl: string,
  _knownAnimationCount?: number,
): void {
  if (!model.ready) {
    return
  }

  // Skip animation loading for empty URLs (pending conversions have no URL yet)
  if (!modelUrl || modelUrl === '') {
    return
  }

  // Clamp progress to valid range
  const progress = Math.max(0, Math.min(1, gearProgress))

  // Check if animations need to be loaded for this model URL
  if (!animationSets.has(modelUrl) && !animationSetsLoading.has(modelUrl)) {
    animationSetsLoading.add(modelUrl)

    // Start async parse of animation data
    parseAnimationSetFromUrl(modelUrl).then((animSet) => {
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
  applyClipAnimationsPercent(model, animSet, 'gear', progress, modelUrl)
}

/**
 * Apply spoiler, reverser and wheel-spin clips to a Cesium model, from the animation set applyGearAnimation loaded.
 * Spoilers and reversers use the progress cache; wheel spin is uncached.
 *
 * @param model - Cesium Model instance
 * @param pose - Spoiler and reverser deployment and wheel phase (updateSurfaceAnimation)
 * @param modelUrl - Model URL
 */
export function applySurfaceAnimation(model: Cesium.Model, pose: SurfacePose, modelUrl: string): void {
  const animSet = model.ready ? animationSets.get(modelUrl) : undefined
  if (!animSet) {
    return // Not ready, or applyGearAnimation is still loading the animation set
  }
  applyClipAnimationsPercent(model, animSet, 'spoiler', pose.spoiler, modelUrl)
  applyClipAnimationsPercent(model, animSet, 'reverser', pose.reverser, modelUrl)
  applyWheelSpin(model, animSet, pose.wheelPhase)
}

/**
 * Cubic ease-out function for gear transitions
 */
function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3
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
  clearAllSurfaceStates()
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
