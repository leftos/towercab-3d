/**
 * The style that packs each OSM building's type, storeys, wall height and a stable hash into its
 * feature colour, for the facade shader to read.
 *
 * Text tags never reach a custom shader, but a `Cesium3DTileStyle` colour does: the shader reads
 * it back through `selectedFeatureIdStage()`. The tileset's MIX colour blend at amount 0 (see
 * `applyBuildingStyle`) keeps the colour itself out of the rendered result. Every channel still
 * stays near white (228 to 255) and alpha stays 1, so no feature moves to the translucent pass.
 *
 * Layout, with each channel holding `255 - code` and every code in 0..27:
 * - red: `facadeClass * 4 + hash`, the hash in 0..3 from the building's latitude and longitude
 * - green: storeys of the building or part, 0 when unknown
 * - blue: wall height (roof left out) in 2 m buckets, 0 when unknown, 27 for 54 m or more
 *
 * A tag's cell counts as a number only when it is a finite number, or a string holding one with an
 * optional trailing `m`; every other cell (missing, null, empty, `12;14`, `30 ft`) counts as absent.
 */

import * as Cesium from 'cesium'
import buildingOutlines from '../data/buildingOutlines.json'

/** Facade grammar a building gets, by its OSM tags. */
export const FacadeClass = {
  GENERIC: 0,
  GARAGE: 1,
  HANGAR: 2,
  HOUSE: 3,
  OFFICE: 4,
  TERMINAL: 5,
  PLAIN: 6,
} as const

export type FacadeClassCode = (typeof FacadeClass)[keyof typeof FacadeClass]

/** Lowest value a packed channel takes (8-bit). */
export const PACK_CHANNEL_MIN = 228

/** Largest code a channel carries: `255 - PACK_CHANNEL_MIN`. */
export const PACK_CODE_MAX = 255 - PACK_CHANNEL_MIN

/** Number of hash states packed beside the class in the red channel. */
export const PACK_HASH_STATES = 4

/** Height bucket size in metres. */
export const PACK_HEIGHT_STEP_M = 2

/** The fields the facade shader decodes from a packed colour. */
export interface PackedBuilding {
  facadeClass: number
  levels: number
  heightM: number
  hash: number
}

interface ClassRule {
  code: FacadeClassCode
  buildings: readonly string[]
  tags?: ReadonlyArray<readonly [string, string]>
}

/**
 * The class rules in priority order: OSM `building` values per class, and the other tags that
 * also set it. When a building's tags name two classes, the earlier rule wins.
 */
const CLASS_RULES: readonly ClassRule[] = [
  {
    code: FacadeClass.TERMINAL,
    buildings: ['terminal', 'transportation', 'train_station'],
    tags: [['aeroway', 'terminal']],
  },
  {
    code: FacadeClass.GARAGE,
    buildings: ['parking'],
    tags: [
      ['amenity', 'parking'],
      ['parking', 'multi-storey'],
    ],
  },
  {
    code: FacadeClass.HANGAR,
    buildings: ['hangar', 'industrial', 'warehouse', 'manufacture', 'factory'],
    tags: [['aeroway', 'hangar']],
  },
  { code: FacadeClass.PLAIN, buildings: ['garage', 'garages', 'carport'] },
  {
    code: FacadeClass.HOUSE,
    buildings: [
      'house',
      'residential',
      'detached',
      'semidetached_house',
      'terrace',
      'apartments',
      'bungalow',
      'dormitory',
      'cabin',
    ],
  },
  {
    code: FacadeClass.OFFICE,
    buildings: [
      'office',
      'commercial',
      'retail',
      'hotel',
      'hospital',
      'clinic',
      'public',
      'civic',
      'government',
      'school',
      'college',
      'university',
      'mixed_use',
    ],
  },
]

/** Rule index per `building` value. */
const RULE_BY_BUILDING = new Map<string, number>(
  CLASS_RULES.flatMap((rule, index) => rule.buildings.map((value) => [value, index] as const)),
)

/** The non-`building` tags the rules test, each read once per feature. */
const RULE_TAG_KEYS = [...new Set(CLASS_RULES.flatMap((rule) => (rule.tags ?? []).map(([key]) => key)))]

/** Each rule's tag tests as slots into `TAG_VALUES` and the value each slot must equal. */
const RULE_TAG_SLOTS: readonly (readonly number[])[] = CLASS_RULES.map((rule) =>
  (rule.tags ?? []).map(([key]) => RULE_TAG_KEYS.indexOf(key)),
)
const RULE_TAG_VALUES: readonly (readonly string[])[] = CLASS_RULES.map((rule) =>
  (rule.tags ?? []).map(([, value]) => value),
)

