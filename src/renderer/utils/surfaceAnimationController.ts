/**
 * Spoiler, Reverser and Wheel-Spin Controller
 *
 * Decides, per aircraft and per frame, how far the spoilers and thrust reversers are deployed and how far the wheels
 * have turned. Pure state: applying the result to a model is `applySurfaceAnimation` in gearAnimationController.ts.
 *
 * ## Rules
 * - Spoilers deploy at a touchdown above 60 kt and stay out while in contact above 60 kt.
 * - Reversers deploy from 1.5 s after the touchdown while in contact, above 60 kt and decelerating (the groundspeed
 *   fell over the last 0.5 s of data time, measured here, so slow frames and fast replay still see it), and once out
 *   stay out until the rollout ends.
 * - Contact is the shared contact, except that a source without a height above ground being drawn down by the landing
 *   blend is in contact only once drawn fully onto the terrain (so a VATSIM arrival deploys nothing in the air); in
 *   the departure blend and the ground cases the shared contact stands (so a rollout or taxi reported a few metres
 *   above the terrain, first seen or seeked onto, keeps it).
 * - Both stow on contact loss and when the rollout ends: at 60 kt, or when the groundspeed rises 10 kt above its
 *   minimum since touchdown (a touch-and-go). A touchdown is a contact after at least 2 s out of contact, so a contact
 *   flicker on the rollout is not a second touchdown; an aircraft first seen out of contact counts as airborne long
 *   enough, and one first seen in contact (spawned on the rollout, or rolling for takeoff) deploys nothing.
 * - Wheels turn at groundspeed over the wheel circumference in contact, backwards in a pushback, and coast linearly to
 *   zero over 5 s after liftoff.
 *
 * ## Time base
 * Everything runs on the data-source time of the frame (`aircraft.timestamp`), so a paused replay stops the wheels and
 * holds a reverser mid-travel. A seek snaps the spoilers and reversers to their targets and keeps the wheel phase: a
 * data-time step backwards, in replay a step forwards by more than 5 s, or a switch between replay and live either
 * way. Live, a longer gap just continues. The gear's own transition stays on the wall clock.
 */

import { KNOTS_TO_MS } from '@/constants/precipitation'
import {
  REVERSER_DELAY_SECONDS,
  REVERSER_TRAVEL_SECONDS,
  SPOILER_DEPLOY_SECONDS,
  SPOILER_STOW_SECONDS,
  SURFACE_DECELERATION_WINDOW_SECONDS,
  SURFACE_DEPLOY_MIN_GROUNDSPEED_KTS,
  SURFACE_HEIGHTLESS_CONTACT_BLEND_WEIGHT,
  SURFACE_SEEK_SECONDS,
  SURFACE_TOUCH_AND_GO_SPEEDUP_KTS,
  SURFACE_TOUCHDOWN_ARM_SECONDS,
  WHEEL_COAST_SECONDS,
  WHEEL_RADIUS_NARROWBODY_M,
  WHEEL_RADIUS_NARROWBODY_MAX_WINGSPAN_M,
  WHEEL_RADIUS_REGIONAL_M,
  WHEEL_RADIUS_REGIONAL_MAX_WINGSPAN_M,
  WHEEL_RADIUS_WIDEBODY_M,
} from '@/constants/rendering'
import type { InterpolatedAircraftState } from '@/types/vatsim'
import { isPushingBack } from '@/utils/aircraft/pushback'

/** One frame of aircraft state for the spoilers, reversers and wheels */
export interface SurfaceFrameInput {
  /** The shared ground contact (`InterpolatedAircraftState.inContact`) */
  inContact: boolean
  /**
   * Ground blend weight (0..1) for a source without a height above ground, which in the landing blend is in contact
   * for the surfaces only at SURFACE_HEIGHTLESS_CONTACT_BLEND_WEIGHT; null for a source with that height, whose shared
   * contact stands
   */
  groundBlendWeight: number | null
  /**
   * Whether the blend weight came from the landing blend (`InterpolatedAircraftState.groundBlendDescending`); null
   * for a source with a height above ground
   */
  groundBlendDescending: boolean | null
  /** Groundspeed in knots */
  groundspeedKts: number
  /** Heading in degrees */
  headingDeg: number
  /** Ground track (direction of movement) in degrees */
  trackDeg: number
  /** Data-source time of this frame in milliseconds, the clock every transition and the wheel spin run on */
  dataTime: number
  /** Wheel radius in meters (wheelRadiusForWingspan) */
  wheelRadiusM: number
  /**
   * Whether the frame comes from a replay, where a forward data-time jump over 5 s is a seek (live it is a gap); a
   * frame whose replay flag differs from the previous frame's is a seek too
   */
  isReplay: boolean
}

