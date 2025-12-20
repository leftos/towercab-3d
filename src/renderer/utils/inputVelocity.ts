// Input velocity utilities for smooth keyboard/mouse controls

/**
 * State for velocity-based smooth movement
 */
export interface VelocityState {
  forward: number
  right: number
  up: number
  heading: number
  pitch: number
  zoom: number
  orbitHeading: number
  orbitPitch: number
  orbitDistance: number
  altitude: number
}

/**
 * Create initial velocity state with all values at zero
 */
export function createVelocityState(): VelocityState {
  return {
    forward: 0,
    right: 0,
    up: 0,
    heading: 0,
    pitch: 0,
    zoom: 0,
    orbitHeading: 0,
    orbitPitch: 0,
    orbitDistance: 0,
    altitude: 0
  }
}

/**
 * Default movement configuration constants
 */
export const MOVEMENT_CONFIG = {
  ACCELERATION: 8.0,       // How fast velocity builds up (per second)
  DECELERATION: 6.0,       // How fast velocity decays (per second)
  MAX_MOVE_SPEED: 60,      // Max movement speed (meters per second)
  MAX_ROTATE_SPEED: 90,    // Max rotation speed (degrees per second)
  MAX_ZOOM_SPEED: 30,      // Max FOV change speed (degrees per second)
  MAX_ALTITUDE_SPEED: 1500, // Max altitude change speed (meters per second)
  MAX_ORBIT_DIST_SPEED: 500, // Max orbit distance change speed (meters per second)
  WHEEL_IMPULSE_STRENGTH: 80, // How much velocity each unit of wheel adds
  VELOCITY_THRESHOLD: 0.01  // Minimum velocity to apply
} as const

/**
 * Smoothly interpolate a velocity value toward a target
 * Uses acceleration when moving toward target, deceleration when returning to zero
 *
 * @param current - Current velocity value
 * @param target - Target direction (-1, 0, or 1)
 * @param maxSpeed - Maximum speed for this velocity channel
 * @param dt - Delta time in seconds
 * @param acceleration - Acceleration rate (default from MOVEMENT_CONFIG)
 * @param deceleration - Deceleration rate (default from MOVEMENT_CONFIG)
 */
export function accelerateVelocity(
  current: number,
  target: number,
  maxSpeed: number,
  dt: number,
  acceleration: number = MOVEMENT_CONFIG.ACCELERATION,
  deceleration: number = MOVEMENT_CONFIG.DECELERATION
): number {
  const targetVel = target * maxSpeed

  if (Math.abs(targetVel) > 0.001) {
    // Accelerating toward target
    const diff = targetVel - current
    const change = Math.sign(diff) * acceleration * maxSpeed * dt
    if (Math.abs(change) > Math.abs(diff)) {
      return targetVel
    }
    return current + change
  } else {
    // Decelerating to zero
    const change = deceleration * maxSpeed * dt
    if (Math.abs(current) < change) {
      return 0
    }
    return current - Math.sign(current) * change
  }
}

/**
 * Calculate effective movement speed based on altitude and sprint modifier
 */
export function calculateEffectiveMoveSpeed(
  baseSpeed: number,
  isTopDown: boolean,
  topdownAltitude: number,
  sprintMultiplier: number = 1,
  referenceAltitude: number = 2000
): number {
  const altitudeScale = isTopDown ? topdownAltitude / referenceAltitude : 1
  return baseSpeed * altitudeScale * sprintMultiplier
}

/**
 * Keys that trigger continuous movement (mapped to velocity channels)
 */
export const MOVEMENT_KEYS = new Set([
  'w', 'W', 's', 'S', 'a', 'A', 'd', 'D',
  'q', 'Q', 'e', 'E',  // Up/down movement
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  '+', '=', '-', '_',
  'Shift'  // Sprint modifier
])

export interface TargetVelocities {
  forward: number
  right: number
  up: number
  heading: number
  pitch: number
  zoom: number
  orbitHeading: number
  orbitPitch: number
  orbitDistance: number
  altitude: number
}

/**
 * Calculate target velocities based on pressed keys and current mode
 */
