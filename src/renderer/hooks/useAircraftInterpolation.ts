import { useState, useEffect } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { useReplayStore } from '../stores/replayStore'
import { useAircraftTimelineStore } from '../stores/aircraftTimelineStore'
import { getAircraftDataSource } from './useAircraftDataSource'
import { calculateFlarePitch, angleDifference } from '../utils/interpolation'
import { performanceMonitor } from '../utils/performanceMonitor'
import type { InterpolatedAircraftState, AircraftState } from '../types/vatsim'
import type { TimelineInterpolationResult } from '../types/aircraft-timeline'
import {
  GROUND_AIRCRAFT_TERRAIN_OFFSET,
  FLYING_AIRCRAFT_TERRAIN_OFFSET,
  TERRAIN_SMOOTHING_LERP_FACTOR,
  HEIGHT_TRANSITION_LERP_FACTOR,
  NOSEWHEEL_LOWERING_LERP_FACTOR,
  FALLBACK_FLARE_PITCH_DEGREES,
  PITCH_RATE_MULTIPLIER,
  ROLL_RATE_MULTIPLIER,
  MAX_PITCH_DEGREES,
  MAX_ROLL_DEGREES,
  MAX_PITCH_RATE_DEG_PER_SEC,
  MAX_ROLL_RATE_DEG_PER_SEC
} from '../constants/rendering'

// SINGLETON: Shared interpolated states map and animation loop
// This ensures only ONE interpolation loop runs, even if hook is called multiple times
const sharedInterpolatedStates = new Map<string, InterpolatedAircraftState>()
let animationLoopRunning = false
let animationFrameId: number | null = null
let hookInstanceCount = 0

// Shared state for animation loop (accessed by singleton loop)
const sharedAircraftStatesRef = { current: new Map<string, AircraftState>() }
const sharedPreviousStatesRef = { current: new Map<string, AircraftState>() }
const sharedOrientationEnabledRef = { current: true }
const sharedOrientationIntensityRef = { current: 1.0 }
const sharedLastInterpolationTimeRef = { current: 0 }
const sharedLastAircraftCountRef = { current: 0 }

// Shared state for terrain correction (injected from rendering layer)
const sharedGroundAircraftTerrainRef = { current: new Map<string, number>() }
const sharedTerrainOffsetRef = { current: 0 }
const sharedGroundElevationMetersRef = { current: 0 }

// ============================================================================
// CONSOLIDATED STATE OBJECTS
// ============================================================================
// Consolidate related Maps into single Maps with combined state objects
// This reduces memory overhead and simplifies cleanup

/** Consolidated terrain correction state per aircraft */
interface TerrainCorrectionState {
  smoothedTerrainHeight: number
  prevClampState: boolean
  transition: { source: number; target: number; progress: number } | null
  prevCorrectedHeight: number
}

/** Consolidated nosewheel transition state per aircraft */
interface NosewheelState {
  transition: { sourcePitch: number; progress: number } | null
  wasInFlare: boolean
  lastFlarePitch: number | null
}

/** Consolidated timeline rate tracking state per aircraft */
interface TimelineRateState {
  prevAltitude: number | null
  prevHeading: number | null
  prevGroundspeed: number | null
  smoothedVerticalRate: number
  smoothedTurnRate: number
  prevPitch: number | null
  prevRoll: number | null
}

