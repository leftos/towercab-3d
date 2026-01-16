import { useState, useEffect } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { useReplayStore } from '../stores/replayStore'
import { useAircraftTimelineStore } from '../stores/aircraftTimelineStore'
import { useVatsimStore } from '../stores/vatsimStore'
import { getAircraftDataSource } from './useAircraftDataSource'
import { calculateFlarePitch, angleDifference, calculateDistanceNM } from '../utils/interpolation'
import { performanceMonitor } from '../utils/performanceMonitor'
import { geoidService } from '../services/GeoidService'
import type { InterpolatedAircraftState } from '../types/vatsim'
import type { TimelineInterpolationResult } from '../types/aircraft-timeline'
import type { TerrainData } from './useGroundAircraftTerrain'
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
  MAX_ROLL_RATE_DEG_PER_SEC,
  MAX_HEADING_RATE_DEG_PER_SEC_AIR,
  MAX_HEADING_RATE_DEG_PER_SEC_GROUND,
  LANDING_BLEND_START_AGL,
  LANDING_BLEND_END_AGL,
  LANDING_BLEND_DESCENT_RATE,
  DEPARTURE_BLEND_START_AGL,
  DEPARTURE_BLEND_END_AGL
} from '../constants/rendering'

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
  smoothedAcceleration: number
  prevPitch: number | null
  prevRoll: number | null
  smoothedHeading: number | null  // Rate-limited heading for smooth yaw
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
      smoothedAcceleration: 0,
      prevPitch: null,
      prevRoll: null,
      smoothedHeading: null
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
    // Apply smoothing to reduce noise from GPS jitter, especially important for
    // vNAS where groundspeed is calculated from position changes
    if (rateState.prevGroundspeed !== null) {
      const speedChange = timeline.groundspeed - rateState.prevGroundspeed
      const rawAcceleration = (speedChange / frameDelta) * 1000 // knots/sec
      // Clamp to realistic limits (jets rarely exceed 5 kts/s acceleration)
      const clampedAcceleration = Math.max(-10, Math.min(10, rawAcceleration))
      acceleration = rateState.smoothedAcceleration + (clampedAcceleration - rateState.smoothedAcceleration) * RATE_SMOOTHING
      rateState.smoothedAcceleration = acceleration
    }
  }

  // Store current values for next frame
  rateState.prevAltitude = timeline.altitude
  rateState.prevHeading = timeline.heading
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

  // ============================================================================
  // HEADING RATE LIMITING
  // ============================================================================
  // Apply rate limiting to heading to smooth out noisy yaw from 1Hz vNAS data.
  // This prevents jerky heading changes while preserving realistic turn behavior.
  // Ground aircraft get higher rate limit since they can pivot faster during taxi.

  let smoothedHeading = timeline.heading

  if (frameDelta > 0 && frameDelta < 100) {
    const targetHeading = timeline.heading
    const prevSmoothedHeading = rateState.smoothedHeading ?? targetHeading

    // Determine rate limit based on ground/air state
    const isOnGround = timeline.onGround === true || timeline.groundspeed < 40
    const maxHeadingRate = isOnGround
      ? MAX_HEADING_RATE_DEG_PER_SEC_GROUND
      : MAX_HEADING_RATE_DEG_PER_SEC_AIR

    const dtSeconds = frameDelta / 1000
    const maxHeadingChange = maxHeadingRate * dtSeconds

    // Calculate heading delta with wraparound handling (shortest path)
    let headingDelta = targetHeading - prevSmoothedHeading
    if (headingDelta > 180) headingDelta -= 360
    if (headingDelta < -180) headingDelta += 360

    // Apply rate limiting
    if (Math.abs(headingDelta) > maxHeadingChange) {
      smoothedHeading = prevSmoothedHeading + Math.sign(headingDelta) * maxHeadingChange
    } else {
      smoothedHeading = targetHeading
    }

    // Normalize to 0-360
    smoothedHeading = ((smoothedHeading % 360) + 360) % 360

    // Store for next frame
    rateState.smoothedHeading = smoothedHeading
  }

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

    isInterpolated: true
  }
}

