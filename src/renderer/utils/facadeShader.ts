/**
 * Procedural facade shader for the Cesium OSM Buildings tileset.
 *
 * Each building's class, storeys and height arrive packed in its style colour (see
 * `buildingStyle.ts`) and pick a facade grammar: a grid of openings laid out in model space, one
 * per storey and bay. Offices and terminals get continuous window bands, houses small punched
 * windows, parking garages open slab bands with dark gaps, hangars door panels with corrugated
 * ribs, domestic garages a plain wall, and every other building the generic window grid; canopies,
 * carports, shops, warehouses, fire stations, hotels, tanks and static caravans have their own looks,
 * each read from the fitted grid. Each fragment finds the wall face it lies on in the tile's face table (see
 * `buildingFaces.ts`), and the grid is fitted to that face: whole bays along its run, between a
 * pier at each end of an open run, and whole rows between a base band and a parapet, so no opening
 * is cut (`facadeFit.ts` holds the TypeScript twins). A fragment on no face draws plain wall. Walls take a colour from a curated palette per
 * class, picked by the building's position hash and jittered by a second hash of it, so neighbours
 * differ. Where a grid cell shrinks under a pixel, the grid can fade to a flat tint, the area-weighted
 * mean of wall and opening in linear light. At night a class's share of the windows glow, in clusters
 * of varied colour and brightness, and the flat tint glows by that share and the mean lit colour.
 * Roofs are left as the tiles draw them.
 */

import * as Cesium from 'cesium'
import {
  FACADE_BASE_BAND_M,
  FACADE_BAY_WIDTH_M,
  FACADE_FADE_END,
  FACADE_FADE_START,
  FACADE_FLOOR_HEIGHT_M,
  FACADE_LIT_SHARE,
  FACADE_PARAPET_M,
  FACADE_PIER_M,
  FACADE_ROOF_COS,
  FACADE_WINDOW_HI,
  FACADE_WINDOW_LO,
  FACE_GATE_COS,
  FACE_PLANE_TOL_M,
  FACE_S_TOL_M,
  FACES_PER_FEATURE_MAX,
} from '@/constants'
import {
  BUILDING_FACES_SAMPLER,
  BUILDING_LOOKUP_DEFINE,
  glslBuildingLookupRead,
  LOOKUP_ROW_GROUND,
  LOOKUP_ROW_TOP,
} from '@/utils/buildingBaseLookup'
import {
  FacadeClass,
  type FacadeClassCode,
  PACK_CODE_MAX,
  PACK_HASH_STATES,
  PACK_HEIGHT_STEP_M,
} from '@/utils/buildingStyle'
import {
  BAND_MIN_M,
  type FacadeLight,
  LIT_BASE,
  LIT_BRIGHT,
  LIT_COOL,
  LIT_CURTAIN,
  LIT_CURTAIN_DIM,
  LIT_DARK_RATE,
  LIT_DIM,
  LIT_GROUP_RATE,
  LIT_GROUP_SCALE,
  LIT_NEUTRAL,
  LIT_PICKS,
  LIT_SILL_SHADE,
  LIT_WARM,
  litMeanLinear,
  STOREY_MAX_M,
  STOREY_MIN_M,
  TINT_JITTER_B,
  TINT_JITTER_HASH,
  TINT_JITTER_L,
  WALL_MIN_M,
} from '@/utils/facadeFit'

type Vec2 = readonly [number, number]
type Vec3 = readonly [number, number, number]

/** Glass colour range in sRGB; each window picks a colour between the two by a hash of its cell. */
const GLASS_DARK_SRGB: Vec3 = [0.1, 0.13, 0.17]
const GLASS_LIGHT_SRGB: Vec3 = [0.22, 0.27, 0.32]

/** Rough enough that Cesium's image-based light adds no second, sun-overhead reflection to the analytic one. */
const GLASS_ROUGHNESS = 0.6

/** The shadowed inside of a garage storey, seen through its open slab band, in sRGB. */
const GAP_SRGB: Vec3 = [0.035, 0.035, 0.04]

const GAP_ROUGHNESS = 0.95

/** Ribbed-metal cladding ribs per metre (a 0.3 m pitch), and the wall shade at the trough and crest of a rib. */
const RIBS_PER_M = 1 / 0.3
const RIB_SHADE_LOW = 0.92
const RIB_SHADE_HIGH = 1.0

/** Share of each rib period on the crest; the crest runs from `1 - share` to the period's end. */
export const RIB_CREST_SHARE = 0.55

/** Narrowest box the rib profile is filtered over, in rib periods, against float noise up close. */
const RIB_FILTER_MIN = 0.01

/** Mean of the rib shade over one rib. */
const RIB_SHADE_MEAN = RIB_SHADE_LOW + (RIB_SHADE_HIGH - RIB_SHADE_LOW) * RIB_CREST_SHARE

/** Hangar door-panel seam: its shade at the seam and its width in cells. */
const SEAM_SHADE = 0.3
const SEAM_WIDTH = 0.01

/** Narrowest box the seam profile is filtered over: a tenth of its width, above float noise. */
export const SEAM_FILTER_MIN = SEAM_WIDTH / 10

/**
 * The rib crest (0 trough, 1 crest) box-filtered over a footprint, as the shader's
 * `facadeRibCrest` computes it: the integral of the square crest profile over the box, divided by
 * its width, so the edges and the wrap between periods blend over the pixel instead of aliasing.
 *
 * @param x - Position in rib periods
 * @param footprint - Box width in rib periods (the pixel footprint)
 * @returns The crest share of the box, 0 to 1
 */
export function ribCrest(x: number, footprint: number): number {
  const width = Math.max(footprint, RIB_FILTER_MIN)
  const troughEnd = 1 - RIB_CREST_SHARE
  const x0 = x - width / 2
  const x1 = x + width / 2
  const base = Math.floor(x0)
  const whole = (Math.floor(x1) - base) * RIB_CREST_SHARE
  const rise = whole + Math.max(x1 - Math.floor(x1) - troughEnd, 0) - Math.max(x0 - base - troughEnd, 0)
  return rise / width
}

/**
 * The hangar door-panel seam's shade (1 away from the seam) box-filtered over a footprint, as the
 * shader's `facadeSeam` computes it: the profile's integral over the box, divided by its width,
 * with the seam repeating at the start of every cell.
 *
 * @param x - Position in cells
 * @param footprint - Box width in cells (the pixel footprint)
 * @returns The mean seam shade over the box, 0.7 at the seam centre when unfiltered
 */
export function seamShade(x: number, footprint: number): number {
  const width = Math.max(footprint, SEAM_FILTER_MIN)
  const x0 = x - width / 2
  const x1 = x + width / 2
  const base = Math.floor(x0)
  const area = (Math.floor(x1) - base) * seamArea(1) + seamArea(x1 - Math.floor(x1)) - seamArea(x0 - base)
  return area / width
}

/** The seam profile's integral over `[0, t]` within one cell. */
function seamArea(t: number): number {
  const ramp = Math.min(Math.max(t, 0), SEAM_WIDTH)
  const u = ramp / SEAM_WIDTH
  const smoothed = SEAM_WIDTH * (u * u * u - 0.5 * u * u * u * u)
  return (1 - SEAM_SHADE) * ramp + SEAM_SHADE * smoothed + Math.max(t - SEAM_WIDTH, 0)
}

/** What fills the opening of a facade grammar's grid cell. */
export type FacadeOpening = 'glass' | 'gap' | 'none'

/**
 * The wall's relief: slab lines at each storey, those plus the panel seams and corrugated ribs of
 * a hangar, or none.
 */
export type FacadeRelief = 'slabs' | 'panels' | 'flat'

/** One facade grammar: its grid cell, the opening in it and the wall's relief. */
export interface FacadeGrammar {
  /** Horizontal spacing of the openings */
  bayM: number
  /** Storey height when the building's storeys and height are not both known */
  floorM: number
  /** Whether a known storey count and height set the storey height */
  storeysFromLevels: boolean
  opening: FacadeOpening
  /** Lower-left corner of the opening in cell space */
  lo: Vec2
  /** Upper-right corner of the opening in cell space */
  hi: Vec2
  relief: FacadeRelief
}

const OFFICE_GRAMMAR: FacadeGrammar = {
  bayM: 1.6,
  floorM: 3.6,
  storeysFromLevels: true,
  opening: 'glass',
  lo: [0.04, 0.28],
  hi: [0.96, 0.9],
  relief: 'slabs',
}

/** The rectangle of a grammar without openings. */
const PLAIN_RECT = { lo: [0, 0], hi: [0, 0] } as const