export function calculateTargetVelocities(
  pressedKeys: Set<string>,
  viewMode: '3d' | 'topdown',
  followingCallsign: string | null,
  followMode: 'tower' | 'orbit'
): TargetVelocities {
  let targetForward = 0
  let targetRight = 0
  let targetUp = 0
  let targetHeading = 0
  let targetPitch = 0
  let targetZoom = 0
  let targetOrbitHeading = 0
  let targetOrbitPitch = 0
  let targetOrbitDistance = 0
  let targetAltitude = 0

  // WASD movement
  if (pressedKeys.has('w')) targetForward = 1
  if (pressedKeys.has('s')) targetForward = -1
  if (pressedKeys.has('a')) targetRight = -1
  if (pressedKeys.has('d')) targetRight = 1

  // Q/E for vertical movement
  if (pressedKeys.has('e')) targetUp = 1
  if (pressedKeys.has('q')) targetUp = -1

  // Arrow keys - rotation or orbit control
  const inOrbitMode = followingCallsign !== null && followMode === 'orbit'
  if (pressedKeys.has('arrowleft')) {
    if (inOrbitMode) targetOrbitHeading = -1
    else targetHeading = -1
  }
  if (pressedKeys.has('arrowright')) {
    if (inOrbitMode) targetOrbitHeading = 1
    else targetHeading = 1
  }
  if (pressedKeys.has('arrowup')) {
    if (inOrbitMode) targetOrbitPitch = 1
    else targetPitch = 1
  }
  if (pressedKeys.has('arrowdown')) {
    if (inOrbitMode) targetOrbitPitch = -1
    else targetPitch = -1
  }

  // Zoom controls (+/-)
  const zoomIn = pressedKeys.has('+') || pressedKeys.has('=')
  const zoomOut = pressedKeys.has('-') || pressedKeys.has('_')
  if (zoomIn) {
    if (viewMode === 'topdown') targetAltitude = -1
    else if (inOrbitMode) targetOrbitDistance = -1
    else if (followingCallsign) targetZoom = 1  // Positive = zoom in (increase followZoom)
    else targetZoom = -1  // Negative = decrease FOV = zoom in
  }
  if (zoomOut) {
    if (viewMode === 'topdown') targetAltitude = 1
    else if (inOrbitMode) targetOrbitDistance = 1
    else if (followingCallsign) targetZoom = -1
    else targetZoom = 1
  }

  return {
    forward: targetForward,
    right: targetRight,
    up: targetUp,
    heading: targetHeading,
    pitch: targetPitch,
    zoom: targetZoom,
    orbitHeading: targetOrbitHeading,
    orbitPitch: targetOrbitPitch,
    orbitDistance: targetOrbitDistance,
    altitude: targetAltitude
  }
}

/**
 * Apply wheel impulse to velocity state
 * Returns the decayed wheel impulse value
 */
export function applyWheelImpulse(
  velocity: VelocityState,
  wheelImpulse: number,
  viewMode: '3d' | 'topdown',
  followingCallsign: string | null,
  followMode: 'tower' | 'orbit'
): number {
  if (Math.abs(wheelImpulse) <= 0.001) {
    return 0
  }

  const impulseAmount = wheelImpulse * MOVEMENT_CONFIG.WHEEL_IMPULSE_STRENGTH
  const inOrbitMode = followingCallsign !== null && followMode === 'orbit'

  if (viewMode === 'topdown') {
    velocity.altitude += impulseAmount * 3  // Scale up for altitude
  } else if (inOrbitMode) {
    velocity.orbitDistance += impulseAmount * 1.2
  } else if (followingCallsign) {
    velocity.zoom -= impulseAmount * 0.002  // Inverted and scaled for follow zoom
  } else {
    velocity.zoom += impulseAmount * 0.08
  }

  // Decay the impulse
  let decayedImpulse = wheelImpulse * 0.6
  if (Math.abs(decayedImpulse) < 0.01) {
    decayedImpulse = 0
  }

  return decayedImpulse
}

/**
 * Update all velocity channels based on targets
 */
export function updateVelocities(
  velocity: VelocityState,
  targets: TargetVelocities,
  dt: number,
  effectiveMoveSpeed: number
): void {
  velocity.forward = accelerateVelocity(velocity.forward, targets.forward, effectiveMoveSpeed, dt)
  velocity.right = accelerateVelocity(velocity.right, targets.right, effectiveMoveSpeed, dt)
  velocity.up = accelerateVelocity(velocity.up, targets.up, effectiveMoveSpeed, dt)
  velocity.heading = accelerateVelocity(velocity.heading, targets.heading, MOVEMENT_CONFIG.MAX_ROTATE_SPEED, dt)
  velocity.pitch = accelerateVelocity(velocity.pitch, targets.pitch, MOVEMENT_CONFIG.MAX_ROTATE_SPEED, dt)
  velocity.zoom = accelerateVelocity(velocity.zoom, targets.zoom, MOVEMENT_CONFIG.MAX_ZOOM_SPEED, dt)
  velocity.orbitHeading = accelerateVelocity(velocity.orbitHeading, targets.orbitHeading, MOVEMENT_CONFIG.MAX_ROTATE_SPEED, dt)
  velocity.orbitPitch = accelerateVelocity(velocity.orbitPitch, targets.orbitPitch, MOVEMENT_CONFIG.MAX_ROTATE_SPEED, dt)
  velocity.orbitDistance = accelerateVelocity(velocity.orbitDistance, targets.orbitDistance, MOVEMENT_CONFIG.MAX_ORBIT_DIST_SPEED, dt)
  velocity.altitude = accelerateVelocity(velocity.altitude, targets.altitude, MOVEMENT_CONFIG.MAX_ALTITUDE_SPEED, dt)
}
