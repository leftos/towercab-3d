// ENU (East-North-Up) coordinate transformation utilities
// Used for synchronizing Babylon.js camera with Cesium camera

import * as Cesium from 'cesium'
import * as BABYLON from '@babylonjs/core'

/**
 * Result of setting up ENU transforms for a base position
 */
export interface EnuTransformData {
  baseCartesian: Cesium.Cartesian3
  enuToFixed: Cesium.Matrix4
  fixedToEnu: Cesium.Matrix4
  basePoint: BABYLON.Vector3
  basePointUp: BABYLON.Vector3
}

/**
 * Setup ENU (East-North-Up) transformation matrices for a given geographic location.
 * These matrices allow converting between:
 * - ECEF (Earth-Centered, Earth-Fixed) - global Cartesian coordinates
 * - ENU (East-North-Up) - local Cartesian coordinates relative to the base point
 *
 * @param lat - Latitude in degrees
 * @param lon - Longitude in degrees
 * @param height - Height in meters above ellipsoid
 */
export function setupEnuTransforms(lat: number, lon: number, height: number): EnuTransformData {
  // Calculate base point in ECEF coordinates
  const baseCartesian = Cesium.Cartesian3.fromDegrees(lon, lat, height)
  const baseCartUp = Cesium.Cartesian3.fromDegrees(lon, lat, height + 1000)

  // Calculate the ENU (East-North-Up) to Fixed (ECEF) transformation matrix
  // This allows us to convert local ENU coordinates to ECEF
  const enuToFixed = Cesium.Transforms.eastNorthUpToFixedFrame(baseCartesian)

  // Calculate the inverse (Fixed to ENU) for converting ECEF positions to local ENU
  const fixedToEnu = Cesium.Matrix4.inverse(enuToFixed, new Cesium.Matrix4())

  // Convert base points to Babylon coordinate system
  const basePoint = cesiumToBabylon(baseCartesian)
  const basePointUp = cesiumToBabylon(baseCartUp)

  return {
    baseCartesian,
    enuToFixed,
    fixedToEnu,
    basePoint,
    basePointUp
  }
}

/**
 * Convert a Cesium Cartesian3 to a Babylon Vector3.
 * Swaps Y and Z axes to convert from Cesium's coordinate system to Babylon's.
 * Cesium: X=East, Y=North, Z=Up (when in local ENU)
 * Babylon: X=East, Y=Up, Z=North
 */
export function cesiumToBabylon(cart: Cesium.Cartesian3 | { x: number; y: number; z: number }): BABYLON.Vector3 {
  return new BABYLON.Vector3(cart.x, cart.z, cart.y)
}

/**
 * Transform a point from ECEF (Earth-Centered, Earth-Fixed) to ENU (East-North-Up) coordinates
 *
 * @param position - Position in ECEF coordinates
 * @param fixedToEnu - The fixed-to-ENU transformation matrix
 * @returns Position in ENU coordinates
 */
export function ecefToEnu(position: Cesium.Cartesian3, fixedToEnu: Cesium.Matrix4): Cesium.Cartesian3 {
  return Cesium.Matrix4.multiplyByPoint(fixedToEnu, position, new Cesium.Cartesian3())
}

/**
 * Transform a direction vector from ECEF to ENU coordinates
 * Unlike points, direction vectors don't get translated, only rotated
 *
 * @param direction - Direction vector in ECEF coordinates
 * @param fixedToEnu - The fixed-to-ENU transformation matrix
 * @returns Direction vector in ENU coordinates
 */
export function ecefToEnuDirection(direction: Cesium.Cartesian3, fixedToEnu: Cesium.Matrix4): Cesium.Cartesian3 {
  return Cesium.Matrix4.multiplyByPointAsVector(fixedToEnu, direction, new Cesium.Cartesian3())
}

/**
 * Convert ENU coordinates to Babylon coordinates and return as Vector3
 * ENU: X=East, Y=North, Z=Up
 * Babylon: X=East, Y=Up, Z=North
 *
 * @param enu - Position in ENU coordinates
 */
export function enuToBabylonPosition(enu: Cesium.Cartesian3): BABYLON.Vector3 {
  return new BABYLON.Vector3(enu.x, enu.z, enu.y)
}

/**
 * Convert a geographic position to local ENU offset relative to a base position
 * Uses simple Euclidean approximation (accurate for short distances)
 *
 * @param baseLat - Base latitude in degrees
 * @param baseLon - Base longitude in degrees
 * @param targetLat - Target latitude in degrees
 * @param targetLon - Target longitude in degrees
 * @param heading - Optional heading rotation in degrees (0 = north)
 * @returns Offset in meters: { x: east offset, z: north offset }
 */
