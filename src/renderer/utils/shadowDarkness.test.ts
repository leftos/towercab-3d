import { describe, expect, it } from 'vitest'
import { toCesiumShadowDarkness } from '@/utils/shadowDarkness'

describe('toCesiumShadowDarkness', () => {
  it('turns an invisible shadow setting into no Cesium darkening', () => {
    expect(toCesiumShadowDarkness(0)).toBe(1)
  })

  it('turns a black shadow setting into full Cesium darkening', () => {
    expect(toCesiumShadowDarkness(1)).toBe(0)
  })

  it('inverts the default setting of 0.3', () => {
    expect(toCesiumShadowDarkness(0.3)).toBeCloseTo(0.7)
  })

  it('clamps a setting below 0 to no darkening', () => {
    expect(toCesiumShadowDarkness(-0.5)).toBe(1)
  })

  it('clamps a setting above 1 to full darkening', () => {
    expect(toCesiumShadowDarkness(1.5)).toBe(0)
  })
})
