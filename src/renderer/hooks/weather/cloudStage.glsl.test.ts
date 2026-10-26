import { describe, expect, it } from 'vitest'
import { WEATHER_STAGE_PRESETS } from '@/constants'
import stageHookSource from '@/hooks/useCesiumWeatherStages.ts?raw'
import { CLOUD_STAGE_FS, CLOUD_STAGE_MAX_STEPS, WEATHER_COMPOSITE_FS } from '@/hooks/weather/cloudStage.glsl'
import { deckEdgeElevationDeg, EARTH_RADIUS_M, horizonDipDeg } from '@/utils/cloudDeckGeometry'

/** Source of the GLSL function whose signature starts with `signature`, up to its closing brace. */
function glslFunction(source: string, signature: string): string {
  const start = source.indexOf(signature)
  expect(start, `missing ${signature}`).toBeGreaterThanOrEqual(0)
  return source.slice(start, source.indexOf('\n}\n', start) + 2)
}

function glslNumber(source: string, pattern: RegExp): number {
  const match = source.match(pattern)
  expect(match, `missing ${pattern}`).not.toBeNull()
  return Number(match?.[1])
}

describe('cloud deck shader', () => {
  it('curves the slab with the earth, using the same radius as the CPU geometry', () => {
    expect(CLOUD_STAGE_FS).toContain('float deckZ(vec3 p)')
    expect(CLOUD_STAGE_FS).toContain('vec2 belowLevel(vec3 ro, vec3 rd, float h)')
    expect(glslFunction(CLOUD_STAGE_FS, 'void marchLayer(')).toContain('belowLevel(')
    expect(glslFunction(CLOUD_STAGE_FS, 'float cloudDensity(')).toContain('deckZ(p)')
    expect(glslNumber(CLOUD_STAGE_FS, /const float EARTH_R = ([\d.]+);/)).toBe(EARTH_RADIUS_M)
  })

  it('drops the datum by the parabola d^2 / 2R and lights the slab by its curved height', () => {
    expect(glslFunction(CLOUD_STAGE_FS, 'float deckZ(')).toContain('return p.z + dot(p.xy, p.xy) / (2.0 * EARTH_R);')
    expect(glslFunction(CLOUD_STAGE_FS, 'vec3 cloudLight(')).toContain('(deckZ(p) - layer.x) / layer.y')
  })

  it('orders the layers by their base against the camera, not by the ray slope', () => {
    const main = glslFunction(CLOUD_STAGE_FS, 'void main(')
    expect(main).toContain('int below = layersBelow(deckZ(ro), count);')
    expect(main).toContain('int i = k < below ? below - 1 - k : k;')
    expect(main).not.toContain('rd.z >= 0.0 ? k')
    expect(glslFunction(CLOUD_STAGE_FS, 'int layersBelow(')).toContain('layerAt(j).x <= camZ')
  })

  it('allows 256 march steps, enough for the configured step count, and clamps u_steps to the same bound', () => {
    const maxSteps = glslNumber(CLOUD_STAGE_FS, /const int MAX_STEPS = (\d+);/)
    expect(maxSteps).toBe(256)
    expect(maxSteps).toBe(CLOUD_STAGE_MAX_STEPS)
    expect(maxSteps).toBeGreaterThanOrEqual(WEATHER_STAGE_PRESETS.high.steps)
    expect(stageHookSource).toContain('Math.round(qualityRef.current.steps), 4, CLOUD_STAGE_MAX_STEPS)')
  })

  it('spreads the High deck 100 km with 120 steps, leaving under 0.16 deg of sky above the horizon from the tower', () => {
    expect(WEATHER_STAGE_PRESETS.high.radius).toBe(100000)
    expect(WEATHER_STAGE_PRESETS.high.steps).toBe(120)
    const edge = deckEdgeElevationDeg(88.8, 609.6, WEATHER_STAGE_PRESETS.high.radius, true)
    expect(edge - -horizonDipDeg(88.8)).toBeLessThan(0.16)
  })

  it.each([
    ['cloud', CLOUD_STAGE_FS],
    ['composite', WEATHER_COMPOSITE_FS],
  ])('shades the cloud underside and the fog with the same grey in the %s pass', (_pass, source) => {
    expect(glslFunction(source, 'vec3 fogColor(')).toContain('FOG_GREY *')
    expect(source).not.toContain('0.40, 0.43, 0.50')
  })

  it('takes the cloud underside colour from the fog grey', () => {
    expect(glslFunction(CLOUD_STAGE_FS, 'vec3 cloudLight(')).toContain('vec3 dark = FOG_GREY;')
  })

  it('marches each layer with the sun shade its layer data gives it', () => {
    const passesShade = (source: string) => glslFunction(source, 'void main(').includes('layerAt(i), layerShade(i),')
    expect(passesShade(CLOUD_STAGE_FS)).toBe(true)
    expect(passesShade(CLOUD_STAGE_FS.replace('layerShade(i)', '0.0'))).toBe(false)
  })

  it('lights a shaded layer from its shade, not from full sun', () => {
    const lightsWithShade = (source: string) => /mix\([^;]*,\s*shade\)/.test(glslFunction(source, 'vec3 cloudLight('))
    expect(lightsWithShade(CLOUD_STAGE_FS)).toBe(true)
    expect(lightsWithShade(CLOUD_STAGE_FS.replace(', shade)', ', 0.0)'))).toBe(false)
  })
})