/** The facade grammar per class. Terminals take the office grammar. */
export const FACADE_GRAMMARS: Readonly<Record<FacadeClassCode, FacadeGrammar>> = {
  [FacadeClass.GENERIC]: {
    bayM: FACADE_BAY_WIDTH_M,
    floorM: FACADE_FLOOR_HEIGHT_M,
    storeysFromLevels: true,
    opening: 'glass',
    lo: FACADE_WINDOW_LO,
    hi: FACADE_WINDOW_HI,
    relief: 'slabs',
  },
  [FacadeClass.GARAGE]: {
    bayM: 8.0,
    floorM: 3.0,
    storeysFromLevels: true,
    opening: 'gap',
    lo: [0.03, 0.3],
    hi: [0.97, 0.92],
    relief: 'slabs',
  },
  [FacadeClass.HANGAR]: {
    bayM: 12.0,
    floorM: 12.0,
    storeysFromLevels: false,
    opening: 'none',
    lo: [0, 0],
    hi: [0, 0],
    relief: 'panels',
  },
  [FacadeClass.HOUSE]: {
    bayM: 3.4,
    floorM: 2.8,
    storeysFromLevels: true,
    opening: 'glass',
    lo: [0.3, 0.35],
    hi: [0.7, 0.8],
    relief: 'slabs',
  },
  [FacadeClass.OFFICE]: OFFICE_GRAMMAR,
  [FacadeClass.TERMINAL]: OFFICE_GRAMMAR,
  [FacadeClass.PLAIN]: {
    bayM: 3.0,
    floorM: 3.0,
    storeysFromLevels: false,
    opening: 'none',
    lo: [0, 0],
    hi: [0, 0],
    relief: 'flat',
  },
  [FacadeClass.CANOPY]: {
    bayM: 7.0,
    floorM: 3.0,
    storeysFromLevels: false,
    opening: 'gap',
    lo: [0.05, 0],
    hi: [0.95, 0.75],
    relief: 'flat',
  },
  [FacadeClass.RETAIL]: {
    bayM: 3.0,
    floorM: 5.0,
    storeysFromLevels: false,
    opening: 'glass',
    lo: [0.03, 0.08],
    hi: [0.97, 0.45],
    relief: 'flat',
  },
  [FacadeClass.WAREHOUSE]: {
    bayM: 4.2,
    floorM: 12.0,
    storeysFromLevels: false,
    opening: 'none',
    ...PLAIN_RECT,
    relief: 'flat',
  },
  [FacadeClass.FIRE_STATION]: {
    bayM: 5.1,
    floorM: 5.0,
    storeysFromLevels: false,
    opening: 'glass',
    lo: [0.3, 0.3],
    hi: [0.7, 0.8],
    relief: 'flat',
  },
  [FacadeClass.HOTEL]: {
    bayM: 3.8,
    floorM: 3.0,
    storeysFromLevels: true,
    opening: 'glass',
    lo: [0.22, 0.3],
    hi: [0.78, 0.85],
    relief: 'slabs',
  },
  [FacadeClass.TANK]: {
    bayM: 3.0,
    floorM: 2.4,
    storeysFromLevels: false,
    opening: 'none',
    ...PLAIN_RECT,
    relief: 'flat',
  },
  [FacadeClass.CARPORT]: {
    bayM: 8.0,
    floorM: 3.0,
    storeysFromLevels: false,
    opening: 'gap',
    lo: [0.05, 0],
    hi: [0.95, 0.85],
    relief: 'flat',
  },
  [FacadeClass.CARAVAN]: {
    bayM: 3.4,
    floorM: 2.8,
    storeysFromLevels: false,
    opening: 'none',
    ...PLAIN_RECT,
    relief: 'flat',
  },
}

/** Mixes of lit colour: warm-led, and the cool-neutral of offices and terminals. */
const WARM_LED = { warm: 0.55, neutral: 0.3 } as const
const COOL_LED = { warm: 0.2, neutral: 0.4 } as const

/** Bays a lit group spans along a row; this many or more lights whole floors. */
const GROUP_BAYS = 4
const WHOLE_FLOOR_BAYS = 65536

const CURTAINED_SHARE = 0.3

const DARK_LIGHT: FacadeLight = { share: 0, ...WARM_LED, curtain: 0, groupBays: GROUP_BAYS, level: 1 }

/** The night lights per class; the share stays a constant of the class at any hour. */
export const FACADE_LIGHTS: Readonly<Record<FacadeClassCode, FacadeLight>> = {
  [FacadeClass.GENERIC]: { ...DARK_LIGHT, share: FACADE_LIT_SHARE },
  [FacadeClass.GARAGE]: DARK_LIGHT,
  [FacadeClass.HANGAR]: DARK_LIGHT,
  [FacadeClass.HOUSE]: { ...DARK_LIGHT, share: 0.35, warm: 1, neutral: 0, curtain: CURTAINED_SHARE },
  [FacadeClass.OFFICE]: { ...DARK_LIGHT, ...COOL_LED, share: 0.15, groupBays: WHOLE_FLOOR_BAYS },
  [FacadeClass.TERMINAL]: { ...DARK_LIGHT, ...COOL_LED, share: 0.85, groupBays: 8, level: 0.55 },
  [FacadeClass.PLAIN]: DARK_LIGHT,
  [FacadeClass.CANOPY]: DARK_LIGHT,
  [FacadeClass.RETAIL]: { ...DARK_LIGHT, share: 0.7, warm: 0, neutral: 1, level: 0.7 },
  [FacadeClass.WAREHOUSE]: DARK_LIGHT,
  [FacadeClass.FIRE_STATION]: { ...DARK_LIGHT, share: 0.4 },
  [FacadeClass.HOTEL]: { ...DARK_LIGHT, share: 0.5, curtain: CURTAINED_SHARE },
  [FacadeClass.TANK]: DARK_LIGHT,
  [FacadeClass.CARPORT]: DARK_LIGHT,
  [FacadeClass.CARAVAN]: DARK_LIGHT,
}

/** Fresnel reflectance at normal incidence: clear glass, and the coated glass of offices and terminals. */
const GLASS_F0_CLEAR = 0.08
const GLASS_F0_COATED = 0.22

/** Share of the way to white every wall tone is lightened, in sRGB. */
const WALL_LIGHTEN = 0.25

/**
 * Wall tones per class in sRGB, one per hash state, before `WALL_LIGHTEN`, so neighbouring buildings
 * of one class differ in tone.
 */
const WALL_TONES: Readonly<Record<FacadeClassCode, readonly Vec3[]>> = {
  [FacadeClass.GENERIC]: [
    [0.82, 0.8, 0.76],
    [0.74, 0.75, 0.76],
    [0.86, 0.84, 0.8],
    [0.78, 0.72, 0.64],
  ],
  [FacadeClass.GARAGE]: [
    [0.72, 0.72, 0.7],
    [0.66, 0.66, 0.65],
    [0.78, 0.77, 0.74],
    [0.7, 0.68, 0.64],
  ],
  [FacadeClass.HANGAR]: [
    [0.84, 0.85, 0.86],
    [0.76, 0.78, 0.8],
    [0.88, 0.87, 0.83],
    [0.7, 0.73, 0.74],
  ],
  [FacadeClass.HOUSE]: [
    [0.9, 0.88, 0.84],
    [0.66, 0.44, 0.36],
    [0.8, 0.76, 0.66],
    [0.7, 0.7, 0.7],
  ],
  [FacadeClass.OFFICE]: [
    [0.8, 0.8, 0.78],
    [0.68, 0.72, 0.76],
    [0.86, 0.84, 0.8],
    [0.72, 0.7, 0.66],
  ],
  [FacadeClass.TERMINAL]: [
    [0.88, 0.89, 0.9],
    [0.8, 0.82, 0.84],
    [0.9, 0.88, 0.84],
    [0.76, 0.78, 0.8],
  ],
  [FacadeClass.PLAIN]: [
    [0.84, 0.82, 0.78],
    [0.72, 0.7, 0.66],
    [0.78, 0.74, 0.68],
    [0.66, 0.65, 0.63],
  ],
  [FacadeClass.CANOPY]: [
    [0.92, 0.92, 0.9],
    [0.8, 0.82, 0.84],
    [0.95, 0.94, 0.9],
    [0.62, 0.65, 0.68],
  ],
  [FacadeClass.RETAIL]: [
    [0.82, 0.76, 0.66],
    [0.74, 0.72, 0.68],
    [0.86, 0.82, 0.74],
    [0.7, 0.66, 0.6],
  ],
  [FacadeClass.WAREHOUSE]: [
    [0.8, 0.79, 0.76],
    [0.84, 0.8, 0.72],
    [0.88, 0.87, 0.84],
    [0.72, 0.73, 0.74],
  ],
  [FacadeClass.FIRE_STATION]: [
    [0.78, 0.68, 0.54],
    [0.6, 0.36, 0.28],
    [0.84, 0.8, 0.72],
    [0.74, 0.66, 0.56],
  ],
  [FacadeClass.HOTEL]: [
    [0.9, 0.88, 0.84],
    [0.84, 0.8, 0.72],
    [0.78, 0.78, 0.78],
    [0.88, 0.84, 0.78],
  ],
  [FacadeClass.TANK]: [
    [0.93, 0.93, 0.92],
    [0.86, 0.87, 0.88],
    [0.95, 0.95, 0.94],
    [0.8, 0.82, 0.83],
  ],
  [FacadeClass.CARPORT]: [
    [0.62, 0.64, 0.65],
    [0.56, 0.58, 0.59],
    [0.66, 0.67, 0.68],
    [0.6, 0.62, 0.64],
  ],
  [FacadeClass.CARAVAN]: [
    [0.9, 0.89, 0.87],
    [0.88, 0.88, 0.86],
    [0.92, 0.91, 0.88],
    [0.86, 0.86, 0.85],
  ],
}

function lightened(tone: Vec3): Vec3 {
  return [0, 1, 2].map((i) => 1 - (1 - tone[i]) * (1 - WALL_LIGHTEN)) as unknown as Vec3
}

/**
 * Wall colours per class in sRGB, one per hash state. The tiles' own base colour is white, so these
 * are the walls' colours.
 */
export const FACADE_PALETTES: Readonly<Record<FacadeClassCode, readonly Vec3[]>> = Object.fromEntries(
  Object.values(FacadeClass).map((code) => [code, WALL_TONES[code].map(lightened)]),
) as unknown as Record<FacadeClassCode, readonly Vec3[]>

/**
 * The wall colour a building gets: its class palette's entry at its palette index.
 *
 * @param facadeClass - The building's facade class
 * @param paletteIndex - The building's palette index, `featureHash` floored by `PACK_HASH_STATES`
 * @returns The wall colour in sRGB
 */
export function wallColourSrgb(facadeClass: FacadeClassCode, paletteIndex: number): Vec3 {
  const palette = FACADE_PALETTES[facadeClass]
  return palette[paletteIndex % palette.length]
}

