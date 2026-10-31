import { useEffect, useState } from 'react'
import {
  AOA_HIGH_SPEED_THRESHOLD_KNOTS,
  AOA_LOW_SPEED_THRESHOLD_KNOTS,
  AOA_OFFSET_HIGH_SPEED_DEGREES,
  AOA_OFFSET_LOW_SPEED_DEGREES,
  CONTACT_ENTER_HEIGHT_METERS,
  CONTACT_EXIT_HEIGHT_METERS,
  CONTACT_HOLD_MS,
  DEPARTURE_BLEND_END_AGL,
  DEPARTURE_BLEND_START_AGL,
  DROP_CONTACT_EASE_MS,
  DROP_CONTACT_EXIT_HEIGHT_METERS,
  DROP_CONTACT_MAX_HEIGHT_METERS,
  DROP_CONTACT_REST_DROP_HEIGHT_METERS,
  DROP_CONTACT_SEEK_MS,
  FALLBACK_FLARE_PITCH_DEGREES,
  FLARE_START_ALTITUDE_METERS,
  GROUND_AIRCRAFT_TERRAIN_OFFSET,
  HEIGHT_TRANSITION_LERP_FACTOR,
  isRotorcraftType,
  LANDING_BLEND_DESCENT_RATE,
  LANDING_BLEND_END_AGL,
  LANDING_BLEND_START_AGL,
  MAX_HEADING_RATE_DEG_PER_SEC_AIR,
  MAX_HEADING_RATE_DEG_PER_SEC_GROUND,
  MAX_PITCH_DEGREES,
  MAX_PITCH_RATE_DEG_PER_SEC,
  MAX_ROLL_DEGREES,
  MAX_ROLL_RATE_DEG_PER_SEC,
  NOSEWHEEL_LOWERING_LERP_FACTOR,
  PITCH_RATE_MULTIPLIER,
  RESTING_HEIGHT_EASE_MS,
  ROLL_RATE_MULTIPLIER,
  STOPPED_SPEED_KTS,
  TERRAIN_SMOOTHING_LERP_FACTOR,
} from '@/constants'
import { heightOverRest, restingHeightFor } from '@/utils/aircraft/restingHeight'
import { geoidService } from '../services/GeoidService'
import { useAircraftTimelineStore } from '../stores/aircraftTimelineStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useVatsimStore } from '../stores/vatsimStore'
import type { SettleRun, TimelineInterpolationResult } from '../types/aircraft-timeline'
import type { InterpolatedAircraftState } from '../types/vatsim'
import { angleDifference, calculateDistanceNM, calculateFlarePitch } from '../utils/geoMath'
import { performanceMonitor } from '../utils/performanceMonitor'
import { getAircraftDataSource } from './useAircraftDataSource'
import type { TerrainData } from './useGroundAircraftTerrain'

// SINGLETON: Shared interpolated states map and animation loop
// This ensures only ONE interpolation loop runs, even if hook is called multiple times
const sharedInterpolatedStates = new Map<string, InterpolatedAircraftState>()
let animationLoopRunning = false
let animationFrameId: number | null = null
let hookInstanceCount = 0

// Shared state for animation loop (accessed by singleton loop)
const sharedOrientationEnabledRef = { current: true }
const sharedOrientationIntensityRef = { current: 1.0 }
const sharedLastInterpolationTimeRef = { current: 0 }
const sharedLastAircraftCountRef = { current: 0 }

// Shared state for terrain correction (injected from rendering layer)
const sharedGroundAircraftTerrainRef = { current: new Map<string, TerrainData>() }
// Note: groundElevationMeters is in MSL for fallback when no terrain sample available
// It will be converted to ellipsoidal using the aircraft's position
const sharedGroundElevationMetersRef = { current: 0 }

// Shared state for distance filtering (only interpolate aircraft in range)
// Reference position comes from vatsimStore (set when airport is selected)
// Distance radius comes from settingsStore.memory.aircraftDataRadiusNM
const sharedReferencePositionRef = { current: null as { latitude: number; longitude: number } | null }
const sharedAircraftDataRadiusNMRef = { current: 250 } // Default, updated from settings

// ============================================================================
// CONSOLIDATED STATE OBJECTS
// ============================================================================
// Consolidate related Maps into single Maps with combined state objects
// This reduces memory overhead and simplifies cleanup

/** Consolidated terrain correction state per aircraft */
interface TerrainCorrectionState {
  smoothedTerrainHeight: number
  prevClampState: boolean
  /**
   * The height easing from `source` to `target`: by HEIGHT_TRANSITION_LERP_FACTOR a frame, or, for a change of contact
   * while the aircraft has no resting height, by a smoothstep over DROP_CONTACT_EASE_MS of display time from
   * `easeStartedAt`
   */
  transition: { source: number; target: number; progress: number; easeStartedAt: number | null } | null
  prevCorrectedHeight: number
}

/** Consolidated nosewheel transition state per aircraft */
interface NosewheelState {
  transition: { sourcePitch: number; progress: number } | null
  wasInFlare: boolean
  lastFlarePitch: number | null
  groundCommitted: boolean // Prevents flare re-engagement after touchdown
}

/** Consolidated timeline rate tracking state per aircraft */
interface TimelineRateState {
  prevAltitude: number | null
  prevGroundspeed: number | null
  smoothedVerticalRate: number
  smoothedTurnRate: number
  smoothedAcceleration: number
  prevPitch: number | null
  prevRoll: number | null
  smoothedHeading: number | null // Rate-limited heading; also drives turn-rate calc
}

// Consolidated state Maps (3 Maps instead of 16)
const sharedTerrainStateRef = { current: new Map<string, TerrainCorrectionState>() }
const sharedNosewheelStateRef = { current: new Map<string, NosewheelState>() }
const sharedTimelineRateStateRef = { current: new Map<string, TimelineRateState>() }
/** Ground contact per aircraft with a height above ground, kept for the hysteresis */
const sharedContactStateRef = { current: new Map<string, boolean>() }

/** What lane B remembers of an aircraft that has no resting height of its own or of its type */
interface LaneBState {
  /**
   * Descent memory: the lowest height (m) since the height last turned down while `descending`, else the highest since
   * it last turned up. A move of more than CONTACT_ENTER_HEIGHT_METERS past it turns the direction.
   */
  reference: number
  descending: boolean
  /** The provisional resting height (m) taken from the run contact was entered on, or null before an entry */
  provisionalRest: number | null
  /** Display time of the last frame, to see it go back or jump */
  lastTime: number
  /** The last frame's `displayAnchorOffsetMs`, to tell display time's own moves from a seek */
  lastAnchorOffset: number
}

/** Per aircraft with a height above ground and no resting height, lane B's memory */
const sharedLaneBStateRef = { current: new Map<string, LaneBState>() }

/**
 * What is taken off an aircraft's drawn reported height (`drawnRestOffset`): `share` of `rest`, a resting height, the
 * share fading with the raw height when `fades` (a provisional one). A change of `rest` or `fades` leaves a `residual`,
 * the old offset less the new one on the frame of the change (m), eased out as `progress` goes from 0 to 1.
 */
interface RestOffsetState {
  rest: number
  fades: boolean
  /** The share of `rest` taken off on the last frame */
  share: number
  residual: number
  progress: number
  /** Frame time (ms) of the last frame, which the ease runs on */
  lastFrameTime: number
}

/** Per aircraft, what is taken off its drawn reported height */
const sharedRestOffsetStateRef = { current: new Map<string, RestOffsetState>() }

/**
 * What the contact hold remembers of an aircraft: whether it was in contact at its last height, and the hold
 * itself (CONTACT_HOLD_MS).
 */
interface ContactHoldState {
  /** Display time the held exit started (t_e), or null while not held */
  heldSince: number | null
  /** Whether the aircraft was in contact on its last frame with a height; a null height keeps it */
  inContactAtLastHeight: boolean
  /** False on the frame the state starts (first sight, or after a seek), on which no hold arms */
  armable: boolean
  /** Display time of the last frame, to see it go back or jump */
  lastTime: number
  /** The last frame's `displayAnchorOffsetMs`, to tell display time's own moves from a seek */
  lastAnchorOffset: number
}

/** Per aircraft whose type is not a rotorcraft's, its contact hold */
const sharedContactHoldStateRef = { current: new Map<string, ContactHoldState>() }

// The 3 ft span test compares with this tolerance (m), so a run that moves exactly 3 ft passes
const SETTLE_RANGE_TOLERANCE_METERS = 1e-6 * 0.3048

/** Feed one frame's height to the descent memory. */
function feedDescentMemory(state: LaneBState, height: number): void {
  if (state.descending) {
    if (height > state.reference + CONTACT_ENTER_HEIGHT_METERS) {
      state.descending = false
      state.reference = height
    } else {
      state.reference = Math.min(state.reference, height)
    }
  } else if (height < state.reference - CONTACT_ENTER_HEIGHT_METERS) {
    state.descending = true
    state.reference = height
  } else {
    state.reference = Math.max(state.reference, height)
  }
}

