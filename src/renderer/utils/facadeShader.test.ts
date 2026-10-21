import * as Cesium from 'cesium'
import { describe, expect, it } from 'vitest'
import { createFacadeShader, meanGlassLinear, windowCoverage } from './facadeShader'

/** sRGB to linear light by the IEC 61966-2-1 transfer curve. */
function iecSrgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

const GLASS_DARK_SRGB = [0.1, 0.13, 0.17]
const GLASS_LIGHT_SRGB = [0.22, 0.27, 0.32]

describe('windowCoverage', () => {
  it('is the window rectangle area as a share of the cell', () => {
    expect(windowCoverage([0.2, 0.32], [0.8, 0.82])).toBeCloseTo(0.3, 10)
  })

  it('is zero for an empty rectangle and one for the whole cell', () => {
    expect(windowCoverage([0.5, 0.5], [0.5, 0.5])).toBe(0)
    expect(windowCoverage([0, 0], [1, 1])).toBe(1)
  })
})

describe('meanGlassLinear', () => {
  it('is the mean of the two glass end colours in linear light', () => {
    const mean = meanGlassLinear()
    const expected = GLASS_DARK_SRGB.map(
      (dark, i) => (iecSrgbToLinear(dark) + iecSrgbToLinear(GLASS_LIGHT_SRGB[i])) / 2,
    )

    expect(mean[0]).toBeCloseTo(expected[0], 10)
    expect(mean[1]).toBeCloseTo(expected[1], 10)
    expect(mean[2]).toBeCloseTo(expected[2], 10)
  })
})

describe('createFacadeShader', () => {
  it('starts with the fade off and the default fade range and window coverage', () => {
    const { uniforms } = createFacadeShader()

    expect(uniforms.u_fade.value).toBe(0)
    expect(uniforms.u_fadeStart.value).toBe(0.25)
    expect(uniforms.u_fadeEnd.value).toBe(0.6)
    expect(uniforms.u_cover.value).toBeCloseTo(0.3, 10)
    expect(uniforms.u_fade.type).toBe(Cesium.UniformType.FLOAT)
    expect(uniforms.u_glassMean.type).toBe(Cesium.UniformType.VEC3)
  })

  it('takes screen-space derivatives before any branch in the fragment', () => {
    const text = createFacadeShader().fragmentShaderText ?? ''
    const body = text.slice(text.indexOf('void fragmentMain('))
    const firstDerivative = body.indexOf('fwidth(')

    expect(firstDerivative).toBeGreaterThan(-1)
    expect(body.indexOf('if (detail')).toBeGreaterThan(firstDerivative)
    expect(body.indexOf('if (')).toBeGreaterThan(firstDerivative)
  })
})