const CLASS_CODES = Object.values(FacadeClass)

const OPENING_KIND: Record<FacadeOpening, number> = { glass: 0, gap: 1, none: 2 }

/**
 * Share of a grid cell the window rectangle covers.
 *
 * @param lo - Lower-left corner of the window in cell space
 * @param hi - Upper-right corner of the window in cell space
 * @returns The rectangle's area as a fraction of the unit cell
 */
export function windowCoverage(lo: Vec2, hi: Vec2): number {
  return (hi[0] - lo[0]) * (hi[1] - lo[1])
}

/**
 * Share of a class's grid cell its opening covers; 0 for a grammar without openings.
 *
 * @param facadeClass - The building's facade class
 * @returns The opening's area as a fraction of the unit cell
 */
export function grammarCoverage(facadeClass: FacadeClassCode): number {
  const grammar = FACADE_GRAMMARS[facadeClass]
  return grammar.opening === 'none' ? 0 : windowCoverage(grammar.lo, grammar.hi)
}

/** sRGB to linear light by the IEC 61966-2-1 transfer curve. */
function srgbChannelToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

function srgbToLinear(colour: Vec3): [number, number, number] {
  return [srgbChannelToLinear(colour[0]), srgbChannelToLinear(colour[1]), srgbChannelToLinear(colour[2])]
}

/**
 * Mean glass colour in linear light: the mean of the two glass end colours, each converted
 * from sRGB by the IEC 61966-2-1 curve.
 *
 * @returns Linear RGB of the glass the far tint mixes with the wall
 */
export function meanGlassLinear(): [number, number, number] {
  const mean = (i: number) => (srgbChannelToLinear(GLASS_DARK_SRGB[i]) + srgbChannelToLinear(GLASS_LIGHT_SRGB[i])) / 2
  return [mean(0), mean(1), mean(2)]
}

/**
 * Mean colour of a class's opening in linear light, which the far tint mixes with the wall by
 * the opening's coverage: the dark gap for garages, the mean glass otherwise (a grammar without
 * openings covers nothing, so its mean never shows).
 *
 * @param facadeClass - The building's facade class
 * @returns Linear RGB of the opening
 */
export function openingMeanLinear(facadeClass: FacadeClassCode): [number, number, number] {
  return FACADE_GRAMMARS[facadeClass].opening === 'gap' ? srgbToLinear(GAP_SRGB) : meanGlassLinear()
}

/** An sRGB hex colour as 0-1 channels. */
function hexSrgb(hex: string): Vec3 {
  const n = Number.parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** A number as a GLSL float literal (GLSL ES rejects `3` where a float is expected). */
function glslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : `${value}`
}

function glslVec3(value: Vec3): string {
  return `vec3(${value.map(glslFloat).join(', ')})`
}

function glslVec2(value: Vec2): string {
  return `vec2(${value.map(glslFloat).join(', ')})`
}

function glslVec4(value: readonly [number, number, number, number]): string {
  return `vec4(${value.map(glslFloat).join(', ')})`
}

/** An sRGB hex colour as a GLSL linear-light vec3 literal. */
function lin(hex: string): string {
  return glslVec3(srgbToLinear(hexSrgb(hex)))
}

/**
 * A GLSL function of the class code returning one value per class, as a chain of selects, so
 * calling it adds no branch before the derivatives are taken.
 */
function glslPerClass(
  name: string,
  type: string,
  params: string,
  value: (facadeClass: FacadeClassCode) => string,
): string {
  const chain = CLASS_CODES.filter((code) => code !== FacadeClass.GENERIC).reduceRight(
    (otherwise, code) => `facadeClass == ${glslFloat(code)} ? ${value(code)} : (${otherwise})`,
    value(FacadeClass.GENERIC),
  )
  return `${type} ${name}(${params}) {\n  return ${chain};\n}`
}

/** Selects a class's palette entry by `paletteIndex`, mirroring `wallColourSrgb`, in linear light. */
function glslPaletteEntry(facadeClass: FacadeClassCode): string {
  const palette = FACADE_PALETTES[facadeClass].map(srgbToLinear)
  return palette
    .slice(1)
    .reduceRight(
      (otherwise, entry, i) => `paletteIndex == ${glslFloat(i + 1)} ? ${glslVec3(entry)} : (${otherwise})`,
      glslVec3(palette[0]),
    )
}

const WALL_GLSL = glslPerClass('facadeWallLinear', 'vec3', 'float facadeClass, float paletteIndex', glslPaletteEntry)

/** Per relief: (slab lines on, panel seams and ribs on). */
const RELIEF_VALUES: Record<FacadeRelief, Vec2> = { slabs: [1, 0], panels: [1, 1], flat: [0, 0] }

const RELIEF_GLSL = glslPerClass('facadeRelief', 'vec2', 'float facadeClass', (code) => {
  const [slabs, panels] = RELIEF_VALUES[FACADE_GRAMMARS[code].relief]
  return `vec2(${glslFloat(slabs)}, ${glslFloat(panels)})`
})

const CELL_GLSL = glslPerClass('facadeCell', 'vec4', 'float facadeClass', (code) => {
  const grammar = FACADE_GRAMMARS[code]
  return glslVec4([grammar.bayM, grammar.floorM, OPENING_KIND[grammar.opening], grammar.storeysFromLevels ? 1 : 0])
})

const OPENING_RECT_GLSL = glslPerClass('facadeOpeningRect', 'vec4', 'float facadeClass', (code) => {
  const { lo, hi } = FACADE_GRAMMARS[code]
  return glslVec4([lo[0], lo[1], hi[0], hi[1]])
})

const COVER_GLSL = glslPerClass('facadeCover', 'float', 'float facadeClass', (code) => glslFloat(grammarCoverage(code)))

const LIT_SHARE_GLSL = glslPerClass('facadeLitShare', 'float', 'float facadeClass', (code) =>
  glslFloat(FACADE_LIGHTS[code].share),
)

const LIT_LEVEL_GLSL = glslPerClass('facadeLitLevel', 'float', 'float facadeClass', (code) =>
  glslFloat(FACADE_LIGHTS[code].level),
)

const LIT_MIX_GLSL = glslPerClass('facadeLitMix', 'vec4', 'float facadeClass', (code) => {
  const { warm, neutral, curtain, groupBays } = FACADE_LIGHTS[code]
  return glslVec4([warm, neutral, curtain, groupBays])
})

const LIT_MEAN_GLSL = glslPerClass('facadeLitMean', 'vec3', 'float facadeClass', (code) =>
  glslVec3(litMeanLinear(FACADE_LIGHTS[code])),
)

const COATED_CLASSES: readonly FacadeClassCode[] = [FacadeClass.OFFICE, FacadeClass.TERMINAL]

const GLASS_F0_GLSL = glslPerClass('facadeGlassF0', 'float', 'float facadeClass', (code) =>
  glslFloat(COATED_CLASSES.includes(code) ? GLASS_F0_COATED : GLASS_F0_CLEAR),
)

const WASHED_CLASSES: readonly FacadeClassCode[] = [
  FacadeClass.TERMINAL,
  FacadeClass.RETAIL,
  FacadeClass.FIRE_STATION,
  FacadeClass.HOTEL,
]

const WASH_GLSL = glslPerClass('facadeWash', 'float', 'float facadeClass', (code) =>
  glslFloat(WASHED_CLASSES.includes(code) ? 1 : 0),
)

const FRAME_COLOURS_GLSL = ['#3B3631', '#A9ACAE', '#E9E7E1', '#1E1F21'].map(lin)

/** Packed heights at or above this are saturated and say nothing about the storey height. */
const SATURATED_HEIGHT_M = PACK_CODE_MAX * PACK_HEIGHT_STEP_M

/**
 * The face match and the window fit, mirroring `matchFace` and `fitOpening` in `facadeFit.ts` line
 * for line. The match reads the face table (`buildingFaces.ts`, three texels per face) only where
 * the patched stage binds it, and takes no derivative, so it can run after the far return.
 */