/** The spoiler, reverser and wheel pose of one aircraft */
export interface SurfacePose {
  /** Spoiler deployment (0 = stowed, 1 = deployed) */
  spoiler: number
  /** Reverser deployment (0 = stowed, 1 = deployed) */
  reverser: number
  /** Wheel phase in revolutions, 0..1 */
  wheelPhase: number
  /** Wheel spin in revolutions per second (negative = backwards) */
  wheelRevPerSec: number
}

/** What the spoiler and reverser rules see of one frame */
export interface SurfaceRuleInput {
  inContact: boolean
  groundspeedKts: number
  /** Groundspeed change over the last 0.5 s of data time, knots per second (negative = decelerating) */
  accelerationKtsPerSec: number
  /** Seconds since the touchdown the current rollout began with, or null when no rollout is running */
  secondsSinceTouchdown: number | null
  /** Whether the reversers have deployed in this rollout: once out they stay out until the rollout ends */
  reverserLatched: boolean
}

/** What the wheel-spin rule sees of one frame */
export interface WheelRuleInput {
  inContact: boolean
  groundspeedKts: number
  pushingBack: boolean
  wheelRadiusM: number
  /** Wheel spin at the last liftoff, revolutions per second */
  liftoffRevPerSec: number
  /** Seconds since the last liftoff, or null when out of contact without a liftoff seen */
  secondsSinceLiftoff: number | null
}

/** Per-aircraft state */
interface SurfaceState {
  /** Data time of the last frame (ms) */
  dataTime: number
  /** The surface contact of the last frame, for seeing a touchdown or a liftoff on this one */
  inContact: boolean
  /** Data time contact was lost, or the aircraft was first seen out of contact; null while in contact */
  contactLostAt: number | null
  /** Data time of the touchdown the current rollout began with; null when no rollout is running */
  touchdownAt: number | null
  /** Lowest groundspeed since the touchdown (knots), for the touch-and-go end of the rollout */
  minGroundspeedKts: number
  /** Whether the reversers have deployed in this rollout */
  reverserLatched: boolean
  /** Whether the last frame came from a replay */
  isReplay: boolean
  /** Data time (ms) and groundspeed (knots) of the frame the current deceleration window started at */
  speedRefAt: number
  speedRefKts: number
  /** Groundspeed change over the last completed deceleration window, knots per second */
  windowAccelKtsPerSec: number
  /** Data time of the last liftoff; null in contact or without a liftoff seen */
  liftoffAt: number | null
  liftoffRevPerSec: number
  spoiler: number
  reverser: number
  wheelPhase: number
  wheelRevPerSec: number
}

const surfaceStates = new Map<string, SurfaceState>()

/** The fields of an interpolated aircraft a surface frame is built from */
export type SurfaceAircraft = Pick<
  InterpolatedAircraftState,
  | 'inContact'
  | 'heightAboveGround'
  | 'groundBlendWeight'
  | 'groundBlendDescending'
  | 'interpolatedGroundspeed'
  | 'interpolatedHeading'
  | 'track'
  | 'timestamp'
  | 'isReplay'
>

/**
 * Build this frame's surface input from the interpolated aircraft, so the data time and the replay flag come from the
 * same data-source read.
 *
 * @param aircraft - The interpolated aircraft of this frame
 * @param wheelRadiusM - Wheel radius in meters (wheelRadiusForWingspan)
 * @returns The frame for updateSurfaceAnimation
 */
