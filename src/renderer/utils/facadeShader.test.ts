import * as Cesium from 'cesium'
import { describe, expect, it } from 'vitest'
import {
  FACADE_BASE_BAND_M,
  FACADE_PARAPET_M,
  FACADE_PIER_M,
  FACE_GATE_COS,
  FACE_PLANE_TOL_M,
  FACE_S_TOL_M,
  FACES_PER_FEATURE_MAX,
} from '@/constants'
import {
  BUILDING_FACES_SAMPLER,
  BUILDING_LOOKUP_DEFINE,
  BUILDING_LOOKUP_SAMPLER,
  featureHash,
  glslBuildingLookupRead,
} from '@/utils/buildingBaseLookup'
import {
  createBuildingStyle,
  decodePackedColour,
  FacadeClass,
  type FacadeClassCode,
  PACK_HASH_STATES,
} from '@/utils/buildingStyle'
import { STOREY_MAX_M, STOREY_MIN_M } from '@/utils/facadeFit'
import {
  createFacadeShader,
  FACADE_GRAMMARS,
  FACADE_PALETTES,
  grammarCoverage,
  meanGlassLinear,
  openingMeanLinear,
  RIB_CREST_SHARE,
  ribCrest,
  SEAM_FILTER_MIN,
  seamShade,
  wallColourSrgb,
  windowCoverage,
} from '@/utils/facadeShader'

/** sRGB to linear light by the IEC 61966-2-1 transfer curve. */
function iecSrgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

const GLASS_DARK_SRGB = [0.1, 0.13, 0.17]
const GLASS_LIGHT_SRGB = [0.22, 0.27, 0.32]

describe('windowCoverage', () => {
  it('is the window rectangle area as a share of the cell', () => {
    expect(windowCoverage([0.2, 0.32], [0.8, 0.82])).toBeCloseTo(0.3, 10)
  })

  it('is zero for an empty rectangle and one for the whole cell', () => {
    expect(windowCoverage([0.5, 0.5], [0.5, 0.5])).toBe(0)
    expect(windowCoverage([0, 0], [1, 1])).toBe(1)
  })
})

describe('meanGlassLinear', () => {
  it('is the mean of the two glass end colours in linear light', () => {
    const mean = meanGlassLinear()
    const expected = GLASS_DARK_SRGB.map(
      (dark, i) => (iecSrgbToLinear(dark) + iecSrgbToLinear(GLASS_LIGHT_SRGB[i])) / 2,
    )

    expect(mean[0]).toBeCloseTo(expected[0], 10)
    expect(mean[1]).toBeCloseTo(expected[1], 10)
    expect(mean[2]).toBeCloseTo(expected[2], 10)
  })
})

