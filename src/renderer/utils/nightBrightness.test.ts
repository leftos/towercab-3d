import { describe, expect, it } from 'vitest'
import { NIGHT_BRIGHTNESS_MIN, SUN_ELEVATION_CIVIL_TWILIGHT, SUN_ELEVATION_DAY } from '@/constants'
import { cabNightFactor, nightBrightness } from './nightBrightness'

const INTENSITY = 0.7
const NIGHT_FLOOR = NIGHT_BRIGHTNESS_MIN + (1 - INTENSITY) * (1 - NIGHT_BRIGHTNESS_MIN)

describe('cabNightFactor', () => {
  it('is 1 by day', () => {
    expect(cabNightFactor(20, INTENSITY, true)).toBe(1)
    expect(cabNightFactor(SUN_ELEVATION_DAY, INTENSITY, true)).toBe(1)
  })

  it('is the curve floor in deep night', () => {
    expect(cabNightFactor(-40, INTENSITY, true)).toBeCloseTo(NIGHT_FLOOR, 12)
    expect(cabNightFactor(-40, 1, true)).toBeCloseTo(NIGHT_BRIGHTNESS_MIN, 12)
  })

  it('falls through twilight between day and the floor', () => {
    const twilight = cabNightFactor(SUN_ELEVATION_CIVIL_TWILIGHT / 2, INTENSITY, true)
    expect(twilight).toBeLessThan(1)
    expect(twilight).toBeGreaterThan(NIGHT_FLOOR)
  })

  it('is 1 when night darkening is off, whatever the sun', () => {
    expect(cabNightFactor(-40, INTENSITY, false)).toBe(1)
    expect(cabNightFactor(-3, INTENSITY, false)).toBe(1)
  })

  it('is 1 before the sun elevation is known', () => {
    expect(cabNightFactor(null, INTENSITY, true)).toBe(1)
  })

  it('matches the imagery darkening curve', () => {
    for (const elevation of [5, -2, -7, -13, -25]) {
      expect(cabNightFactor(elevation, INTENSITY, true)).toBe(nightBrightness(elevation, INTENSITY))
    }
  })
})