/**
 * Whether lane B enters contact without a provisional resting height: at or below DROP_CONTACT_MAX_HEIGHT_METERS,
 * with the descent memory down, on a run whose highest and lowest samples are no more than CONTACT_ENTER_HEIGHT_METERS
 * apart.
 */
function settlesOnRun(state: LaneBState, height: number, run: SettleRun | undefined): run is SettleRun {
  return (
    height <= DROP_CONTACT_MAX_HEIGHT_METERS &&
    state.descending &&
    run !== undefined &&
    run.highest - run.lowest <= CONTACT_ENTER_HEIGHT_METERS + SETTLE_RANGE_TOLERANCE_METERS
  )
}

/**
 * Contact by the height over a resting height, learned or provisional: in contact, left above
 * CONTACT_EXIT_HEIGHT_METERS over it; out of contact, entered below CONTACT_ENTER_HEIGHT_METERS over it.
 */
function contactOverRest(wasInContact: boolean, overRest: number): boolean {
  return wasInContact ? overRest <= CONTACT_EXIT_HEIGHT_METERS : overRest < CONTACT_ENTER_HEIGHT_METERS
}

/**
 * Whether display time moved more than DROP_CONTACT_SEEK_MS either way from the last frame, beyond what its offset
 * moved (`displayAnchorOffsetMs`). A move of its own (a new anchor, a snap of the delay) is not a seek.
 */
function isSeek(last: { lastTime: number; lastAnchorOffset: number }, frame: ContactFrame): boolean {
  const seekMs = frame.displayTime - last.lastTime - (frame.displayAnchorOffsetMs - last.lastAnchorOffset)
  return Math.abs(seekMs) > DROP_CONTACT_SEEK_MS
}

/**
 * An aircraft's lane B memory at this frame, with the frame's height fed to its descent memory. On a seek (`isSeek`)
 * the memory restarts as at first sight, and so does what is taken off the drawn height, rather than easing out a
 * provisional resting height the seek dropped.
 */
function laneBStateAt(callsign: string, height: number, frame: ContactFrame): { state: LaneBState; restarts: boolean } {
  const time = frame.displayTime
  const anchorOffset = frame.displayAnchorOffsetMs
  const previous = sharedLaneBStateRef.current.get(callsign)
  const restarts = previous !== undefined && isSeek(previous, frame)
  if (restarts) sharedRestOffsetStateRef.current.delete(callsign)
  const state: LaneBState =
    previous === undefined || restarts
      ? { reference: height, descending: true, provisionalRest: null, lastTime: time, lastAnchorOffset: anchorOffset }
      : previous
  feedDescentMemory(state, height)
  state.lastTime = time
  state.lastAnchorOffset = anchorOffset
  sharedLaneBStateRef.current.set(callsign, state)
  return { state, restarts }
}

/**
 * Lane B contact without a provisional resting height: an aircraft already in contact (from a source without height,
 * or a resting height forgotten) takes its height as it; otherwise contact is entered on a settled run
 * (`settlesOnRun`), whose second-lowest sample becomes it.
 */
function laneBEntry(state: LaneBState, height: number, run: SettleRun | undefined, inContactBefore: boolean): boolean {
  if (inContactBefore) {
    state.provisionalRest = height
    return true
  }
  if (!settlesOnRun(state, height, run)) return false
  state.provisionalRest = run.secondLowest
  return true
}

/**
 * Lane B: contact while the aircraft has no resting height. Without a provisional resting height, `laneBEntry`
 * decides. With one, contact is the learned path's (`contactOverRest`), and in contact the provisional resting height
 * follows the run's second-lowest sample down. Above DROP_CONTACT_EXIT_HEIGHT_METERS the aircraft is out of contact,
 * and above DROP_CONTACT_REST_DROP_HEIGHT_METERS the provisional resting height is dropped; a seek (`laneBStateAt`)
 * drops it and restarts out of contact, as at first sight.
 */
function laneBContact(callsign: string, height: number, frame: ContactFrame, wasInContact: boolean): boolean {
  const run = frame.settleRun
  const { state, restarts } = laneBStateAt(callsign, height, frame)
  const inContactBefore = wasInContact && !restarts
  if (height > DROP_CONTACT_REST_DROP_HEIGHT_METERS) state.provisionalRest = null
  if (height > DROP_CONTACT_EXIT_HEIGHT_METERS) return false
  if (state.provisionalRest === null) return laneBEntry(state, height, run, inContactBefore)
  if (inContactBefore && run !== undefined) {
    state.provisionalRest = Math.min(state.provisionalRest, run.secondLowest)
  }
  return contactOverRest(inContactBefore, height - state.provisionalRest)
}

/**
 * The share of a provisional resting height taken off the drawn height at a raw height above ground: all of it up to
 * DROP_CONTACT_EXIT_HEIGHT_METERS, none from DROP_CONTACT_REST_DROP_HEIGHT_METERS, linear between.
 */
function provisionalRestShare(height: number): number {
  const span = DROP_CONTACT_REST_DROP_HEIGHT_METERS - DROP_CONTACT_EXIT_HEIGHT_METERS
  return Math.min(1, Math.max(0, (DROP_CONTACT_REST_DROP_HEIGHT_METERS - height) / span))
}

/** An aircraft's provisional resting height (m), or null while lane B has none for it. Exported for tests. */
export function provisionalRestFor(callsign: string): number | null {
  return sharedLaneBStateRef.current.get(callsign)?.provisionalRest ?? null
}

/**
 * An aircraft's contact hold at this frame. On a seek (`isSeek`) the hold restarts as at first sight, not armable on its
 * first frame. A move of display time's own keeps it.
 */
function contactHoldAt(callsign: string, frame: ContactFrame): ContactHoldState {
  const time = frame.displayTime
  const anchorOffset = frame.displayAnchorOffsetMs
  const previous = sharedContactHoldStateRef.current.get(callsign)
  if (previous !== undefined && !isSeek(previous, frame)) {
    previous.lastTime = time
    previous.lastAnchorOffset = anchorOffset
    return previous
  }
  const state: ContactHoldState = {
    heldSince: null,
    inContactAtLastHeight: false,
    armable: false,
    lastTime: time,
    lastAnchorOffset: anchorOffset,
  }
  sharedContactHoldStateRef.current.set(callsign, state)
  return state
}

/** Whether the frame's height is over the exit height that contact would be left above, from contact. */
function overExitHeight(callsign: string, height: number, rest: number | null): boolean {
  if (rest !== null) return height - rest > CONTACT_EXIT_HEIGHT_METERS
  if (height > DROP_CONTACT_EXIT_HEIGHT_METERS) return true
  const provisionalRest = provisionalRestFor(callsign)
  return provisionalRest !== null && height - provisionalRest > CONTACT_EXIT_HEIGHT_METERS
}

/**
 * Whether a running hold keeps the aircraft in contact this frame. It ends at CONTACT_HOLD_MS after the exit started,
 * or once the height is back under the exit height. While it holds, lane B's memory is
 * frozen but for its frame time, so a burst neither drops nor sets a provisional resting height.
 */
function stillHeld(
  hold: ContactHoldState,
  callsign: string,
  height: number,
  rest: number | null,
  frame: ContactFrame,
): boolean {
  if (hold.heldSince === null) return false
  if (frame.displayTime - hold.heldSince >= CONTACT_HOLD_MS) {
    hold.heldSince = null
    return false
  }
  if (!overExitHeight(callsign, height, rest)) {
    hold.heldSince = null
    return false
  }
  const laneB = sharedLaneBStateRef.current.get(callsign)
  if (laneB !== undefined) {
    laneB.lastTime = frame.displayTime
    laneB.lastAnchorOffset = frame.displayAnchorOffsetMs
  }
  return true
}

/** What `updateContact` reads of a frame: the timeline's fields of the same names. */
export type ContactFrame = Pick<
  TimelineInterpolationResult,
  'heightAboveGround' | 'aircraftType' | 'displayTime' | 'settleRun' | 'bracketStartStopped' | 'displayAnchorOffsetMs'
>

/** One frame's contact decision with a height. */
interface ContactDecision {
  callsign: string
  height: number
  rest: number | null
  wasInContact: boolean
  frame: ContactFrame
}

/**
 * After the contact rule decided: leaving contact on a bracket whose earlier sample is stopped, not on the hold's
 * first frame, starts a hold.
 *
 * @returns Whether a hold starts this frame
 */
function startsHold(hold: ContactHoldState, decision: ContactDecision, inContact: boolean): boolean {
  const { frame } = decision
  if (inContact || !hold.armable || !decision.wasInContact || !frame.bracketStartStopped) return false
  hold.heldSince = frame.displayTime
  return true
}

/**
 * The frame's contact: a running hold's (`stillHeld`), else the contact rule's, which an exit that starts a hold
 * (`startsHold`) overrides, lane B keeping its memory from before the frame.
 */
