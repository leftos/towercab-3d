import { describe, expect, it } from 'vitest'
import { isBuildingPart, tagValueNumber } from '@/utils/buildingTags'

/** A batch-table cell: a column can hold null or '' where a building lacks the tag. */
type Tags = Record<string, string | number | null>

/** A tile feature as far as the tag helpers read it: its properties. */
function stubFeature(tags: Tags) {
  return { getProperty: (name: string) => tags[name] }
}

describe('tagValueNumber', () => {
  it('reads a number, metres and a decimal comma, and gives NaN for anything else', () => {
    expect(tagValueNumber(12)).toBe(12)
    expect(tagValueNumber('6 m')).toBe(6)
    expect(tagValueNumber(' 4,5 ')).toBe(4.5)
    expect(tagValueNumber('-2')).toBe(-2)
    expect(tagValueNumber('10;12')).toBeNaN()
    expect(tagValueNumber('30 ft')).toBeNaN()
    expect(tagValueNumber('')).toBeNaN()
    expect(tagValueNumber(null)).toBeNaN()
    expect(tagValueNumber(undefined)).toBeNaN()
    expect(tagValueNumber(Number.POSITIVE_INFINITY)).toBeNaN()
  })
})

describe('isBuildingPart', () => {
  it('is a part exactly when the feature carries its own part#elementId', () => {
    expect(isBuildingPart(stubFeature({ elementId: 'w1', 'part#elementId': 'w9' }))).toBe(true)
    expect(isBuildingPart(stubFeature({ 'part#elementId': 0 }))).toBe(true)
    expect(isBuildingPart(stubFeature({ elementId: 'w1', 'part#height': '12' }))).toBe(false)
    expect(isBuildingPart(stubFeature({ elementId: 'w1', 'part#elementId': null }))).toBe(false)
  })
})