/** Per-feature scratch for the rule tags, so each is read once and no Map is built. */
const TAG_VALUES: unknown[] = new Array<unknown>(RULE_TAG_KEYS.length).fill(undefined)

/** The rule tags of each OSM outline relation, keyed by relation id. */
const OUTLINE_TAGS: Readonly<Record<string, Readonly<Record<string, string>>>> = buildingOutlines.relations

/** The height tags a building or a part carries, built once so no key is built per feature. */
interface HeightKeys {
  minLevel: string
  minHeight: string
  roofHeight: string
  roofLevels: string
}

function heightKeys(prefix: string): HeightKeys {
  return Object.freeze({
    minLevel: `${prefix}building:min_level`,
    minHeight: `${prefix}min_height`,
    roofHeight: `${prefix}roof:height`,
    roofLevels: `${prefix}roof:levels`,
  })
}

/** The height tags of a whole building, and those of a building part. */
const BUILDING_KEYS = heightKeys('')
const PART_KEYS = heightKeys('part#')

type Feature = Cesium.Cesium3DTileFeature

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

/** A tag's number, NaN when the cell holds anything else (a multi-value, feet, empty). */
function tagNumber(feature: Feature, name: string): number {
  return tagValueNumber(feature.getProperty(name))
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

function orZero(value: number): number {
  return Number.isNaN(value) ? 0 : value
}

/** One source of tags: a feature's own, or one entry of the outline table. */
type TagSource = (key: string) => unknown

function classify(read: TagSource): FacadeClassCode {
  let best = RULE_BY_BUILDING.get(String(read('building'))) ?? CLASS_RULES.length
  if (best > 0) {
    for (let slot = 0; slot < RULE_TAG_KEYS.length; slot++) {
      TAG_VALUES[slot] = read(RULE_TAG_KEYS[slot])
    }
    for (let index = 0; index < best; index++) {
      const slots = RULE_TAG_SLOTS[index]
      const values = RULE_TAG_VALUES[index]
      for (let test = 0; test < slots.length; test++) {
        if (TAG_VALUES[slots[test]] === values[test]) {
          best = index
          break
        }
      }
    }
  }
  return best < CLASS_RULES.length ? CLASS_RULES[best].code : FacadeClass.GENERIC
}

/** The feature `classifyFeature` is classifying, so the reader below builds no closure per feature. */
let currentFeature: Feature | undefined

/** Reads a tag of `currentFeature`: the tag source for a feature's own tags. */
const readCurrentTag: TagSource = (key) => currentFeature?.getProperty(key)

/**
 * A feature's class: its own tags first, then, when they say nothing, the outline relation it
 * belongs to. Only a feature tagged `type=building` is looked up. A part's unprefixed tags and
 * elementId are its parent relation's, while a way shares the relation number space, so a way's
 * elementId must never reach the table.
 */
function classifyFeature(feature: Feature): FacadeClassCode {
  currentFeature = feature
  const own = classify(readCurrentTag)
  currentFeature = undefined
  if (own !== FacadeClass.GENERIC || feature.getProperty('type') !== 'building') return own
  const outline = OUTLINE_TAGS[String(feature.getProperty('elementId'))]
  return outline === undefined ? FacadeClass.GENERIC : classify((key) => outline[key])
}

/**
 * Storeys and wall height in metres (NaN when unknown) of the part, or of the building. Part-ness
 * is the feature's own `part#elementId`: a part reads only its own `part#` tags, never the parent
 * building's unprefixed levels or height. Every part of one element carries the element's own
 * `cesium#estimatedHeight`, so a part without its own height stays unknown and the shader keeps
 * the grammar's storey.
 */
function storeysAndWall(feature: Feature): { storeys: number; wallM: number } {
  const isPart = isBuildingPart(feature)
  const keys = isPart ? PART_KEYS : BUILDING_KEYS
  const levels = isPart ? tagNumber(feature, 'part#building:levels') : tagNumber(feature, 'building:levels')
  const height = isPart ? tagNumber(feature, 'part#height') : tagNumber(feature, 'height')

  const storeys = orZero(levels) - orZero(tagNumber(feature, keys.minLevel))
  if (isPart && Number.isNaN(height)) return { storeys, wallM: Number.NaN }
  const taggedHeight = !Number.isNaN(height)
  const topM = taggedHeight ? height : tagNumber(feature, 'cesium#estimatedHeight')
  const totalM = Math.max(topM - orZero(tagNumber(feature, keys.minHeight)), 0)
  const roofM = taggedHeight ? roofHeight(feature, keys, totalM, storeys) : 0
  return { storeys, wallM: totalM - roofM }
}

/** The wall keeps at least one storey below a tagged `roof:height`. */
const MIN_WALL_M = 3

/**
 * The roof's share of the total height: `roof:height` when tagged, else `roof:levels` storeys of
 * the height spread evenly over wall and roof storeys, else none. A tagged roof is clamped to the
 * wall's one-storey floor, and one at or above the total is ignored.
 */
function roofHeight(feature: Feature, keys: HeightKeys, totalM: number, storeys: number): number {
  const tagged = tagNumber(feature, keys.roofHeight)
  if (!Number.isNaN(tagged)) {
    if (tagged >= totalM) return 0
    return Math.min(Math.max(tagged, 0), Math.max(totalM - MIN_WALL_M, 0))
  }
  const roofLevels = tagNumber(feature, keys.roofLevels)
  if (Number.isNaN(roofLevels) || roofLevels <= 0 || storeys <= 0) return 0
  return (totalM * roofLevels) / (storeys + roofLevels)
}

function hashOf(feature: Feature): number {
  const seed = tagNumber(feature, 'cesium#latitude') * 12.9898 + tagNumber(feature, 'cesium#longitude') * 78.233
  const sine = Math.abs(Math.sin(seed)) * 43758.5453
  return orZero(Math.floor((sine - Math.floor(sine)) * PACK_HASH_STATES))
}

function clampCode(value: number): number {
  return Number.isNaN(value) ? 0 : Math.min(Math.max(Math.round(value), 0), PACK_CODE_MAX)
}

/**
 * The building style's colour: reads each tag once per feature with `getProperty` and packs the
 * fields described in the module doc. It overrides the styling-language expression, whose
 * per-feature cost stalled a frame on every restyle and tile load.
 */
class BuildingColour extends Cesium.StyleExpression {
  override evaluate(feature: Feature | undefined, result?: Cesium.Color): Cesium.Color {
    return this.evaluateColor(feature, result)
  }

  override evaluateColor(feature: Feature | undefined, result?: Cesium.Color): Cesium.Color {
    // Cesium evaluates the style with no feature for tile content that has none.
    if (feature === undefined) return Cesium.Color.clone(Cesium.Color.WHITE, result)
    const { storeys, wallM } = storeysAndWall(feature)
    const red = 255 - (classifyFeature(feature) * PACK_HASH_STATES + hashOf(feature))
    const green = 255 - clampCode(storeys)
    const blue = 255 - clampCode(wallM / PACK_HEIGHT_STEP_M)
    return Cesium.Color.fromBytes(red, green, blue, 255, result)
  }
}

/**
 * The style for the OSM Buildings tileset. It replaces Cesium's default style, whose
 * `cesium#color` tint the facade palette supersedes.
 *
 * @returns A new style packing class, storeys, wall height and hash into each feature's colour
 */
export function createBuildingStyle(): Cesium.Cesium3DTileStyle {
  const style = new Cesium.Cesium3DTileStyle()
  style.color = new BuildingColour()
  return style
}

/**
 * Sets the building style on a tileset and keeps the packed colour out of what it draws: the MIX
 * colour blend at amount 0 leaves the source colour (Cesium clamps the amount to 1e-4), so the
 * CPU styling stage multiplies the lit result, specular and image-based light included, by one.
 *
 * @param tileset - The OSM Buildings tileset the facade shader draws
 */
export function applyBuildingStyle(tileset: Cesium.Cesium3DTileset): void {
  tileset.style = createBuildingStyle()
  tileset.colorBlendMode = Cesium.Cesium3DTileColorBlendMode.MIX
  tileset.colorBlendAmount = 0
}

/**
 * Decodes a packed colour, as the facade shader does.
 *
 * @param rgb - The feature colour in 8-bit channels
 * @returns The class, storeys (0 unknown), wall height in metres (0 unknown) and hash
 */
export function decodePackedColour(rgb: readonly [number, number, number]): PackedBuilding {
  const [red, green, blue] = rgb.map((channel) => 255 - channel)
  return {
    facadeClass: Math.floor(red / PACK_HASH_STATES),
    levels: green,
    heightM: blue * PACK_HEIGHT_STEP_M,
    hash: red % PACK_HASH_STATES,
  }
}