export function surfaceFrameFor(aircraft: SurfaceAircraft, wheelRadiusM: number): SurfaceFrameInput {
  const heightless = aircraft.heightAboveGround === null
  return {
    inContact: aircraft.inContact === true,
    groundBlendWeight: heightless ? aircraft.groundBlendWeight : null,
    groundBlendDescending: heightless ? aircraft.groundBlendDescending : null,
    groundspeedKts: aircraft.interpolatedGroundspeed,
    headingDeg: aircraft.interpolatedHeading,
    trackDeg: aircraft.track,
    dataTime: aircraft.timestamp,
    wheelRadiusM,
    isReplay: aircraft.isReplay,
  }
}

/**
 * Ground contact for the spoilers, reversers and wheels, from this frame alone. A source with a height above ground
 * keeps the shared contact. One without it (VATSIM, RealTraffic) being drawn down by the landing blend is in contact
 * only once drawn fully onto the terrain, since the shared contact ("more than halfway") passes about 30 m up on a
 * landing; in the departure blend and the ground cases the shared contact stands, since the departure blend keeps the
 * weight under 0.99 on a rollout or taxi reported a few metres above the terrain.
 *
 * @param frame - This frame's shared contact, blend weight and which blend produced it
 * @returns Whether the surfaces see the aircraft in contact
 */
function surfaceContactOf(frame: SurfaceFrameInput): boolean {
  if (!frame.inContact) return false
  if (frame.groundBlendWeight === null || !frame.groundBlendDescending) return true
  return frame.groundBlendWeight >= SURFACE_HEIGHTLESS_CONTACT_BLEND_WEIGHT
}

/**
 * Wheel radius for a type, by its wingspan: regional up to 30 m, narrowbody up to 42 m, widebody above.
 *
 * @param wingspanM - Wingspan in meters, or null when the type's dimensions are unknown
 * @returns Wheel radius in meters (narrowbody when unknown)
 */
export function wheelRadiusForWingspan(wingspanM: number | null): number {
  if (wingspanM === null) return WHEEL_RADIUS_NARROWBODY_M
  if (wingspanM <= WHEEL_RADIUS_REGIONAL_MAX_WINGSPAN_M) return WHEEL_RADIUS_REGIONAL_M
  if (wingspanM <= WHEEL_RADIUS_NARROWBODY_MAX_WINGSPAN_M) return WHEEL_RADIUS_NARROWBODY_M
  return WHEEL_RADIUS_WIDEBODY_M
}

/** Whether a rollout is running in contact above the deploy speed */
function isRollingOut(input: SurfaceRuleInput): boolean {
  return (
    input.inContact && input.secondsSinceTouchdown !== null && input.groundspeedKts > SURFACE_DEPLOY_MIN_GROUNDSPEED_KTS
  )
}

/**
 * Spoiler target: deployed from the touchdown while in contact above 60 kt, stowed otherwise.
 *
 * @param input - This frame's contact, speed and time since touchdown
 * @returns 1 for deployed, 0 for stowed
 */
export function spoilerTarget(input: SurfaceRuleInput): number {
  return isRollingOut(input) ? 1 : 0
}

/**
 * Reverser target: deploys from 1.5 s after the touchdown while in contact, above 60 kt and decelerating; once
 * deployed (latched) it stays out while the rollout runs, whatever the acceleration.
 *
 * @param input - This frame's contact, speed, acceleration, time since touchdown and latch
 * @returns 1 for deployed, 0 for stowed
 */
export function reverserTarget(input: SurfaceRuleInput): number {
  if (!isRollingOut(input)) return 0
  if (input.reverserLatched) return 1
  const delayed = (input.secondsSinceTouchdown ?? 0) >= REVERSER_DELAY_SECONDS
  return delayed && input.accelerationKtsPerSec < 0 ? 1 : 0
}

/**
 * Wheel spin: groundspeed over the circumference in contact (backwards in a pushback); out of contact, the liftoff
 * spin coasting linearly to zero over 5 s.
 *
 * @param input - This frame's contact, speed, pushback, wheel radius and liftoff
 * @returns Revolutions per second (negative = backwards)
 */
