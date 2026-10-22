import * as Cesium from 'cesium'
import { describe, expect, it } from 'vitest'
import {
  applyBuildingStyle,
  createBuildingStyle,
  decodePackedColour,
  FacadeClass,
  PACK_CHANNEL_MIN,
  PACK_CODE_MAX,
  PACK_HASH_STATES,
  PACK_HEIGHT_STEP_M,
  type PackedBuilding,
} from '@/utils/buildingStyle'

/** A batch-table cell: a column can hold null or '' where a building lacks the tag. */
type Tags = Record<string, string | number | null>

/** A tile feature as the style evaluator sees it: properties only, with every read counted. */
function stubFeature(tags: Tags, reads: Map<string, number> = new Map()) {
  const read = (name: string) => {
    reads.set(name, (reads.get(name) ?? 0) + 1)
    return tags[name]
  }
  return { getPropertyInherited: read, getProperty: read }
}

const style = createBuildingStyle()

/** Evaluates the style's colour on a stub feature and returns it as 0-255 channels plus alpha. */
function evaluate(tags: Tags, reads?: Map<string, number>): { rgb: [number, number, number]; alpha: number } {
  const feature = stubFeature(tags, reads) as unknown as Cesium.Cesium3DTileFeature
  const colour = (style.color as Cesium.StyleExpression).evaluateColor(feature, new Cesium.Color())
  return {
    rgb: [Math.round(colour.red * 255), Math.round(colour.green * 255), Math.round(colour.blue * 255)],
    alpha: colour.alpha,
  }
}

function packed(tags: Tags): PackedBuilding {
  return decodePackedColour(evaluate(tags).rgb)
}

const AT_KSFO = { 'cesium#latitude': 37.61568, 'cesium#longitude': -122.38905 }

describe('createBuildingStyle class', () => {
  it.each([
    [{ building: 'parking' }, FacadeClass.GARAGE],
    [{ building: 'yes', amenity: 'parking' }, FacadeClass.GARAGE],
    [{ building: 'yes', amenity: 'parking', parking: 'multi-storey' }, FacadeClass.GARAGE],
    [{ building: 'yes', parking: 'multi-storey' }, FacadeClass.GARAGE],
    [{ building: 'garage' }, FacadeClass.PLAIN],
    [{ building: 'garages' }, FacadeClass.PLAIN],
    [{ building: 'carport' }, FacadeClass.PLAIN],
    [{ building: 'hangar' }, FacadeClass.HANGAR],
    [{ building: 'warehouse' }, FacadeClass.HANGAR],
    [{ building: 'industrial' }, FacadeClass.HANGAR],
    [{ building: 'house' }, FacadeClass.HOUSE],
    [{ building: 'apartments' }, FacadeClass.HOUSE],
    [{ building: 'detached' }, FacadeClass.HOUSE],
    [{ building: 'office' }, FacadeClass.OFFICE],
    [{ building: 'commercial' }, FacadeClass.OFFICE],
    [{ building: 'hotel' }, FacadeClass.OFFICE],
    [{ building: 'terminal' }, FacadeClass.TERMINAL],
    [{ building: 'transportation', aeroway: 'terminal' }, FacadeClass.TERMINAL],
    [{ building: 'yes', aeroway: 'terminal' }, FacadeClass.TERMINAL],
    [{ building: 'yes' }, FacadeClass.GENERIC],
    [{ building: 'roof' }, FacadeClass.GENERIC],
    [{ building: null }, FacadeClass.GENERIC],
    [{}, FacadeClass.GENERIC],
  ])('classes %o as %i', (tags, expected) => {
    expect(packed({ ...AT_KSFO, ...tags }).facadeClass).toBe(expected)
  })

  it('lets an earlier class win when tags name two', () => {
    expect(packed({ building: 'garage', amenity: 'parking' }).facadeClass).toBe(FacadeClass.GARAGE)
    expect(packed({ building: 'house', aeroway: 'hangar' }).facadeClass).toBe(FacadeClass.HANGAR)
  })
})

describe('createBuildingStyle levels', () => {
  it('reads building:levels, a string on the ion tileset', () => {
    expect(packed({ building: 'office', 'building:levels': '7' }).levels).toBe(7)
  })

  it('reads a decimal through the unbucketed levels channel', () => {
    expect(packed({ 'building:levels': '7,5' }).levels).toBe(8)
    expect(packed({ 'building:levels': '12.5' }).levels).toBe(13)
  })

  it('is zero (unknown) when levels are missing or not a number', () => {
    expect(packed({ building: 'office' }).levels).toBe(0)
    expect(packed({ building: 'office', 'building:levels': '4;5' }).levels).toBe(0)
  })

  it("counts a building part's own storeys above its min_level", () => {
    const part = { 'part#building:levels': '6', 'part#building:min_level': '3', 'building:levels': '9' }
    expect(packed(part).levels).toBe(3)
  })

  it('saturates at the largest code', () => {
    expect(packed({ 'building:levels': '60' }).levels).toBe(PACK_CODE_MAX)
  })
})

