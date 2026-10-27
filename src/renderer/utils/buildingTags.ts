/**
 * Reading OSM building tags off a tile feature: a tag's number and whether the feature is a
 * building part. A leaf module, so the building style and the floor-line lookup share it without
 * importing each other.
 */

/** A cell holding one number with an optional trailing `m`; a decimal comma is replaced first. */
const TAG_NUMBER = /^(-?\d+(?:\.\d+)?)\s*m?$/

/**
 * A tag cell's number, NaN when the cell holds anything else (absent, a multi-value, feet, empty).
 *
 * @param value - The cell, as `getProperty` returns it
 * @returns The number in metres, or NaN
 */
export function tagValueNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN
  if (typeof value !== 'string') return Number.NaN
  const match = TAG_NUMBER.exec(value.trim().replace(',', '.'))
  return match === null ? Number.NaN : Number(match[1])
}

/**
 * Whether a feature is a building part: it carries its own `part#elementId` (its unprefixed tags
 * are then its parent building's).
 *
 * @param feature - A tile feature, or anything that reads its properties
 */
export function isBuildingPart(feature: { getProperty(name: string): unknown }): boolean {
  const part = feature.getProperty('part#elementId')
  return part !== undefined && part !== null
}