export function latLonToEnuOffset(
  baseLat: number,
  baseLon: number,
  targetLat: number,
  targetLon: number,
  heading: number = 0
): { x: number; z: number } {
  const METERS_PER_DEGREE_LAT = 111111

  const latDiff = targetLat - baseLat
  const lonDiff = targetLon - baseLon

  // Convert to meters
  const northOffset = latDiff * METERS_PER_DEGREE_LAT
  const eastOffset = lonDiff * METERS_PER_DEGREE_LAT * Math.cos(baseLat * Math.PI / 180)

  // Apply heading rotation if specified
  if (heading !== 0) {
    const headingRad = heading * Math.PI / 180
    const cosH = Math.cos(headingRad)
    const sinH = Math.sin(headingRad)
    return {
      x: eastOffset * cosH - northOffset * sinH,
      z: eastOffset * sinH + northOffset * cosH
    }
  }

  return { x: eastOffset, z: northOffset }
}

/**
 * Calculate Babylon camera rotation from direction and up vectors
 * Returns Euler angles in radians: { rotationX, rotationY, rotationZ }
 *
 * @param direction - Camera direction in Babylon coordinates (normalized)
 * @param up - Camera up vector in Babylon coordinates (normalized)
 */
export function calculateBabylonCameraRotation(
  direction: BABYLON.Vector3,
  up: BABYLON.Vector3
): { rotationX: number; rotationY: number; rotationZ: number } {
  const forward = direction.normalize()

  // Yaw: rotation around Y axis (heading)
  const rotationY = Math.atan2(forward.x, forward.z)

  // Pitch: rotation around X axis (looking up/down)
  const rotationX = -Math.asin(Math.max(-1, Math.min(1, forward.y)))

  // Roll: rotation around Z axis
  const cosY = Math.cos(rotationY)
  const sinY = Math.sin(rotationY)
  const cosX = Math.cos(rotationX)
  const sinX = Math.sin(rotationX)

  // Expected right vector after yaw
  const rightAfterYaw = new BABYLON.Vector3(cosY, 0, -sinY)
  // Expected up after yaw and pitch
  const upAfterYawPitch = new BABYLON.Vector3(
    sinY * sinX,
    cosX,
    cosY * sinX
  )

  // Project actual up onto the plane perpendicular to forward
  const upNormalized = up.normalize()
  const upInPlane = upNormalized.subtract(forward.scale(BABYLON.Vector3.Dot(upNormalized, forward)))
  const upInPlaneLen = upInPlane.length()

  let rotationZ = 0
  if (upInPlaneLen > 0.001) {
    upInPlane.scaleInPlace(1 / upInPlaneLen)
    const dotUp = BABYLON.Vector3.Dot(upAfterYawPitch, upInPlane)
    const dotRight = BABYLON.Vector3.Dot(rightAfterYaw, upInPlane)
    rotationZ = Math.atan2(dotRight, dotUp)
  }

  return { rotationX, rotationY, rotationZ }
}

/**
 * Full camera sync data for Babylon camera from Cesium camera
 */
export interface BabylonCameraSyncData {
  position: BABYLON.Vector3
  rotation: { rotationX: number; rotationY: number; rotationZ: number }
  fov: number
}

/**
 * Calculate Babylon camera sync data from Cesium viewer
 * This is the main function used to sync Babylon camera with Cesium camera in 3D mode
 *
 * @param cesiumViewer - The Cesium viewer
 * @param fixedToEnu - The fixed-to-ENU transformation matrix
 * @returns Camera sync data or null if prerequisites are missing
 */
export function calculateBabylonCameraSync(
  cesiumViewer: Cesium.Viewer,
  fixedToEnu: Cesium.Matrix4
): BabylonCameraSyncData | null {
  const frustum = cesiumViewer.camera.frustum
  let fov = Math.PI / 4 // Default 45 degrees
  if (frustum instanceof Cesium.PerspectiveFrustum && frustum.fovy !== undefined) {
    fov = frustum.fovy
  }

  // Get camera position in ECEF and transform to local ENU
  const cesiumCamPos = cesiumViewer.camera.positionWC
  const camEnu = ecefToEnu(cesiumCamPos, fixedToEnu)

  // Transform camera direction and up from ECEF to ENU
  const dirEnu = ecefToEnuDirection(cesiumViewer.camera.direction, fixedToEnu)
  const upEnu = ecefToEnuDirection(cesiumViewer.camera.up, fixedToEnu)

  // Convert to Babylon coordinate system
  const position = enuToBabylonPosition(camEnu)
  const dirBabylon = new BABYLON.Vector3(dirEnu.x, dirEnu.z, dirEnu.y)
  const upBabylon = new BABYLON.Vector3(upEnu.x, upEnu.z, upEnu.y)

  // Calculate rotation from direction and up vectors
  const rotation = calculateBabylonCameraRotation(dirBabylon, upBabylon)

  return { position, rotation, fov }
}
