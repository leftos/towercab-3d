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

// The Cesium cab follows the earlier Cesium cab hook: at manifest rotation 0 its glTF +X faces
// east, and it turns clockwise as the rotation grows (glTF +X bearing = rotation + 90, mod 360).
// Existing tower manifests, KOAK among them, were tuned against that convention.
describe('towerModelMatrix', () => {
  it('puts glTF +X east at rotation 0, as the earlier Cesium cab did (KOAK is centred on its shaft there)', () => {
    const m = towerModelMatrix(LON, LAT, HEIGHT, 0, 1)
    expect(angleDiff(axisBearing(m, Cesium.Cartesian3.UNIT_X), 90)).toBeLessThan(1e-6)
    // Cesium turns glTF Y-up into Z-up inside the model, so glTF +Z is the model frame's -Y.
    const gltfZ = new Cesium.Cartesian3(0, -1, 0)
    expect(angleDiff(axisBearing(m, gltfZ), 180)).toBeLessThan(1e-6)
  })

  it('turns clockwise from that rest pose: glTF +X bearing is rotation + 90', () => {
    const cases: Array<[number, number]> = [
      [90, 180],
      [213, 303],
      [300, 30],
    ]
    for (const [rotation, bearing] of cases) {
      const m = towerModelMatrix(LON, LAT, HEIGHT, rotation, 1)
      expect(angleDiff(axisBearing(m, Cesium.Cartesian3.UNIT_X), bearing)).toBeLessThan(1e-6)
    }
  })

  it('goes through the shared compass helper with the cab 90-degree offset', () => {
    const rotation = 213
    const position = Cesium.Cartesian3.fromDegrees(LON, LAT, HEIGHT)
    const hpr = new Cesium.HeadingPitchRoll(compassToModelHeading(rotation + 90, 0), 0, 0)
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