describe('facade grammars', () => {
  it('keeps the generic class on the window grid every building had before types', () => {
    const generic = FACADE_GRAMMARS[FacadeClass.GENERIC]

    expect(generic.bayM).toBe(2.6)
    expect(generic.floorM).toBe(3)
    expect(grammarCoverage(FacadeClass.GENERIC)).toBeCloseTo(0.3, 10)
    expect(openingMeanLinear(FacadeClass.GENERIC)).toEqual(meanGlassLinear())
  })

  it('gives offices and terminals continuous bands, more glass than the generic grid', () => {
    expect(grammarCoverage(FacadeClass.OFFICE)).toBeGreaterThan(0.5)
    expect(FACADE_GRAMMARS[FacadeClass.TERMINAL]).toEqual(FACADE_GRAMMARS[FacadeClass.OFFICE])
    expect(openingMeanLinear(FacadeClass.OFFICE)).toEqual(meanGlassLinear())
  })

  it('gives houses small punched windows, less glass than the generic grid', () => {
    expect(grammarCoverage(FacadeClass.HOUSE)).toBeLessThan(grammarCoverage(FacadeClass.GENERIC))
    expect(grammarCoverage(FacadeClass.HOUSE)).toBeGreaterThan(0.1)
  })

  it('gives garages open slab bands: dark gaps, no glass', () => {
    const garage = FACADE_GRAMMARS[FacadeClass.GARAGE]
    const gapMean = openingMeanLinear(FacadeClass.GARAGE)

    expect(garage.opening).toBe('gap')
    expect(grammarCoverage(FacadeClass.GARAGE)).toBeGreaterThan(0.5)
    expect(Math.max(...gapMean)).toBeLessThan(Math.min(...meanGlassLinear()))
  })

  it('gives hangars door panels with no openings', () => {
    expect(FACADE_GRAMMARS[FacadeClass.HANGAR].opening).toBe('none')
    expect(FACADE_GRAMMARS[FacadeClass.HANGAR].relief).toBe('panels')
    expect(grammarCoverage(FacadeClass.HANGAR)).toBe(0)
    expect(FACADE_GRAMMARS[FacadeClass.HANGAR].bayM).toBeGreaterThan(8)
  })

  it('gives domestic garages and carports a plain wall: no openings, no relief', () => {
    expect(FACADE_GRAMMARS[FacadeClass.PLAIN].opening).toBe('none')
    expect(FACADE_GRAMMARS[FacadeClass.PLAIN].relief).toBe('flat')
    expect(grammarCoverage(FacadeClass.PLAIN)).toBe(0)
  })

  it('draws slab lines on every grammar with openings', () => {
    for (const code of [FacadeClass.GENERIC, FacadeClass.GARAGE, FacadeClass.HOUSE, FacadeClass.OFFICE]) {
      expect(FACADE_GRAMMARS[code].relief).toBe('slabs')
    }
  })
})

/** The wall colour the shader picks for a building with these tags, through the packed style colour. */
function wallFor(tags: Record<string, string | number>): readonly number[] {
  const read = (name: string) => tags[name]
  const feature = { getPropertyInherited: read, getProperty: read } as unknown as Cesium.Cesium3DTileFeature
  const style = createBuildingStyle()
  const colour = (style.color as Cesium.StyleExpression).evaluateColor(feature, new Cesium.Color())
  const rgb = [colour.red, colour.green, colour.blue].map((c) => Math.round(c * 255)) as [number, number, number]
  const { facadeClass } = decodePackedColour(rgb)
  return wallColourSrgb(facadeClass as FacadeClassCode, Math.floor(featureHash(feature) * PACK_HASH_STATES))
}