const FACE_FIT_GLSL = /* glsl */ `
const int FACADE_FACES_MAX = ${FACES_PER_FEATURE_MAX};
const float FACADE_FACE_GATE_COS = ${glslFloat(FACE_GATE_COS)};
const float FACADE_FACE_PLANE_TOL = ${glslFloat(FACE_PLANE_TOL_M)};
const float FACADE_FACE_S_TOL = ${glslFloat(FACE_S_TOL_M)};
const float FACADE_PIER = ${glslFloat(FACADE_PIER_M)};
const float FACADE_BASE_BAND = ${glslFloat(FACADE_BASE_BAND_M)};
const float FACADE_PARAPET = ${glslFloat(FACADE_PARAPET_M)};
const float FACADE_STOREY_MIN = ${glslFloat(STOREY_MIN_M)};
const float FACADE_STOREY_MAX = ${glslFloat(STOREY_MAX_M)};
const float FACADE_BAND_MIN = ${glslFloat(BAND_MIN_M)};
const float FACADE_WALL_MIN = ${glslFloat(WALL_MIN_M)};
#if defined(HAS_SELECTED_FEATURE_ID) && defined(${BUILDING_LOOKUP_DEFINE})
ivec2 facadeFaceTexel(int k) {
  ivec2 size = textureSize(${BUILDING_FACES_SAMPLER}, 0);
  return ivec2(k % size.x, min(k / size.x, size.y - 1));
}
// The first face of the feature's range [first, first + count) that p (relative to the feature's
// base) lies on: 1 when one matches, with run = (u along its run, the run's length, negative for a
// closed loop, the index of the run's first face) and heights = the face's (bottom, top) along up.
float facadeFace(int first, int count, vec3 p, vec3 n, vec3 up, out vec3 run, out vec2 heights) {
  run = vec3(0.0);
  heights = vec2(0.0);
  for (int i = 0; i < FACADE_FACES_MAX; i++) {
    if (i >= count) break;
    int k = 3 * (first + i);
    vec4 plane = texelFetch(${BUILDING_FACES_SAMPLER}, facadeFaceTexel(k), 0);
    if (dot(n, plane.xyz) < FACADE_FACE_GATE_COS || abs(dot(p, plane.xyz) - plane.w) > FACADE_FACE_PLANE_TOL) continue;
    vec4 ends = texelFetch(${BUILDING_FACES_SAMPLER}, facadeFaceTexel(k + 1), 0);
    float s = dot(p, normalize(cross(up, plane.xyz)));
    if (s < ends.x - FACADE_FACE_S_TOL || s > ends.y + FACADE_FACE_S_TOL) continue;
    vec4 span = texelFetch(${BUILDING_FACES_SAMPLER}, facadeFaceTexel(k + 2), 0);
    run = vec3(ends.z + clamp(s, ends.x, ends.y) - ends.x, ends.w, span.z);
    heights = span.xy;
    return 1.0;
  }
  return 0.0;
}
#else
float facadeFace(int first, int count, vec3 p, vec3 n, vec3 up, out vec3 run, out vec2 heights) {
  run = vec3(0.0);
  heights = vec2(0.0);
  return 0.0;
}
#endif
// The wall's (base band, parapet): their full heights, shrunk in proportion on a wall too short for
// those and a lowest row, each down to the thinnest band.
vec2 facadeBands(float wall) {
  float scale = clamp((wall - FACADE_STOREY_MIN) / (FACADE_BASE_BAND + FACADE_PARAPET), 0.0, 1.0);
  return max(vec2(FACADE_BASE_BAND, FACADE_PARAPET) * scale, vec2(FACADE_BAND_MIN));
}
// Fits whole bays along the matched face's run, between a pier at each end of an open run, and
// whole rows between the face's base band and parapet: 1 where the point lies in a cell of that
// grid, with cell = its place in bays from the first pier and rows from the base band and size =
// (bay width, row pitch); 0, with both zero, where the face draws no openings.
float facadeFit(float matched, vec3 run, vec2 heights, float h, vec4 grammar, float levels, out vec2 cell, out vec2 size) {
  cell = vec2(0.0);
  size = vec2(0.0);
  float closed = run.y < 0.0 ? 1.0 : 0.0;
  float len = abs(run.y);
  float pier = (1.0 - closed) * FACADE_PIER;
  float span = len - 2.0 * pier;
  float wall = heights.y - heights.x;
  vec2 bands = facadeBands(wall);
  float bottom = heights.x + bands.x;
  float usable = heights.y - bands.y - bottom;
  if (matched < 0.5 || span <= 0.0 || wall < FACADE_WALL_MIN) return 0.0;
  float bays = max(1.0, floor(span / grammar.x + 0.5));
  float bay = span / bays;
  float wanted = grammar.w > 0.5 && levels >= 1.0
    ? max(levels, ceil(usable / FACADE_STOREY_MAX))
    : max(1.0, floor(usable / grammar.y + 0.5));
  float rows = max(1.0, min(wanted, floor(usable / FACADE_STOREY_MIN)));
  float pitch = usable / rows;
  float along = closed > 0.5 ? mod(run.x, len) : run.x - pier;
  cell = vec2(along / bay, (h - bottom) / pitch);
  size = vec2(bay, pitch);
  vec2 index = floor(cell);
  return step(0.0, index.x) * step(index.x, bays - 1.0) * step(0.0, index.y) * step(index.y, rows - 1.0);
}
`

/**
 * The near looks, drawn on the fitted grid: each takes its cell, row and place in the cell from
 * `facadeFit`, and everything it adds to the wall lies inside the cell or a band, so no detail is cut
 * by a roof line or a face end. Windows are framed, recessed and sill-hung, glazed as an interior
 * behind an analytic Fresnel reflection, and lit in clusters. Each class stays under eight boxes.
 */
