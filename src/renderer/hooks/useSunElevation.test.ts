import * as Cesium from 'cesium'
import { describe, expect, it } from 'vitest'
import { computeSunElevationDeg } from '@/hooks/useSunElevation'

const KSFO = Cesium.Cartesian3.fromDegrees(-122.375, 37.6189, 10)

// The app's fixed mode reads an hour as local time at longitude/15, so 22:00 local at KSFO (122.375 W) is
// 06:09:30 UTC and 12:00 local is 20:09:30 UTC.
const NIGHT = Cesium.JulianDate.fromDate(new Date(Date.UTC(2025, 5, 21, 6, 9, 30)))
const DAY = Cesium.JulianDate.fromDate(new Date(Date.UTC(2025, 5, 21, 20, 9, 30)))

describe('computeSunElevationDeg', () => {
  it('reports the sun below the horizon at 22:00 local', () => {
    expect(computeSunElevationDeg(KSFO, NIGHT)).toBeLessThan(-5)
  })

  it('reports the sun above the horizon at 12:00 local', () => {
    expect(computeSunElevationDeg(KSFO, DAY)).toBeGreaterThan(30)
  })

  it('returns null for a missing position', () => {
    expect(computeSunElevationDeg(Cesium.Cartesian3.ZERO, DAY)).toBeNull()
  })
})