// Consolidated state Maps (3 Maps instead of 16)
const sharedTerrainStateRef = { current: new Map<string, TerrainCorrectionState>() }
const sharedNosewheelStateRef = { current: new Map<string, NosewheelState>() }
const sharedTimelineRateStateRef = { current: new Map<string, TimelineRateState>() }

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
  orientationIntensity: number
): InterpolatedAircraftState {
  const callsign = timeline.callsign

  // Get or create consolidated rate state for this aircraft
  let rateState = sharedTimelineRateStateRef.current.get(callsign)
  if (!rateState) {
    rateState = {
      prevAltitude: null,
      prevHeading: null,
      prevGroundspeed: null,
      smoothedVerticalRate: 0,
      smoothedTurnRate: 0,
      prevPitch: null,
      prevRoll: null
    }
    sharedTimelineRateStateRef.current.set(callsign, rateState)
  }

  const lastFrameTime = sharedTimelineLastFrameTimeRef.current

  // Calculate frame delta (ms)
  const frameDelta = lastFrameTime > 0 ? now - lastFrameTime : 16.67 // ~60fps default

  // Calculate rates from frame-to-frame changes
  let verticalRate = 0 // m/min
  let turnRate = 0 // deg/sec
  let acceleration = 0 // knots/sec

  if (frameDelta > 0 && frameDelta < 100) { // Only calculate if reasonable frame time
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
      verticalRate = rateState.smoothedVerticalRate + (rawVerticalRate - rateState.smoothedVerticalRate) * RATE_SMOOTHING
      rateState.smoothedVerticalRate = verticalRate
    }

    // Turn rate: heading change per second
    if (rateState.prevHeading !== null) {
      const headingChange = angleDifference(rateState.prevHeading, timeline.heading)
      const rawTurnRate = (headingChange / frameDelta) * 1000 // deg/sec
      // Clamp to realistic limits and smooth
      const clampedTurnRate = Math.max(-6, Math.min(6, rawTurnRate))
      turnRate = rateState.smoothedTurnRate + (clampedTurnRate - rateState.smoothedTurnRate) * RATE_SMOOTHING
      rateState.smoothedTurnRate = turnRate
    }

    // Acceleration: groundspeed change per second
    if (rateState.prevGroundspeed !== null) {
      const speedChange = timeline.groundspeed - rateState.prevGroundspeed
      acceleration = (speedChange / frameDelta) * 1000 // knots/sec
    }
  }

  // Store current values for next frame
  rateState.prevAltitude = timeline.altitude
  rateState.prevHeading = timeline.heading
  rateState.prevGroundspeed = timeline.groundspeed

  // Calculate pitch and roll from rates (orientation emulation)
  let pitch = 0
  let roll = 0

  if (orientationEnabled) {
    // Pitch from vertical rate
    // ~1000 fpm climb = ~5 degrees pitch (standard approximation)
    // verticalRate is in m/min, convert to fpm for calculation
    const fpm = verticalRate * 3.28084
    let targetPitch = (fpm / 1000) * PITCH_RATE_MULTIPLIER * orientationIntensity
    targetPitch = Math.max(-MAX_PITCH_DEGREES, Math.min(MAX_PITCH_DEGREES, targetPitch))

    // Roll: Only calculate for airborne aircraft
    // Ground aircraft steer with rudder (yaw only), they don't bank/roll
    const isOnGround = timeline.onGround === true || timeline.groundspeed < 40
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

    // Interpolated values (same as raw for timeline-based)
    interpolatedLatitude: timeline.latitude,
    interpolatedLongitude: timeline.longitude,
    interpolatedAltitude: timeline.altitude,
    interpolatedHeading: timeline.heading,
    interpolatedGroundspeed: timeline.groundspeed,

    // Orientation
    interpolatedPitch: pitch,
    interpolatedRoll: roll,

    // Rates
    verticalRate,
    turnRate,
    acceleration,
    track,

    isInterpolated: true
  }
}