const LOOK_GLSL = /* glsl */ `
// One wall fragment as the looks read it: q = metres into the cell, size = (bay, pitch), lo and hi =
// the grammar's opening in metres, y = metres above the run's bottom, wallH = the run's height,
// bands = (base band, parapet), longest = 1 on the feature's longest run, hash = the palette index.
struct FacadeCtx {
  vec3 wall;
  vec3 refl;
  vec3 frame;
  vec3 glow;
  vec3 tint;
  vec2 m;
  vec2 id;
  vec2 q;
  vec2 size;
  vec2 lo;
  vec2 hi;
  vec2 bands;
  float y;
  float wallH;
  float inside;
  float longest;
  float hash;
  float seed;
  float F;
  float night;
  float tierA;
  float sunSide;
  float lit;
  float share;
  float blinds;
  float pick;
  float glassPick;
  float blindPick;
  float ribShade;
};
struct FacadeDraw {
  vec3 col;
  vec3 emi;
  float rough;
  float base;
  float coping;
  float grime;
};
float facadeBand(float y, float lo, float hi, float my) {
  return smoothstep(lo - my, lo + my, y) * (1.0 - smoothstep(hi - my, hi + my, y));
}
float facadeBelow(float y, float top, float my) {
  return 1.0 - smoothstep(top - my, top + my, y);
}
// Mirrors windowLit() in facadeFit.ts: a group of bays in a row is picked lit or dark, then most of a
// lit group's windows glow and few of a dark group's, keeping the class's share on average.
float facadeWindowLit(vec2 id, float runId, float litPick, float share, float groupBays) {
  float rate = max(${glslFloat(LIT_GROUP_RATE)}, share);
  float dark = min(${glslFloat(LIT_DARK_RATE)}, share);
  float groups = (share - dark) / (rate - dark);
  float group = facadeHash12(vec2(facadeHash12(vec2(floor(id.x / groupBays), id.y) * ${glslFloat(LIT_GROUP_SCALE)}), runId));
  return litPick < (group < groups ? rate : dark) ? 1.0 : 0.0;
}
// Mirrors litGlow() in facadeFit.ts. light = (warm share, neutral share, curtained share, group bays).
vec3 facadeLitGlow(vec3 picks, vec4 light, float level) {
  vec3 colour = picks.x < light.x ? ${glslVec3(LIT_WARM)}
    : (picks.x < light.x + light.y ? ${glslVec3(LIT_NEUTRAL)} : ${glslVec3(LIT_COOL)});
  float curtained = picks.z < light.z ? 1.0 : 0.0;
  float scale = ${glslFloat(LIT_BASE)} * level * mix(${glslFloat(LIT_DIM)}, ${glslFloat(LIT_BRIGHT)}, picks.y);
  return mix(colour, ${glslVec3(LIT_CURTAIN)}, curtained) * scale * mix(1.0, ${glslFloat(LIT_CURTAIN_DIM)}, curtained);
}
// One framed, recessed window with its sill in the cell. sillTier: -1 none, 0 near tier only, 1 mid too.
void facadePane(vec2 lo, vec2 hi, float sillTier, FacadeCtx c, inout FacadeDraw d) {
  vec2 q = c.q;
  float b = c.size.x;
  float fw = min(0.035 * b, 0.1);
  float wW = hi.x - lo.x;
  float wH = hi.y - lo.y;
  float sillOn = step(-0.5, sillTier);
  float sillLo = lo.y - 0.05 * c.size.y;
  float sill = facadeBox(q, vec2(lo.x - 0.04 * b, sillLo), vec2(hi.x + 0.04 * b, lo.y), c.m) * mix(c.tierA, 1.0, max(sillTier, 0.0)) * sillOn;
  float streak = facadeBox(q, vec2(lo.x + 0.1 * wW, sillLo - 0.6), vec2(hi.x - 0.1 * wW, sillLo), c.m) * c.tierA * sillOn;
  d.col *= mix(1.0, mix(0.92, 1.0, clamp((sillLo - q.y) / 0.6, 0.0, 1.0)), streak);
  d.col = mix(d.col, c.wall * 1.12, sill);
  float opening = facadeBox(q, lo, hi, c.m);
  float pane = facadeBox(q, lo + fw, hi - fw, c.m);
  float fy = clamp((q.y - lo.y - fw) / max(wH - 2.0 * fw, 0.01), 0.0, 1.0);
  vec3 interior = mix(vec3(0.008, 0.009, 0.01), vec3(0.025, 0.026, 0.027), c.glassPick) * c.tint;
  float blind = step(c.blindPick, 0.25 * c.blinds) * step(mix(0.2, 0.6, c.pick), fy) * step(fy, 0.95);
  interior = mix(interior, ${lin('#B4AEA2')} * 0.6, blind);
  vec3 glass = interior * (1.0 - c.F);
  float topShadow = facadeBox(q, vec2(lo.x + fw, hi.y - fw - 0.06 * wH), hi - fw, c.m);
  float sideX = c.sunSide > 0.0 ? hi.x - fw - 0.04 * b : lo.x + fw;
  float sideShadow = facadeBox(q, vec2(sideX, lo.y + fw), vec2(sideX + 0.04 * b, hi.y - fw), c.m) * (1.0 - topShadow);
  float midX = 0.5 * (lo.x + hi.x);
  float mullion = step(1.3, wW) * c.tierA * facadeBox(q, vec2(midX - 0.011 * b, lo.y), vec2(midX + 0.011 * b, hi.y), c.m);
  vec3 midFrame = mix(c.wall, glass + c.refl * c.F, 0.5) * 0.85;
  d.col = mix(d.col, mix(midFrame, c.frame, c.tierA), opening);
  d.col = mix(d.col, glass, pane);
  d.col = mix(d.col, c.wall * 0.55, topShadow * pane);
  d.col = mix(d.col, c.wall * 0.7, sideShadow * pane);
  d.col = mix(d.col, c.frame, mullion);
  float show = pane * (1.0 - topShadow) * (1.0 - sideShadow) * (1.0 - mullion);
  d.rough = mix(d.rough, ${glslFloat(GLASS_ROUGHNESS)}, opening);
  d.emi += show * c.refl * c.F;
  d.emi += show * c.night * (c.lit * mix(${glslFloat(LIT_SILL_SHADE)}, 1.0, fy) * c.glow + (1.0 - c.lit) * ${lin('#0B0E14')});
}
void facadeGeneric(FacadeCtx c, inout FacadeDraw d) {
  float b = c.size.x;
  float S = c.size.y;
  if (c.hash > 2.5) {
    // A brick wainscot with a soldier course at its head, stucco above (schools, civic).
    d.col = mix(d.col, ${lin('#A8705C')}, facadeBelow(c.y, 1.0, c.m.y));
    d.col *= 1.0 - 0.1 * facadeBand(c.y, 0.8, 1.0, c.m.y);
  }
  if (c.inside < 0.5) return;
  if (c.id.y < 0.5 && S >= 3.0 && c.pick < 0.1) {
    // A glazed entry under a canopy line.
    float top = min(2.4, 0.85 * S);
    d.col *= 1.0 - 0.28 * facadeBox(c.q, vec2(0.2 * b, top + 0.05), vec2(0.8 * b, top + 0.3), c.m);
    c.tint = vec3(1.6);
    facadePane(vec2(0.3 * b, 0.0), vec2(0.7 * b, top), -1.0, c, d);
    return;
  }
  if (c.hash > 1.5 && c.hash < 2.5) {
    float mid = 0.5 * (c.lo.x + c.hi.x);
    facadePane(c.lo, vec2(mid - 0.075 * b, c.hi.y), 1.0, c, d);
    facadePane(vec2(mid + 0.075 * b, c.lo.y), c.hi, 1.0, c, d);
    return;
  }
  facadePane(c.lo, c.hi, 1.0, c, d);
}
void facadeOffice(FacadeCtx c, inout FacadeDraw d) {
  if (c.inside < 0.5) return;
  float b = c.size.x;
  float S = c.size.y;
  c.blinds = 0.0;
  c.tint = c.hash > 0.5 && c.hash < 1.5 ? vec3(0.45, 1.35, 1.55) : (c.hash > 1.5 && c.hash < 2.5 ? vec3(1.45, 0.95, 0.6) : vec3(1.0));
  if (c.id.y < 0.5) {
    facadePane(vec2(0.0), vec2(b, 0.92 * S), -1.0, c, d);
    return;
  }
  float curtain = step(0.5, c.hash) * step(c.hash, 1.5);
  float visionLo = mix(c.lo.y, 0.25 * S, curtain);
  float spandrel = curtain * facadeBelow(c.q.y, visionLo, c.m.y);
  d.col = mix(d.col, ${lin('#2B3138')} * (1.0 - c.F), spandrel);
  d.emi += spandrel * c.refl * c.F;
  d.rough = mix(d.rough, ${glslFloat(GLASS_ROUGHNESS)}, spandrel);
  facadePane(vec2(0.0, visionLo), vec2(b, S), -1.0, c, d);
}
void facadeTerminal(FacadeCtx c, inout FacadeDraw d) {
  // A full-height curtain wall under a metal fascia; a low box, a skybridge, is a glass band between white beams.
  float low = 1.0 - step(6.0, c.wallH);
  float fascia = smoothstep(c.wallH - c.bands.y - c.m.y, c.wallH - c.bands.y + c.m.y, c.y);
  d.col = mix(d.col, mix(${lin('#C9CDD0')}, ${lin('#E9E7E1')}, low), max(low, fascia));
  d.base = 1.0 - low;
  if (c.inside < 0.5) return;
  float b = c.size.x;
  float S = c.size.y;
  c.blinds = 0.0;
  facadePane(vec2(0.0, mix(0.0, 0.18, low) * S), vec2(b, mix(1.0, 0.82, low) * S), -1.0, c, d);
  float fin = (1.0 - low) * step(mod(c.id.x, 7.0), 0.5) * facadeBox(c.q, vec2(0.0), vec2(0.5, S), c.m);
  d.col = mix(d.col, ${lin('#E9E7E1')}, fin);
  d.emi *= 1.0 - fin;
  d.rough = mix(d.rough, 0.5, fin);
}
void facadeHangar(FacadeCtx c, inout FacadeDraw d) {
  // Ribbed metal over a concrete wainscot; the door, ribbed leaves of a tone each, on the longest run only.
  d.col = mix(d.col, ${lin('#CFCBC2')}, facadeBelow(c.y, 1.0, c.m.y));
  d.emi += 0.06 * c.wall * c.night * facadeBelow(c.y, 6.0, 1.0);
  if (c.longest < 0.5 || c.inside < 0.5 || c.id.y > 0.5) return;
  float S = c.size.y;
  float door = facadeBelow(c.q.y, 0.8 * S, c.m.y);
  float tone = 0.97 + 0.06 * facadeHash12(vec2(c.id.x, c.seed + 3.0));
  vec3 paint = mod(c.seed, 2.0) < 1.0 ? ${lin('#3C5F8C')} : ${lin('#E6E6E2')};
  vec3 leaf = mix(d.col * 0.82, paint * c.ribShade, step(1.5, c.hash) * step(c.hash, 2.5));
  d.col = mix(d.col, leaf * tone, door);
  d.col *= 1.0 - 0.28 * facadeBand(c.q.y, 0.8 * S, 0.8 * S + 0.08, c.m.y);
  float strip = step(0.5, c.hash) * step(c.hash, 1.5) * facadeBand(c.q.y, 1.0, 1.6, c.m.y);
  d.col = mix(d.col, vec3(0.02) * (1.0 - c.F), strip);
  d.emi += strip * (c.refl * c.F + c.night * ${glslVec3(LIT_COOL)} * 0.8);
  d.rough = mix(d.rough, ${glslFloat(GLASS_ROUGHNESS)}, strip);
}
void facadeHouse(FacadeCtx c, inout FacadeDraw d) {
  float lap = c.tierA * facadeBand(mod(c.y, 0.2), 0.08, 0.1, c.m.y);
  if (c.hash > 1.5) d.col *= 1.0 - 0.1 * lap;
  if (c.inside < 0.5 || c.pick < 0.4) return;
  c.frame = ${lin('#E9E7E1')};
  facadePane(c.lo, c.hi, 0.0, c, d);
}
void facadeCaravan(FacadeCtx c, inout FacadeDraw d) {
  // White lap siding, a trim stripe and a dark skirting.
  d.base = 0.0;
  d.col *= 1.0 - 0.12 * c.tierA * facadeBand(mod(c.y, 0.2), 0.08, 0.1, c.m.y);
  d.col = mix(d.col, ${lin('#7A8088')}, facadeBand(c.y, 1.6, 1.7, c.m.y));
  d.col = mix(d.col, ${lin('#6D6A63')}, facadeBelow(c.y, 0.6, c.m.y));
}
void facadeGarage(FacadeCtx c, inout FacadeDraw d) {
  // Upstands over dark open decks, the slab underside lighter at the top of each opening.
  if (c.inside < 0.5) return;
  float open = facadeBox(c.q, c.lo, c.hi, c.m);
  float depth = clamp((c.q.y - c.lo.y) / max(c.hi.y - c.lo.y, 0.1), 0.0, 1.0);
  vec3 deck = mix(${glslVec3(srgbToLinear(GAP_SRGB))}, ${lin('#5A5A57')} * 0.7, smoothstep(0.72, 0.86, depth));
  float cable = facadeBand(depth, 0.1, 0.11, c.m.y) + facadeBand(depth, 0.25, 0.26, c.m.y) + facadeBand(depth, 0.4, 0.41, c.m.y);
  d.col = mix(d.col, mix(deck, ${lin('#9EA3A6')}, min(cable, 1.0) * c.tierA), open);
  d.rough = mix(d.rough, ${glslFloat(GAP_ROUGHNESS)}, open);
  vec3 led = c.hash < 0.5 ? vec3(1.0, 0.62, 0.25) : vec3(0.9, 0.95, 1.0);
  d.emi += c.night * led * open * (1.2 * step(0.92, depth) + 0.05);
}
void facadeCanopy(FacadeCtx c, float carport, inout FacadeDraw d) {
  // A roof on posts: a fuel canopy's fascia on a dark drip line or a carport's steel edge, a light or
  // solar underside at the top, and the far side seen through below, never a black box.
  d.base = 0.0;
  d.coping = 0.0;
  d.grime = 0.0;
  float T = c.wallH;
  float edgeLo = T - mix(0.9, 0.3, carport);
  float underTop = edgeLo - 0.08 * (1.0 - carport);
  float fascia = smoothstep(edgeLo - c.m.y, edgeLo + c.m.y, c.y);
  vec3 brand = c.hash < 0.5 ? c.wall : (c.hash < 1.5 ? ${lin('#B5251D')} : (c.hash < 2.5 ? ${lin('#1F4E9A')} : ${lin('#E8B520')}));
  d.col = mix(d.col, brand, fascia * (1.0 - carport));
  d.col = mix(d.col, ${lin('#2A2A28')}, facadeBand(c.y, underTop, edgeLo, c.m.y) * (1.0 - carport));
  float under = facadeBelow(c.y, underTop, c.m.y);
  float soffitZone = smoothstep(0.85 * underTop - c.m.y, 0.85 * underTop + c.m.y, c.y);
  vec3 seen = mix(${lin('#3E3F3C')}, mix(${lin('#9A9B98')} * 0.55, ${lin('#2C3440')}, carport), soffitZone);
  float pw = 0.5 * mix(0.45, 0.25, carport);
  float postX = 0.5 * c.size.x;
  float post = facadeBox(c.q, vec2(postX - pw, -1.0), vec2(postX + pw, underTop + 1.0), c.m);
  seen = mix(seen, mix(${lin('#E9E7E1')}, ${lin('#9EA3A6')}, carport), post);
  d.col = mix(d.col, seen, under);
  d.rough = mix(d.rough, ${glslFloat(GAP_ROUGHNESS)}, under * (1.0 - post));
  float spot = facadeBox(c.q, vec2(0.2 * c.size.x, -1.0), vec2(0.25 * c.size.x, c.size.y + 1.0), c.m)
    * step(0.5, c.pick) * facadeBand(c.y, underTop - 0.1, underTop, c.m.y);
  vec3 fuelNight = vec3(1.0, 0.89, 0.8) * (2.0 * soffitZone + 0.12 * (1.0 - soffitZone) * (1.0 - post)) * under + 0.6 * brand * fascia;
  vec3 carportNight = vec3(1.0, 0.85, 0.6) * (0.8 * spot + 0.015 * under * soffitZone);
  d.emi += c.night * mix(fuelNight, carportNight, carport);
  // By day the open side shows the lit ground beyond and the soffit catches its bounce.
  vec3 seenThrough = mix(vec3(0.05, 0.05, 0.048), vec3(0.09, 0.09, 0.088) * mix(1.0, 0.35, carport), soffitZone);
  d.emi += (1.0 - c.night) * under * (1.0 - post) * seenThrough;
}
void facadeRetail(FacadeCtx c, inout FacadeDraw d) {
  // Storefronts on the ground row only, a pier and a sign per tenant; the wall above stays blank.
  if (c.inside < 0.5 || c.id.y > 0.5) return;
  float b = c.size.x;
  float tenantBays = 2.0 + mod(c.hash, 3.0);
  float tenant = floor(c.id.x / tenantBays);
  float bayInTenant = mod(c.id.x, tenantBays);
  float tenantPick = facadeHash12(vec2(tenant, c.seed + 4.0));
  float glassTop = min(2.6, 0.62 * c.size.y);
  float transom = step(2.3, glassTop);
  d.col = mix(d.col, ${lin('#BDB4A6')}, facadeBelow(c.q.y, 0.1, c.m.y));
  c.lit = step(1.0 - c.share, tenantPick);
  c.glow *= mix(0.6, 1.0, fract(tenantPick * 9.7));
  c.tint = vec3(2.2);
  c.blinds = 0.0;
  facadePane(vec2(0.0, 0.1), vec2(b, mix(glassTop, 2.0, transom)), -1.0, c, d);
  if (transom > 0.5) facadePane(vec2(0.0, 2.0), vec2(b, glassTop), -1.0, c, d);
  float pier = step(bayInTenant, 0.5) * facadeBox(c.q, vec2(-1.0), vec2(0.6, glassTop + 0.1), c.m);
  d.col = mix(d.col, c.wall, pier);
  d.emi *= 1.0 - pier;
  float W = tenantBays * b;
  vec2 tenantQ = vec2(bayInTenant * b + c.q.x, c.q.y);
  float sign = facadeBox(tenantQ, vec2(0.2 * W, glassTop + 0.3), vec2(0.8 * W, min(glassTop + 0.9, c.size.y - 0.1)), c.m);
  float hue = fract(tenantPick * 23.0);
  vec3 signColour = hue < 0.25 ? ${lin('#7A3B32')} : (hue < 0.5 ? ${lin('#34506B')} : (hue < 0.75 ? ${lin('#5C6A3A')} : ${lin('#8A7650')}));
  d.col = mix(d.col, signColour, sign);
  d.emi += c.night * 0.8 * signColour * sign * c.lit;
}
void facadeWarehouse(FacadeCtx c, inout FacadeDraw d) {
  // Tilt-up panels with joints and two reveals, or (hash 1) ribbed metal; dock doors at dock height
  // on the longest run, in black shelters wider at the sides and top than at the foot, a lamp over each.
  float ribbed = step(0.5, c.hash) * step(c.hash, 1.5);
  float my = c.m.y;
  float reveals = facadeBand(c.y, c.wallH / 3.0, c.wallH / 3.0 + 0.05, my) + facadeBand(c.y, 2.0 * c.wallH / 3.0, 2.0 * c.wallH / 3.0 + 0.05, my);
  float joint = step(mod(c.id.x, 2.0), 0.5) * c.tierA * c.inside * facadeBox(c.q, vec2(-1.0), vec2(0.03, c.size.y + 1.0), c.m);
  d.col *= mix((1.0 - 0.15 * joint) * (1.0 - 0.2 * reveals), c.ribShade, ribbed);
  if (c.hash > 1.5 && c.hash < 2.5 && c.wallH > 6.4) {
    float clerestory = facadeBand(c.y, 0.75 * c.wallH - 0.4, 0.75 * c.wallH + 0.4, my);
    d.col = mix(d.col, vec3(0.02) * (1.0 - c.F), clerestory);
    d.emi += clerestory * c.refl * c.F;
    d.rough = mix(d.rough, ${glslFloat(GLASS_ROUGHNESS)}, clerestory);
  }
  if (c.longest < 0.5 || c.inside < 0.5 || c.id.y > 0.5 || c.size.y < 4.6) return;
  float b = c.size.x;
  float docks = step(0.45, facadeHash12(vec2(floor(c.id.x / 10.0), c.seed + 5.0)));
  float shelter = facadeBox(c.q, vec2(0.07 * b, 0.75), vec2(0.93 * b, 4.15), c.m) * docks;
  float door = facadeBox(c.q, vec2(0.16 * b, 0.8), vec2(0.84 * b, 3.8), c.m) * docks;
  float slat = 1.0 - 0.15 * c.tierA * facadeBand(mod(c.q.y, 0.15), 0.12, 0.14, my);
  float guide = (facadeBox(c.q, vec2(0.05 * b, -1.0), vec2(0.08 * b, 0.8), c.m) + facadeBox(c.q, vec2(0.92 * b, -1.0), vec2(0.95 * b, 0.8), c.m)) * docks * c.tierA;
  float lamp = facadeBox(c.q, vec2(0.45 * b, 4.3), vec2(0.55 * b, 4.45), c.m) * docks;
  d.col = mix(d.col, ${lin('#1C1C1C')}, shelter);
  d.col = mix(d.col, ${lin('#B7BCC0')} * slat, door);
  d.col = mix(d.col, ${lin('#E3B320')}, guide);
  d.col = mix(d.col, vec3(0.3), lamp);
  d.emi += c.night * vec3(1.0, 0.75, 0.45) * (2.4 * lamp + 0.05 * door);
}
void facadeFireStation(FacadeCtx c, inout FacadeDraw d) {
  // Apparatus doors in a red surround on the ground row of the longest run, glazed sectional or
  // (hash 1) solid red; punched crew windows elsewhere.
  if (c.inside < 0.5) return;
  if (c.longest < 0.5 || c.id.y > 0.5) {
    facadePane(c.lo, c.hi, 0.0, c, d);
    return;
  }
  float b = c.size.x;
  float S = c.size.y;
  float surround = facadeBox(c.q, vec2(0.03 * b, -1.0), vec2(0.97 * b, 0.94 * S), c.m);
  float door = facadeBox(c.q, vec2(0.08 * b, -1.0), vec2(0.92 * b, 0.88 * S), c.m);
  float section = 1.0 - 0.14 * facadeBand(mod(c.q.y, 0.61), 0.0, 0.04, c.m.y);
  d.col = mix(d.col, ${lin('#B22222')}, surround);
  if (c.hash > 0.5 && c.hash < 1.5) {
    d.col = mix(d.col, ${lin('#B22222')} * 0.85 * section, door);
    return;
  }
  d.col = mix(d.col, ${lin('#C9CCCE')} * section, door);
  float glazing = facadeBox(c.q, vec2(0.12 * b, 0.55 * 0.88 * S), vec2(0.88 * b, 0.7 * 0.88 * S), c.m) * door;
  d.col = mix(d.col, vec3(0.015) * (1.0 - c.F), glazing);
  d.emi += glazing * (c.refl * c.F + c.night * vec3(0.85, 0.92, 1.0) * 1.6);
  d.rough = mix(d.rough, ${glslFloat(GLASS_ROUGHNESS)}, glazing);
}
void facadeHotel(FacadeCtx c, inout FacadeDraw d) {
  // One window per room, mirrored across the party walls; brick on the lower two rows, lobby glass on
  // a third of the ground bays, a lighter cornice in the parapet.
  vec3 brick = mod(c.hash, 2.0) < 0.5 ? ${lin('#B08472')} : ${lin('#A8705C')};
  float zone = facadeBelow(c.y, c.bands.x + 2.0 * c.size.y, c.m.y);
  d.col = mix(d.col, brick, zone);
  d.col *= mix(1.0, 1.1, smoothstep(c.wallH - c.bands.y - c.m.y, c.wallH - c.bands.y + c.m.y, c.y));
  if (c.inside < 0.5) return;
  c.wall = mix(c.wall, brick, zone);
  float b = c.size.x;
  float S = c.size.y;
  if (c.id.y < 0.5 && c.pick < 0.33) {
    c.lit = 1.0;
    c.tint = vec3(2.0);
    c.blinds = 0.0;
    facadePane(vec2(0.08 * b, 0.0), vec2(0.92 * b, 0.9 * S), -1.0, c, d);
    return;
  }
  float shift = (mod(c.id.x, 2.0) < 0.5 ? 0.1 : -0.1) * b;
  vec2 lo = c.lo + vec2(shift, 0.0);
  vec2 hi = c.hi + vec2(shift, 0.0);
  float wide = 0.15 * (hi.x - lo.x);
  float grille = facadeBox(c.q, vec2(lo.x + wide, lo.y - 0.05 * S - 0.5), vec2(hi.x - wide, lo.y - 0.05 * S - 0.1), c.m) * c.tierA;
  facadePane(lo, hi, 1.0, c, d);
  d.col = mix(d.col, c.wall * 0.75, grille);
}
void facadeTank(FacadeCtx c, inout FacadeDraw d) {
  // Shell-course lines on the rows, a wind girder over a shadow line, a rim, faint streaks from the top.
  d.base = 0.0;
  d.coping = 0.0;
  float T = c.wallH;
  float my = c.m.y;
  d.col *= 1.0 - 0.05 * c.inside * facadeBelow(c.q.y, 0.05, my);
  d.col *= 1.0 + 0.08 * facadeBand(c.y, T - 0.75, T - 0.6, my);
  d.col *= 1.0 - 0.25 * facadeBand(c.y, T - 0.85, T - 0.75, my);
  d.col *= 1.0 - 0.2 * smoothstep(T - 0.1 - my, T - 0.1 + my, c.y);
  float streak = step(0.7, facadeHash12(vec2(c.id.x, c.seed)));
  d.col *= 1.0 - 0.05 * c.tierA * streak * smoothstep(T - 4.0, T - 0.9, c.y);
}
// The near look per class. PLAIN stays a plain wall with its base band and coping.
void facadeLook(float cls, FacadeCtx c, inout FacadeDraw d) {
  if (cls == ${glslFloat(FacadeClass.GENERIC)}) facadeGeneric(c, d);
  else if (cls == ${glslFloat(FacadeClass.GARAGE)}) facadeGarage(c, d);
  else if (cls == ${glslFloat(FacadeClass.HANGAR)}) facadeHangar(c, d);
  else if (cls == ${glslFloat(FacadeClass.HOUSE)}) facadeHouse(c, d);
  else if (cls == ${glslFloat(FacadeClass.OFFICE)}) facadeOffice(c, d);
  else if (cls == ${glslFloat(FacadeClass.TERMINAL)}) facadeTerminal(c, d);
  else if (cls == ${glslFloat(FacadeClass.CANOPY)}) facadeCanopy(c, 0.0, d);
  else if (cls == ${glslFloat(FacadeClass.CARPORT)}) facadeCanopy(c, 1.0, d);
  else if (cls == ${glslFloat(FacadeClass.RETAIL)}) facadeRetail(c, d);
  else if (cls == ${glslFloat(FacadeClass.WAREHOUSE)}) facadeWarehouse(c, d);
  else if (cls == ${glslFloat(FacadeClass.FIRE_STATION)}) facadeFireStation(c, d);
  else if (cls == ${glslFloat(FacadeClass.HOTEL)}) facadeHotel(c, d);
  else if (cls == ${glslFloat(FacadeClass.TANK)}) facadeTank(c, d);
  else if (cls == ${glslFloat(FacadeClass.CARAVAN)}) facadeCaravan(c, d);
}
`