function heldOrRuledContact(hold: ContactHoldState | null, decision: ContactDecision): boolean {
  const { callsign, height, rest, wasInContact, frame } = decision
  // A hold that ends this frame does not start again on the same exit
  const wasHeld = hold !== null && hold.heldSince !== null
  if (hold !== null && stillHeld(hold, callsign, height, rest, frame)) return true
  const laneBBefore = laneBSnapshotOf(callsign)
  const inContact =
    rest === null ? laneBContact(callsign, height, frame, wasInContact) : contactOverRest(wasInContact, height - rest)
  if (hold === null || wasHeld || !startsHold(hold, decision, inContact)) return inContact
  // The exit frame's height is the burst's: lane B keeps its memory from before it
  restoreLaneB(callsign, laneBBefore, frame)
  return true
}

/**
 * Whether an aircraft with no contact state from its height starts in contact. After a null height, it does when it
 * was in contact at its last height and the bracket's earlier sample is stopped (it stood still through the gap).
 * Otherwise it starts from the contact it was last drawn with (a source without height takes it from the terrain
 * clamp), so a switch to a source with height on the ground keeps it in contact.
 */
function startsInContact(callsign: string, hold: ContactHoldState | null, frame: ContactFrame): boolean {
  if (hold?.inContactAtLastHeight && frame.bracketStartStopped) return true
  return sharedInterpolatedStates.get(callsign)?.inContact === true
}

/**
 * Ground contact for this frame from the height above ground at the displayed instant, with hysteresis.
 * Once the aircraft has a resting height (its own, else its type's), contact is entered below the entry height over it
 * and left above the exit height over it; until then lane B decides (`laneBContact`). An aircraft with no earlier
 * contact state from its height starts as `startsInContact` says.
 *
 * An aircraft that leaves contact on a bracket whose earlier sample is stopped is held in contact until its height has
 * stayed over the exit height for CONTACT_HOLD_MS (`stillHeld`), unless its type is a rotorcraft's. A null height
 * ends contact and the hold but keeps whether the aircraft was in contact; a seek, a playback mode change and removal
 * clear the hold.
 *
 * Exported for tests.
 *
 * @param frame - The timeline's height above ground, type, display time, settle run and bracket fields
 * @returns Whether the aircraft is in contact, or null when the source reports no height
 */
export function updateContact(callsign: string, frame: ContactFrame): boolean | null {
  const hold = contactHoldFor(callsign, frame)
  const height = frame.heightAboveGround
  if (height === null) {
    sharedContactStateRef.current.delete(callsign)
    sharedLaneBStateRef.current.delete(callsign)
    if (hold !== null) hold.heldSince = null
    return null
  }
  const rest = restingHeightFor(callsign, frame.aircraftType)
  if (rest !== null) sharedLaneBStateRef.current.delete(callsign)
  const wasInContact = sharedContactStateRef.current.get(callsign) ?? startsInContact(callsign, hold, frame)
  const inContact = heldOrRuledContact(hold, { callsign, height, rest, wasInContact, frame })
  sharedContactStateRef.current.set(callsign, inContact)
  if (hold !== null) {
    hold.inContactAtLastHeight = inContact
    hold.armable = true
  }
  return inContact
}

/** An aircraft's contact hold; null for a rotorcraft, which is never held. */
function contactHoldFor(callsign: string, frame: ContactFrame): ContactHoldState | null {
  if (isRotorcraftType(frame.aircraftType)) {
    sharedContactHoldStateRef.current.delete(callsign)
    return null
  }
  return contactHoldAt(callsign, frame)
}

/** A copy of an aircraft's lane B memory, or undefined while it has none. */
function laneBSnapshotOf(callsign: string): LaneBState | undefined {
  const state = sharedLaneBStateRef.current.get(callsign)
  return state === undefined ? undefined : { ...state }
}

/** Put back lane B memory copied before this frame, at this frame's time. */
function restoreLaneB(callsign: string, snapshot: LaneBState | undefined, frame: ContactFrame): void {
  if (snapshot === undefined) return
  sharedLaneBStateRef.current.set(callsign, {
    ...snapshot,
    lastTime: frame.displayTime,
    lastAnchorOffset: frame.displayAnchorOffsetMs,
  })
}

/**
 * The next progress of a height transition: a smoothstep over DROP_CONTACT_EASE_MS of display time from its start for
 * a change of contact without a resting height, else HEIGHT_TRANSITION_LERP_FACTOR more than the last frame's
 * (~15 frames, ~0.25 s at 60 fps). Exported for tests.
 */
export function transitionProgress(
  transition: { progress: number; easeStartedAt: number | null },
  displayTime: number,
): number {
  if (transition.easeStartedAt === null) return Math.min(1.0, transition.progress + HEIGHT_TRANSITION_LERP_FACTOR)
  const elapsed = Math.min(1, Math.max(0, (displayTime - transition.easeStartedAt) / DROP_CONTACT_EASE_MS))
  return elapsed * elapsed * (3 - 2 * elapsed)
}

/**
 * What is taken off an aircraft's drawn reported height this frame, before any ease: `share` of `rest`. When the source
 * reports a height above ground, all of its resting height (its own, else its type's) once one is learned, else lane
 * B's provisional resting height, its share fading with the raw height (`provisionalRestShare`), else 0; without that
 * height, 0.
 */
function restOffsetTarget(
  callsign: string,
  entry: InterpolatedAircraftState,
): { rest: number; fades: boolean; share: number } {
  const height = entry.heightAboveGround
  if (height === null) return { rest: 0, fades: false, share: 1 }
  const learned = restingHeightFor(callsign, entry.aircraftType)
  if (learned !== null) return { rest: learned, fades: false, share: 1 }
  return { rest: provisionalRestFor(callsign) ?? 0, fades: true, share: provisionalRestShare(height) }
}

/**
 * How far below its reported height an aircraft is drawn out of contact (m): `restOffsetTarget`'s offset, so the
 * provisional resting height's share fades from DROP_CONTACT_EXIT_HEIGHT_METERS to DROP_CONTACT_REST_DROP_HEIGHT_METERS
 * with no ease. A discrete change for an aircraft already drawn (a resting height learned, a provisional one taken or
 * dropped, a switch to a source without height) eases linearly over RESTING_HEIGHT_EASE_MS of frame time from what the
 * old resting height takes off on that frame (its share at that frame's raw height, the last frame's without one), so
 * the drawn height never jumps, and a change where both take off the same, as a provisional one dropped where its share
 * is 0, moves nothing. Frame time going back holds the ease where it is. A seek (`laneBStateAt`) or a playback mode
 * change restarts the offset as at first sight.
 */
function drawnRestOffset(callsign: string, entry: InterpolatedAircraftState, now: number): number {
  const next = restOffsetTarget(callsign, entry)
  const state = sharedRestOffsetStateRef.current.get(callsign)
  if (!state) {
    sharedRestOffsetStateRef.current.set(callsign, { ...next, residual: 0, progress: 1, lastFrameTime: now })
    return next.rest * next.share
  }
  state.progress = Math.min(1, state.progress + Math.max(0, now - state.lastFrameTime) / RESTING_HEIGHT_EASE_MS)
  state.lastFrameTime = now
  if (next.rest !== state.rest || next.fades !== state.fades) {
    const height = entry.heightAboveGround
    const oldShare = state.fades && height !== null ? provisionalRestShare(height) : state.share
    state.residual = state.rest * oldShare + state.residual * (1 - state.progress) - next.rest * next.share
    state.progress = 0
    state.rest = next.rest
    state.fades = next.fades
  }
  state.share = next.share
  return next.rest * next.share + state.residual * (1 - state.progress)
}

/**
 * Height above ground for the flare from a source that reports one: over the aircraft's resting height (its own, else
 * its type's; never below 0) once one is learned, the raw height until then.
 */
function flareHeightAboveGround(callsign: string, aircraftType: string | null, heightAboveGround: number): number {
  const overRest = heightOverRest(callsign, aircraftType, heightAboveGround)
  return overRest === null ? heightAboveGround : Math.max(0, overRest)
}

// ============================================================================
// TIMELINE FRAME TIMING
// ============================================================================
/** Last frame's timestamp (ms) for rate calculations */
const sharedTimelineLastFrameTimeRef = { current: 0 }

/** Track playback mode to detect mode changes */
const sharedLastPlaybackModeRef = { current: 'live' as string }

// Store subscribers for triggering re-renders
const subscribers = new Set<() => void>()

// Rate smoothing factor (higher = more smoothing, less responsive)
const RATE_SMOOTHING = 0.15

/**
 * Convert a TimelineInterpolationResult to InterpolatedAircraftState
 * Calculates rates and orientation from frame-to-frame changes
 */
