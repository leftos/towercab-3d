import * as Cesium from 'cesium'
import { describe, expect, it } from 'vitest'
import { aircraftModelHeading, compassToModelHeading, towerModelMatrix } from './modelOrientation'

const LAT = 37.7213
const LON = -122.2208
const HEIGHT = 30

/** Bearing in degrees clockwise from north of a model-local axis, read from a model matrix. */
function axisBearing(modelMatrix: Cesium.Matrix4, localAxis: Cesium.Cartesian3): number {
  const origin = Cesium.Matrix4.getTranslation(modelMatrix, new Cesium.Cartesian3())
  const worldAxis = Cesium.Matrix4.multiplyByPointAsVector(modelMatrix, localAxis, new Cesium.Cartesian3())
  const enuToFixed = Cesium.Transforms.eastNorthUpToFixedFrame(origin)
  const fixedToEnu = Cesium.Matrix4.inverseTransformation(enuToFixed, new Cesium.Matrix4())
  const enu = Cesium.Matrix4.multiplyByPointAsVector(fixedToEnu, worldAxis, new Cesium.Cartesian3())
  const bearing = (Math.atan2(enu.x, enu.y) * 180) / Math.PI
  return (bearing + 360) % 360
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return Math.min(d, 360 - d)
}

describe('aircraftModelHeading', () => {
  it('is numerically the formula it replaced, for every rotation offset', () => {
    for (const offset of [0, 90, 180, 270]) {
      for (const heading of [0, 37.5, 90, 213.25, 359.9]) {
        const before = Cesium.Math.toRadians(heading - 90 + 180 + offset)
        expect(aircraftModelHeading(heading, offset)).toBeCloseTo(before, 12)
      }
    }
  })

  it('goes through the shared compass helper with the +180 default flip', () => {
    expect(aircraftModelHeading(123, 0)).toBeCloseTo(compassToModelHeading(123, 180), 12)
  })
})

describe('compassToModelHeading', () => {
  it('points glTF +X along the compass heading', () => {
    for (const compass of [0, 90, 180, 213, 300]) {
      const position = Cesium.Cartesian3.fromDegrees(LON, LAT, HEIGHT)
      const hpr = new Cesium.HeadingPitchRoll(compassToModelHeading(compass, 0), 0, 0)
      const m = Cesium.Transforms.headingPitchRollToFixedFrame(position, hpr)
      expect(angleDiff(axisBearing(m, Cesium.Cartesian3.UNIT_X), compass)).toBeLessThan(1e-6)
    }
  })
})

// The removed Babylon cab hook (useBabylonTowerModel), measured with Babylon's own math: at
// rotation 0 it put glTF +X north and glTF +Z east. It turned counter-clockwise as rotation grew
// (rotation 90 put +X west, 213 at bearing 147); the Cesium cab turns clockwise from north, as
// MODDING.md and the positioning wizard say, through the same helper as aircraft.
describe('towerModelMatrix', () => {
  it('faces the way the Babylon cab did at rotation 0: glTF +X north, +Z east', () => {
    const m = towerModelMatrix(LON, LAT, HEIGHT, 0, 1)
    expect(angleDiff(axisBearing(m, Cesium.Cartesian3.UNIT_X), 0)).toBeLessThan(1e-6)
    // Cesium turns glTF Y-up into Z-up inside the model, so glTF +Z is the model frame's -Y.
    const gltfZ = new Cesium.Cartesian3(0, -1, 0)
    expect(angleDiff(axisBearing(m, gltfZ), 90)).toBeLessThan(1e-6)
  })

  it('turns clockwise from north (deliberately unlike the old Babylon cab at rotations 90 and 213)', () => {
    for (const rotation of [90, 213]) {
      const m = towerModelMatrix(LON, LAT, HEIGHT, rotation, 1)
      expect(angleDiff(axisBearing(m, Cesium.Cartesian3.UNIT_X), rotation)).toBeLessThan(1e-6)
    }
  })

  it('uses the aircraft convention with no cab special case', () => {
    const rotation = 213
    const position = Cesium.Cartesian3.fromDegrees(LON, LAT, HEIGHT)
    const hpr = new Cesium.HeadingPitchRoll(compassToModelHeading(rotation, 0), 0, 0)
    const expected = Cesium.Transforms.headingPitchRollToFixedFrame(position, hpr)
    const actual = towerModelMatrix(LON, LAT, HEIGHT, rotation, 1)
    for (let i = 0; i < 16; i++) {
      expect(actual[i]).toBeCloseTo(expected[i], 6)
    }
  })

  it('scales uniformly and places the origin at the given height', () => {
    const m = towerModelMatrix(LON, LAT, HEIGHT, 0, 2)
    const xLength = Cesium.Cartesian3.magnitude(
      Cesium.Matrix4.multiplyByPointAsVector(m, Cesium.Cartesian3.UNIT_X, new Cesium.Cartesian3()),
    )
    expect(xLength).toBeCloseTo(2, 9)
    const origin = Cesium.Cartographic.fromCartesian(Cesium.Matrix4.getTranslation(m, new Cesium.Cartesian3()))
    expect(origin.height).toBeCloseTo(HEIGHT, 6)
  })
})
