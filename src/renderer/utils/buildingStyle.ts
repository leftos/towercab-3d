/**
 * The style that packs each OSM building's type, storeys and wall height into its feature colour,
 * for the facade shader to read.
 *
 * Text tags never reach a custom shader, but a `Cesium3DTileStyle` colour does: the shader reads
 * it back through `selectedFeatureIdStage()`. The tileset's MIX colour blend at amount 0 (see
 * `applyBuildingStyle`) keeps the colour itself out of the rendered result. Every channel still
 * stays near white (228 to 255) and alpha stays 1, so no feature moves to the translucent pass.
 *
 * Layout, with each channel holding `255 - code` and every code in 0..27:
 * - red: `facadeClass`
 * - green: storeys of the building or part, 0 when unknown
 * - blue: wall height (roof left out) in 2 m buckets, 0 when unknown, 27 for 54 m or more
 *
 * The building's colour variant is not packed: its hash (`featureHash`) travels in the tile's
 * lookup texture (see `buildingBaseLookup.ts`).
 *
 * A tag's cell counts as a number only when it is a finite number, or a string holding one with an
 * optional trailing `m`; every other cell (missing, null, empty, `12;14`, `30 ft`) counts as absent.
 */

import * as Cesium from 'cesium'
import { getTileFeatureStats } from '@/utils/buildingBaseLookup'
import { isBuildingPart, tagValueNumber } from '@/utils/buildingTags'
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

/** Number of wall colour variants per class, picked by the lookup's per-building hash. */
export const PACK_HASH_STATES = 4

/** Height bucket size in metres. */
export const PACK_HEIGHT_STEP_M = 2