function timelineToInterpolatedState(
  timeline: TimelineInterpolationResult,
  now: number,
  orientationEnabled: boolean,
  orientationIntensity: number,
  isReplay: boolean,
): InterpolatedAircraftState {
  const callsign = timeline.callsign

  // Get or create consolidated rate state for this aircraft
  let rateState = sharedTimelineRateStateRef.current.get(callsign)
  if (!rateState) {
    rateState = {
      prevAltitude: null,
      prevGroundspeed: null,
      smoothedVerticalRate: 0,
      smoothedTurnRate: 0,
      smoothedAcceleration: 0,
      prevPitch: null,
      prevRoll: null,
      smoothedHeading: null,
    }
    sharedTimelineRateStateRef.current.set(callsign, rateState)
  }

  const lastFrameTime = sharedTimelineLastFrameTimeRef.current
  const inContact = updateContact(callsign, timeline)
  // On the ground for heading rate, pitch and roll: ground contact when the source reports its height above
  // ground, otherwise the source's ground flag or a groundspeed under 40 kt
  const isOnGround = inContact ?? (timeline.onGround === true || timeline.groundspeed < 40)

  // Calculate frame delta (ms)
  const frameDelta = lastFrameTime > 0 ? now - lastFrameTime : 16.67 // ~60fps default

  // ============================================================================
  // HEADING RATE LIMITING (computed first so turn-rate can use the smoothed value)
  // ============================================================================
  // Apply rate limiting to heading to smooth out noisy yaw from 1Hz vNAS data.
  // This prevents jerky heading changes while preserving realistic turn behavior.
  // Ground aircraft get higher rate limit since they can pivot faster during taxi.

  const prevSmoothedHeading = rateState.smoothedHeading
  let smoothedHeading = timeline.heading

  if (frameDelta > 0 && frameDelta < 100) {
    const targetHeading = timeline.heading
    const headingBase = prevSmoothedHeading ?? targetHeading

    // Determine rate limit based on ground/air state
    const maxHeadingRate = isOnGround ? MAX_HEADING_RATE_DEG_PER_SEC_GROUND : MAX_HEADING_RATE_DEG_PER_SEC_AIR

    const dtSeconds = frameDelta / 1000
    const maxHeadingChange = maxHeadingRate * dtSeconds

    // Calculate heading delta with wraparound handling (shortest path)
    let headingDelta = targetHeading - headingBase
    if (headingDelta > 180) headingDelta -= 360
    if (headingDelta < -180) headingDelta += 360

    // Apply rate limiting
    if (Math.abs(headingDelta) > maxHeadingChange) {
      smoothedHeading = headingBase + Math.sign(headingDelta) * maxHeadingChange
    } else {
      smoothedHeading = targetHeading
    }

    // Normalize to 0-360
    smoothedHeading = ((smoothedHeading % 360) + 360) % 360
  }
  rateState.smoothedHeading = smoothedHeading

  // Calculate rates from frame-to-frame changes
  let verticalRate = 0 // m/min
  let turnRate = 0 // deg/sec
  let acceleration = 0 // knots/sec

  if (frameDelta > 0 && frameDelta < 100) {
    // Only calculate if reasonable frame time
    // Vertical rate: prefer actual ADS-B baro_rate when available
    if (timeline.verticalRate !== null) {
      // Use actual ADS-B vertical rate (in fpm), convert to m/min
      const FEET_TO_METERS = 0.3048
      const adsVerticalRate = timeline.verticalRate * FEET_TO_METERS // fpm to m/min
      // Still apply smoothing to reduce sudden jumps when new observations arrive
      verticalRate = rateState.smoothedVerticalRate + (adsVerticalRate - rateState.smoothedVerticalRate) * 0.3
      rateState.smoothedVerticalRate = verticalRate
    } else if (rateState.prevAltitude !== null) {
      // Fall back to calculating from altitude deltas (VATSIM, vNAS)
      const altitudeChange = timeline.altitude - rateState.prevAltitude // meters
      const rawVerticalRate = (altitudeChange / frameDelta) * 60000 // m/min
      // Smooth the rate to reduce jitter
      verticalRate =
        rateState.smoothedVerticalRate + (rawVerticalRate - rateState.smoothedVerticalRate) * RATE_SMOOTHING
      rateState.smoothedVerticalRate = verticalRate
    }

    // Turn rate: derive from the rate-limited heading we just computed so the
    // resulting bank angle stays in lock-step with the visible yaw. Using the
    // raw timeline.heading here would jerk the roll on noisy 1Hz vNAS samples
    // even though the displayed heading is smooth.
    if (prevSmoothedHeading !== null) {
      const headingChange = angleDifference(prevSmoothedHeading, smoothedHeading)
      const rawTurnRate = (headingChange / frameDelta) * 1000 // deg/sec
      const clampedTurnRate = Math.max(-6, Math.min(6, rawTurnRate))
      turnRate = rateState.smoothedTurnRate + (clampedTurnRate - rateState.smoothedTurnRate) * RATE_SMOOTHING
      rateState.smoothedTurnRate = turnRate
    }

    // Acceleration: groundspeed change per second
    // Apply smoothing to reduce noise from GPS jitter, especially important for
    // vNAS where groundspeed is calculated from position changes
    if (rateState.prevGroundspeed !== null) {
      const speedChange = timeline.groundspeed - rateState.prevGroundspeed
      const rawAcceleration = (speedChange / frameDelta) * 1000 // knots/sec
      // Clamp to realistic limits (jets rarely exceed 5 kts/s acceleration)
      const clampedAcceleration = Math.max(-10, Math.min(10, rawAcceleration))
      acceleration =
        rateState.smoothedAcceleration + (clampedAcceleration - rateState.smoothedAcceleration) * RATE_SMOOTHING
      rateState.smoothedAcceleration = acceleration
    }
  }

  // Store current values for next frame
  rateState.prevAltitude = timeline.altitude
  rateState.prevGroundspeed = timeline.groundspeed

  // Calculate pitch and roll from rates (orientation emulation)
  let pitch = 0
  let roll = 0

  // For broadcast source (insets), use pre-interpolated pitch/roll from main app
  // This avoids redundant calculations and ensures visual consistency between viewports
  if (timeline.source === 'broadcast' && timeline.pitch !== null && timeline.roll !== null) {
    pitch = timeline.pitch
    roll = timeline.roll
    // Store for next frame (in case source changes)
    rateState.prevPitch = pitch
    rateState.prevRoll = roll
  } else if (orientationEnabled) {
    // Pitch from vertical rate (flight path angle)
    // ~1000 fpm climb = ~5 degrees pitch (standard approximation)
    // verticalRate is in m/min, convert to fpm for calculation
    const fpm = verticalRate * 3.28084
    let targetPitch = (fpm / 1000) * PITCH_RATE_MULTIPLIER * orientationIntensity

    // Add angle-of-attack offset for airborne aircraft
    // Real aircraft fly with positive body pitch even when descending:
    // body pitch = flight path angle + angle of attack
    // On approach at -700 fpm with AoA ~5°, body pitch is ~+1° nose-up (realistic)
    if (!isOnGround) {
      const speedFraction = Math.min(
        1,
        Math.max(
          0,
          (timeline.groundspeed - AOA_LOW_SPEED_THRESHOLD_KNOTS) /
            (AOA_HIGH_SPEED_THRESHOLD_KNOTS - AOA_LOW_SPEED_THRESHOLD_KNOTS),
        ),
      )
      const aoaOffset =
        AOA_OFFSET_LOW_SPEED_DEGREES + (AOA_OFFSET_HIGH_SPEED_DEGREES - AOA_OFFSET_LOW_SPEED_DEGREES) * speedFraction
      targetPitch += aoaOffset * orientationIntensity
    }

    targetPitch = Math.max(-MAX_PITCH_DEGREES, Math.min(MAX_PITCH_DEGREES, targetPitch))
    let targetRoll: number
    if (isOnGround) {
      // Ground aircraft: no roll, only yaw steering
      targetRoll = 0
    } else if (timeline.roll !== null) {
      // Use actual ADS-B bank angle (apply intensity for consistency with calculated roll)
      targetRoll = timeline.roll * orientationIntensity
      targetRoll = Math.max(-MAX_ROLL_DEGREES, Math.min(MAX_ROLL_DEGREES, targetRoll))
    } else {
      // Calculate from turn rate
      // Standard rate turn (3 deg/sec) = ~15-20 degrees bank
      targetRoll = turnRate * ROLL_RATE_MULTIPLIER * orientationIntensity
      targetRoll = Math.max(-MAX_ROLL_DEGREES, Math.min(MAX_ROLL_DEGREES, targetRoll))
    }

    // Apply rate limiting to prevent jerky motion from noisy data
    const prevPitch = rateState.prevPitch ?? targetPitch
    const prevRoll = rateState.prevRoll ?? targetRoll
    const dtSeconds = frameDelta / 1000

    // Limit pitch rate of change
    const maxPitchChange = MAX_PITCH_RATE_DEG_PER_SEC * dtSeconds
    const pitchDelta = targetPitch - prevPitch
    if (Math.abs(pitchDelta) > maxPitchChange) {
      pitch = prevPitch + Math.sign(pitchDelta) * maxPitchChange
    } else {
      pitch = targetPitch
    }

    // Limit roll rate of change
    const maxRollChange = MAX_ROLL_RATE_DEG_PER_SEC * dtSeconds
    const rollDelta = targetRoll - prevRoll
    if (Math.abs(rollDelta) > maxRollChange) {
      roll = prevRoll + Math.sign(rollDelta) * maxRollChange
    } else {
      roll = targetRoll
    }

    // Store for next frame
    rateState.prevPitch = pitch
    rateState.prevRoll = roll
  }

  // Calculate track from groundTrack or default to heading
  const track = timeline.groundTrack ?? timeline.heading

  // Build the InterpolatedAircraftState
  return {
    // Base AircraftState fields
    callsign: timeline.callsign,
    cid: timeline.cid,
    latitude: timeline.latitude,
    longitude: timeline.longitude,
    altitude: timeline.altitude,
    groundspeed: timeline.groundspeed,
    heading: timeline.heading,
    groundTrack: timeline.groundTrack,
    transponder: timeline.transponder,
    aircraftType: timeline.aircraftType,
    departure: timeline.departure,
    arrival: timeline.arrival,
    timestamp: now,

    // Interpolated values (same as raw for timeline-based, except heading is rate-limited)
    interpolatedLatitude: timeline.latitude,
    interpolatedLongitude: timeline.longitude,
    interpolatedAltitude: timeline.altitude,
    reportedAltitude: timeline.altitude,
    interpolatedHeading: smoothedHeading,
    interpolatedGroundspeed: timeline.groundspeed,

    // Orientation
    interpolatedPitch: pitch,
    interpolatedRoll: roll,

    // Rates
    verticalRate,
    turnRate,
    acceleration,
    track,

    // Source ground flag (vNAS 50/80 ft flag for labels, ADS-B ground bit); contact comes from the height
    isOnGround: timeline.onGround,
    heightAboveGround: timeline.heightAboveGround,
    inContact,
    // Written by the terrain pass each frame
    groundBlendWeight: 0,
    groundBlendDescending: false,
    isReplay,

    isInterpolated: true,

    // Display delay
    displayDelay: timeline.displayDelay,
    displayTime: timeline.displayTime,
  }
}