describe('createBuildingStyle height', () => {
  it('uses the explicit height, less any min_height, in buckets', () => {
    expect(packed({ height: '20', 'cesium#estimatedHeight': 99 }).heightM).toBe(20)
    expect(packed({ 'part#height': '38', 'part#min_height': '20', 'cesium#estimatedHeight': 41 }).heightM).toBe(18)
  })

  it('falls back to the estimated height when no explicit height parses', () => {
    expect(packed({ 'cesium#estimatedHeight': 9 }).heightM).toBe(10)
    expect(packed({ height: 'tall', 'cesium#estimatedHeight': 12 }).heightM).toBe(12)
  })

  // Every part of one element carries the element's own cesium#estimatedHeight (probe-koak.json),
  // so a part without a part#height has an unknown height, not the element's top.
  it('leaves a part without its own height unknown', () => {
    const part = { 'part#building:levels': '2', 'part#min_height': '10', 'cesium#estimatedHeight': 40 }
    expect(packed(part).heightM).toBe(0)
  })

  it('keeps the estimated height for a building, less its min_height', () => {
    expect(packed({ 'building:levels': '5', min_height: '10', 'cesium#estimatedHeight': 40 }).heightM).toBe(30)
  })

  it('is zero (unknown) without any height and clamps extreme heights', () => {
    expect(packed({}).heightM).toBe(0)
    expect(packed({ height: '-5' }).heightM).toBe(0)
    expect(packed({ height: '500' }).heightM).toBe(PACK_CODE_MAX * PACK_HEIGHT_STEP_M)
  })

  it('leaves the roof out of the wall height: roof:height when tagged', () => {
    expect(packed({ height: '20', 'building:levels': '4', 'roof:height': '4' }).heightM).toBe(16)
  })

  it('leaves the roof out of the wall height: roof:levels as storeys when no roof:height', () => {
    expect(packed({ height: '18', 'building:levels': '4', 'roof:levels': '2' }).heightM).toBe(12)
  })

  it("takes a part's roof from the part", () => {
    const part = { 'part#height': '30', 'part#building:levels': '5', 'part#roof:height': '6', 'roof:height': '20' }
    expect(packed(part).heightM).toBe(24)
  })

  it('takes the roof off a tagged height only, never off the estimated height', () => {
    expect(packed({ 'cesium#estimatedHeight': 30, 'roof:height': '6' }).heightM).toBe(30)
    expect(packed({ height: '30', 'roof:height': '6' }).heightM).toBe(24)
  })

  it('ignores a roof that would leave less than one storey of wall', () => {
    expect(packed({ height: '20', 'roof:height': '-5' }).heightM).toBe(20)
    expect(packed({ height: '20', 'roof:height': '25' }).heightM).toBe(20)
  })
})

describe('createBuildingStyle absent cells', () => {
  it('treats null and empty cells as absent, so the estimated height still applies', () => {
    expect(packed({ height: null, 'building:levels': null, 'cesium#estimatedHeight': 9 })).toMatchObject({
      levels: 0,
      heightM: 10,
    })
    expect(packed({ height: '', 'building:levels': '', 'cesium#estimatedHeight': 9 })).toMatchObject({
      levels: 0,
      heightM: 10,
    })
  })

  it('reads the building when the part cells are null or empty', () => {
    const building = { height: '20', 'building:levels': '5' }
    expect(packed({ ...building, 'part#height': null, 'part#building:levels': null })).toMatchObject({
      levels: 5,
      heightM: 20,
    })
    expect(packed({ ...building, 'part#height': '', 'part#building:levels': '' })).toMatchObject({
      levels: 5,
      heightM: 20,
    })
  })
})

describe('createBuildingStyle part or building', () => {
  it('takes storeys from the part levels, and height only from its own height', () => {
    const levelsOnly = {
      'part#building:levels': '4',
      height: '40',
      'building:levels': '12',
      'cesium#estimatedHeight': 12,
    }
    expect(packed(levelsOnly)).toMatchObject({ levels: 4, heightM: 0 })

    const heightOnly = { 'part#height': '10', height: '40', 'building:levels': '12' }
    expect(packed(heightOnly)).toMatchObject({ levels: 0, heightM: 10 })
  })

  it('takes both from the building when the part has neither', () => {
    expect(packed({ 'part#min_height': '5', height: '40', 'building:levels': '12' })).toMatchObject({
      levels: 12,
      heightM: 40,
    })
  })
})

describe('createBuildingStyle tag numbers', () => {
  // The wall height in 2 m buckets, so the tag's own value shows through the packing.
  it.each([
    ['12', 12],
    ['12.5', 12],
    ['12 m', 12],
    ['7,5', 8],
    [' 9', 10],
    ['abc', 0],
    ['', 0],
    ['4;5', 0],
    ['30 ft', 0],
    [14, 14],
  ])('reads %o as a wall height', (height, expected) => {
    expect(packed({ height } as Tags).heightM).toBe(expected)
  })
})

