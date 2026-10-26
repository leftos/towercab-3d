/**
 * Procedural facade shader for the Cesium OSM Buildings tileset.
 *
 * Each building's class, storeys and height arrive packed in its style colour (see
 * `buildingStyle.ts`) and pick a facade grammar: a grid of openings laid out in model space, one
 * per storey and bay. Offices and terminals get continuous window bands, houses small punched
 * windows, parking garages open slab bands with dark gaps, hangars door panels with corrugated
 * ribs, domestic garages and carports a plain wall, and every other building the generic window
 * grid. Storeys count up from each building's ground, read per feature from the tile's lookup
 * texture (see `buildingBaseLookup.ts`). Walls take a colour from a curated palette per
 * class, picked by the building's position hash, so neighbours differ. Where a grid cell shrinks under a pixel, the grid
 * can fade to a flat tint, the area-weighted mean of wall and opening in linear light. At night a
 * share of the windows glow, and the flat tint glows by the same share. Roofs are left as the
 * tiles draw them.
 */

import * as Cesium from 'cesium'
import {
  FACADE_BAY_WIDTH_M,
  FACADE_FADE_END,
  FACADE_FADE_START,
  FACADE_FLOOR_HEIGHT_M,
  FACADE_LIT_SHARE,
  FACADE_WINDOW_HI,
  FACADE_WINDOW_LO,
} from '@/constants'
import { BUILDING_LOOKUP_DEFINE, glslBuildingLookupRead } from '@/utils/buildingBaseLookup'
import {
  FacadeClass,
  type FacadeClassCode,
  PACK_CODE_MAX,
  PACK_HASH_STATES,
  PACK_HEIGHT_STEP_M,
} from '@/utils/buildingStyle'

type Vec2 = readonly [number, number]
type Vec3 = readonly [number, number, number]

/** Glass colour range in sRGB; each window picks a colour between the two by a hash of its cell. */
const GLASS_DARK_SRGB: Vec3 = [0.1, 0.13, 0.17]
const GLASS_LIGHT_SRGB: Vec3 = [0.22, 0.27, 0.32]

const GLASS_ROUGHNESS = 0.12

/** The shadowed inside of a garage storey, seen through its open slab band, in sRGB. */
const GAP_SRGB: Vec3 = [0.035, 0.035, 0.04]

const GAP_ROUGHNESS = 0.95

/** Lit-window emissive colour, already scaled by its intensity. */
const LIT_WINDOW_EMISSIVE: Vec3 = [1.4, 1.4 * 0.78, 1.4 * 0.48]

/** Hangar cladding ribs per metre, and the wall shade at the trough and crest of a rib. */
const RIBS_PER_M = 1.2
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

/** Bounds on a storey height derived from height and storeys, against bad OSM tags. */
const STOREY_MIN_M = 2.4
const STOREY_MAX_M = 6.0

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
}

/**
 * Wall colours per class in sRGB, one per hash state, so neighbouring buildings of one class
 * differ in tone. The tiles' own base colour is white, so these are the walls' colours.
 */
export const FACADE_PALETTES: Readonly<Record<FacadeClassCode, readonly Vec3[]>> = {
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
}

/**
 * The wall colour a building gets: its class palette's entry for its hash.
 *
 * @param facadeClass - The building's facade class
 * @param hash - The building's packed hash, 0 to `PACK_HASH_STATES - 1`
 * @returns The wall colour in sRGB
 */
export function wallColourSrgb(facadeClass: FacadeClassCode, hash: number): Vec3 {
  const palette = FACADE_PALETTES[facadeClass]
  return palette[hash % palette.length]
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

/** A number as a GLSL float literal (GLSL ES rejects `3` where a float is expected). */
function glslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : `${value}`
}

function glslVec3(value: Vec3): string {
  return `vec3(${value.map(glslFloat).join(', ')})`
}