// Singleton animation loop function
function updateInterpolation() {
  try {
    runInterpolationFrame()
  } catch (error) {
    // Don't let a single bad frame kill the singleton loop for the whole app.
    // Without this, any throw inside the body permanently stops aircraft updates.
    console.error('[Interpolation] Frame failed, continuing loop:', error)
  } finally {
    animationFrameId = requestAnimationFrame(updateInterpolation)
  }
}

function runInterpolationFrame() {
  performanceMonitor.startTimer('interpolation')

  // Get timing and mode info from unified source (handles live vs replay mode)
  const source = getAircraftDataSource()

  // Use source timestamp as "now" - for live mode this is Date.now(),
  // for replay mode this is calculated based on segment progress
  const now = source.timestamp

  // Track frame timing for diagnostics
  sharedLastInterpolationTimeRef.current = now

  const statesMap = sharedInterpolatedStates

  // Track which callsigns are still active
  const activeCallsigns = new Set<string>()

  const orientationEnabled = sharedOrientationEnabledRef.current
  const orientationIntensity = sharedOrientationIntensityRef.current

  // ============================================================================
  // MODE CHANGE DETECTION - Load replay data into timeline when entering replay
  // ============================================================================
  const currentMode = source.playbackMode
  const previousMode = sharedLastPlaybackModeRef.current

  if (currentMode !== previousMode) {
    sharedLastPlaybackModeRef.current = currentMode
    const timelineStore = useAircraftTimelineStore.getState()
    // Entering or leaving replay is a seek: contact and what is taken off the drawn height restart as at first sight,
    // not from the last live frame's
    for (const state of sharedInterpolatedStates.values()) state.inContact = null
    sharedContactStateRef.current.clear()
    sharedLaneBStateRef.current.clear()
    sharedRestOffsetStateRef.current.clear()
    sharedContactHoldStateRef.current.clear()

    if (currentMode === 'imported') {
      // Entering imported replay mode - timelines are already loaded by
      // replayStore.importReplay() which calls loadImportedTimelines() or loadReplaySnapshots()
      sharedTimelineRateStateRef.current.clear()
    } else if (currentMode === 'replay') {
      // Entering buffer replay mode - scrub through existing timeline
      // The timeline already has live observations, no need to load anything
      // Just clear rate tracking for fresh orientation
      sharedTimelineRateStateRef.current.clear()
    } else if (currentMode === 'live' && previousMode === 'imported') {
      // Returning to live mode from imported replay - clear the data
      // Live observations will start populating the timeline again
      timelineStore.clear()
    }
    // Note: Returning to live from buffer replay doesn't need to clear -
    // the timeline still has valid live observations
  }

  // ============================================================================
  // UNIFIED TIMELINE-BASED INTERPOLATION (both main app and insets)
  // ============================================================================
  // Use the timeline store for smooth position interpolation:
  // - Main app: Uses VATSIM/vNAS/RealTraffic with source-specific display delays
  // - Insets: Uses broadcast observations (fed from useBroadcastAircraft)
  // - Buffer replay: Scrubs through existing timeline with virtual "now" time
  // - Imported replay: Uses loaded snapshots with zero display delay
  //
  // The timeline store handles interpolation uniformly for all sources.

  // Get interpolated states from timeline store
  const timelineStore = useAircraftTimelineStore.getState()
  const timelineStates = timelineStore.getInterpolatedStates(now)

  // Get reference position and filter radius for distance filtering
  const referencePosition = sharedReferencePositionRef.current
  const aircraftDataRadiusNM = sharedAircraftDataRadiusNMRef.current
  for (const [callsign, timeline] of timelineStates) {
    // Skip aircraft with fewer than 2 observations - we need at least 2 data points
    // to interpolate smoothly. Aircraft will "spawn in" once they have enough data.
    // Exception: Allow stopped aircraft (groundspeed < STOPPED_SPEED_KTS) with only
    // 1 observation. vNAS doesn't send updates for stationary aircraft, so they would
    // otherwise never appear. Since they're not moving, interpolation isn't needed -
    // their VATSIM position is valid as-is. The reported speed decides, not the held groundspeed of 0, so an
    // aircraft first seen moving is not drawn held and then hidden when display time passes its first report. An
    // aircraft a vNAS drop holds is drawn at the hold's point, the only sample in its drawn list until a newer arrives.
    if (timeline.observationCount < 2 && timeline.reportedGroundspeed >= STOPPED_SPEED_KTS && !timeline.heldAtDrop) {
      continue
    }

    // Still require at least 1 observation
    if (timeline.observationCount < 1) {
      continue
    }

    // Skip aircraft if no reference position is set (no airport selected yet)
    // This prevents model matching and rendering work before airport selection
    if (!referencePosition) {
      continue
    }

    // Skip aircraft outside the user-configured range
    // This ensures we only interpolate and model-match aircraft that will be rendered
    const distance = calculateDistanceNM(
      referencePosition.latitude,
      referencePosition.longitude,
      timeline.latitude,
      timeline.longitude,
    )
    if (distance > aircraftDataRadiusNM) {
      continue
    }

    activeCallsigns.add(callsign)

    // Convert timeline result to InterpolatedAircraftState
    // The replay flag comes from the same data-source read as `now`, so the frame's data time and flag agree
    const isReplay = source.playbackMode !== 'live'
    const interpolated = timelineToInterpolatedState(timeline, now, orientationEnabled, orientationIntensity, isReplay)

    // Reuse existing entry or create new one
    const existing = statesMap.get(callsign)
    if (existing) {
      // Update in place to avoid object allocation
      existing.callsign = interpolated.callsign
      existing.cid = interpolated.cid
      existing.transponder = interpolated.transponder
      existing.interpolatedLatitude = interpolated.interpolatedLatitude
      existing.interpolatedLongitude = interpolated.interpolatedLongitude
      existing.interpolatedAltitude = interpolated.interpolatedAltitude
      existing.reportedAltitude = interpolated.reportedAltitude
      existing.interpolatedGroundspeed = interpolated.interpolatedGroundspeed
      existing.interpolatedHeading = interpolated.interpolatedHeading
      existing.interpolatedPitch = interpolated.interpolatedPitch
      existing.interpolatedRoll = interpolated.interpolatedRoll
      existing.aircraftType = interpolated.aircraftType
      existing.departure = interpolated.departure
      existing.arrival = interpolated.arrival
      existing.isInterpolated = interpolated.isInterpolated
      existing.verticalRate = interpolated.verticalRate
      existing.turnRate = interpolated.turnRate
      existing.acceleration = interpolated.acceleration
      existing.track = interpolated.track
      existing.timestamp = interpolated.timestamp
      existing.displayDelay = interpolated.displayDelay
      existing.displayTime = interpolated.displayTime
      existing.isOnGround = interpolated.isOnGround
      existing.heightAboveGround = interpolated.heightAboveGround
      existing.inContact = interpolated.inContact
      existing.groundBlendWeight = interpolated.groundBlendWeight
      existing.groundBlendDescending = interpolated.groundBlendDescending
      existing.isReplay = interpolated.isReplay
    } else {
      statesMap.set(callsign, interpolated)
    }
  }

  // Update frame timestamp for rate calculations
  sharedTimelineLastFrameTimeRef.current = now

  // ============================================================================
  // TERRAIN CORRECTION AND FLARE PITCH (applies to ALL aircraft)
  // ============================================================================

  for (const callsign of activeCallsigns) {
    // Apply terrain correction to aircraft altitude
    // This ensures consistent height across all rendering (models, labels, etc.)
    const entry = statesMap.get(callsign)
    if (!entry) continue // Safety check
    // Aircraft altitude is already in ellipsoidal coordinates (converted in vatsimStore/RealTrafficService)
    const reportedEllipsoidHeight = entry.interpolatedAltitude
    const groundElevationMetersMsl = sharedGroundElevationMetersRef.current
    const groundAircraftTerrain = sharedGroundAircraftTerrainRef.current

    // Get or create consolidated terrain state for this aircraft
    let terrainState = sharedTerrainStateRef.current.get(callsign)
    if (!terrainState) {
      terrainState = {
        smoothedTerrainHeight: 0,
        prevClampState: false,
        transition: null,
        prevCorrectedHeight: entry.interpolatedAltitude,
      }
      sharedTerrainStateRef.current.set(callsign, terrainState)
    }

    // Get terrain data - sampledTerrainHeight is in ellipsoidal coordinates (from Cesium)
    const terrainDataForAircraft = groundAircraftTerrain.get(callsign)
    const sampledTerrainHeight = terrainDataForAircraft?.height
    const terrainSlopeDegrees = terrainDataForAircraft?.slopeDegrees ?? 0

    // A source with a height above ground reports a reference point its resting height above the wheels:
    // out of contact the aircraft is drawn that much lower, so its wheels sit at their true height
    const restOffset = drawnRestOffset(callsign, entry, now)
    const drawnReportedHeight = reportedEllipsoidHeight - restOffset

    // Calculate altitude above ground level (AGL) for ground detection
    // Use terrain sample if available, otherwise convert MSL ground elevation to ellipsoidal
    const altitudeAGL =
      sampledTerrainHeight !== undefined
        ? drawnReportedHeight - sampledTerrainHeight
        : drawnReportedHeight -
          geoidService.mslToEllipsoidal(
            entry.interpolatedLatitude,
            entry.interpolatedLongitude,
            groundElevationMetersMsl,
          )

    // ========================================================================
    // PROGRESSIVE LANDING/DEPARTURE BLENDING
    // ========================================================================
    // Instead of binary ground/air clamping, we progressively blend between
    // terrain-clamped height and reported altitude based on:
    // - Landing: descending aircraft blend toward terrain starting at 50m AGL
    // - Departure: low aircraft blend toward reported as altitude increases
    // This eliminates the visual "pop" when crossing altitude thresholds.

    // Get vertical rate for landing detection (m/min, negative = descending)
    const verticalRate = entry.verticalRate ?? 0

    // Calculate both terrain-clamped and reported heights
    let terrainClampedHeight: number

    // Update smoothed terrain height when we have terrain data
    if (sampledTerrainHeight !== undefined) {
      if (terrainState.smoothedTerrainHeight === 0) {
        terrainState.smoothedTerrainHeight = sampledTerrainHeight
      }
      terrainState.smoothedTerrainHeight +=
        (sampledTerrainHeight - terrainState.smoothedTerrainHeight) * TERRAIN_SMOOTHING_LERP_FACTOR
      terrainClampedHeight = terrainState.smoothedTerrainHeight + GROUND_AIRCRAFT_TERRAIN_OFFSET
    } else {
      // Fallback: use MSL ground elevation
      const groundEllipsoidHeight = geoidService.mslToEllipsoidal(
        entry.interpolatedLatitude,
        entry.interpolatedLongitude,
        groundElevationMetersMsl,
      )
      terrainClampedHeight = groundEllipsoidHeight + GROUND_AIRCRAFT_TERRAIN_OFFSET
    }

    // Airborne aircraft are drawn at their reported (already ellipsoidal) altitude. Near the ground the
    // ground offset fades out over the first 30 m AGL so the hand-off from the terrain clamp is continuous.
    let flyingOffset = 0
    if (sampledTerrainHeight !== undefined) {
      const transitionProgress = Math.min(1.0, Math.max(0, altitudeAGL / 30))
      flyingOffset = GROUND_AIRCRAFT_TERRAIN_OFFSET * (1 - transitionProgress)
    }
    const reportedHeightWithOffset = drawnReportedHeight + flyingOffset

    // Determine ground blend weight (0 = fully airborne/reported, 1 = fully on terrain)
    let groundBlendWeight: number
    let groundBlendDescending = false
    const isLowSpeed = entry.interpolatedGroundspeed < 5

    if (isLowSpeed) {
      // Very low speed = definitely on ground, full terrain clamping
      groundBlendWeight = 1.0
    } else if (entry.heightAboveGround !== null) {
      // The source reports its height above ground: on the sampled terrain in contact, at the reported height
      // otherwise (kept above the terrain). Without a terrain sample the reported height stands, since the
      // reference airport's elevation may not be the field the aircraft is on. The landing and departure blends
      // below are for sources without that height.
      const sampled = sampledTerrainHeight !== undefined
      const terrainAboveReported = sampled && terrainClampedHeight > reportedHeightWithOffset
      groundBlendWeight = sampled && (entry.inContact || terrainAboveReported) ? 1.0 : 0
    } else if (entry.isOnGround === true && sampledTerrainHeight !== undefined) {
      // Source ground flag (RealTraffic's ADS-B ground bit) confirms aircraft is on ground - trust it over computed AGL
      // This is more reliable than altitude-based detection when MSL/ellipsoidal conversion has errors
      groundBlendWeight = 1.0
    } else if (sampledTerrainHeight !== undefined && terrainClampedHeight > reportedHeightWithOffset) {
      // Terrain higher than reported = prevent going underground
      groundBlendWeight = 1.0
    } else if (entry.isOnGround === false && altitudeAGL >= DEPARTURE_BLEND_END_AGL) {
      // Source ground flag confirms aircraft is airborne AND well above ground
      // Skip progressive blending - trust reported altitude fully
      groundBlendWeight = 0
    } else if (entry.isOnGround === false) {
      // Source says airborne but aircraft is still very close to ground
      // Use progressive departure blend instead of snapping to reported altitude,
      // which prevents visible oscillation when the ground flag toggles rapidly
      const blendRange = DEPARTURE_BLEND_END_AGL - DEPARTURE_BLEND_START_AGL
      if (altitudeAGL <= DEPARTURE_BLEND_START_AGL) {
        groundBlendWeight = 1.0
      } else {
        groundBlendWeight = Math.min(1.0, Math.max(0, 1.0 - (altitudeAGL - DEPARTURE_BLEND_START_AGL) / blendRange))
      }
    } else if (verticalRate < LANDING_BLEND_DESCENT_RATE && altitudeAGL < LANDING_BLEND_START_AGL) {
      // LANDING: Aircraft is descending and low - blend toward terrain
      // Only applies for sources without authoritative ground state (VATSIM HTTP polling)
      // At LANDING_BLEND_START_AGL (50m): start blending (weight = 0)
      // At LANDING_BLEND_END_AGL (10m): full ground (weight = 1)
      const blendRange = LANDING_BLEND_START_AGL - LANDING_BLEND_END_AGL
      groundBlendWeight = Math.min(1.0, Math.max(0, (LANDING_BLEND_START_AGL - altitudeAGL) / blendRange))
      groundBlendDescending = true
    } else if (altitudeAGL < DEPARTURE_BLEND_END_AGL) {
      // GROUND/DEPARTURE: Low altitude aircraft - clamp to terrain or blend toward reported
      // This catches:
      // - Taxiing aircraft (AGL ≈ 0 or slightly negative due to GPS error)
      // - Departing aircraft (AGL 0-35m)
      // At DEPARTURE_BLEND_START_AGL (5m) or below: full ground (weight = 1)
      // At DEPARTURE_BLEND_END_AGL (35m): full airborne (weight = 0)
      const blendRange = DEPARTURE_BLEND_END_AGL - DEPARTURE_BLEND_START_AGL
      if (altitudeAGL <= DEPARTURE_BLEND_START_AGL) {
        groundBlendWeight = 1.0
      } else {
        groundBlendWeight = Math.min(1.0, Math.max(0, 1.0 - (altitudeAGL - DEPARTURE_BLEND_START_AGL) / blendRange))
      }
    } else {
      // Fully airborne - use reported altitude
      groundBlendWeight = 0
    }

    // Blend between terrain and reported heights
    const targetHeight = terrainClampedHeight * groundBlendWeight + reportedHeightWithOffset * (1 - groundBlendWeight)

    // For state transition tracking, consider "clamped" if blend weight > 0.5
    const shouldClampToTerrain = groundBlendWeight > 0.5

    // A source without a height above ground takes its contact from the drawn result, so the gear has one input
    if (entry.heightAboveGround === null) {
      entry.inContact = shouldClampToTerrain
    }
    entry.groundBlendWeight = groundBlendWeight
    entry.groundBlendDescending = groundBlendDescending

    // Reset smoothed terrain height for aircraft that are truly airborne
    if (groundBlendWeight === 0 && sampledTerrainHeight !== undefined && altitudeAGL > 50) {
      terrainState.smoothedTerrainHeight = 0
    } else if (groundBlendWeight === 0 && sampledTerrainHeight === undefined) {
      terrainState.smoothedTerrainHeight = 0
    }

    // Smooth transition when switching between clamped/unclamped states
    // Track shouldClampToTerrain changes (not just isOnGround) to handle landing transition
    let correctedHeight = targetHeight

    if (terrainState.prevClampState !== shouldClampToTerrain) {
      // State changed! Start a transition
      if (!terrainState.transition || terrainState.transition.target !== targetHeight) {
        // Initialize new transition from current position to target
        // Use the PREVIOUS FRAME's corrected height as source (not raw interpolated altitude)
        // This prevents visual jumps when transitioning between ground/airborne states
        let sourceHeight: number
        if (terrainState.transition) {
          // Mid-transition: calculate current interpolated height
          sourceHeight =
            terrainState.transition.source +
            (terrainState.transition.target - terrainState.transition.source) * terrainState.transition.progress
        } else {
          // New transition: use previous frame's corrected height
          sourceHeight = terrainState.prevCorrectedHeight
        }
        // A change of contact while the aircraft has no resting height moves it by that unknown height: eased over
        // DROP_CONTACT_EASE_MS of display time rather than a few frames
        const contactWithoutRest =
          entry.heightAboveGround !== null &&
          entry.inContact === shouldClampToTerrain &&
          restingHeightFor(callsign, entry.aircraftType) === null
        terrainState.transition = {
          source: sourceHeight,
          target: targetHeight,
          progress: 0,
          easeStartedAt: contactWithoutRest ? entry.displayTime : null,
        }
      }
    }

    // Apply ongoing transition if exists
    if (terrainState.transition && terrainState.transition.progress < 1.0) {
      terrainState.transition.progress = transitionProgress(terrainState.transition, entry.displayTime)
      correctedHeight =
        terrainState.transition.source +
        (terrainState.transition.target - terrainState.transition.source) * terrainState.transition.progress

      // Update target if it changed during transition
      if (terrainState.transition.target !== targetHeight) {
        terrainState.transition.target = targetHeight
      }

      // Clean up completed transitions
      if (terrainState.transition.progress >= 1.0) {
        terrainState.transition = null
      }
    }

    // Update previous state
    terrainState.prevClampState = shouldClampToTerrain

    // Apply corrected height to interpolated altitude; the shown altitude takes back the resting height wherever the
    // reported height is drawn, so the text matches the source
    entry.interpolatedAltitude = correctedHeight
    entry.reportedAltitude = correctedHeight + restOffset * (1 - groundBlendWeight)

    // Store corrected height for next frame (used as transition source when state changes)
    terrainState.prevCorrectedHeight = correctedHeight

    // Apply landing flare pitch adjustment
    // When aircraft is descending close to the ground, pitch nose up to emulate flare
    // NOTE: Calculate AGL BEFORE terrain correction is applied to entry.interpolatedAltitude
    if (orientationEnabled && sampledTerrainHeight !== undefined) {
      // Get or create consolidated nosewheel state for this aircraft
      let nosewheelState = sharedNosewheelStateRef.current.get(callsign)
      if (!nosewheelState) {
        nosewheelState = {
          transition: null,
          wasInFlare: false,
          lastFlarePitch: null,
          groundCommitted: false,
        }
        sharedNosewheelStateRef.current.set(callsign, nosewheelState)
      }

      // Height above ground for the flare: the source's own over the aircraft's resting height (raw until one is
      // learned) when it reports one, else the reported altitude
      // (not corrected) above the terrain sample, both in ellipsoid coords
      const altitudeAGLFlare =
        entry.heightAboveGround !== null
          ? flareHeightAboveGround(callsign, entry.aircraftType, entry.heightAboveGround)
          : reportedEllipsoidHeight - sampledTerrainHeight

      // Clear groundCommitted when clearly airborne again (handles go-around / touch-and-go)
      // Both conditions required to prevent false clears from a single noisy datum
      if (nosewheelState.groundCommitted) {
        if (!shouldClampToTerrain && altitudeAGLFlare > FLARE_START_ALTITUDE_METERS) {
          nosewheelState.groundCommitted = false
          nosewheelState.wasInFlare = false
          nosewheelState.lastFlarePitch = null
          nosewheelState.transition = null
        }
      }

      // Only run flare detection when NOT committed to ground
      // Once committed (after first touchdown), flare logic is locked out to prevent
      // nose oscillation from noisy AGL data flickering the isInFlare flag
      if (!nosewheelState.groundCommitted) {
        const isDescending = entry.verticalRate < -50 // m/min
        const inFlareZone = altitudeAGLFlare > 0 && altitudeAGLFlare < 15 // meters
        const isInFlare = isDescending && inFlareZone

        const basePitch = entry.interpolatedPitch

        // Apply flare pitch calculation
        entry.interpolatedPitch = calculateFlarePitch(
          entry.interpolatedPitch,
          altitudeAGLFlare,
          entry.verticalRate, // Already in m/min
          entry.interpolatedGroundspeed,
          orientationIntensity,
        )

        // If currently in flare, store the actual flare pitch for nosewheel transition
        if (isInFlare) {
          nosewheelState.lastFlarePitch = entry.interpolatedPitch
        }

        // Track flare state for nosewheel lowering transition
        if (nosewheelState.wasInFlare && !isInFlare && !nosewheelState.transition) {
          // Just exited flare! Start nosewheel lowering transition
          const lastFlarePitch = nosewheelState.lastFlarePitch ?? basePitch + FALLBACK_FLARE_PITCH_DEGREES
          nosewheelState.transition = {
            sourcePitch: lastFlarePitch,
            progress: 0,
          }
          nosewheelState.lastFlarePitch = null
          // Lock: prevent flare re-engagement until clearly airborne again
          nosewheelState.groundCommitted = true
        }

        nosewheelState.wasInFlare = isInFlare
      }

      // Nosewheel transition runs even when groundCommitted
      if (nosewheelState.transition && nosewheelState.transition.progress < 1.0) {
        // Gradually lower nose over ~1 second at 60fps (~60 frames)
        nosewheelState.transition.progress = Math.min(
          1.0,
          nosewheelState.transition.progress + NOSEWHEEL_LOWERING_LERP_FACTOR,
        )

        // smoothstep: x^2 * (3 - 2x) for smooth acceleration/deceleration
        const easedProgress =
          nosewheelState.transition.progress *
          nosewheelState.transition.progress *
          (3 - 2 * nosewheelState.transition.progress)

        // Blend from flare pitch to level (0 degrees)
        entry.interpolatedPitch = nosewheelState.transition.sourcePitch * (1 - easedProgress)

        // Clean up completed transitions
        if (nosewheelState.transition.progress >= 1.0) {
          nosewheelState.transition = null
        }
      }

      // While ground-committed and no active transition, suppress AoA-induced pitch
      // Aircraft may still be >40 kts (isOnGround=false) during rollout, but it's on the ground
      // Terrain slope is added in the next section
      if (nosewheelState.groundCommitted && !nosewheelState.transition) {
        entry.interpolatedPitch = 0
      }
    }

    // ========================================================================
    // TERRAIN SLOPE APPLICATION
    // ========================================================================
    // Apply terrain slope to pitch for ground aircraft so they "glide" on sloped
    // runways instead of appearing to climb tiny steps
    // Only apply when:
    // 1. Aircraft is on ground (shouldClampToTerrain)
    // 2. We have terrain slope data
    // 3. Groundspeed is above a minimum (to avoid jitter when stationary)
    if (shouldClampToTerrain && terrainSlopeDegrees !== 0 && entry.interpolatedGroundspeed > 2) {
      // Smoothly blend terrain slope into pitch
      // The terrain slope should ADD to the current pitch (which may include flare/nosewheel effects)
      // Negative slope (downhill) should pitch nose down, positive (uphill) pitches nose up
      entry.interpolatedPitch += terrainSlopeDegrees
    }

    // ========================================================================
    // GROUND ROLL SUPPRESSION
    // ========================================================================
    // Aircraft clamped to terrain should never show roll, regardless of speed.
    // Ground aircraft steer with rudder (yaw only), they don't bank/roll.
    // This handles cases where groundspeed > 40 kts but aircraft is still on ground
    // (e.g., high-speed taxi, takeoff roll, landing rollout).
    if (shouldClampToTerrain) {
      entry.interpolatedRoll = 0
    }
  }

  // Remove stale entries (aircraft that are no longer in the data)
  // Consolidated cleanup: only 3 Maps to clean instead of 16
  for (const callsign of statesMap.keys()) {
    if (!activeCallsigns.has(callsign)) {
      statesMap.delete(callsign)
      // Clean up all consolidated state Maps for removed aircraft
      sharedTerrainStateRef.current.delete(callsign)
      sharedNosewheelStateRef.current.delete(callsign)
      sharedTimelineRateStateRef.current.delete(callsign)
      sharedContactStateRef.current.delete(callsign)
      sharedLaneBStateRef.current.delete(callsign)
      sharedRestOffsetStateRef.current.delete(callsign)
      sharedContactHoldStateRef.current.delete(callsign)
    }
  }

  // Trigger React re-render for subscribers when aircraft count changes
  const currentCount = statesMap.size
  if (currentCount !== sharedLastAircraftCountRef.current) {
    sharedLastAircraftCountRef.current = currentCount
    for (const callback of subscribers) {
      callback()
    }
  }

  performanceMonitor.endTimer('interpolation')
}

