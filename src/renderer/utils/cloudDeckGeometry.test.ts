import { describe, expect, it } from 'vitest'
import {
  cloudLayerMarchOrder,
  curvatureDropM,
  deckEdgeElevationDeg,
  horizonDipDeg,
  minDeckRadiusForHorizonM,
} from '@/utils/cloudDeckGeometry'

const CAMERA_M = 80
const OVC_BASE_M = 609.6
const BKN_BASE_M = 274.3

/** Angle in degrees between the deck's far edge and the horizon below it (positive leaves sky between them). */
function gapDeg(cameraAglM: number, baseAglM: number, deckRadiusM: number, curved: boolean): number {
  return deckEdgeElevationDeg(cameraAglM, baseAglM, deckRadiusM, curved) + horizonDipDeg(cameraAglM)
}

describe('cloud deck geometry', () => {
  it('puts the horizon 0.287 deg below level from 80 m', () => {
    expect(horizonDipDeg(CAMERA_M)).toBeCloseTo(0.287, 3)
  })

  it('leaves about a degree of sky under a flat 40 km deck', () => {
    expect(Math.abs(deckEdgeElevationDeg(CAMERA_M, OVC_BASE_M, 40_000, false) - 0.759)).toBeLessThan(0.005)
    expect(gapDeg(CAMERA_M, OVC_BASE_M, 40_000, false)).toBeCloseTo(1.05, 1)
  })

  it('brings a curved 100 km deck to within 0.15 deg of the horizon', () => {
    expect(Math.abs(deckEdgeElevationDeg(CAMERA_M, OVC_BASE_M, 100_000, true) - -0.146)).toBeLessThan(0.005)
    const gap = gapDeg(CAMERA_M, OVC_BASE_M, 100_000, true)
    expect(gap).toBeGreaterThan(0)
    expect(gap).toBeLessThan(0.15)
  })

  it('needs about 120 km for the overcast base to reach the horizon', () => {
    expect(Math.abs(minDeckRadiusForHorizonM(CAMERA_M, OVC_BASE_M) - 120_000)).toBeLessThan(500)
    expect(Math.abs(minDeckRadiusForHorizonM(88.8, OVC_BASE_M) - 121_800)).toBeLessThan(500)
  })

  it('meets the horizon exactly at the minimum radius', () => {
    const radius = minDeckRadiusForHorizonM(CAMERA_M, OVC_BASE_M)
    expect(gapDeg(CAMERA_M, OVC_BASE_M, radius, true)).toBeCloseTo(0, 4)
  })

  it('closes a 274.3 m base below the horizon at 100 km', () => {
    expect(gapDeg(CAMERA_M, BKN_BASE_M, 100_000, true)).toBeLessThan(0)
  })

  it('widens the gap at 100 km as the camera climbs toward the curvature drop, then narrows it', () => {
    const gaps = [80, 300, 500].map((h) => gapDeg(h, OVC_BASE_M, 100_000, true))
    expect(gaps[1]).toBeGreaterThan(gaps[0])
    expect(gaps[2]).toBeGreaterThan(gaps[1])
    const peak = gapDeg(curvatureDropM(100_000), OVC_BASE_M, 100_000, true)
    expect(peak).toBeGreaterThanOrEqual(gaps[2])
    expect(peak).toBeGreaterThanOrEqual(gapDeg(1500, OVC_BASE_M, 100_000, true))
  })
})

describe('cloudLayerMarchOrder', () => {
  it('marches layers above the camera lowest first, even for a ray that starts level or downward', () => {
    expect(cloudLayerMarchOrder(CAMERA_M, [BKN_BASE_M, OVC_BASE_M])).toEqual([0, 1])
  })

  it('marches layers below the camera highest first', () => {
    expect(cloudLayerMarchOrder(1524, [BKN_BASE_M, OVC_BASE_M])).toEqual([1, 0])
  })

  it('marches the layer below a camera between two layers before the one above it', () => {
    expect(cloudLayerMarchOrder(400, [BKN_BASE_M, OVC_BASE_M, 1500])).toEqual([0, 1, 2])
    expect(cloudLayerMarchOrder(700, [BKN_BASE_M, OVC_BASE_M, 1500])).toEqual([1, 0, 2])
  })

  it('counts a camera exactly at a base as above that layer', () => {
    expect(cloudLayerMarchOrder(OVC_BASE_M, [BKN_BASE_M, OVC_BASE_M])).toEqual([1, 0])
  })
})