const FACADE_FRAGMENT_SHADER = /* glsl */ `
float facadeHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float facadeNight(vec3 positionWC) {
  vec3 upEC = normalize(czm_viewRotation * normalize(positionWC));
  float sunUp = dot(normalize(czm_sunDirectionEC), upEC);
  return smoothstep(0.05, -0.12, sunUp);
}
float facadeBox(vec2 f, vec2 lo, vec2 hi, vec2 aa) {
  vec2 a = smoothstep(lo - aa, lo + aa, f) * (1.0 - smoothstep(hi - aa, hi + aa, f));
  return a.x * a.y;
}
// The rib crest box-filtered over the footprint; mirrors ribCrest() in facadeShader.ts.
float facadeRibCrest(float x, float footprint) {
  float width = max(footprint, ${glslFloat(RIB_FILTER_MIN)});
  float troughEnd = ${glslFloat(1 - RIB_CREST_SHARE)};
  float x0 = x - 0.5 * width;
  float x1 = x + 0.5 * width;
  float base = floor(x0);
  float whole = (floor(x1) - base) * ${glslFloat(RIB_CREST_SHARE)};
  float rise = whole + max(x1 - floor(x1) - troughEnd, 0.0) - max(x0 - base - troughEnd, 0.0);
  return rise / width;
}
// The hangar door-panel seam's shade (1 away from the seam), box-filtered over the pixel footprint
// like facadeRibCrest: the profile's integral over the box, divided by its width, so the wrap
// between cells blends instead of stepping. facadeSeamArea integrates the profile over one cell,
// which repeats with the seam at its start.
float facadeSeamArea(float t) {
  float w = ${glslFloat(SEAM_WIDTH)};
  float u = clamp(t, 0.0, w) / w;
  float smoothed = w * (u * u * u - 0.5 * u * u * u * u);
  float ramp = ${glslFloat(1 - SEAM_SHADE)} * clamp(t, 0.0, w) + ${glslFloat(SEAM_SHADE)} * smoothed;
  return ramp + max(t - w, 0.0);
}
float facadeSeam(float x, float footprint) {
  float width = max(footprint, ${glslFloat(SEAM_FILTER_MIN)});
  float x0 = x - 0.5 * width;
  float x1 = x + 0.5 * width;
  float base = floor(x0);
  float area = (floor(x1) - base) * facadeSeamArea(1.0)
    + facadeSeamArea(x1 - floor(x1)) - facadeSeamArea(x0 - base);
  return area / width;
}
// The packed style colour (see buildingStyle.ts) as (class, storeys, wall height in metres, 0).
vec4 facadeDecode(vec3 styleRgb) {
  vec3 code = floor((1.0 - styleRgb) * 255.0 + 0.5);
  return vec4(code.r, code.g, code.b * ${glslFloat(PACK_HEIGHT_STEP_M)}, 0.0);
}
// (bay width, default storey height, opening kind: 0 glass 1 gap 2 none, storeys from levels)
${CELL_GLSL}
${OPENING_RECT_GLSL}
${COVER_GLSL}
${RELIEF_GLSL}
${WALL_GLSL}
${LIT_SHARE_GLSL}
${LIT_LEVEL_GLSL}
${LIT_MIX_GLSL}
${LIT_MEAN_GLSL}
${GLASS_F0_GLSL}
${WASH_GLSL}
${FACE_FIT_GLSL}
${LOOK_GLSL}
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  vec4 building = vec4(0.0);
  // (the building's lowest vertex in model coordinates, metres from its ground to that vertex);
  // a negative w marks no lookup (unbuilt or skipped tile, or none bound), which draws no rows.
  vec4 ground = vec4(0.0, 0.0, 0.0, -1.0);
  // (metres from the building's ground to its wall top, -1 unknown; the hash in [0, 1)); the hash
  // picks the wall colour variant, variant 0 until the tile's lookup is built.
  vec4 top = vec4(-1.0, 0.0, 0.0, 0.0);
  #ifdef HAS_SELECTED_FEATURE_ID
  SelectedFeature styled;
  selectedFeatureIdStage(styled, fsInput.featureIds);
  building = facadeDecode(styled.color.rgb);
  #endif
  #if defined(HAS_SELECTED_FEATURE_ID) && defined(${BUILDING_LOOKUP_DEFINE})
  ground = ${glslBuildingLookupRead('styled.id', `${LOOKUP_ROW_GROUND}`)};
  top = ${glslBuildingLookupRead('styled.id', `${LOOKUP_ROW_TOP}`)};
  #endif
  vec4 grammar = facadeCell(building.x);
  float levelsKnown = step(0.5, building.y) * step(0.5, building.z) * step(building.z, ${glslFloat(SATURATED_HEIGHT_M - 1)}) * grammar.w;
  float levelStorey = clamp(building.z / max(building.y, 1.0), ${glslFloat(STOREY_MIN_M)}, ${glslFloat(STOREY_MAX_M)});
  float storey = mix(grammar.y, levelStorey, levelsKnown);

  vec3 positionMC = fsInput.attributes.positionMC;
  vec3 upWC = normalize(fsInput.attributes.positionWC);
  vec3 normalWC = normalize(czm_inverseViewRotation * normalize(fsInput.attributes.normalEC));
  vec3 upMC = normalize((czm_inverseModel * vec4(upWC, 0.0)).xyz);
  vec3 normalMC = normalize((czm_inverseModel * vec4(normalWC, 0.0)).xyz);

  // Derivatives are undefined in non-uniform control flow (GLSL ES 3.00 section 8.14.1), so the
  // cell footprint is taken on every fragment, before the roof test and the far early-out. The
  // tangent's length guard keeps roofs, where it vanishes, from feeding NaN into a wall's quad.
  vec3 across = cross(upMC, normalMC);
  vec3 tangentMC = across / max(length(across), 1e-4);
  // Position along the wall and height above the building's base, measured from its own base so
  // the far model origin's tilt across the tile cannot shift them: the face table's frame.
  vec3 local = positionMC - ground.xyz;
  float s = dot(local, tangentMC);
  float h = dot(local, upMC);
  vec2 metresAa = fwidth(vec2(s, h));
  vec2 aa = max(metresAa / vec2(grammar.x, storey), vec2(1e-4));
  float ribCoord = s * ${glslFloat(RIBS_PER_M)};
  float ribAa = max(fwidth(ribCoord), 1e-4);
  float fadeDetail = 1.0 - smoothstep(u_fadeStart, u_fadeEnd, max(aa.x, aa.y));
  float detail = mix(1.0, fadeDetail, u_fade) * step(0.0, ground.w);
  float ribDetail = 1.0 - smoothstep(0.25, 0.6, ribAa);

  if (dot(normalWC, upWC) > ${glslFloat(FACADE_ROOF_COS)}) {
    return;
  }

  float glassy = 1.0 - step(0.5, grammar.z);
  float gappy = step(0.5, grammar.z) * (1.0 - step(1.5, grammar.z));
  vec2 relief = facadeRelief(building.x);
  float panels = relief.y;
  float cover = facadeCover(building.x);
  vec3 gap = ${glslVec3(srgbToLinear(GAP_SRGB))};
  float openingRoughness = mix(${glslFloat(GLASS_ROUGHNESS)}, ${glslFloat(GAP_ROUGHNESS)}, gappy);

  float paletteIndex = clamp(floor(top.y * ${glslFloat(PACK_HASH_STATES)}), 0.0, ${glslFloat(PACK_HASH_STATES - 1)});
  // Tint jitter per building, a second hash of the lookup's; mirrors tintFactor() in facadeFit.ts.
  vec2 jitter = (fract(top.yy * ${glslVec2(TINT_JITTER_HASH)}) * 2.0 - 1.0) * step(0.0, ground.w);
  vec3 wall = material.diffuse * facadeWallLinear(building.x, paletteIndex)
    * (1.0 + ${glslFloat(TINT_JITTER_L)} * jitter.x) * (1.0 + ${glslVec3(TINT_JITTER_B)} * jitter.y);
  float wallRoughness = material.roughness;
  float night = facadeNight(fsInput.attributes.positionWC);
  vec3 litEmissive = facadeLitMean(building.x) * night;
  float litShare = facadeLitShare(building.x) * glassy;

  vec3 farWall = wall * mix(1.0, ${glslFloat(RIB_SHADE_MEAN)}, panels);
  vec3 farColour = mix(farWall, mix(u_glassMean, gap, gappy), cover);
  float farRoughness = mix(wallRoughness, openingRoughness, cover);
  vec3 farEmissive = litEmissive * cover * litShare;
  if (detail <= 0.001) {
    material.diffuse = farColour;
    material.roughness = farRoughness;
    material.emissive += farEmissive;
    return;
  }

  // Whole bays and rows fitted to the face the fragment lies on; with no face, a plain wall.
  vec4 rect = facadeOpeningRect(building.x);
  vec3 run;
  vec2 heights;
  float matched = facadeFace(int(top.z + 0.5), int(top.w + 0.5), local, normalMC, upMC, run, heights);
  vec2 cell;
  vec2 size;
  float inside = facadeFit(matched, run, heights, h, grammar, building.y, cell, size);
  vec2 fitAa = max(metresAa / max(size, vec2(1e-4)), vec2(1e-4));
  vec2 id = floor(cell);
  vec2 f = fract(cell);
  float slab = 1.0 - 0.12 * relief.x * detail * inside * (1.0 - smoothstep(0.0, 0.06 + fitAa.y, f.y));
  float seam = mix(1.0, facadeSeam(f.x, fitAa.x), panels * detail * inside);
  float rib = mix(${glslFloat(RIB_SHADE_LOW)}, ${glslFloat(RIB_SHADE_HIGH)}, facadeRibCrest(ribCoord, ribAa));
  float ribShade = mix(${glslFloat(RIB_SHADE_MEAN)}, rib, ribDetail);
  float shade = slab * seam * mix(1.0, ribShade, panels);
  // The run's identity is hashed in on its own term, so no run's pattern is a shifted copy of
  // another's; mirrors windowHashes() in facadeFit.ts.
  float glassPick = facadeHash12(vec2(facadeHash12(id), run.z));
  float litPick = facadeHash12(vec2(facadeHash12(id * 1.37), run.z));
  vec4 lightMix = facadeLitMix(building.x);

  // The glass reflects an analytic sky by the reflected ray's elevation, weighted by Schlick Fresnel.
  vec3 viewEC = normalize(-fsInput.attributes.positionEC);
  vec3 nEC = normalize(fsInput.attributes.normalEC);
  float grazing = 1.0 - clamp(dot(nEC, viewEC), 0.0, 1.0);
  float elevation = dot(czm_inverseViewRotation * reflect(-viewEC, nEC), upWC);
  vec3 sky = mix(${lin('#5C5D58')}, ${lin('#C6D1DB')}, smoothstep(-0.08, 0.0, elevation));
  sky = mix(sky, ${lin('#7FA2C6')}, smoothstep(0.0, 0.25, elevation));
  vec3 sunWC = normalize(czm_inverseViewRotation * czm_sunDirectionEC);
  float lowSun = (1.0 - smoothstep(0.0, 0.14, dot(sunWC, upWC))) * max(dot(sunWC, normalWC), 0.0);
  sky = mix(sky, ${lin('#E3B48C')}, 0.6 * lowSun * (1.0 - smoothstep(0.0, 0.25, abs(elevation))));
  float f0 = facadeGlassF0(building.x);

  FacadeCtx look;
  look.wall = wall;
  look.refl = mix(sky, ${lin('#0E1219')}, night);
  look.frame = paletteIndex < 0.5 ? ${FRAME_COLOURS_GLSL[0]} : (paletteIndex < 1.5 ? ${FRAME_COLOURS_GLSL[1]}
    : (paletteIndex < 2.5 ? ${FRAME_COLOURS_GLSL[2]} : ${FRAME_COLOURS_GLSL[3]}));
  vec3 glowPicks = vec3(fract(glassPick * ${glslFloat(LIT_PICKS[0])}), fract(litPick * ${glslFloat(LIT_PICKS[1])}),
    fract((glassPick + litPick) * ${glslFloat(LIT_PICKS[2])}));
  look.glow = facadeLitGlow(glowPicks, lightMix, facadeLitLevel(building.x));
  look.tint = vec3(1.0);
  look.m = max(metresAa, vec2(1e-4));
  look.id = id;
  look.q = f * size;
  look.size = size;
  look.lo = rect.xy * size;
  look.hi = rect.zw * size;
  look.bands = facadeBands(heights.y - heights.x);
  look.y = h - heights.x;
  look.wallH = heights.y - heights.x;
  look.inside = inside;
  look.longest = step(abs(run.z - top.z), 0.5);
  look.hash = paletteIndex;
  look.seed = floor(top.y * 997.0);
  look.F = f0 + (1.0 - f0) * grazing * grazing * grazing * grazing * grazing;
  look.night = night;
  look.tierA = smoothstep(6.0, 10.0, 1.0 / max(look.m.x, look.m.y));
  look.sunSide = dot((czm_inverseModel * vec4(sunWC, 0.0)).xyz, tangentMC);
  look.share = litShare;
  look.lit = facadeWindowLit(id, run.z, litPick, litShare, lightMix.w);
  look.blinds = 1.0;
  look.pick = fract(glassPick * 13.7);
  look.glassPick = glassPick;
  look.blindPick = fract(glassPick * 23.3);
  look.ribShade = ribShade;

  FacadeDraw draw;
  draw.col = wall * shade;
  draw.emi = vec3(0.0);
  draw.rough = wallRoughness;
  draw.base = matched;
  draw.coping = matched * step(0.2, look.bands.y);
  draw.grime = 1.0;
  if (matched > 0.5) facadeLook(building.x, look, draw);

  // The base band, the coping along the run's top, and grime and contact darkening toward the foot.
  float my = look.m.y;
  float copeLo = look.wallH - 0.12;
  draw.col *= mix(1.0, mix(0.78, 1.0, smoothstep(look.bands.x - my, look.bands.x + my, look.y)), draw.base);
  draw.col *= mix(1.0, 1.0 + 0.12 * facadeBand(look.y, copeLo, look.wallH, my) - 0.28 * facadeBand(look.y, copeLo - 0.08, copeLo, my), draw.coping);
  draw.col *= mix(1.0, mix(0.84, 1.0, smoothstep(0.0, 1.4, look.y)) * mix(0.7, 1.0, smoothstep(0.15 - my, 0.15 + my, look.y)), draw.grime);

  vec3 nearColour = draw.col;
  float nearRoughness = draw.rough;
  // A warm street and entrance wash at the foot of the classes people come and go from.
  vec3 nearEmissive = draw.emi + facadeWash(building.x) * 0.04 * wall * night * (1.0 - smoothstep(0.0, 3.0, look.y));

  material.diffuse = mix(farColour, nearColour, detail);
  material.roughness = mix(farRoughness, nearRoughness, detail);
  material.emissive += mix(farEmissive, nearEmissive, detail);
}
`