/**
 * Inject terrain correction data into the interpolation system
 *
 * This function allows the rendering layer to provide terrain data that will be
 * used for ground aircraft altitude and pitch correction during interpolation.
 *
 * @param groundAircraftTerrain - Map of terrain data (height and slope) sampled at 10Hz
 * @param groundElevationMetersMsl - Ground elevation at tower/reference position in MSL meters (fallback only)
 */
export function setInterpolationTerrainData(
  groundAircraftTerrain: Map<string, TerrainData>,
  groundElevationMetersMsl: number,
) {
  sharedGroundAircraftTerrainRef.current = groundAircraftTerrain
  sharedGroundElevationMetersRef.current = groundElevationMetersMsl
}

/**
 * Hook that provides smoothly interpolated aircraft positions
 * Updates at 60fps for smooth rendering
 *
 * SINGLETON PATTERN: Multiple calls to this hook share the same interpolation loop
 * and the same Map instance to prevent duplicate calculations and memory waste.
 */
/**
 * Provides smooth 60 Hz aircraft position and orientation interpolation using a
 * singleton animation loop.
 *
 * ## Responsibilities
 * - Interpolate aircraft positions between 15-second VATSIM API updates
 * - Calculate smooth heading changes during turns
 * - Estimate pitch/roll from climb/descent and turn rates
 * - Extrapolate positions when data is stale
 * - Maintain singleton animation loop (only ONE loop for entire app)
 *
 * ## Singleton Pattern
 * **CRITICAL:** This hook uses a singleton pattern. Multiple components can call this
 * hook, but only ONE animation loop runs for the entire application. All instances
 * share the same interpolated states map.
 *
 * Benefits:
 * - Single source of truth for interpolated positions
 * - Prevents duplicate calculations (60 Hz * N components = waste)
 * - Consistent aircraft state across all viewports
 * - Automatic cleanup when last instance unmounts
 *
 * ## Dependencies
 * - Reads: vatsimStore OR replayStore (via getAircraftDataSource abstraction)
 * - Reads: settingsStore (for orientation emulation settings)
 * - Writes: Shared interpolatedStates Map (singleton)
 *
 * ## Interpolation Algorithm
 *
 * ### Position Interpolation
 * Uses linear interpolation (lerp) between previous and current position:
 * ```
 * t = (now - lastUpdate) / (currentUpdate - lastUpdate)
 * interpolatedPos = lerp(previousPos, currentPos, clamp(t, 0, 1.2))
 * ```
 * Note: Allows 20% extrapolation (t > 1.0) for stale data.
 *
 * ### Heading Interpolation
 * Uses spherical interpolation to avoid wrap-around issues:
 * - Handles 350° → 10° transition smoothly
 * - Calculates turn rate from heading delta
 *
 * ### Pitch/Roll Estimation
 * Derives orientation from motion:
 * - Pitch: Based on vertical rate (climb/descent)
 * - Roll: Based on turn rate (banking in turns)
 * - Intensity configurable via settings (25% to 150%)
 *
 * ## Performance
 * - Runs at 60 Hz (requestAnimationFrame)
 * - Processes all aircraft each frame (~100-500 aircraft typical)
 * - Performance monitored via performanceMonitor.startTimer('interpolation')
 * - Frame timing logged for followed aircraft
 *
 * ## Data Flow
 * ```
 * LIVE MODE:                          REPLAY MODE:
 * VATSIM API (15s updates)            replayStore snapshots
 *   ↓                                    ↓
 * vatsimStore                         getActiveSnapshots()
 *   ↓                                    ↓
 *   └──────────────┬────────────────────┘
 *                  ↓
 *        getAircraftDataSource() (unified abstraction)
 *                  ↓
 *        useAircraftInterpolation (60 Hz singleton loop)
 *                  ↓
 *        sharedInterpolatedStates Map
 *                  ↓
 *        ├─ CesiumViewer (labels, culling)
 *        └─ useBabylonOverlay (3D models, shadows)
 * ```
 *
 * ## Memory Management
 * - Automatically removes stale aircraft (no longer in VATSIM data)
 * - Cleans up animation loop when last component unmounts
 * - Reuses Map entries to minimize allocations
 *
 * @returns Shared Map of interpolated aircraft states (callsign → InterpolatedAircraftState)
 *
 * @example
 * // Basic usage (call once per component that needs interpolated data)
 * const interpolatedAircraft = useAircraftInterpolation()
 *
 * // Access interpolated state for specific aircraft
 * const aircraft = interpolatedAircraft.get('AAL123')
 * if (aircraft) {
 *   console.log(aircraft.latitude, aircraft.longitude, aircraft.altitude)
 *   console.log(aircraft.heading, aircraft.pitch, aircraft.roll)
 * }
 *
 * @example
 * // Multiple components can call this hook - only ONE loop runs
 * function ComponentA() {
 *   const aircraft = useAircraftInterpolation() // Instance 1
 *   // ...
 * }
 *
 * function ComponentB() {
 *   const aircraft = useAircraftInterpolation() // Instance 2 (same data!)
 *   // ...
 * }
 *
 * @example
 * // Iterate over all interpolated aircraft
 * const interpolatedAircraft = useAircraftInterpolation()
 * for (const [callsign, aircraft] of interpolatedAircraft) {
 *   // Process each aircraft at 60 Hz
 * }
 *
 * @see interpolateAircraftState - core interpolation math
 * @see vatsimStore - source data for interpolation
 * @see docs/architecture.md - data flow diagram
 */
