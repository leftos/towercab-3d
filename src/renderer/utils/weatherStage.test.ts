import { describe, expect, it } from 'vitest'
import { STATUTE_MILES_TO_METERS, WEATHER_STAGE_GROUND_BLEND_MS, WEATHER_STAGE_NOISE_ORIGIN_RESET_M } from '@/constants'
import { CLOUD_STAGE_FS, WEATHER_COMPOSITE_FS } from '@/hooks/weather/cloudStage.glsl'
import type { CloudLayer } from '@/types'
import {
  anchorGround,
  babylonDrawsWeather,
  buildCloudLayerUniforms,
  effectiveVisibilitySM,
  type FrameGround,
  groundBlendShift,
  groundShiftStart,
  horizontalNoiseOffset,
  nextWeatherAnchor,
  noiseOriginNeedsReset,
  sceneFogValues,
  stageDrawsFog,
  stageFogExtinction,
  stageVisibilityMeters,
  type WeatherStageGateInput,
  weatherStageGates,
  weatherStageHasWork,
} from '@/utils/weatherStage'

const THICKNESS = { FEW: 250, SCT: 350, BKN: 450, OVC: 600 }

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

describe('stageVisibilityMeters', () => {
  it('is 0 (no fog) without a METAR', () => {
    expect(stageVisibilityMeters(undefined, 1)).toBe(0)
  })

  it('is 0 (no fog) at 10 SM and above', () => {
    expect(stageVisibilityMeters(10, 1)).toBe(0)
    expect(stageVisibilityMeters(15, 2)).toBe(0)
  })

  it('converts statute miles to meters and applies visibilityScale', () => {
    expect(stageVisibilityMeters(0.5, 1)).toBeCloseTo(0.5 * STATUTE_MILES_TO_METERS)
    expect(stageVisibilityMeters(3, 2)).toBeCloseTo(6 * STATUTE_MILES_TO_METERS)
  })

  it('floors visibility at 0.05 SM so zero visibility still draws finite fog', () => {
    expect(stageVisibilityMeters(0, 1)).toBeCloseTo(0.05 * STATUTE_MILES_TO_METERS)
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
    renderer: 'cesium',
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
    ['the Babylon renderer is selected', { renderer: 'babylon' as const }],
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

describe('babylonDrawsWeather', () => {
  it('draws when the switch picks Babylon', () => {
    expect(babylonDrawsWeather('babylon', true)).toBe(true)
  })

  it('stays off while the Cesium stage can draw', () => {
    expect(babylonDrawsWeather('cesium', true)).toBe(false)
  })

  it('takes over when the Cesium stage cannot draw without the logarithmic depth buffer', () => {
    expect(babylonDrawsWeather('cesium', false)).toBe(true)
  })
})