export function wheelSpinRate(input: WheelRuleInput): number {
  if (input.inContact) {
    const rate = (input.groundspeedKts * KNOTS_TO_MS) / (2 * Math.PI * input.wheelRadiusM)
    return input.pushingBack ? -rate : rate
  }
  if (input.secondsSinceLiftoff === null) return 0
  return input.liftoffRevPerSec * Math.max(0, 1 - input.secondsSinceLiftoff / WHEEL_COAST_SECONDS)
}

/** Move a deployment toward its target over `seconds`, at the deploy or stow travel time */
function travel(value: number, target: number, seconds: number, deploySeconds: number, stowSeconds: number): number {
  if (target > value) return Math.min(target, value + seconds / deploySeconds)
  return Math.max(target, value - seconds / stowSeconds)
}

/**
 * Forget touchdown and liftoff, as when the aircraft is first seen (or after a seek). One seen out of contact counts
 * as airborne long enough, so its next contact is a touchdown. `contact` is this frame's surface contact.
 */
function rememberFirstSight(state: SurfaceState, frame: SurfaceFrameInput, contact: boolean): void {
  state.inContact = contact
  state.contactLostAt = contact ? null : Number.NEGATIVE_INFINITY
  state.touchdownAt = null
  state.minGroundspeedKts = frame.groundspeedKts
  state.reverserLatched = false
  state.isReplay = frame.isReplay
  state.speedRefAt = frame.dataTime
  state.speedRefKts = frame.groundspeedKts
  state.windowAccelKtsPerSec = 0
  state.liftoffAt = null
  state.liftoffRevPerSec = 0
}

/** Close the deceleration window once it spans 0.5 s of data time, and start the next one at this frame */
function measureAcceleration(state: SurfaceState, frame: SurfaceFrameInput): void {
  const elapsedSeconds = (frame.dataTime - state.speedRefAt) / 1000
  if (elapsedSeconds < SURFACE_DECELERATION_WINDOW_SECONDS) return
  state.windowAccelKtsPerSec = (frame.groundspeedKts - state.speedRefKts) / elapsedSeconds
  state.speedRefAt = frame.dataTime
  state.speedRefKts = frame.groundspeedKts
}

/** End the rollout at 60 kt, or when the groundspeed rises 10 kt above its minimum since touchdown (touch-and-go) */
function endRolloutWhenOver(state: SurfaceState, frame: SurfaceFrameInput): void {
  if (state.touchdownAt === null) return
  state.minGroundspeedKts = Math.min(state.minGroundspeedKts, frame.groundspeedKts)
  const stopped = frame.groundspeedKts <= SURFACE_DEPLOY_MIN_GROUNDSPEED_KTS
  const goingAgain = frame.groundspeedKts > state.minGroundspeedKts + SURFACE_TOUCH_AND_GO_SPEEDUP_KTS
  if (stopped || goingAgain) {
    state.touchdownAt = null
    state.reverserLatched = false
  }
}

/** Track touchdowns, liftoffs and the end of the rollout, from this frame's surface contact */
function rememberContact(state: SurfaceState, frame: SurfaceFrameInput, contact: boolean): void {
  if (contact && !state.inContact) {
    const outOfContactMs = state.contactLostAt === null ? 0 : frame.dataTime - state.contactLostAt
    if (outOfContactMs >= SURFACE_TOUCHDOWN_ARM_SECONDS * 1000) {
      state.touchdownAt = frame.dataTime
      state.minGroundspeedKts = frame.groundspeedKts
    }
    state.contactLostAt = null
    state.liftoffAt = null
  } else if (!contact && state.inContact) {
    state.contactLostAt = frame.dataTime
    state.liftoffAt = frame.dataTime
    state.liftoffRevPerSec = state.wheelRevPerSec
    state.reverserLatched = false
  }
  endRolloutWhenOver(state, frame)
  state.inContact = contact
}

/** Seconds from a remembered data time to this frame, or null when nothing is remembered */
const secondsSince = (from: number | null, frame: SurfaceFrameInput): number | null =>
  from === null ? null : (frame.dataTime - from) / 1000