// Singleton animation loop function
function updateInterpolation() {
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

  {

    for (const [callsign, timeline] of timelineStates) {
      // Skip aircraft with fewer than 2 observations - we need at least 2 data points
      // to interpolate smoothly. Aircraft will "spawn in" once they have enough data.
      if (timeline.observationCount < 2) {
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
        timeline.longitude
      )
      if (distance > aircraftDataRadiusNM) {
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
        prevCorrectedHeight: entry.interpolatedAltitude
      }
      sharedTerrainStateRef.current.set(callsign, terrainState)
    }

    // Get terrain data - sampledTerrainHeight is in ellipsoidal coordinates (from Cesium)
    const terrainDataForAircraft = groundAircraftTerrain.get(callsign)
    const sampledTerrainHeight = terrainDataForAircraft?.height
    const terrainSlopeDegrees = terrainDataForAircraft?.slopeDegrees ?? 0

    // Calculate altitude above ground level (AGL) for ground detection
    // Use terrain sample if available, otherwise convert MSL ground elevation to ellipsoidal
    const altitudeAGL = sampledTerrainHeight !== undefined
      ? reportedEllipsoidHeight - sampledTerrainHeight
      : reportedEllipsoidHeight - geoidService.mslToEllipsoidal(entry.interpolatedLatitude, entry.interpolatedLongitude, groundElevationMetersMsl)

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
      terrainState.smoothedTerrainHeight += (sampledTerrainHeight - terrainState.smoothedTerrainHeight) * TERRAIN_SMOOTHING_LERP_FACTOR
      terrainClampedHeight = terrainState.smoothedTerrainHeight + GROUND_AIRCRAFT_TERRAIN_OFFSET
    } else {
      // Fallback: use MSL ground elevation
      const groundEllipsoidHeight = geoidService.mslToEllipsoidal(entry.interpolatedLatitude, entry.interpolatedLongitude, groundElevationMetersMsl)
      terrainClampedHeight = groundEllipsoidHeight + GROUND_AIRCRAFT_TERRAIN_OFFSET
    }

    // Calculate flying height with progressive offset (0.1m at ground → 5m at 30m AGL)
    let flyingOffset = FLYING_AIRCRAFT_TERRAIN_OFFSET
    if (sampledTerrainHeight !== undefined) {
      const transitionProgress = Math.min(1.0, Math.max(0, altitudeAGL / 30))
      flyingOffset = GROUND_AIRCRAFT_TERRAIN_OFFSET +
        (FLYING_AIRCRAFT_TERRAIN_OFFSET - GROUND_AIRCRAFT_TERRAIN_OFFSET) * transitionProgress
    }
    const reportedHeightWithOffset = reportedEllipsoidHeight + flyingOffset

    // Determine ground blend weight (0 = fully airborne/reported, 1 = fully on terrain)
    let groundBlendWeight: number
    const isLowSpeed = entry.interpolatedGroundspeed < 5

    if (isLowSpeed) {
      // Very low speed = definitely on ground, full terrain clamping
      groundBlendWeight = 1.0
    } else if (sampledTerrainHeight !== undefined && terrainClampedHeight > reportedHeightWithOffset) {
      // Terrain higher than reported = prevent going underground
      groundBlendWeight = 1.0
    } else if (verticalRate < LANDING_BLEND_DESCENT_RATE && altitudeAGL < LANDING_BLEND_START_AGL) {
      // LANDING: Aircraft is descending and low - blend toward terrain
      // At LANDING_BLEND_START_AGL (50m): start blending (weight = 0)
      // At LANDING_BLEND_END_AGL (10m): full ground (weight = 1)
      const blendRange = LANDING_BLEND_START_AGL - LANDING_BLEND_END_AGL
      groundBlendWeight = Math.min(1.0, Math.max(0, (LANDING_BLEND_START_AGL - altitudeAGL) / blendRange))
    } else if (altitudeAGL > 0 && altitudeAGL < DEPARTURE_BLEND_END_AGL) {
      // DEPARTURE: Low altitude, possibly lifting off - blend toward reported
      // At DEPARTURE_BLEND_START_AGL (5m): full ground (weight = 1)
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
 * used for ground aircraft altitude and pitch correction during interpolation.
 *
 * @param groundAircraftTerrain - Map of terrain data (height and slope) sampled at 10Hz
 * @param groundElevationMetersMsl - Ground elevation at tower/reference position in MSL meters (fallback only)
 */
export function setInterpolationTerrainData(
  groundAircraftTerrain: Map<string, TerrainData>,
  groundElevationMetersMsl: number
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
    const updateCallback = () => setVersion(v => v + 1)
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