describe('wall palette', () => {
  it('has a curated entry per hash state for every class', () => {
    for (const code of Object.values(FacadeClass)) {
      expect(FACADE_PALETTES[code]).toHaveLength(PACK_HASH_STATES)
      for (const entry of FACADE_PALETTES[code]) {
        for (const channel of entry) {
          expect(channel).toBeGreaterThan(0.3)
          expect(channel).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('always picks the same entry for the same position', () => {
    const at = { building: 'house', 'cesium#latitude': 37.72118, 'cesium#longitude': -122.22054 }
    const first = wallFor(at)

    expect(wallFor({ ...at, 'building:levels': '2' })).toEqual(first)
    expect(wallFor({ ...at })).toEqual(first)
  })

  it('spreads neighbouring buildings across the palette', () => {
    const seen = new Map<string, number>()
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        const tags = {
          building: 'house',
          'cesium#latitude': 37.7212 + i * 1e-4,
          'cesium#longitude': -122.2205 + j * 1e-4,
        }
        const key = wallFor(tags).join(',')
        seen.set(key, (seen.get(key) ?? 0) + 1)
      }
    }

    expect(seen.size).toBe(PACK_HASH_STATES)
    for (const count of seen.values()) {
      expect(count).toBeGreaterThanOrEqual(8)
    }
  })

  it('picks from the building class palette', () => {
    const at = { 'cesium#latitude': 37.61568, 'cesium#longitude': -122.38905 }

    expect(FACADE_PALETTES[FacadeClass.HANGAR]).toContainEqual(wallFor({ ...at, building: 'hangar' }))
    expect(FACADE_PALETTES[FacadeClass.HOUSE]).toContainEqual(wallFor({ ...at, building: 'house' }))
  })
})

describe('createFacadeShader', () => {
  it('starts with the fade off and the default fade range', () => {
    const { uniforms } = createFacadeShader()

    expect(uniforms.u_fade.value).toBe(0)
    expect(uniforms.u_fadeStart.value).toBe(0.25)
    expect(uniforms.u_fadeEnd.value).toBe(0.6)
    expect(uniforms.u_cover).toBeUndefined()
    expect(uniforms.u_fade.type).toBe(Cesium.UniformType.FLOAT)
    expect(uniforms.u_glassMean.type).toBe(Cesium.UniformType.VEC3)
  })

  it('takes screen-space derivatives before any branch in the fragment', () => {
    const text = createFacadeShader().fragmentShaderText ?? ''
    const body = text.slice(text.indexOf('void fragmentMain('))
    const firstDerivative = body.indexOf('fwidth(')

    expect(firstDerivative).toBeGreaterThan(-1)
    expect(body.indexOf('if (detail')).toBeGreaterThan(firstDerivative)
    expect(body.indexOf('if (')).toBeGreaterThan(firstDerivative)
  })

  it('reads the packed style colour only where the tileset carries feature ids', () => {
    const text = createFacadeShader().fragmentShaderText ?? ''
    const body = text.slice(text.indexOf('void fragmentMain('))
    const guard = body.indexOf('#ifdef HAS_SELECTED_FEATURE_ID')
    const read = body.indexOf('selectedFeatureIdStage(')

    expect(guard).toBeGreaterThan(-1)
    expect(read).toBeGreaterThan(guard)
    expect(body.indexOf('#endif', guard)).toBeGreaterThan(read)
  })

  it("reads the building's base from the lookup texture only where feature ids and the bound lookup both exist", () => {
    const text = createFacadeShader().fragmentShaderText ?? ''
    const body = text.slice(text.indexOf('void fragmentMain('))
    const guard = body.indexOf(`#if defined(HAS_SELECTED_FEATURE_ID) && defined(${BUILDING_LOOKUP_DEFINE})`)
    const read = body.indexOf(`ground = ${glslBuildingLookupRead('styled.id', '0')};`)
    const topRead = body.indexOf(`top = ${glslBuildingLookupRead('styled.id', '1')};`)

    expect(guard).toBeGreaterThan(-1)
    expect(read).toBeGreaterThan(guard)
    expect(topRead).toBeGreaterThan(read)
    expect(body.indexOf('texelFetch(')).toBe(read + 'ground = '.length)
    expect(body.indexOf('#endif', guard)).toBeGreaterThan(topRead)
  })

  it('starts the base and the wall top at the no-lookup sentinels, so a tile without one never draws rows', () => {
    const text = createFacadeShader().fragmentShaderText ?? ''
    const body = text.slice(text.indexOf('void fragmentMain('))

    expect(text).toContain('vec4 ground = vec4(0.0, 0.0, 0.0, -1.0);')
    expect(body.indexOf('vec4 top = vec4(-1.0, 0.0, 0.0, 0.0);')).toBeGreaterThan(-1)
    expect(body.indexOf('vec4 top = vec4(-1.0, 0.0, 0.0, 0.0);')).toBeLessThan(body.indexOf('#if defined('))
  })

  it("picks the wall palette entry from the lookup's hash, not from the packed colour", () => {
    const text = createFacadeShader().fragmentShaderText ?? ''
    const decode = text.slice(text.indexOf('vec4 facadeDecode('), text.indexOf('}', text.indexOf('vec4 facadeDecode(')))

    expect(text).toContain(
      `float paletteIndex = clamp(floor(top.y * ${PACK_HASH_STATES}.0), 0.0, ${PACK_HASH_STATES - 1}.0);`,
    )
    expect(text).toContain('facadeWallLinear(building.x, paletteIndex)')
    expect(decode).not.toContain(`${PACK_HASH_STATES}.0`)
    expect(decode).toContain('return vec4(code.r, code.g,')
  })

  // The patched stage declares the sampler (installBuildingLookupStage), as it does the lookup's; a
  // second declaration in the shader text would not compile.
  it('reads the face table only on the near path, after the far return', () => {
    const text = createFacadeShader().fragmentShaderText ?? ''
    const body = text.slice(text.indexOf('void fragmentMain('))
    const farReturn = body.indexOf('return;', body.indexOf('if (detail <= 0.001)'))
    const match = body.indexOf('facadeFace(')

    expect(BUILDING_FACES_SAMPLER).toBe('tc3d_buildingFaces')
    expect(text).not.toContain(`uniform sampler2D ${BUILDING_FACES_SAMPLER}`)
    expect(body).not.toContain(BUILDING_FACES_SAMPLER)
    expect(farReturn).toBeGreaterThan(-1)
    expect(match).toBeGreaterThan(farReturn)
    expect(body.indexOf('facadeFace(')).toBe(body.lastIndexOf('facadeFace('))
  })

  it('bounds the face loop by the per-feature cap and clamps every face read into the table', () => {
    const text = createFacadeShader().fragmentShaderText ?? ''
    const reads = text.split(`texelFetch(${BUILDING_FACES_SAMPLER}, `).slice(1)

    expect(text).toContain(`const int FACADE_FACES_MAX = ${FACES_PER_FEATURE_MAX};`)
    expect(text).toContain('for (int i = 0; i < FACADE_FACES_MAX; i++) {\n    if (i >= count) break;')
    expect(text).toContain('return ivec2(k % size.x, min(k / size.x, size.y - 1));')
    expect(reads).toHaveLength(3)
    for (const read of reads) expect(read.startsWith('facadeFaceTexel(')).toBe(true)
  })

  it('reads faces with texelFetch only and takes no derivative in the face match', () => {
    const text = createFacadeShader().fragmentShaderText ?? ''
    const start = text.indexOf('ivec2 facadeFaceTexel(')
    const helpers = text.slice(start, text.indexOf('void fragmentMain('))
    const body = text.slice(text.indexOf('void fragmentMain('))

    expect(start).toBeGreaterThan(-1)
    for (const derivative of ['fwidth', 'dFdx', 'dFdy', 'texture(']) expect(helpers).not.toContain(derivative)
    expect(body).toContain('vec2 metresAa = fwidth(vec2(s, h));')
    expect(body.indexOf('if (')).toBeGreaterThan(body.indexOf('vec2 metresAa = fwidth(vec2(s, h));'))
    expect(body).toContain('vec2 fitAa = max(metresAa / max(size, vec2(1e-4)), vec2(1e-4));')
  })

  it("takes the matched face's coordinate along cross(upMC, the face's normal)", () => {
    const text = createFacadeShader().fragmentShaderText ?? ''

    expect(text).toContain('float s = dot(p, normalize(cross(up, plane.xyz)));')
    expect(text).toContain('facadeFace(int(top.z + 0.5), int(top.w + 0.5), local, normalMC, upMC, run, heights)')
    expect(text).toContain('vec2 id = floor(cell);')
    expect(text).toContain('float glassPick = facadeHash12(vec2(facadeHash12(id), run.z));')
    expect(text).toContain('float litPick = facadeHash12(vec2(facadeHash12(id * 1.37), run.z));')
    expect(text).not.toContain('+ vec2(run.z')
  })

  it('writes the TypeScript constants of the match and the fit into the GLSL', () => {
    const text = createFacadeShader().fragmentShaderText ?? ''
    const floats: [string, number][] = [
      ['FACADE_FACE_GATE_COS', FACE_GATE_COS],
      ['FACADE_FACE_PLANE_TOL', FACE_PLANE_TOL_M],
      ['FACADE_FACE_S_TOL', FACE_S_TOL_M],
      ['FACADE_PIER', FACADE_PIER_M],
      ['FACADE_BASE_BAND', FACADE_BASE_BAND_M],
      ['FACADE_PARAPET', FACADE_PARAPET_M],
      ['FACADE_STOREY_MIN', STOREY_MIN_M],
      ['FACADE_STOREY_MAX', STOREY_MAX_M],
    ]

    for (const [name, value] of floats) {
      expect(text).toContain(`const float ${name} = ${Number.isInteger(value) ? `${value}.0` : value};`)
    }
  })

  // These bodies are the GLSL twins of matchFace and fitOpening in facadeFit.ts, whose tests check
  // what the shader draws. Change the TypeScript twin with any change here, line for line.
  it('keeps the GLSL face match and fit identical to their TypeScript twins', () => {
    const text = createFacadeShader().fragmentShaderText ?? ''
    const body = (signature: string, end: string) => {
      const start = text.indexOf(signature)
      return text.slice(start, text.indexOf(end, start) + 2)
    }
    const face = [
      'float facadeFace(int first, int count, vec3 p, vec3 n, vec3 up, out vec3 run, out vec2 heights) {',
      '  run = vec3(0.0);',
      '  heights = vec2(0.0);',
      '  for (int i = 0; i < FACADE_FACES_MAX; i++) {',
      '    if (i >= count) break;',
      '    int k = 3 * (first + i);',
      '    vec4 plane = texelFetch(tc3d_buildingFaces, facadeFaceTexel(k), 0);',
      '    if (dot(n, plane.xyz) < FACADE_FACE_GATE_COS || abs(dot(p, plane.xyz) - plane.w) > FACADE_FACE_PLANE_TOL) continue;',
      '    vec4 ends = texelFetch(tc3d_buildingFaces, facadeFaceTexel(k + 1), 0);',
      '    float s = dot(p, normalize(cross(up, plane.xyz)));',
      '    if (s < ends.x - FACADE_FACE_S_TOL || s > ends.y + FACADE_FACE_S_TOL) continue;',
      '    vec4 span = texelFetch(tc3d_buildingFaces, facadeFaceTexel(k + 2), 0);',
      '    run = vec3(ends.z + clamp(s, ends.x, ends.y) - ends.x, ends.w, span.z);',
      '    heights = span.xy;',
      '    return 1.0;',
      '  }',
      '  return 0.0;',
      '}',
    ]
    const fit = [
      'float facadeFit(float matched, vec3 run, vec2 heights, float h, vec4 grammar, float levels, out vec2 cell, out vec2 size) {',
      '  cell = vec2(0.0);',
      '  size = vec2(0.0);',
      '  float closed = run.y < 0.0 ? 1.0 : 0.0;',
      '  float len = abs(run.y);',
      '  float pier = (1.0 - closed) * FACADE_PIER;',
      '  float span = len - 2.0 * pier;',
      '  float bottom = heights.x + FACADE_BASE_BAND;',
      '  float usable = heights.y - FACADE_PARAPET - bottom;',
      '  if (matched < 0.5 || span <= 0.0 || usable <= 0.0) return 0.0;',
      '  float bays = max(1.0, floor(span / grammar.x + 0.5));',
      '  float bay = span / bays;',
      '  float wanted = grammar.w > 0.5 && levels >= 1.0',
      '    ? max(levels, ceil(usable / FACADE_STOREY_MAX))',
      '    : max(1.0, floor(usable / grammar.y + 0.5));',
      '  float rows = max(1.0, min(wanted, floor(usable / FACADE_STOREY_MIN)));',
      '  float pitch = usable / rows;',
      '  float along = closed > 0.5 ? mod(run.x, len) : run.x - pier;',
      '  cell = vec2(along / bay, (h - bottom) / pitch);',
      '  size = vec2(bay, pitch);',
      '  vec2 index = floor(cell);',
      '  return step(0.0, index.x) * step(index.x, bays - 1.0) * step(0.0, index.y) * step(index.y, rows - 1.0);',
      '}',
    ]

    expect(body('float facadeFace(int first', '\n}')).toBe(face.join('\n'))
    expect(body('float facadeFit(float matched', '\n}')).toBe(fit.join('\n'))
  })

  it('clamps the feature id into the lookup on both sides', () => {
    const text = createFacadeShader().fragmentShaderText ?? ''

    expect(text).toContain(`ivec2(clamp(styled.id, 0, textureSize(${BUILDING_LOOKUP_SAMPLER}, 0).x - 1), `)
  })

  it('drops the floor-line detail where the lookup is missing, after the derivatives and without a branch', () => {
    const text = createFacadeShader().fragmentShaderText ?? ''
    const body = text.slice(text.indexOf('void fragmentMain('))
    const gate = body.search(/float detail = [^;\n]*\* step\(0\.0, ground\.w\);/)

    expect(gate).toBeGreaterThan(body.indexOf('fwidth('))
    expect(body.indexOf('if (')).toBeGreaterThan(gate)
  })

  it("measures heights from the building's base, in the face table's frame", () => {
    const text = createFacadeShader().fragmentShaderText ?? ''

    expect(text).not.toContain('float h = dot(positionMC, upMC);')
    expect(text).toContain('vec3 local = positionMC - ground.xyz;')
    expect(text).toContain('float h = dot(local, upMC);')
    expect(text).toContain('float s = dot(local, tangentMC);')
    expect(text).toContain('facadeFit(matched, run, heights, h, grammar, building.y, cell, size)')
  })

  // applyBuildingStyle sets the MIX blend at amount 0, so Cesium's CPU styling multiplies the lit
  // result (diffuse, specular and image-based light alike) by one: nothing is left to divide out.
  it('leaves the material as lit, with no division by the style colour', () => {
    const text = createFacadeShader().fragmentShaderText ?? ''

    expect(text).not.toContain('facadeDivideStyle')
    expect(text).not.toContain('czm_gammaCorrect(styled')
  })

  it('carries the wall palettes and the garage gap as linear constants, converted on the CPU', () => {
    const text = createFacadeShader().fragmentShaderText ?? ''
    const linearEntry = FACADE_PALETTES[FacadeClass.HOUSE][1].map(iecSrgbToLinear)

    expect(text).not.toContain('facadeSrgbToLinear')
    expect(text).not.toContain('pow(')
    expect(text).toContain(`vec3(${linearEntry.join(', ')})`)
    expect(text).toContain(`vec3(${openingMeanLinear(FacadeClass.GARAGE).join(', ')})`)
  })

  it('box-filters the hangar ribs over the pixel footprint, with no hard wrap', () => {
    const text = createFacadeShader().fragmentShaderText ?? ''

    expect(text).toContain('facadeRibCrest(ribCoord, ribAa)')
    expect(text).not.toContain('fract(ribCoord)')
  })

  it('box-filters the hangar panel seam over the pixel footprint, with no one-sided wrap', () => {
    const text = createFacadeShader().fragmentShaderText ?? ''
    const definition = text.indexOf('float facadeSeam(float x, float footprint)')
    const call = text.indexOf('facadeSeam(f.x, fitAa.x)')

    expect(definition).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(definition)
    expect(text).not.toContain('0.01 + aa.x')
    expect(text).toContain('facadeSeamArea(1.0)')
  })
})

describe('facadeRibCrest', () => {
  it('is continuous across the rib wrap and tends to its mean as the footprint grows', () => {
    const near = [0.999, 1.0, 1.001].map((x) => ribCrest(x, 0.01))

    expect(Math.abs(near[1] - near[0])).toBeLessThan(0.2)
    expect(Math.abs(near[2] - near[1])).toBeLessThan(0.2)
    expect(ribCrest(0.3, 4)).toBeCloseTo(RIB_CREST_SHARE, 6)
    expect(ribCrest(0.7, 1e-6)).toBeCloseTo(1, 9)
    expect(ribCrest(0.2, 1e-6)).toBeCloseTo(0, 9)
  })
})

describe('seamShade', () => {
  it('keeps the seam at its full depth at the smallest footprint', () => {
    let darkest = Number.POSITIVE_INFINITY
    for (let step = 0; step <= 100; step++) {
      darkest = Math.min(darkest, seamShade((step / 100) * SEAM_FILTER_MIN, SEAM_FILTER_MIN))
    }

    expect(darkest).toBeLessThan(0.75)
  })
})