const poseOf = (state: SurfaceState): SurfacePose => ({
  spoiler: state.spoiler,
  reverser: state.reverser,
  wheelPhase: state.wheelPhase,
  wheelRevPerSec: state.wheelRevPerSec,
})

/** A first-seen aircraft's state, stowed and still */
function firstSightState(frame: SurfaceFrameInput): SurfaceState {
  const state: SurfaceState = {
    dataTime: frame.dataTime,
    inContact: false,
    contactLostAt: null,
    touchdownAt: null,
    minGroundspeedKts: frame.groundspeedKts,
    reverserLatched: false,
    isReplay: frame.isReplay,
    speedRefAt: frame.dataTime,
    speedRefKts: frame.groundspeedKts,
    windowAccelKtsPerSec: 0,
    liftoffAt: null,
    liftoffRevPerSec: 0,
    spoiler: 0,
    reverser: 0,
    wheelPhase: 0,
    wheelRevPerSec: 0,
  }
  rememberFirstSight(state, frame, surfaceContactOf(frame))
  return state
}

/**
 * Update an aircraft's spoilers, reversers and wheel spin for this frame, on data time.
 *
 * @param callsign - Aircraft callsign
 * @param frame - This frame's contact, speeds, heading, track, data time and wheel radius
 * @returns The pose to draw
 */
export function updateSurfaceAnimation(callsign: string, frame: SurfaceFrameInput): SurfacePose {
  const state = surfaceStates.get(callsign)
  if (!state) {
    const seen = firstSightState(frame)
    surfaceStates.set(callsign, seen)
    return poseOf(seen)
  }

  const seconds = (frame.dataTime - state.dataTime) / 1000
  const modeSwitched = frame.isReplay !== state.isReplay
  const seek = seconds < 0 || modeSwitched || (frame.isReplay && seconds > SURFACE_SEEK_SECONDS)
  const contact = surfaceContactOf(frame)
  if (seek) rememberFirstSight(state, frame, contact)
  else rememberContact(state, frame, contact)
  measureAcceleration(state, frame)

  const rule: SurfaceRuleInput = {
    inContact: contact,
    groundspeedKts: frame.groundspeedKts,
    accelerationKtsPerSec: state.windowAccelKtsPerSec,
    secondsSinceTouchdown: secondsSince(state.touchdownAt, frame),
    reverserLatched: state.reverserLatched,
  }
  const spoilerTo = spoilerTarget(rule)
  const reverserTo = reverserTarget(rule)
  state.reverserLatched = reverserTo === 1
  state.wheelRevPerSec = wheelSpinRate({
    inContact: contact,
    groundspeedKts: frame.groundspeedKts,
    pushingBack: isPushingBack(frame.groundspeedKts, frame.headingDeg, frame.trackDeg),
    wheelRadiusM: frame.wheelRadiusM,
    liftoffRevPerSec: state.liftoffRevPerSec,
    secondsSinceLiftoff: secondsSince(state.liftoffAt, frame),
  })

  if (seek) {
    state.spoiler = spoilerTo
    state.reverser = reverserTo
  } else {
    state.spoiler = travel(state.spoiler, spoilerTo, seconds, SPOILER_DEPLOY_SECONDS, SPOILER_STOW_SECONDS)
    state.reverser = travel(state.reverser, reverserTo, seconds, REVERSER_TRAVEL_SECONDS, REVERSER_TRAVEL_SECONDS)
    const phase = state.wheelPhase + state.wheelRevPerSec * seconds
    state.wheelPhase = phase - Math.floor(phase)
  }
  state.dataTime = frame.dataTime
  return poseOf(state)
}

/**
 * Clear an aircraft's spoiler, reverser and wheel state (when it leaves the scene)
 */
export function clearSurfaceState(callsign: string): void {
  surfaceStates.delete(callsign)
}

/**
 * Clear every aircraft's spoiler, reverser and wheel state
 */
export function clearAllSurfaceStates(): void {
  surfaceStates.clear()
}