function glslVec4(value: readonly [number, number, number, number]): string {
  return `vec4(${value.map(glslFloat).join(', ')})`
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

/** Selects a class's palette entry by `hash`, mirroring `wallColourSrgb`, in linear light. */
function glslPaletteEntry(facadeClass: FacadeClassCode): string {
  const palette = FACADE_PALETTES[facadeClass].map(srgbToLinear)
  return palette
    .slice(1)
    .reduceRight(
      (otherwise, entry, i) => `hash == ${glslFloat(i + 1)} ? ${glslVec3(entry)} : (${otherwise})`,
      glslVec3(palette[0]),
    )
}

const WALL_GLSL = glslPerClass('facadeWallLinear', 'vec3', 'float facadeClass, float hash', glslPaletteEntry)

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

/** Packed heights at or above this are saturated and say nothing about the storey height. */
const SATURATED_HEIGHT_M = PACK_CODE_MAX * PACK_HEIGHT_STEP_M

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
// The packed style colour (see buildingStyle.ts) as (class, storeys, wall height in metres, hash).
vec4 facadeDecode(vec3 styleRgb) {
  vec3 code = floor((1.0 - styleRgb) * 255.0 + 0.5);
  float facadeClass = floor(code.r / ${glslFloat(PACK_HASH_STATES)});
  float hash = code.r - facadeClass * ${glslFloat(PACK_HASH_STATES)};
  return vec4(facadeClass, code.g, code.b * ${glslFloat(PACK_HEIGHT_STEP_M)}, hash);
}
// (bay width, default storey height, opening kind: 0 glass 1 gap 2 none, storeys from levels)
${CELL_GLSL}
${OPENING_RECT_GLSL}
${COVER_GLSL}
${RELIEF_GLSL}
${WALL_GLSL}

void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  vec4 building = vec4(0.0);
  // (the building's lowest vertex in model coordinates, metres from its ground to that vertex);
  // a negative w marks no lookup (unbuilt or skipped tile, or none bound), which draws no rows.
  vec4 ground = vec4(0.0, 0.0, 0.0, -1.0);
  #ifdef HAS_SELECTED_FEATURE_ID
  SelectedFeature styled;
  selectedFeatureIdStage(styled, fsInput.featureIds);
  building = facadeDecode(styled.color.rgb);
  #endif
  #if defined(HAS_SELECTED_FEATURE_ID) && defined(${BUILDING_LOOKUP_DEFINE})
  ground = ${glslBuildingLookupRead('styled.id')};
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
  float s = dot(positionMC, tangentMC);
  // Height above the building's ground, measured from its own base so the far model origin's
  // tilt across the tile cannot shift it; a raised part adds its min_height, so rows continue
  // through stacked parts.
  float h = dot(positionMC - ground.xyz, upMC) + ground.w;
  vec2 cell = vec2(s / grammar.x, h / storey);
  vec2 aa = max(fwidth(cell), vec2(1e-4));
  float ribCoord = s * ${glslFloat(RIBS_PER_M)};
  float ribAa = max(fwidth(ribCoord), 1e-4);
  float fadeDetail = 1.0 - smoothstep(u_fadeStart, u_fadeEnd, max(aa.x, aa.y));
  float detail = mix(1.0, fadeDetail, u_fade) * step(0.0, ground.w);
  float ribDetail = 1.0 - smoothstep(0.25, 0.6, ribAa);

  if (dot(normalWC, upWC) > 0.6) {
    return;
  }

  float glassy = 1.0 - step(0.5, grammar.z);
  float gappy = step(0.5, grammar.z) * (1.0 - step(1.5, grammar.z));
  float hasOpening = 1.0 - step(1.5, grammar.z);
  vec2 relief = facadeRelief(building.x);
  float panels = relief.y;
  float cover = facadeCover(building.x);
  vec3 gap = ${glslVec3(srgbToLinear(GAP_SRGB))};
  float openingRoughness = mix(${glslFloat(GLASS_ROUGHNESS)}, ${glslFloat(GAP_ROUGHNESS)}, gappy);

  vec3 wall = material.diffuse * facadeWallLinear(building.x, building.w);
  float wallRoughness = material.roughness;
  float night = facadeNight(fsInput.attributes.positionWC);
  vec3 litEmissive = ${glslVec3(LIT_WINDOW_EMISSIVE)} * night;
  float litShare = ${glslFloat(FACADE_LIT_SHARE)} * glassy;

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

  vec4 rect = facadeOpeningRect(building.x);
  vec2 id = floor(cell);
  vec2 f = fract(cell);
  float slab = 1.0 - 0.12 * relief.x * detail * (1.0 - smoothstep(0.0, 0.06 + aa.y, f.y));
  float seam = mix(1.0, facadeSeam(f.x, aa.x), panels * detail);
  float rib = mix(${glslFloat(RIB_SHADE_LOW)}, ${glslFloat(RIB_SHADE_HIGH)}, facadeRibCrest(ribCoord, ribAa));
  float ribShade = mix(${glslFloat(RIB_SHADE_MEAN)}, rib, ribDetail);
  float shade = slab * seam * mix(1.0, ribShade, panels);
  float opening = facadeBox(f, rect.xy, rect.zw, aa) * hasOpening;
  vec3 glass = mix(${glslVec3(srgbToLinear(GLASS_DARK_SRGB))}, ${glslVec3(srgbToLinear(GLASS_LIGHT_SRGB))}, facadeHash12(id));
  float lit = step(1.0 - litShare, facadeHash12(id * 1.37)) * glassy;

  vec3 nearColour = mix(wall * shade, mix(glass, gap, gappy), opening);
  float nearRoughness = mix(wallRoughness, openingRoughness, opening);
  vec3 nearEmissive = litEmissive * opening * lit;

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