describe('createBuildingStyle evaluation', () => {
  // Cesium evaluates a tileset style's colour with no feature for tile content that has none
  // (Model.applyColorAndShow, @cesium/engine Model.js).
  it('gives tile content without features white, without throwing', () => {
    const expression = style.color as Cesium.StyleExpression
    const noFeature = undefined as unknown as Cesium.Cesium3DTileFeature
    const reused = new Cesium.Color()
    const colour = expression.evaluateColor(noFeature, reused)

    expect(colour).toBe(reused)
    expect([reused.red, reused.green, reused.blue, reused.alpha]).toEqual([1, 1, 1, 1])
    expect(expression.evaluateColor(noFeature)).toEqual(Cesium.Color.WHITE)
  })

  it('reads each tag at most once per feature, by its own property only', () => {
    const reads = new Map<string, number>()
    evaluate({ ...AT_KSFO, building: 'office', 'building:levels': '7', height: '25' }, reads)

    expect(reads.size).toBeGreaterThan(0)
    for (const [name, count] of reads) {
      expect(count, name).toBe(1)
    }
  })
})

describe('createBuildingStyle bounds', () => {
  const cases: Tags[] = [
    {},
    { building: 'terminal', 'building:levels': '60', height: '500', ...AT_KSFO },
    { building: 'carport', 'building:levels': '60', height: '500', ...AT_KSFO },
    { building: 'garage', 'building:levels': '0', height: '0' },
    { building: 'house', 'cesium#latitude': -89.99999, 'cesium#longitude': 179.99999 },
  ]

  it.each(cases)('keeps every channel near white and alpha at 1 for %o', (tags) => {
    const { rgb, alpha } = evaluate(tags)
    for (const channel of rgb) {
      expect(channel).toBeGreaterThanOrEqual(PACK_CHANNEL_MIN)
      expect(channel).toBeLessThanOrEqual(255)
    }
    expect(alpha).toBe(1)
  })
})

describe('createBuildingStyle packing headroom', () => {
  it('fits every class and the largest hash in the red channel', () => {
    for (const code of Object.values(FacadeClass)) {
      expect(code * PACK_HASH_STATES + (PACK_HASH_STATES - 1)).toBeLessThanOrEqual(PACK_CODE_MAX)
    }
  })
})

describe('createBuildingStyle hash', () => {
  it('gives the same hash for the same position, whatever the other tags', () => {
    const a = packed({ ...AT_KSFO, building: 'office' }).hash
    const b = packed({ ...AT_KSFO, building: 'office', 'building:levels': '3' }).hash
    expect(a).toBe(b)
  })

  // On the ion tileset every part feature of one OSM building carries the building's own
  // cesium#latitude/longitude: the parts of the KSFO central garage (relation 15730419, features
  // 65..89 of one tile) all sit at 37.61568, -122.38905 whatever their part tags.
  it('gives every part of one building the same hash', () => {
    const parts: Tags[] = [
      { 'part#building:levels': '3', 'part#height': '12' },
      { 'part#building:levels': '6', 'part#building:min_level': '3', 'part#height': '24', 'part#min_height': '12' },
      { 'part#building:part': 'roof', 'part#height': '41' },
    ]
    const hashes = parts.map((part) => packed({ ...AT_KSFO, type: 'building', ...part }).hash)
    expect(new Set(hashes).size).toBe(1)
  })

  it('is zero without a position', () => {
    expect(packed({ building: 'office' }).hash).toBe(0)
    expect(packed({ building: 'office', 'cesium#latitude': null, 'cesium#longitude': '' }).hash).toBe(0)
  })

  it('spreads neighbouring buildings over every hash state', () => {
    const counts = new Array(PACK_HASH_STATES).fill(0)
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 10; j++) {
        const tags = { 'cesium#latitude': 37.615 + i * 1e-4, 'cesium#longitude': -122.389 + j * 1e-4 }
        counts[packed(tags).hash]++
      }
    }
    for (const count of counts) {
      expect(count).toBeGreaterThanOrEqual(15)
    }
  })
})

describe('applyBuildingStyle', () => {
  it('sets the packing style and keeps its colour out of the lit result', () => {
    const tileset = {} as Cesium.Cesium3DTileset
    applyBuildingStyle(tileset)

    expect(tileset.style).toBeInstanceOf(Cesium.Cesium3DTileStyle)
    expect(tileset.colorBlendMode).toBe(Cesium.Cesium3DTileColorBlendMode.MIX)
    expect(tileset.colorBlendAmount).toBe(0)
  })
})

describe('decodePackedColour', () => {
  it('reads white as a generic building with nothing known', () => {
    expect(decodePackedColour([255, 255, 255])).toEqual({
      facadeClass: FacadeClass.GENERIC,
      levels: 0,
      heightM: 0,
      hash: 0,
    })
  })

  it('reads the darkest packed colour as the largest codes', () => {
    expect(decodePackedColour([PACK_CHANNEL_MIN, PACK_CHANNEL_MIN, PACK_CHANNEL_MIN])).toEqual({
      facadeClass: FacadeClass.PLAIN,
      levels: PACK_CODE_MAX,
      heightM: PACK_CODE_MAX * PACK_HEIGHT_STEP_M,
      hash: PACK_HASH_STATES - 1,
    })
  })
})
