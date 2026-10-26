import { describe, expect, it, vi } from 'vitest'
import {
  STATUTE_MILES_TO_METERS,
  WEATHER_STAGE_FOG_EASE_MS,
  WEATHER_STAGE_GROUND_BLEND_MS,
  WEATHER_STAGE_NOISE_ORIGIN_RESET_M,
  WEATHER_STAGE_PRESETS,
} from '@/constants'
import { CLOUD_STAGE_FS, CLOUD_STAGE_MAX_STEPS, WEATHER_COMPOSITE_FS } from '@/hooks/weather/cloudStage.glsl'
import type { CloudLayer, WeatherQualityPreset } from '@/types'
import {
  anchorGround,
  buildCloudLayerUniforms,
  easedFogDensity,
  effectiveVisibilitySM,
  type FogEase,
  type FogEaseInput,
  type FrameGround,
  groundBlendShift,
  groundShiftStart,
  horizontalNoiseOffset,
  insetStageQuality,
  layerSunShade,
  NO_FOG_EASE,
  nextFogEase,
  nextWeatherAnchor,
  noiseOriginNeedsReset,
  sceneFogValues,
  stageDrawsFog,
  stageFogDensity,
  stageFogExtinction,
  stageFogFade,
  stagePresetForViewport,
  startFogEase,
  type WeatherStageGateInput,
  weatherStageGates,
  weatherStageHasWork,
  weatherStageQuality,
} from '@/utils/weatherStage'

const THICKNESS = { FEW: 250, SCT: 350, BKN: 450, OVC: 600 }

const PRESETS: WeatherQualityPreset[] = ['low', 'medium', 'high']

describe('weatherStageQuality', () => {
  it.each(PRESETS)('gives the %s preset all six knobs', (preset) => {
    expect(Object.keys(weatherStageQuality(preset)).sort()).toEqual([
      'densityScale',
      'fogExtinction',
      'fogHeightScale',
      'radius',
      'resolutionScale',
      'steps',
    ])
  })

  it.each(PRESETS)('keeps the %s preset steps an integer within the shader maximum', (preset) => {
    const { steps } = weatherStageQuality(preset)
    expect(Number.isInteger(steps)).toBe(true)
    expect(steps).toBeGreaterThanOrEqual(4)
    expect(steps).toBeLessThanOrEqual(CLOUD_STAGE_MAX_STEPS)
  })

  it.each(PRESETS)('keeps the %s preset cloud pass scale within 0.25..1', (preset) => {
    const { resolutionScale } = weatherStageQuality(preset)
    expect(resolutionScale).toBeGreaterThanOrEqual(0.25)
    expect(resolutionScale).toBeLessThanOrEqual(1)
  })

  it('keeps High at the stage values the deck was tuned with', () => {
    expect(weatherStageQuality('high')).toEqual({
      steps: 120,
      resolutionScale: 0.5,
      densityScale: 0.04,
      fogExtinction: 1.0,
      fogHeightScale: 400,
      radius: 100000,
    })
  })

  it('gives Medium and Low lower cost knobs and the same look knobs as High', () => {
    expect(weatherStageQuality('medium')).toMatchObject({ steps: 72, resolutionScale: 0.375, radius: 60000 })
    expect(weatherStageQuality('low')).toMatchObject({ steps: 48, resolutionScale: 0.25, radius: 40000 })
    const look = ({ densityScale, fogExtinction, fogHeightScale }: (typeof WEATHER_STAGE_PRESETS)['high']) => ({
      densityScale,
      fogExtinction,
      fogHeightScale,
    })
    expect(look(WEATHER_STAGE_PRESETS.medium)).toEqual(look(WEATHER_STAGE_PRESETS.high))
    expect(look(WEATHER_STAGE_PRESETS.low)).toEqual(look(WEATHER_STAGE_PRESETS.high))
  })

  it('falls back to High for a stored value that is no preset', () => {
    expect(weatherStageQuality('ultra' as WeatherQualityPreset)).toBe(WEATHER_STAGE_PRESETS.high)
  })
})