export function useAircraftInterpolation(): Map<string, InterpolatedAircraftState> {
  // Version counter to trigger re-renders when data changes
  const [, setVersion] = useState(0)

  // Subscribe to store changes and manage singleton lifecycle
  useEffect(() => {
    hookInstanceCount++

    // Subscribe to settings for orientation emulation and distance filtering
    const unsubscribeSettings = useSettingsStore.subscribe((state) => {
      sharedOrientationEnabledRef.current = state.aircraft.orientationEmulation
      sharedOrientationIntensityRef.current = state.aircraft.orientationIntensity
      sharedAircraftDataRadiusNMRef.current = state.memory.aircraftDataRadiusNM
    })

    // Subscribe to vatsimStore for reference position (airport location)
    // This gates interpolation to only run after an airport is selected
    const unsubscribeVatsim = useVatsimStore.subscribe((state) => {
      sharedReferencePositionRef.current = state.referencePosition
    })

    // Initialize settings refs
    const settingsState = useSettingsStore.getState()
    sharedOrientationEnabledRef.current = settingsState.aircraft.orientationEmulation
    sharedOrientationIntensityRef.current = settingsState.aircraft.orientationIntensity
    sharedAircraftDataRadiusNMRef.current = settingsState.memory.aircraftDataRadiusNM

    // Initialize reference position from vatsimStore
    sharedReferencePositionRef.current = useVatsimStore.getState().referencePosition

    // Subscribe this component to updates (for React re-renders when aircraft count changes)
    const updateCallback = () => setVersion((v) => v + 1)
    subscribers.add(updateCallback)

    return () => {
      hookInstanceCount--
      unsubscribeSettings()
      unsubscribeVatsim()
      subscribers.delete(updateCallback)

      // Stop animation loop when last component unmounts
      if (hookInstanceCount === 0 && animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId)
        animationFrameId = null
        animationLoopRunning = false
      }
    }
  }, [])

  // Start singleton animation loop (only once, regardless of hook calls)
  // Both main app and insets now run the animation loop - insets use the timeline
  // store populated by useBroadcastAircraft for smooth interpolation.
  useEffect(() => {
    if (!animationLoopRunning) {
      animationLoopRunning = true
      animationFrameId = requestAnimationFrame(updateInterpolation)
    }
  }, [])

  return sharedInterpolatedStates
}

export default useAircraftInterpolation
