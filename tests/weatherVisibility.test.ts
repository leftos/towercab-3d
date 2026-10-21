import { describe, expect, it } from 'vitest'
import type { WeatherVisibilityConditions, WeatherVisibilityParams } from '@/types'
import { isVisibleThroughWeather } from '@/utils/weatherVisibility'

const STATUTE_MILE_METERS = 1609.34
const CEILING_METERS = 300

const ovcCeiling = { altitude: CEILING_METERS, coverage: 1.0, type: 'OVC' }

function conditions(overrides: Partial<WeatherVisibilityConditions> = {}): WeatherVisibilityConditions {
  return {
    showWeatherEffects: true,
    cullBeyondVisibility: true,
    showClouds: true,
    isTopDownView: false,
    visibilityStatuteMiles: 3,
    visibilityScale: 1,
    cloudLayers: [ovcCeiling],
    ...overrides,
  }
}

function geometry(overrides: Partial<WeatherVisibilityParams> = {}): WeatherVisibilityParams {
  return {
    cameraAltitudeMeters: 50,
    aircraftAltitudeMeters: 100,
    horizontalDistanceMeters: 1000,
    ...overrides,
  }
}

describe('isVisibleThroughWeather', () => {
  it('shows an aircraft in clear weather far away and above any altitude', () => {
    const clear = conditions({ visibilityStatuteMiles: 10, cloudLayers: [] })
    expect(isVisibleThroughWeather(clear, geometry({ horizontalDistanceMeters: 15000, aircraftAltitudeMeters: 9000 }))).toBe(
      true,
    )
  })

  it('shows everything when weather effects are off', () => {
    const off = conditions({ showWeatherEffects: false, visibilityStatuteMiles: 0.25 })
    expect(isVisibleThroughWeather(off, geometry({ horizontalDistanceMeters: 50000, aircraftAltitudeMeters: 3000 }))).toBe(true)
  })

  describe('surface visibility', () => {
    const visibilityMeters = 3 * STATUTE_MILE_METERS

    it('hides an aircraft beyond the METAR visibility', () => {
      expect(isVisibleThroughWeather(conditions(), geometry({ horizontalDistanceMeters: visibilityMeters + 1 }))).toBe(false)
    })

    it('shows an aircraft exactly at the METAR visibility', () => {
      expect(isVisibleThroughWeather(conditions(), geometry({ horizontalDistanceMeters: visibilityMeters }))).toBe(true)
    })

    it('scales the visibility distance by visibilityScale', () => {
      const scaled = conditions({ visibilityScale: 2 })
      expect(isVisibleThroughWeather(scaled, geometry({ horizontalDistanceMeters: visibilityMeters * 1.5 }))).toBe(true)
      expect(isVisibleThroughWeather(scaled, geometry({ horizontalDistanceMeters: visibilityMeters * 2 + 1 }))).toBe(false)
    })

    it('does not cull by distance when the fog toggle is off', () => {
      const fogOff = conditions({ cullBeyondVisibility: false })
      expect(isVisibleThroughWeather(fogOff, geometry({ horizontalDistanceMeters: visibilityMeters * 10 }))).toBe(true)
    })

    it('culls by distance when the fog toggle is on', () => {
      expect(isVisibleThroughWeather(conditions(), geometry({ horizontalDistanceMeters: visibilityMeters * 10 }))).toBe(false)
    })

    it('does not cull by distance without a METAR', () => {
      const noMetar = conditions({ visibilityStatuteMiles: null })
      expect(isVisibleThroughWeather(noMetar, geometry({ horizontalDistanceMeters: 1e7 }))).toBe(true)
    })

    it('treats a METAR visibility of zero as a METAR and hides any distant aircraft', () => {
      const zero = conditions({ visibilityStatuteMiles: 0 })
      expect(isVisibleThroughWeather(zero, geometry({ horizontalDistanceMeters: 1 }))).toBe(false)
    })
  })

  describe('cloud ceiling', () => {
    it('hides an aircraft above the ceiling from a camera below it', () => {
      expect(isVisibleThroughWeather(conditions(), geometry({ cameraAltitudeMeters: 50, aircraftAltitudeMeters: 600 }))).toBe(false)
    })

    it('hides an aircraft below the ceiling from a camera above it', () => {
      expect(isVisibleThroughWeather(conditions(), geometry({ cameraAltitudeMeters: 600, aircraftAltitudeMeters: 50 }))).toBe(false)
    })

    it('shows an aircraft on the same side of the ceiling as the camera', () => {
      expect(isVisibleThroughWeather(conditions(), geometry({ cameraAltitudeMeters: 50, aircraftAltitudeMeters: 250 }))).toBe(true)
      expect(isVisibleThroughWeather(conditions(), geometry({ cameraAltitudeMeters: 400, aircraftAltitudeMeters: 900 }))).toBe(true)
    })

    it('shows an aircraft exactly at the ceiling altitude', () => {
      const atCeiling = geometry({ cameraAltitudeMeters: 50, aircraftAltitudeMeters: CEILING_METERS })
      expect(isVisibleThroughWeather(conditions(), atCeiling)).toBe(true)
    })

    it('shows an aircraft when the camera is exactly at the ceiling altitude', () => {
      const cameraAtCeiling = geometry({ cameraAltitudeMeters: CEILING_METERS, aircraftAltitudeMeters: 600 })
      expect(isVisibleThroughWeather(conditions(), cameraAtCeiling)).toBe(true)
    })

    it('treats BKN (coverage 0.75) as a ceiling and SCT below it as not', () => {
      const across = geometry({ cameraAltitudeMeters: 50, aircraftAltitudeMeters: 600 })
      const bkn = conditions({ cloudLayers: [{ altitude: CEILING_METERS, coverage: 0.75, type: 'BKN' }] })
      const sct = conditions({ cloudLayers: [{ altitude: CEILING_METERS, coverage: 0.74, type: 'SCT' }] })
      expect(isVisibleThroughWeather(bkn, across)).toBe(false)
      expect(isVisibleThroughWeather(sct, across)).toBe(true)
    })

    it('hides an aircraft when any of several layers is a ceiling between them', () => {
      const layers = conditions({
        cloudLayers: [
          { altitude: 200, coverage: 0.5, type: 'SCT' },
          { altitude: 800, coverage: 1.0, type: 'OVC' },
        ],
      })
      expect(isVisibleThroughWeather(layers, geometry({ cameraAltitudeMeters: 50, aircraftAltitudeMeters: 600 }))).toBe(true)
      expect(isVisibleThroughWeather(layers, geometry({ cameraAltitudeMeters: 50, aircraftAltitudeMeters: 900 }))).toBe(false)
    })

    it('does not cull by clouds when clouds are off', () => {
      const cloudsOff = conditions({ showClouds: false })
      expect(isVisibleThroughWeather(cloudsOff, geometry({ cameraAltitudeMeters: 50, aircraftAltitudeMeters: 600 }))).toBe(true)
    })

    it('does not cull by clouds in top-down view', () => {
      const topDown = conditions({ isTopDownView: true })
      expect(isVisibleThroughWeather(topDown, geometry({ cameraAltitudeMeters: 50, aircraftAltitudeMeters: 600 }))).toBe(true)
    })

    it('still culls by distance in top-down view', () => {
      const topDown = conditions({ isTopDownView: true })
      expect(isVisibleThroughWeather(topDown, geometry({ horizontalDistanceMeters: 1e6 }))).toBe(false)
    })
  })
})
