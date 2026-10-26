// @vitest-environment node
/**
 * The resting height of each aircraft type, learned from slow vNAS samples low over the ground: the median of the
 * last 9 per type, known once 3 exist, kept for the session through the timeline store's clear and removal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AircraftDataSource, AircraftMetadata, AircraftObservation } from '@/types/aircraft-timeline'

type RestModule = typeof import('@/utils/aircraft/restingHeight')
type TimelineModule = typeof import('@/stores/aircraftTimelineStore')

const FT = 0.3048
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0)

let rest: RestModule
let tl: TimelineModule

beforeEach(async () => {
  vi.resetModules()
  // vnasStore registers a removal listener at module init; loading it first resolves the store import cycle
  // in the same order the app does.
  await import('@/stores/vnasStore')
  tl = await import('@/stores/aircraftTimelineStore')
  rest = await import('@/utils/aircraft/restingHeight')
})

function record(type: string | null, heightsFt: number[], groundspeedKt = 0, source: AircraftDataSource = 'vnas') {
  for (const h of heightsFt) rest.recordRestingSample(type, h * FT, groundspeedKt, source)
}

function restFt(type: string | null): number | null {
  const r = rest.restingHeightFor(type)
  return r === null ? null : r / FT
}

describe('the estimator', () => {
  it('is not learned at 2 samples and is learned at 3', () => {
    record('A320', [9, 9])
    expect(restFt('A320')).toBeNull()
    record('A320', [9])
    expect(restFt('A320')).toBeCloseTo(9, 9)
  })

  it('is the median of the samples, not their mean', () => {
    record('B77L', [13.6, 13.5, 29])
    expect(restFt('B77L')).toBeCloseTo(13.6, 9)
  })

  it('keeps only the last 9 samples', () => {
    record('C17', [20, 20, 20, 20, 20, 20, 20, 20, 20])
    record('C17', [5.9, 5.9, 5.9, 5.9, 5.9])
    expect(restFt('C17')).toBeCloseTo(5.9, 9)
  })

  it('takes the mean of the two middle samples of an even count', () => {
    record('B752', [10, 11, 10.5, 10.6])
    expect(restFt('B752')).toBeCloseTo(10.55, 9)
  })
})

describe('the samples it ignores', () => {
  it('at 5 kt or over', () => {
    record('A320', [9, 9, 9], 5)
    expect(restFt('A320')).toBeNull()
    record('A320', [9, 9, 9], 4.9)
    expect(restFt('A320')).toBeCloseTo(9, 9)
  })

  it('at 30 ft or over', () => {
    record('A320', [30, 30, 30])
    expect(restFt('A320')).toBeNull()
    record('A320', [29.9, 29.9, 29.9])
    expect(restFt('A320')).toBeCloseTo(29.9, 9)
  })

  it.each<AircraftDataSource>(['vatsim', 'realtraffic', 'replay', 'broadcast'])('from %s', (source) => {
    record('A320', [9, 9, 9], 0, source)
    expect(restFt('A320')).toBeNull()
  })

  it('without a height', () => {
    for (let i = 0; i < 3; i++) rest.recordRestingSample('A320', undefined, 0, 'vnas')
    expect(restFt('A320')).toBeNull()
  })
})

describe('the type key', () => {
  it.each(['UNKN', 'unkn', '', '  ', 'ZZZZ'])('"%s" is never a key', (type) => {
    record(type, [9, 9, 9])
    expect(restFt(type)).toBeNull()
  })

  it('null is never a key', () => {
    record(null, [9, 9, 9])
    expect(restFt(null)).toBeNull()
  })

  it('is case- and whitespace-insensitive', () => {
    record('a320', [9])
    record(' A320 ', [9])
    record('A320', [9])
    expect(restFt('a320')).toBeCloseTo(9, 9)
  })
})

it('heightOverRest is the raw height less the resting height, and null until it is learned', () => {
  expect(rest.heightOverRest('A320', 10 * FT)).toBeNull()
  record('A320', [9, 9, 9])
  expect((rest.heightOverRest('A320', 10 * FT) ?? Number.NaN) / FT).toBeCloseTo(1, 9)
})

it('resetRestingHeightsForTests forgets every type', () => {
  record('A320', [9, 9, 9])
  rest.resetRestingHeightsForTests()
  expect(restFt('A320')).toBeNull()
})

const METADATA: AircraftMetadata = { cid: 1, aircraftType: 'A320', transponder: '1200', departure: null, arrival: null }

/** A stationary vNAS sample at scenario second `t` reporting `heightFt`. */
function vnasSample(t: number, heightFt: number): AircraftObservation {
  const observedAt = T0 + t * 1000
  return {
    latitude: 37.72,
    longitude: -122.22,
    altitude: 10,
    heading: 90,
    groundspeed: 0,
    groundTrack: 90,
    headingIsTrue: true,
    onGround: true,
    pitch: null,
    roll: null,
    verticalRate: null,
    observedAt,
    receivedAt: observedAt + 80,
    source: 'vnas',
    displayDelay: 1500,
    heightAboveGround: heightFt * FT,
  }
}

describe('the timeline store', () => {
  it('learns from addObservation', () => {
    const store = tl.useAircraftTimelineStore.getState()
    for (let t = 0; t < 3; t++) store.addObservation('ACA4LG', vnasSample(t, 9), METADATA)
    expect(restFt('A320')).toBeCloseTo(9, 9)
  })

  it('learns from addObservationBatch, with the type from metadata merged earlier', () => {
    const store = tl.useAircraftTimelineStore.getState()
    store.addObservationBatch([{ callsign: 'ACA4LG', observation: vnasSample(0, 9), metadata: METADATA }])
    const blank = { ...METADATA, aircraftType: null }
    store.addObservationBatch([
      { callsign: 'ACA4LG', observation: vnasSample(1, 9), metadata: blank },
      { callsign: 'ACA4LG', observation: vnasSample(2, 9), metadata: blank },
    ])
    expect(restFt('A320')).toBeCloseTo(9, 9)
  })

  it('keeps what it learned through clear() and removeAircraft', () => {
    const store = tl.useAircraftTimelineStore.getState()
    for (let t = 0; t < 3; t++) store.addObservation('ACA4LG', vnasSample(t, 9), METADATA)
    tl.useAircraftTimelineStore.getState().removeAircraft('ACA4LG')
    expect(restFt('A320')).toBeCloseTo(9, 9)
    tl.useAircraftTimelineStore.getState().clear()
    expect(restFt('A320')).toBeCloseTo(9, 9)
  })

  it('learns from a loaded replay', () => {
    tl.useAircraftTimelineStore.getState().loadImportedTimelines([
      {
        callsign: 'ACA4LG',
        observations: [0, 1, 2].map((t) => vnasSample(t, 9)),
        metadata: METADATA,
        lastSource: 'vnas',
        lastReceivedAt: T0 + 2080,
      },
    ])
    expect(restFt('A320')).toBeCloseTo(9, 9)
  })
})