// Singleton animation loop function
function updateInterpolation() {
  performanceMonitor.startTimer('interpolation')

  // Get aircraft data from unified source (handles live vs replay mode)
  const source = getAircraftDataSource()

  // Update shared refs from source (for any external code that reads them)
  sharedAircraftStatesRef.current = source.aircraftStates
  sharedPreviousStatesRef.current = source.previousStates

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

    if (currentMode === 'imported') {
      // Entering imported replay mode - load external snapshots into timeline store
      // This replaces the timeline with data from an imported file
      const replayState = useReplayStore.getState()
      const snapshots = replayState.getActiveSnapshots()
      timelineStore.loadReplaySnapshots(snapshots)

      // Clear consolidated rate tracking state for fresh start
      sharedTimelineRateStateRef.current.clear()
    } else if (currentMode === 'replay') {
      // Entering buffer replay mode - scrub through existing timeline
      // The timeline already has live observations, no need to load anything
      // Just clear rate tracking for fresh orientation calculations
      sharedTimelineRateStateRef.current.clear()
    } else if (currentMode === 'live' && previousMode === 'imported') {
      // Returning to live mode from imported replay - clear the imported data
      // Live observations will start populating the timeline again
      timelineStore.clear()
    }
    // Note: Returning to live from buffer replay doesn't need to clear -
    // the timeline still has valid live observations
  }

  // ============================================================================
  // UNIFIED TIMELINE-BASED INTERPOLATION (ALL MODES)
  // ============================================================================
  // Use the timeline store for smooth position interpolation.
  // - Live mode: Uses VATSIM/vNAS/RealTraffic with source-specific display delays
  // - Buffer replay: Scrubs through existing timeline with virtual "now" time
  // - Imported replay: Uses loaded snapshots with zero display delay
  //
  // The timeline store handles interpolation uniformly for all sources.

  {
    // Get interpolated states from timeline store
    const timelineStore = useAircraftTimelineStore.getState()
    const timelineStates = timelineStore.getInterpolatedStates(now)

    for (const [callsign, timeline] of timelineStates) {
      // Skip aircraft with fewer than 2 observations - we need at least 2 data points
      // to interpolate smoothly. Aircraft will "spawn in" once they have enough data.
      if (timeline.observationCount < 2) {
        continue
      }

      activeCallsigns.add(callsign)

      // Convert timeline result to InterpolatedAircraftState
      const interpolated = timelineToInterpolatedState(
        timeline,
        now,
        orientationEnabled,
        orientationIntensity
      )

      // Reuse existing entry or create new one
      const existing = statesMap.get(callsign)
      if (existing) {
        // Update in place to avoid object allocation
        existing.callsign = interpolated.callsign
        existing.interpolatedLatitude = interpolated.interpolatedLatitude
        existing.interpolatedLongitude = interpolated.interpolatedLongitude
        existing.interpolatedAltitude = interpolated.interpolatedAltitude
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
      } else {
        statesMap.set(callsign, interpolated)
      }
    }

    // Update frame timestamp for rate calculations
    sharedTimelineLastFrameTimeRef.current = now
  }

  // ============================================================================
  // TERRAIN CORRECTION AND FLARE PITCH (applies to ALL aircraft)
  // ============================================================================

  for (const callsign of activeCallsigns) {
    // Apply terrain correction to aircraft altitude
    // This ensures consistent height across all rendering (models, labels, etc.)
    const entry = statesMap.get(callsign)
    if (!entry) continue // Safety check
    const heightAboveEllipsoid = entry.interpolatedAltitude // VATSIM altitude in meters MSL
    const terrainOffset = sharedTerrainOffsetRef.current
    const groundElevationMeters = sharedGroundElevationMetersRef.current
    const groundAircraftTerrain = sharedGroundAircraftTerrainRef.current

    // Get or create consolidated terrain state for this aircraft
    let terrainState = sharedTerrainStateRef.current.get(callsign)
    if (!terrainState) {
      terrainState = {
        smoothedTerrainHeight: 0,
        prevClampState: false,
        transition: null,
        prevCorrectedHeight: entry.interpolatedAltitude
      }
      sharedTerrainStateRef.current.set(callsign, terrainState)
    }

    // Calculate heights in ellipsoid coordinates for comparison
    const reportedEllipsoidHeight = heightAboveEllipsoid + terrainOffset
    const sampledTerrainHeight = groundAircraftTerrain.get(callsign)

    // Calculate altitude above ground level (AGL) for ground detection
    // Use terrain sample if available, otherwise use airport elevation
    const altitudeAGL = sampledTerrainHeight !== undefined
      ? reportedEllipsoidHeight - sampledTerrainHeight
      : heightAboveEllipsoid - groundElevationMeters

    // Determine if aircraft is on ground using BOTH speed and altitude:
    // - Low speed (< 5 kts): definitely on ground (handles altitude/terrain mismatch)
    // - Low altitude AGL (< 10m): also on ground (handles fast takeoff/landing roll)
    const isLowSpeed = entry.interpolatedGroundspeed < 5
    const isLowAltitude = altitudeAGL < 10
    const isOnGround = isLowSpeed || isLowAltitude

    // Determine if we should clamp to terrain:
    // 1. Altitude AGL is low (definitely on ground), OR
    // 2. Terrain sample exists AND is higher than reported altitude (prevents going underground)
    let shouldClampToTerrain = false
    if (sampledTerrainHeight !== undefined) {
      const terrainEllipsoidHeight = sampledTerrainHeight + GROUND_AIRCRAFT_TERRAIN_OFFSET
      shouldClampToTerrain = isOnGround || (terrainEllipsoidHeight > reportedEllipsoidHeight)
    } else {
      shouldClampToTerrain = isOnGround
    }

    let targetHeight: number

    if (shouldClampToTerrain && sampledTerrainHeight !== undefined) {
      // Clamp to terrain: use terrain-sampled height (smoothed for consistency)
      // Initialize smoothed height if this is the first terrain sample
      if (terrainState.smoothedTerrainHeight === 0) {
        terrainState.smoothedTerrainHeight = sampledTerrainHeight
      }
      terrainState.smoothedTerrainHeight += (sampledTerrainHeight - terrainState.smoothedTerrainHeight) * TERRAIN_SMOOTHING_LERP_FACTOR

      // Target height: smoothed terrain + offset
      targetHeight = terrainState.smoothedTerrainHeight + GROUND_AIRCRAFT_TERRAIN_OFFSET
    } else if (isOnGround) {
      // Low groundspeed but no terrain sample - use fallback
      const groundEllipsoidHeight = groundElevationMeters + terrainOffset
      targetHeight = Math.max(reportedEllipsoidHeight, groundEllipsoidHeight) + GROUND_AIRCRAFT_TERRAIN_OFFSET
    } else {
      // Moving fast (>= 40 kts) but not necessarily airborne yet
      // Scale the flying offset based on actual altitude above ground
      // This prevents the 5m jump when aircraft is still on the runway during takeoff roll
      let flyingOffset = FLYING_AIRCRAFT_TERRAIN_OFFSET
      if (sampledTerrainHeight !== undefined) {
        const altitudeAGLCalc = reportedEllipsoidHeight - sampledTerrainHeight
        // Gradually increase offset from 0.1m (ground) to 5m (fully airborne at 30m AGL)
        // This creates a smooth visual transition during takeoff/landing
        const transitionProgress = Math.min(1.0, Math.max(0, altitudeAGLCalc / 30))
        flyingOffset = GROUND_AIRCRAFT_TERRAIN_OFFSET +
          (FLYING_AIRCRAFT_TERRAIN_OFFSET - GROUND_AIRCRAFT_TERRAIN_OFFSET) * transitionProgress
      }
      targetHeight = reportedEllipsoidHeight + flyingOffset

      // Reset smoothed terrain height for aircraft that are truly airborne
      if (sampledTerrainHeight !== undefined) {
        const altitudeAGLCalc = reportedEllipsoidHeight - sampledTerrainHeight
        if (altitudeAGLCalc > 50) {
          // Only reset once truly airborne (50m+ AGL)
          terrainState.smoothedTerrainHeight = 0
        }
      } else {
        terrainState.smoothedTerrainHeight = 0
      }
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
          sourceHeight = terrainState.transition.source +
            (terrainState.transition.target - terrainState.transition.source) * terrainState.transition.progress
        } else {
          // New transition: use previous frame's corrected height
          sourceHeight = terrainState.prevCorrectedHeight
        }
        terrainState.transition = {
          source: sourceHeight,
          target: targetHeight,
          progress: 0
        }
      }
    }

    // Apply ongoing transition if exists
    if (terrainState.transition && terrainState.transition.progress < 1.0) {
      // Lerp from source to target over ~15 frames (~0.25 seconds at 60fps)
      // Slower transition for smoother landing appearance
      terrainState.transition.progress = Math.min(1.0, terrainState.transition.progress + HEIGHT_TRANSITION_LERP_FACTOR)
      correctedHeight = terrainState.transition.source + (terrainState.transition.target - terrainState.transition.source) * terrainState.transition.progress

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

    // Apply corrected height to interpolated altitude
    entry.interpolatedAltitude = correctedHeight

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
          lastFlarePitch: null
        }
        sharedNosewheelStateRef.current.set(callsign, nosewheelState)
      }

      // Calculate altitude above ground level (AGL)
      // Use reported altitude (not corrected) since terrain height is in ellipsoid coords
      const altitudeAGLFlare = reportedEllipsoidHeight - sampledTerrainHeight

      // Determine if aircraft is currently in flare conditions BEFORE applying flare
      // This allows us to capture the actual flare pitch when aircraft is in flare
      const isDescending = entry.verticalRate < -50  // m/min
      const inFlareZone = altitudeAGLFlare > 0 && altitudeAGLFlare < 15  // meters
      // Note: inFlareZone already requires altitudeAGL > 0 (airborne), no speed check needed
      const isInFlare = isDescending && inFlareZone

      // Get the base pitch (without flare) for reference
      const basePitch = entry.interpolatedPitch

      // Apply flare pitch calculation
      entry.interpolatedPitch = calculateFlarePitch(
        entry.interpolatedPitch,
        altitudeAGLFlare,
        entry.verticalRate,  // Already in m/min
        entry.interpolatedGroundspeed,
        orientationIntensity
      )

      // If currently in flare, store the actual flare pitch for nosewheel transition
      if (isInFlare) {
        nosewheelState.lastFlarePitch = entry.interpolatedPitch
      }

      // Track flare state for nosewheel lowering transition
      if (nosewheelState.wasInFlare && !isInFlare && !nosewheelState.transition) {
        // Just exited flare! Start nosewheel lowering transition
        // Use the stored flare pitch from when we were actually in flare
        const lastFlarePitch = nosewheelState.lastFlarePitch ?? (basePitch + FALLBACK_FLARE_PITCH_DEGREES)
        nosewheelState.transition = {
          sourcePitch: lastFlarePitch,
          progress: 0
        }
        // Clean up stored flare pitch
        nosewheelState.lastFlarePitch = null
      }

      // Apply ongoing nosewheel lowering transition
      if (nosewheelState.transition && nosewheelState.transition.progress < 1.0) {
        // Gradually lower nose over ~1 second at 60fps (~60 frames)
        // smoothstep easing for natural deceleration
        nosewheelState.transition.progress = Math.min(1.0, nosewheelState.transition.progress + NOSEWHEEL_LOWERING_LERP_FACTOR)

        // smoothstep: x^2 * (3 - 2x) for smooth acceleration/deceleration
        const easedProgress = nosewheelState.transition.progress * nosewheelState.transition.progress * (3 - 2 * nosewheelState.transition.progress)

        // Blend from flare pitch to level (0 degrees)
        // Using 0 as target instead of basePitch prevents oscillation from noisy
        // vertical rate data during rollout (terrain samples at 3Hz cause spikes)
        entry.interpolatedPitch = nosewheelState.transition.sourcePitch * (1 - easedProgress)

        // Clean up completed transitions
        if (nosewheelState.transition.progress >= 1.0) {
          nosewheelState.transition = null
        }
      }

      // Update flare state for next frame
      nosewheelState.wasInFlare = isInFlare
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
    }
  }

  // Trigger React re-render for subscribers when aircraft count changes
  const currentCount = statesMap.size
  if (currentCount !== sharedLastAircraftCountRef.current) {
    sharedLastAircraftCountRef.current = currentCount
    subscribers.forEach(callback => callback())
  }

  performanceMonitor.endTimer('interpolation')

  // Schedule next frame
  animationFrameId = requestAnimationFrame(updateInterpolation)
}

