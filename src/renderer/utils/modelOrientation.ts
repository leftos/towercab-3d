/**
 * One orientation convention for every glTF model drawn in Cesium: aircraft and the tower cab.
 *
 * Cesium loads a glTF with `forwardAxis` X (its default), so after the Y-up to Z-up turn the
 * model's glTF +X axis lies along the model frame's +X. `headingPitchRollToFixedFrame` points that
 * axis east at heading 0 and turns it clockwise as the heading grows, so a model whose glTF +X is
 * its front faces compass bearing `c` at heading `c - 90`.
 */

import * as Cesium from 'cesium'

/**
 * Aircraft models are turned 180 degrees on top of their own rotation offset: built-in and mod
 * aircraft without an offset have their nose on glTF -X, FSLTL/AIG conversions declare 180.
 */
const AIRCRAFT_DEFAULT_OFFSET_DEG = 180

/**
 * Cesium heading-pitch-roll heading that points a model's glTF +X along a compass bearing.
 *
 * @param compassDeg - Bearing in degrees clockwise from north
 * @param offsetDeg - Extra clockwise turn in degrees for models whose front is not glTF +X
 * @returns Heading in radians for `Cesium.HeadingPitchRoll`
 */
export function compassToModelHeading(compassDeg: number, offsetDeg: number): number {
  return Cesium.Math.toRadians(compassDeg - 90 + offsetDeg)
}

/**
 * Heading for an aircraft model flying a compass heading.
 *
 * @param headingDeg - Aircraft heading in degrees clockwise from north
 * @param rotationOffsetDeg - The model's own yaw offset in degrees (0 when it declares none)
 * @returns Heading in radians for `Cesium.HeadingPitchRoll`
 */
export function aircraftModelHeading(headingDeg: number, rotationOffsetDeg: number): number {
  return compassToModelHeading(headingDeg, AIRCRAFT_DEFAULT_OFFSET_DEG + rotationOffsetDeg)
}

/**
 * Model matrix of a tower cab: placed at a position, its glTF +X turned to the manifest
 * rotation (degrees clockwise from north, 0 = north), uniformly scaled.
 *
 * @param lon - Longitude in degrees
 * @param lat - Latitude in degrees
 * @param height - Height of the model origin in meters above the ellipsoid
 * @param rotationDeg - Manifest rotation in degrees clockwise from north
 * @param scale - Uniform scale factor
 * @returns The model matrix
 */
export function towerModelMatrix(
  lon: number,
  lat: number,
  height: number,
  rotationDeg: number,
  scale: number,
): Cesium.Matrix4 {
  const position = Cesium.Cartesian3.fromDegrees(lon, lat, height)
  const hpr = new Cesium.HeadingPitchRoll(compassToModelHeading(rotationDeg, 0), 0, 0)
  const modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(position, hpr)
  if (scale !== 1.0) {
    Cesium.Matrix4.multiply(modelMatrix, Cesium.Matrix4.fromUniformScale(scale), modelMatrix)
  }
  return modelMatrix
}
