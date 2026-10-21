import { describe, expect, it } from 'vitest'
import { resolveGroundHeight } from './towerHeight'

const FIELD = 31.5

describe('resolveGroundHeight', () => {
  it('takes the sampled terrain height when there is one', () => {
    expect(resolveGroundHeight(12.25, 14, FIELD)).toBe(12.25)
  })

  it('takes a sampled height of 0 rather than skipping it', () => {
    expect(resolveGroundHeight(0, 14, FIELD)).toBe(0)
  })

  it('falls back to the globe height when the sample has none', () => {
    expect(resolveGroundHeight(undefined, 14, FIELD)).toBe(14)
    expect(resolveGroundHeight(Number.NaN, 14, FIELD)).toBe(14)
  })

  it('falls back to the field elevation when neither terrain source has a height', () => {
    expect(resolveGroundHeight(undefined, undefined, FIELD)).toBe(FIELD)
    expect(resolveGroundHeight(Number.NaN, Number.POSITIVE_INFINITY, FIELD)).toBe(FIELD)
  })
})