describe('insetStageQuality', () => {
  const MAIN = 1000

  it.each(PRESETS)('keeps the main %s preset for an inset of exactly half the main area or more', (preset) => {
    expect(insetStageQuality(preset, 500, MAIN)).toBe(preset)
    expect(insetStageQuality(preset, 1000, MAIN)).toBe(preset)
  })

  it.each([
    ['high', 'medium'],
    ['medium', 'low'],
    ['low', 'low'],
  ] as const)('steps %s down to %s from exactly 15% to just under 50%', (main, expected) => {
    expect(insetStageQuality(main, 150, MAIN)).toBe(expected)
    expect(insetStageQuality(main, 499.9, MAIN)).toBe(expected)
  })

  it.each(PRESETS)('drops the main %s preset to Low under 15% of the main area', (preset) => {
    expect(insetStageQuality(preset, 149.9, MAIN)).toBe('low')
  })

  it.each([
    [0, MAIN],
    [-5, MAIN],
    [500, 0],
    [500, -1],
    [Number.NaN, MAIN],
  ])('keeps the main preset for inset area %s and main area %s', (insetArea, mainArea) => {
    expect(insetStageQuality('medium', insetArea, mainArea)).toBe('medium')
  })
})

describe('stagePresetForViewport', () => {
  const MAIN = 1000

  it.each(PRESETS)('keeps the stored %s preset in the main view whatever the areas', (preset) => {
    expect(stagePresetForViewport({ stageQuality: preset, isInset: false, insetArea: 100, mainArea: MAIN })).toBe(
      preset,
    )
    expect(stagePresetForViewport({ stageQuality: preset, isInset: false, insetArea: null, mainArea: null })).toBe(
      preset,
    )
  })

  it('keeps the stored preset for an inset at 60% of the main area', () => {
    expect(stagePresetForViewport({ stageQuality: 'high', isInset: true, insetArea: 600, mainArea: MAIN })).toBe('high')
  })

  it('steps an inset at 30% of the main area one preset down', () => {
    expect(stagePresetForViewport({ stageQuality: 'high', isInset: true, insetArea: 300, mainArea: MAIN })).toBe(
      'medium',
    )
  })

  it('drops an inset at 10% of the main area to Low', () => {
    expect(stagePresetForViewport({ stageQuality: 'high', isInset: true, insetArea: 100, mainArea: MAIN })).toBe('low')
  })

  it('keeps the stored preset for an inset whose areas cannot be read', () => {
    expect(stagePresetForViewport({ stageQuality: 'medium', isInset: true, insetArea: null, mainArea: null })).toBe(
      'medium',
    )
  })

  it('warns once for an invalid stored value and falls back to High', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const invalid = 'insane' as WeatherQualityPreset
      expect(stagePresetForViewport({ stageQuality: invalid, isInset: false, insetArea: null, mainArea: null })).toBe(
        'high',
      )
      expect(stagePresetForViewport({ stageQuality: invalid, isInset: true, insetArea: 300, mainArea: MAIN })).toBe(
        'medium',
      )
      expect(weatherStageQuality(invalid)).toBe(WEATHER_STAGE_PRESETS.high)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

function layer(altitude: number, coverage: number, type: string): CloudLayer {
  return { altitude, coverage, type } as CloudLayer
}

describe('buildCloudLayerUniforms', () => {
  it('returns nothing for no layers', () => {
    expect(buildCloudLayerUniforms([], THICKNESS)).toEqual([])
  })

  it('drops clear layers and sorts the rest lowest first with thickness by cover code', () => {
    const uniforms = buildCloudLayerUniforms(
      [layer(1500, 1, 'OVC'), layer(300, 0, 'CLR'), layer(760, 0.75, 'BKN')],
      THICKNESS,
    )
    expect(uniforms).toEqual([
      { base: 760, thickness: 450, coverage: 0.75 },
      { base: 1500, thickness: 600, coverage: 1 },
    ])
  })

  it('keeps the four lowest layers when more are reported', () => {
    const uniforms = buildCloudLayerUniforms(
      [1800, 300, 1200, 600, 900].map((altitude) => layer(altitude, 0.5, 'SCT')),
      THICKNESS,
    )
    expect(uniforms.map((u) => u.base)).toEqual([300, 600, 900, 1200])
  })

  it('gives an unknown cover code the default thickness', () => {
    expect(buildCloudLayerUniforms([layer(500, 0.5, 'VV')], THICKNESS)[0].thickness).toBe(400)
  })

  it('leaves the input order untouched', () => {
    const input = [layer(900, 0.5, 'SCT'), layer(300, 0.5, 'SCT')]
    buildCloudLayerUniforms(input, THICKNESS)
    expect(input.map((l) => l.altitude)).toEqual([900, 300])
  })
})

describe('layerSunShade', () => {
  const slab = (base: number, coverage: number) => ({ base, thickness: 450, coverage })
  const FEW = 0.1875
  const SCT = 0.4375
  const BKN = 0.6875
  const OVC = 1

  it('shades a BKN layer under an OVC layer', () => {
    expect(layerSunShade([slab(300, BKN), slab(600, OVC)])).toEqual([1, 0])
  })

  it('shades a BKN layer under another BKN layer', () => {
    expect(layerSunShade([slab(300, BKN), slab(900, BKN)])).toEqual([1, 0])
  })

  it('leaves a BKN layer lit when only FEW or SCT layers are above it', () => {
    expect(layerSunShade([slab(300, BKN), slab(900, SCT), slab(1500, FEW)])).toEqual([0, 0, 0])
  })

  it('shades every layer under a BKN or OVC one, through a lit layer between them', () => {
    expect(layerSunShade([slab(300, BKN), slab(600, SCT), slab(900, OVC)])).toEqual([1, 1, 0])
  })

  it('never shades the top layer or a single layer', () => {
    expect(layerSunShade([slab(300, OVC), slab(600, BKN)])).toEqual([1, 0])
    expect(layerSunShade([slab(300, BKN)])).toEqual([0])
    expect(layerSunShade([])).toEqual([])
  })
})

describe('stageFogFade', () => {
  it('is 0 (no fog) at 10 SM and above', () => {
    expect(stageFogFade(10)).toBe(0)
    expect(stageFogFade(12)).toBe(0)
  })

  it('fades in linearly between 10 and 8 SM', () => {
    expect(stageFogFade(9)).toBeCloseTo(0.5, 12)
  })

  it('is 1 (full METAR fog) at 8 SM and below', () => {
    expect(stageFogFade(8)).toBe(1)
    expect(stageFogFade(3)).toBe(1)
  })
})

describe('stageFogDensity', () => {
  /** Relative difference, for densities of order 1e-4 per meter */
  const relative = (actual: number, expected: number) => Math.abs(actual - expected) / expected

  it('is 0 (no fog) without a METAR', () => {
    expect(stageFogDensity(undefined, 1)).toBe(0)
  })

  it('is 0 (no fog) at 10 SM and above', () => {
    expect(stageFogDensity(10, 1)).toBe(0)
    expect(stageFogDensity(15, 2)).toBe(0)
  })

  it('is one over the visibility in meters, with visibilityScale applied, at full strength', () => {
    expect(relative(stageFogDensity(0.5, 1), 1 / (0.5 * STATUTE_MILES_TO_METERS))).toBeLessThan(1e-12)
    expect(relative(stageFogDensity(3, 2), 1 / (6 * STATUTE_MILES_TO_METERS))).toBeLessThan(1e-12)
  })

  it('scales the density by the fade between 10 and 8 SM', () => {
    expect(relative(stageFogDensity(9, 1), 0.5 / (9 * STATUTE_MILES_TO_METERS))).toBeLessThan(1e-12)
  })

  it('floors visibility at 0.05 SM so zero visibility still draws finite fog', () => {
    expect(relative(stageFogDensity(0, 1), 1 / (0.05 * STATUTE_MILES_TO_METERS))).toBeLessThan(1e-12)
  })
})

describe('fog ease', () => {
  const density = (visibSM: number) => stageFogDensity(visibSM, 1)

  it('eases a METAR step from 10 SM to 6 SM with a smoothstep, reaching the target exactly at the ease time', () => {
    const target = density(6)
    const ease = startFogEase(density(10), target, 0)
    const fraction = (ms: number) => easedFogDensity(ease, target, ms) / target
    expect(fraction(0)).toBe(0)
    expect(fraction(1000)).toBeLessThan(0.1)
    expect(fraction(4800)).toBeLessThan(0.9)
    expect(fraction(4900)).toBeGreaterThanOrEqual(0.9)
    expect(easedFogDensity(ease, target, WEATHER_STAGE_FOG_EASE_MS)).toBe(target)
    expect(easedFogDensity(ease, target, WEATHER_STAGE_FOG_EASE_MS * 3)).toBe(target)
  })

  it('never overshoots, rising or falling', () => {
    for (const [fromSM, toSM] of [
      [10, 6],
      [2, 9],
    ]) {
      const from = density(fromSM)
      const target = density(toSM)
      const ease = startFogEase(from, target, 0)
      let previous = from
      for (let ms = 0; ms <= WEATHER_STAGE_FOG_EASE_MS + 2000; ms += 100) {
        const value = easedFogDensity(ease, target, ms)
        expect(value).toBeGreaterThanOrEqual(Math.min(from, target))
        expect(value).toBeLessThanOrEqual(Math.max(from, target))
        expect(Math.sign(value - previous) * Math.sign(target - from)).toBeGreaterThanOrEqual(0)
        previous = value
      }
    }
  })

  it('starts a new METAR step mid-ease from the current value, without a jump', () => {
    const first = startFogEase(density(10), density(6), 0)
    const current = easedFogDensity(first, density(6), 3000)
    const second = startFogEase(current, density(2), 3000)
    expect(Math.abs(easedFogDensity(second, density(2), 3000) - current) / current).toBeLessThan(1e-9)
    expect(easedFogDensity(second, density(2), 3100)).toBeGreaterThan(current)
    expect(easedFogDensity(second, density(2), 3000 + WEATHER_STAGE_FOG_EASE_MS)).toBe(density(2))
  })

  it('tracks a target gliding 0.01 SM per frame for 10 s after a METAR step, without stalling', () => {
    const ease = startFogEase(density(10), density(7), 0)
    let visibSM = 7
    let value = 0
    for (let frame = 0; frame <= 600; frame++) {
      visibSM = 7 - 0.01 * frame
      value = easedFogDensity(ease, density(visibSM), (frame * 1000) / 60)
    }
    expect(Math.abs(value - density(visibSM)) / density(visibSM)).toBeLessThan(0.02)
  })
})

describe('nextFogEase', () => {
  const density = (visibSM: number | undefined, scale = 1) => stageFogDensity(visibSM, scale)
  const input = (
    visibilitySM: number | undefined,
    targetDensity = density(visibilitySM),
    gateOpen = true,
  ): FogEaseInput => ({ visibilitySM, gateOpen, targetDensity })
  const draw = (ease: FogEase, targetDensity: number, nowMs: number) => easedFogDensity(ease, targetDensity, nowMs)

  it('eases a METAR step from 10 SM to 6 SM with the gate open', () => {
    const target = density(6)
    const ease = nextFogEase(NO_FOG_EASE, input(10), input(6), 0)
    expect(draw(ease, target, 2000)).toBeGreaterThan(0)
    expect(draw(ease, target, 2000)).toBeLessThan(target)
    expect(draw(ease, target, WEATHER_STAGE_FOG_EASE_MS)).toBe(target)
  })

  it('eases an interpolated step the same way, the function cannot tell the two apart', () => {
    const target = density(3)
    const ease = nextFogEase(NO_FOG_EASE, input(5), input(3), 0)
    expect(draw(ease, target, 2000)).toBeGreaterThan(0)
    expect(draw(ease, target, 2000)).toBeLessThan(target)
    expect(draw(ease, target, WEATHER_STAGE_FOG_EASE_MS)).toBe(target)
  })

  it('restarts a step mid-ease from the value drawn at that instant', () => {
    const first = nextFogEase(NO_FOG_EASE, input(10), input(6), 0)
    const drawn = draw(first, density(6), 3000)
    const second = nextFogEase(first, input(6), input(2), 3000)
    expect(Math.abs(draw(second, density(2), 3000) - drawn) / drawn).toBeLessThan(1e-12)
    expect(draw(second, density(2), 3000 + WEATHER_STAGE_FOG_EASE_MS)).toBe(density(2))
  })

  it('applies a visibilityScale change at once, with or without an ease in flight', () => {
    const scaled = density(6, 2)
    const settled = nextFogEase(NO_FOG_EASE, input(6), input(6, scaled), 1000)
    expect(draw(settled, scaled, 1001)).toBe(scaled)
    const easing = nextFogEase(NO_FOG_EASE, input(10), input(6), 0)
    const changed = nextFogEase(easing, input(6), input(6, scaled), 2000)
    expect(draw(changed, scaled, 2001)).toBe(scaled)
  })

  it('applies the gate closing at once, also with an ease in flight', () => {
    const easing = nextFogEase(NO_FOG_EASE, input(10), input(6), 0)
    const closed = nextFogEase(easing, input(6), input(6, 0, false), 2000)
    expect(draw(closed, 0, 2000)).toBe(0)
    expect(draw(closed, 0, 2001)).toBe(0)
  })

  it('applies the gate opening at once, without an ease from 0, after the input changed while it was closed', () => {
    const opened = nextFogEase(NO_FOG_EASE, input(6, 0, false), input(4), 5000)
    expect(draw(opened, density(4), 5000)).toBe(density(4))
    expect(draw(opened, density(4), 5001)).toBe(density(4))
  })

  it('eases the first input in from no fog', () => {
    const target = density(5)
    const ease = nextFogEase(NO_FOG_EASE, input(undefined, 0), input(5), 0)
    expect(draw(ease, target, 0)).toBe(0)
    expect(draw(ease, target, 1000)).toBeGreaterThan(0)
    expect(draw(ease, target, 1000)).toBeLessThan(target)
    expect(draw(ease, target, WEATHER_STAGE_FOG_EASE_MS)).toBe(target)
  })

  it('leaves an ease in flight alone when nothing changed', () => {
    const first = nextFogEase(NO_FOG_EASE, input(10), input(6), 0)
    expect(nextFogEase(first, input(6), input(6), 3000)).toBe(first)
    const closed = input(undefined, 0, false)
    expect(nextFogEase(NO_FOG_EASE, closed, closed, 0)).toBe(NO_FOG_EASE)
  })

  it('applies every frame of a visibilityScale drag at once, without restarting the ease', () => {
    const visibSM = 6
    let ease = nextFogEase(NO_FOG_EASE, input(10), input(visibSM, density(visibSM, 1)), 0)
    let previous = input(visibSM, density(visibSM, 1))
    for (let frame = 1; frame <= 188; frame++) {
      const nowMs = frame * 16
      const targetDensity = density(visibSM, 1 + frame * 0.01)
      const current = input(visibSM, targetDensity)
      ease = nextFogEase(ease, previous, current, nowMs)
      expect(draw(ease, targetDensity, nowMs)).toBe(targetDensity)
      previous = current
    }
  })
})

describe('stageFogExtinction', () => {
  it('is the base extinction at fogIntensity 1', () => {
    expect(stageFogExtinction(1, 1)).toBe(1)
  })

  it('doubles the optical depth at fogIntensity 2', () => {
    expect(stageFogExtinction(1, 2)).toBe(2)
  })

  it('is 0 at fogIntensity 0', () => {
    expect(stageFogExtinction(1, 0)).toBe(0)
  })

  it('clamps a negative fogIntensity to 0', () => {
    expect(stageFogExtinction(1, -1)).toBe(0)
  })
})

describe('sceneFogValues', () => {
  // What Cesium's scene.fog holds when the hook does not tune it from METAR visibility.
  const noWeather = {
    density: 0.0006,
    visualDensityScalar: 0.15,
    screenSpaceErrorFactor: 2.0,
    minimumBrightness: 0.03,
  }

  it('tunes scene.fog from fogDensity while the Cesium stage draws no fog', () => {
    expect(sceneFogValues({ fogEnabled: true, fogDensity: 0.0083, stageDrawsFog: false })).toEqual({
      enabled: true,
      density: 0.0083,
      visualDensityScalar: 0.15 + (0.0083 / 0.015) * 0.85,
      screenSpaceErrorFactor: 2.0,
      minimumBrightness: 0.1,
    })
  })

  it('applies the no-weather values while the Cesium stage draws the fog', () => {
    expect(sceneFogValues({ fogEnabled: true, fogDensity: 0.0083, stageDrawsFog: true })).toEqual({
      enabled: true,
      ...noWeather,
    })
  })

  it('applies the no-weather values at fogDensity 0 either way', () => {
    expect(sceneFogValues({ fogEnabled: true, fogDensity: 0, stageDrawsFog: false })).toEqual({
      enabled: true,
      ...noWeather,
    })
    expect(sceneFogValues({ fogEnabled: true, fogDensity: 0, stageDrawsFog: true })).toEqual({
      enabled: true,
      ...noWeather,
    })
  })

  it('leaves scene.fog off when the fog is toggled off, whatever the density or the stage', () => {
    expect(sceneFogValues({ fogEnabled: false, fogDensity: 0.0083, stageDrawsFog: false })).toEqual({
      enabled: false,
      ...noWeather,
    })
    expect(sceneFogValues({ fogEnabled: false, fogDensity: 0.0083, stageDrawsFog: true })).toEqual({
      enabled: false,
      ...noWeather,
    })
  })
})

describe('stageDrawsFog', () => {
  it('is true only with the fog gate on and an anchor frame', () => {
    expect(stageDrawsFog(true, true)).toBe(true)
    expect(stageDrawsFog(true, false)).toBe(false)
    expect(stageDrawsFog(false, true)).toBe(false)
    expect(stageDrawsFog(false, false)).toBe(false)
  })
})

describe('weatherStageGates', () => {
  const allOn: WeatherStageGateInput = {
    showWeatherEffects: true,
    showClouds: true,
    showBabylonFog: true,
    viewMode: '3d',
    logDepth: true,
  }

  it('draws clouds and fog with everything on', () => {
    expect(weatherStageGates(allOn)).toEqual({ stage: true, clouds: true, fog: true, missingLogDepth: false })
  })

  it('maps showClouds to clouds and showBabylonFog to fog', () => {
    expect(weatherStageGates({ ...allOn, showClouds: false })).toMatchObject({ stage: true, clouds: false, fog: true })
    expect(weatherStageGates({ ...allOn, showBabylonFog: false })).toMatchObject({
      stage: true,
      clouds: true,
      fog: false,
    })
  })

  it('drops the stage when neither clouds nor fog are wanted', () => {
    expect(weatherStageGates({ ...allOn, showClouds: false, showBabylonFog: false }).stage).toBe(false)
  })

  it.each([
    ['the master weather switch is off', { showWeatherEffects: false }],
    ['the view is top-down', { viewMode: 'topdown' as const }],
  ])('draws nothing when %s', (_reason, change) => {
    expect(weatherStageGates({ ...allOn, ...change })).toEqual({
      stage: false,
      clouds: false,
      fog: false,
      missingLogDepth: false,
    })
  })

  it('hides the stage and flags it when the logarithmic depth buffer is off', () => {
    expect(weatherStageGates({ ...allOn, logDepth: false })).toEqual({
      stage: false,
      clouds: false,
      fog: false,
      missingLogDepth: true,
    })
  })

  it('does not flag missing log depth when the stage is not wanted anyway', () => {
    expect(weatherStageGates({ ...allOn, logDepth: false, showWeatherEffects: false }).missingLogDepth).toBe(false)
  })
})

describe('nextWeatherAnchor', () => {
  const oak = { airportIcao: 'KOAK', lat: 37.7213, lon: -122.2208 }

  it('is null without a reference position', () => {
    expect(nextWeatherAnchor(null, { airportIcao: null, lat: null, lon: null })).toBeNull()
  })

  it('anchors on the airport reference the first time, carrying the airport elevation as ground hint', () => {
    expect(nextWeatherAnchor(null, { ...oak, groundHintM: 2.7 })).toEqual({
      key: 'airport:KOAK',
      lat: oak.lat,
      lon: oak.lon,
      groundHintM: 2.7,
    })
  })

  it('keeps the same anchor object under small reference moves at the same airport', () => {
    const first = nextWeatherAnchor(null, oak)
    // About 22 m north: inside the airport re-anchor distance.
    expect(nextWeatherAnchor(first, { ...oak, lat: oak.lat + 0.0002 })).toBe(first)
  })

  it('re-anchors within the same airport once the reference moves past the airport re-anchor distance', () => {
    const first = nextWeatherAnchor(null, oak)
    // About 330 m north, e.g. a custom tower position arriving after the first render.
    const moved = nextWeatherAnchor(first, { ...oak, lat: oak.lat + 0.003 })
    expect(moved).not.toBe(first)
    expect(moved).toEqual({ key: 'airport:KOAK', lat: oak.lat + 0.003, lon: oak.lon, groundHintM: null })
  })

  it('re-anchors on an airport switch', () => {
    const first = nextWeatherAnchor(null, oak)
    const sfo = { airportIcao: 'KSFO', lat: 37.6188, lon: -122.375 }
    expect(nextWeatherAnchor(first, sfo)).toEqual({
      key: 'airport:KSFO',
      lat: sfo.lat,
      lon: sfo.lon,
      groundHintM: null,
    })
  })

  it('keeps the anchor under orbit-follow jitter without an airport', () => {
    const first = nextWeatherAnchor(null, { airportIcao: null, lat: 40, lon: -100 })
    // About 1.1 km north: well inside the free re-anchor distance.
    expect(nextWeatherAnchor(first, { airportIcao: null, lat: 40.01, lon: -100 })).toBe(first)
  })

  it('re-anchors a followed aircraft once it has moved past the re-anchor distance', () => {
    const first = nextWeatherAnchor(null, { airportIcao: null, lat: 40, lon: -100 })
    // About 5.6 km north.
    const moved = nextWeatherAnchor(first, { airportIcao: null, lat: 40.05, lon: -100 })
    expect(moved).not.toBe(first)
    expect(moved).toEqual({ key: 'free', lat: 40.05, lon: -100, groundHintM: null })
  })

  it('re-anchors when the airport is left for orbit-follow', () => {
    const first = nextWeatherAnchor(null, oak)
    expect(nextWeatherAnchor(first, { airportIcao: null, lat: oak.lat, lon: oak.lon })?.key).toBe('free')
  })
})

describe('anchorGround', () => {
  const den = 'airport:KDEN'
  const base = { key: den, previous: null, moved: true }
  const noSample = { sampledM: undefined, ellipsoidProvider: false }

  it('uses the sampled terrain height from a real terrain provider', () => {
    expect(anchorGround({ ...base, sampledM: -28.5, ellipsoidProvider: false, hintM: 2.7 })).toEqual({
      key: den,
      groundM: -28.5,
      sampled: true,
    })
  })

  it('keeps the airport elevation hint, as a placeholder, while the provider is still the bare ellipsoid', () => {
    expect(anchorGround({ ...base, sampledM: 0, ellipsoidProvider: true, hintM: 1656 })).toEqual({
      key: den,
      groundM: 1656,
      sampled: false,
    })
  })

  it('falls back to the hint when the sample has no height', () => {
    expect(anchorGround({ ...base, ...noSample, hintM: 1656 })).toEqual({ key: den, groundM: 1656, sampled: false })
  })

  it('is a 0 placeholder with neither a usable sample, a hint nor a previous ground', () => {
    expect(anchorGround({ ...base, sampledM: undefined, ellipsoidProvider: true, hintM: null })).toEqual({
      key: den,
      groundM: 0,
      sampled: false,
    })
  })

  it('carries the previous sampled ground of the same key to a new location as a placeholder, ahead of the hint', () => {
    const previous: FrameGround = { key: den, groundM: 1634.2, sampled: true }
    expect(anchorGround({ ...base, ...noSample, hintM: 1656, previous })).toEqual({
      key: den,
      groundM: 1634.2,
      sampled: false,
    })
  })

  it('keeps the previous sampled ground at the same location when a new sample has no height', () => {
    const previous: FrameGround = { key: den, groundM: 1634.2, sampled: true }
    expect(anchorGround({ ...base, ...noSample, moved: false, hintM: 1656, previous })).toEqual(previous)
  })

  it('takes the hint over the previous ground of another key', () => {
    const previous: FrameGround = { key: 'airport:KOAK', groundM: -28.5, sampled: true }
    expect(anchorGround({ ...base, ...noSample, hintM: 1656, previous })).toEqual({
      key: den,
      groundM: 1656,
      sampled: false,
    })
  })

  it('carries the previous ground of another key as a placeholder when there is no hint (airport to orbit-follow)', () => {
    const previous: FrameGround = { key: den, groundM: 1634.2, sampled: true }
    expect(anchorGround({ ...base, ...noSample, key: 'free', hintM: null, previous })).toEqual({
      key: 'free',
      groundM: 1634.2,
      sampled: false,
    })
  })

  it('keeps the previous placeholder of the same key when there is no hint', () => {
    const previous: FrameGround = { key: den, groundM: 1656, sampled: false }
    expect(anchorGround({ ...base, ...noSample, hintM: null, previous })).toEqual(previous)
  })

  it('takes a new sample over the previous sampled ground', () => {
    const previous: FrameGround = { key: den, groundM: 1634.2, sampled: true }
    expect(anchorGround({ ...base, sampledM: 1640, ellipsoidProvider: false, hintM: 1656, previous }).groundM).toBe(
      1640,
    )
  })
})

describe('noiseOriginNeedsReset', () => {
  const origin = { key: 'free', lat: 40, lon: -100 }

  it('resets without an origin', () => {
    expect(noiseOriginNeedsReset(null, origin)).toBe(true)
  })

  it('resets when the anchor key changes', () => {
    expect(noiseOriginNeedsReset(origin, { ...origin, key: 'airport:KDEN' })).toBe(true)
  })

  it('keeps the origin while the anchor is within the reset distance', () => {
    // About 44 km north.
    expect(noiseOriginNeedsReset(origin, { ...origin, lat: 40.4 })).toBe(false)
  })

  it('resets once the anchor is beyond the reset distance', () => {
    expect(WEATHER_STAGE_NOISE_ORIGIN_RESET_M).toBe(50000)
    // About 56 km north.
    expect(noiseOriginNeedsReset(origin, { ...origin, lat: 40.5 })).toBe(true)
  })
})

describe('groundShiftStart', () => {
  const key = 'airport:KDEN'
  const sampled = (groundM: number): FrameGround => ({ key, groundM, sampled: true })
  const placeholder = (groundM: number): FrameGround => ({ key, groundM, sampled: false })

  it('is 0 for the first frame', () => {
    expect(groundShiftStart(null, sampled(1634), 0)).toBe(0)
  })

  it('replaces a placeholder ground at once instead of blending from it', () => {
    const previous = { ground: placeholder(0), shiftStartM: 0, shiftStartMs: 0 }
    expect(groundShiftStart(previous, sampled(1634), 100)).toBe(0)
  })

  it('does not blend to a placeholder ground', () => {
    const previous = { ground: sampled(1634), shiftStartM: 0, shiftStartMs: 0 }
    expect(groundShiftStart(previous, placeholder(1656), 100)).toBe(0)
  })

  it('does not blend across an anchor key change', () => {
    const previous = { ground: { key: 'airport:KOAK', groundM: -28, sampled: true }, shiftStartM: 0, shiftStartMs: 0 }
    expect(groundShiftStart(previous, sampled(1634), 100)).toBe(0)
  })

  it('blends between two sampled grounds of the same key, carrying the shift still blending', () => {
    const previous = { ground: sampled(1634), shiftStartM: 10, shiftStartMs: 0 }
    expect(groundShiftStart(previous, sampled(1640), WEATHER_STAGE_GROUND_BLEND_MS / 2)).toBeCloseTo(6 + 5)
  })
})

describe('horizontalNoiseOffset', () => {
  it('drops the vertical component, which grows with the distance from the noise origin', () => {
    expect(horizontalNoiseOffset({ x: 1200, y: -500000, z: -19600 })).toEqual({ x: 1200, y: -500000, z: 0 })
  })
})

describe('fog shader', () => {
  it.each([
    ['cloud', CLOUD_STAGE_FS],
    ['composite', WEATHER_COMPOSITE_FS],
  ])('caps the fog density at its ground value below the anchor ground in the %s pass', (_pass, source) => {
    // Clamping only the camera height let points below the ground grow exponentially denser fog.
    expect(source).not.toContain('float h0 = max(ro.z, 0.0);')
    expect(source).toContain('fogBelowGroundLength(')
  })
})

describe('groundBlendShift', () => {
  it('starts at the full ground change', () => {
    expect(groundBlendShift(30, 0)).toBe(30)
  })

  it('falls linearly to 0 over the blend time', () => {
    expect(groundBlendShift(30, WEATHER_STAGE_GROUND_BLEND_MS / 2)).toBeCloseTo(15)
  })

  it('stays 0 after the blend time', () => {
    expect(groundBlendShift(-30, WEATHER_STAGE_GROUND_BLEND_MS * 2)).toBe(0)
  })
})

describe('effectiveVisibilitySM', () => {
  it('uses the METAR visibility without interpolation', () => {
    expect(effectiveVisibilitySM({ metarSM: 3, useInterpolation: false, interpolatedSM: 7 })).toBe(3)
  })

  it('uses the interpolated visibility while weather interpolation is active', () => {
    expect(effectiveVisibilitySM({ metarSM: 3, useInterpolation: true, interpolatedSM: 7 })).toBe(7)
  })

  it('falls back to the METAR while interpolation has no result yet', () => {
    expect(effectiveVisibilitySM({ metarSM: 3, useInterpolation: true, interpolatedSM: undefined })).toBe(3)
  })
})

describe('weatherStageHasWork', () => {
  it('is false with no cloud layers and no fog', () => {
    expect(weatherStageHasWork(0, 0, true)).toBe(false)
  })

  it('is true with clouds or with fog', () => {
    expect(weatherStageHasWork(1, 0, true)).toBe(true)
    expect(weatherStageHasWork(0, 800, true)).toBe(true)
  })

  it('is false without a frame to draw in, whatever the weather', () => {
    expect(weatherStageHasWork(1, 800, false)).toBe(false)
  })
})
