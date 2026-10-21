import { describe, expect, it } from 'vitest'
import { neutralEnvironmentMapOptions } from './environmentMap'

/** A colour channel as a 0-255 byte, so comparisons read in the CSS colour's own units. */
function channelByte(value: number): number {
  return Math.round(value * 255)
}

describe('neutralEnvironmentMapOptions', () => {
  it('uses a neutral grey ground colour of #6E6E6E', () => {
    const { groundColor } = neutralEnvironmentMapOptions()

    expect(channelByte(groundColor.red)).toBe(channelByte(groundColor.green))
    expect(channelByte(groundColor.green)).toBe(channelByte(groundColor.blue))
    expect(Math.abs(channelByte(groundColor.red) - 0x6e)).toBeLessThanOrEqual(1)
    expect(groundColor.alpha).toBeCloseTo(1)
  })
})