/**
 * The facade shader for an OSM Buildings tileset whose style is `createBuildingStyle()`.
 *
 * Its uniforms can be changed live with `tileset.customShader.setUniform(name, value)`:
 * `u_fade` (0, the default, keeps the full grid at any range; 1 fades it), `u_fadeStart` and
 * `u_fadeEnd` (the cell footprint range of the fade, in cells per pixel) and `u_glassMean`
 * (linear mean glass colour).
 *
 * @returns A new `CustomShader` in `MODIFY_MATERIAL` mode
 */
export function createFacadeShader(): Cesium.CustomShader {
  const glassMean = meanGlassLinear()
  return new Cesium.CustomShader({
    mode: Cesium.CustomShaderMode.MODIFY_MATERIAL,
    uniforms: {
      u_fade: { type: Cesium.UniformType.FLOAT, value: 0 },
      u_fadeStart: { type: Cesium.UniformType.FLOAT, value: FACADE_FADE_START },
      u_fadeEnd: { type: Cesium.UniformType.FLOAT, value: FACADE_FADE_END },
      u_glassMean: {
        type: Cesium.UniformType.VEC3,
        value: new Cesium.Cartesian3(glassMean[0], glassMean[1], glassMean[2]),
      },
    },
    fragmentShaderText: FACADE_FRAGMENT_SHADER,
  })
}