/** The fields the facade shader decodes from a packed colour. */
export interface PackedBuilding {
  facadeClass: number
  levels: number
  heightM: number
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

/** A tag's number, NaN when the cell holds anything else (a multi-value, feet, empty). */
function tagNumber(feature: Feature, name: string): number {
  return tagValueNumber(feature.getProperty(name))
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

/** Smallest footprint a shape-typed hangar has, in m². */
const SHAPE_HANGAR_MIN_AREA_M2 = 1500
/** Tallest `cesium#estimatedHeight` a shape-typed hangar has, in metres. */
const SHAPE_HANGAR_MAX_HEIGHT_M = 20
/** Most storeys a shape-typed hangar has; 0 (none tagged) also passes. */
const SHAPE_HANGAR_MAX_LEVELS = 2
/** Smallest footprint a shape-typed garage has, in m². */
const SHAPE_GARAGE_MIN_AREA_M2 = 1000
/** Fewest storeys a shape-typed garage has. */
const SHAPE_GARAGE_MIN_LEVELS = 4
/** Most storeys a shape-typed garage has. */
const SHAPE_GARAGE_MAX_LEVELS = 8
/** Storey height that turns a tagged height without a levels tag into storeys. */
const SHAPE_METRES_PER_LEVEL = 3

/** Whether a position (degrees) lies where the shape fallback applies; null turns it off. */
type ShapeFallbackArea = (lon: number, lat: number) => boolean

let shapeFallbackArea: ShapeFallbackArea | null = null

/**
 * Sets where the shape fallback types untyped buildings, usually the selected airport's aerodrome
 * boundary. The tileset must be restyled (`makeStyleDirty`) for a change to show.
 *
 * @param contains - Whether a longitude and latitude in degrees lie inside the area, or null for none
 */
export function setShapeFallbackArea(contains: ShapeFallbackArea | null): void {
  shapeFallbackArea = contains
}

/** Whether the shape fallback has an area, so new footprint stats can change a building's class. */
export function isShapeFallbackOn(): boolean {
  return shapeFallbackArea !== null
}

/**
 * The tile content a feature belongs to. Cesium marks the `content` getter `@private`
 * (Source/Scene/Cesium3DTileFeature.js), so its declaration file leaves it out.
 */
function featureContent(feature: Feature): Cesium.Cesium3DTileContent {
  return (feature as unknown as { readonly content: Cesium.Cesium3DTileContent }).content
}

/** What `storeysAndWall` read that the shape rules use. */
interface TaggedSize {
  /** Tagged levels less the tagged `building:min_level`; 0 when no levels are tagged. */
  readonly storeys: number
  /** `part#height` for a part, `height` for a building; NaN when untagged. */
  readonly heightTagM: number
  /** `part#min_height` for a part, `min_height` for a building; 0 when untagged. */
  readonly minHeightM: number
}

/**
 * The class a building's footprint suggests inside the fallback area: large and low is a hangar,
 * large with 4 to 8 storeys a garage, anything else GENERIC. GENERIC too until the feature's tile
 * has its footprint stats, so the building switches class when they arrive.
 *
 * A shape-typed hangar or garage is a guess: a fire station inside the fence gets hangar walls.
 * The checks run cheapest first, the area test on the feature's position last.
 */
function classifyByShape(feature: Feature, area: ShapeFallbackArea, size: TaggedSize): FacadeClassCode {
  const footprint = getTileFeatureStats(featureContent(feature))?.area[feature.featureId]
  const smallest = Math.min(SHAPE_HANGAR_MIN_AREA_M2, SHAPE_GARAGE_MIN_AREA_M2)
  if (footprint === undefined || !(footprint >= smallest)) return FacadeClass.GENERIC
  const shaped = shapeClass(feature, footprint, size)
  if (shaped === FacadeClass.GENERIC) return shaped
  const inside = area(tagNumber(feature, 'cesium#longitude'), tagNumber(feature, 'cesium#latitude'))
  return inside ? shaped : FacadeClass.GENERIC
}

/**
 * The shape rules before the area test. Storeys below 0 count as none tagged. The hangar rule runs
 * first; the garage rule then counts a tagged height above the tagged base in 3 m storeys when no
 * storeys are tagged.
 */
function shapeClass(feature: Feature, footprint: number, size: TaggedSize): FacadeClassCode {
  const storeys = Math.max(size.storeys, 0)
  if (
    footprint >= SHAPE_HANGAR_MIN_AREA_M2 &&
    storeys <= SHAPE_HANGAR_MAX_LEVELS &&
    tagNumber(feature, 'cesium#estimatedHeight') <= SHAPE_HANGAR_MAX_HEIGHT_M
  ) {
    return FacadeClass.HANGAR
  }
  const levels = storeys > 0 ? storeys : Math.round((size.heightTagM - size.minHeightM) / SHAPE_METRES_PER_LEVEL)
  return footprint >= SHAPE_GARAGE_MIN_AREA_M2 && levels >= SHAPE_GARAGE_MIN_LEVELS && levels <= SHAPE_GARAGE_MAX_LEVELS
    ? FacadeClass.GARAGE
    : FacadeClass.GENERIC
}

/** A feature's class from its tags and the outline table, then, when still GENERIC, its shape. */
function classifyWithFallback(feature: Feature, size: TaggedSize): FacadeClassCode {
  const tagged = classifyFeature(feature)
  const area = shapeFallbackArea
  return tagged === FacadeClass.GENERIC && area !== null ? classifyByShape(feature, area, size) : tagged
}

/**
 * Storeys and wall height in metres (NaN when unknown) of the part, or of the building. Part-ness
 * is the feature's own `part#elementId`: a part reads only its own `part#` tags, never the parent
 * building's unprefixed levels or height. Every part of one element carries the element's own
 * `cesium#estimatedHeight`, so a part without its own height stays unknown and the shader keeps
 * the grammar's storey.
 */
function storeysAndWall(feature: Feature): TaggedSize & { wallM: number } {
  const isPart = isBuildingPart(feature)
  const keys = isPart ? PART_KEYS : BUILDING_KEYS
  const levels = isPart ? tagNumber(feature, 'part#building:levels') : tagNumber(feature, 'building:levels')
  const height = isPart ? tagNumber(feature, 'part#height') : tagNumber(feature, 'height')
  const minHeightM = orZero(tagNumber(feature, keys.minHeight))

  const storeys = orZero(levels) - orZero(tagNumber(feature, keys.minLevel))
  const size = { storeys, heightTagM: height, minHeightM }
  if (isPart && Number.isNaN(height)) return { ...size, wallM: Number.NaN }
  const taggedHeight = !Number.isNaN(height)
  const topM = taggedHeight ? height : tagNumber(feature, 'cesium#estimatedHeight')
  const totalM = Math.max(topM - minHeightM, 0)
  const roofM = taggedHeight ? roofHeight(feature, keys, totalM, storeys) : 0
  return { ...size, wallM: totalM - roofM }
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
    const size = storeysAndWall(feature)
    const { storeys, wallM } = size
    const red = 255 - classifyWithFallback(feature, size)
    const green = 255 - clampCode(storeys)
    const blue = 255 - clampCode(wallM / PACK_HEIGHT_STEP_M)
    return Cesium.Color.fromBytes(red, green, blue, 255, result)
  }
}

/**
 * The style for the OSM Buildings tileset. It replaces Cesium's default style, whose
 * `cesium#color` tint the facade palette supersedes.
 *
 * @returns A new style packing class, storeys and wall height into each feature's colour
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
 * @returns The class, storeys (0 unknown) and wall height in metres (0 unknown)
 */
export function decodePackedColour(rgb: readonly [number, number, number]): PackedBuilding {
  const [red, green, blue] = rgb.map((channel) => 255 - channel)
  return {
    facadeClass: red,
    levels: green,
    heightM: blue * PACK_HEIGHT_STEP_M,
  }
}