/**
 * Inject terrain correction data into the interpolation system
 *
 * This function allows the rendering layer to provide terrain data that will be
 * used for ground aircraft altitude correction during interpolation.
 *
 * @param groundAircraftTerrain - Map of terrain heights (ellipsoid) sampled at 3Hz
 * @param terrainOffset - Geoid offset for MSL → ellipsoid conversion
 * @param groundElevationMeters - Ground elevation at tower/reference position
 */
export function setInterpolationTerrainData(
  groundAircraftTerrain: Map<string, number>,
  terrainOffset: number,
  groundElevationMeters: number
) {
  sharedGroundAircraftTerrainRef.current = groundAircraftTerrain
  sharedTerrainOffsetRef.current = terrainOffset
  sharedGroundElevationMetersRef.current = groundElevationMeters
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

    // Subscribe to settings for orientation emulation
    const unsubscribeSettings = useSettingsStore.subscribe((state) => {
      sharedOrientationEnabledRef.current = state.aircraft.orientationEmulation
      sharedOrientationIntensityRef.current = state.aircraft.orientationIntensity
    })

    // Initialize settings refs
    const settingsState = useSettingsStore.getState()
    sharedOrientationEnabledRef.current = settingsState.aircraft.orientationEmulation
    sharedOrientationIntensityRef.current = settingsState.aircraft.orientationIntensity

    // Note: We no longer subscribe to vatsimStore here because the animation loop
    // now calls getAircraftDataSource() each frame, which reads directly from
    // the appropriate store (vatsimStore for live, replayStore for replay).
    // This eliminates the 60Hz store subscription issue during replay.

    // Subscribe this component to updates (for React re-renders when aircraft count changes)
    const updateCallback = () => setVersion(v => v + 1)
    subscribers.add(updateCallback)

    return () => {
      hookInstanceCount--
      unsubscribeSettings()
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
  useEffect(() => {
    if (!animationLoopRunning) {
      animationLoopRunning = true
      animationFrameId = requestAnimationFrame(updateInterpolation)
    }
  }, [])

  return sharedInterpolatedStates
}

export default useAircraftInterpolation
