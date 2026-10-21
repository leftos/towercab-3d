/**
 * Procedural facade shader for the Cesium OSM Buildings tileset.
 *
 * Walls get a grid of windows laid out in model space, one window per storey and bay. Where a
 * grid cell shrinks under a pixel, the grid fades to a flat tint, the area-weighted mean of
 * wall and glass in linear light, so distant buildings neither shimmer nor show moiré. At night
 * a share of the windows glow, and the flat tint glows by the same share. Roofs are left as
 * the tiles draw them.
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

type Vec2 = readonly [number, number]
type Vec3 = readonly [number, number, number]

/** Glass colour range in sRGB; each window picks a colour between the two by a hash of its cell. */
const GLASS_DARK_SRGB: Vec3 = [0.1, 0.13, 0.17]
const GLASS_LIGHT_SRGB: Vec3 = [0.22, 0.27, 0.32]

const GLASS_ROUGHNESS = 0.12

/** Lit-window emissive colour, already scaled by its intensity. */
const LIT_WINDOW_EMISSIVE: Vec3 = [1.4, 1.4 * 0.78, 1.4 * 0.48]

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

/** sRGB to linear light by the IEC 61966-2-1 transfer curve. */
function srgbChannelToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
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

/** A number as a GLSL float literal (GLSL ES rejects `3` where a float is expected). */
function glslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : `${value}`
}

function glslVec2(value: Vec2): string {
  return `vec2(${value.map(glslFloat).join(', ')})`
}

function glslVec3(value: Vec3): string {
  return `vec3(${value.map(glslFloat).join(', ')})`
}

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
// The IEC 61966-2-1 curve, so the near glass and the far mean (computed on the CPU) agree;
// czm_srgbToLinear is a plain 2.2 power.
vec3 facadeSrgbToLinear(vec3 c) {
  vec3 low = c / 12.92;
  vec3 high = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(low, high, step(vec3(0.04045), c));
}

void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
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
  float h = dot(positionMC, upMC);
  vec2 cell = vec2(s / ${glslFloat(FACADE_BAY_WIDTH_M)}, h / ${glslFloat(FACADE_FLOOR_HEIGHT_M)});
  vec2 aa = max(fwidth(cell), vec2(1e-4));
  float fadeDetail = 1.0 - smoothstep(u_fadeStart, u_fadeEnd, max(aa.x, aa.y));
  float detail = mix(1.0, fadeDetail, u_fade);

  if (dot(normalWC, upWC) > 0.6) {
    return;
  }

  vec3 wall = material.diffuse;
  float wallRoughness = material.roughness;
  float night = facadeNight(fsInput.attributes.positionWC);
  vec3 litEmissive = ${glslVec3(LIT_WINDOW_EMISSIVE)} * night;
  float litShare = ${glslFloat(FACADE_LIT_SHARE)};

  vec3 farColour = mix(wall, u_glassMean, u_cover);
  float farRoughness = mix(wallRoughness, ${glslFloat(GLASS_ROUGHNESS)}, u_cover);
  vec3 farEmissive = litEmissive * u_cover * litShare;
  if (detail <= 0.001) {
    material.diffuse = farColour;
    material.roughness = farRoughness;
    material.emissive += farEmissive;
    return;
  }

  vec2 id = floor(cell);
  vec2 f = fract(cell);
  float slab = 1.0 - 0.12 * detail * (1.0 - smoothstep(0.0, 0.06 + aa.y, f.y));
  float win = facadeBox(f, ${glslVec2(FACADE_WINDOW_LO)}, ${glslVec2(FACADE_WINDOW_HI)}, aa);
  vec3 glass = facadeSrgbToLinear(mix(${glslVec3(GLASS_DARK_SRGB)}, ${glslVec3(GLASS_LIGHT_SRGB)}, facadeHash12(id)));
  float lit = step(1.0 - litShare, facadeHash12(id * 1.37));

  vec3 nearColour = mix(wall * slab, glass, win);
  float nearRoughness = mix(wallRoughness, ${glslFloat(GLASS_ROUGHNESS)}, win);
  vec3 nearEmissive = litEmissive * win * lit;

  material.diffuse = mix(farColour, nearColour, detail);
  material.roughness = mix(farRoughness, nearRoughness, detail);
  material.emissive += mix(farEmissive, nearEmissive, detail);
}
`

/**
 * The facade shader for an OSM Buildings tileset.
 *
 * Its uniforms can be changed live with `tileset.customShader.setUniform(name, value)`:
 * `u_fade` (0, the default, keeps the full window grid at any range; 1 fades it), `u_fadeStart` and
 * `u_fadeEnd` (the cell footprint range of the fade, in cells per pixel), `u_cover` (window
 * share of a cell) and `u_glassMean` (linear mean glass colour).
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
      u_cover: { type: Cesium.UniformType.FLOAT, value: windowCoverage(FACADE_WINDOW_LO, FACADE_WINDOW_HI) },
      u_glassMean: {
        type: Cesium.UniformType.VEC3,
        value: new Cesium.Cartesian3(glassMean[0], glassMean[1], glassMean[2]),
      },
    },
    fragmentShaderText: FACADE_FRAGMENT_SHADER,
  })
}
