// @vitest-environment node
/**
 * The resting height of each aircraft and of each aircraft type, learned from slow vNAS samples from -3 to 16 ft: the
 * median of the last 9, known once 3 exist. An aircraft reads its own, else its type's. Its own lives as long as its
 * timeline (forgotten on removal, pruning, clear and a change of type); the type's is kept for the session.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AircraftDataSource, AircraftMetadata, AircraftObservation } from '@/types/aircraft-timeline'

type RestModule = typeof import('@/utils/aircraft/restingHeight')
type TimelineModule = typeof import('@/stores/aircraftTimelineStore')

const FT = 0.3048
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0)

let rest: RestModule
let tl: TimelineModule

// The store graph and the estimator load cold at the top level, where collection runs them with no timeout
// (tests/setup/hookBudget.ts). The beforeEach reassigns `tl` and `rest` after resetModules, so these loads only warm
// the transform cache: the modules are evaluated again there, but not transformed again.
await import('@/stores/vnasStore')
await import('@/stores/aircraftTimelineStore')
await import('@/utils/aircraft/restingHeight')

beforeEach(async () => {
  vi.resetModules()
  // vnasStore registers a removal listener at module init; loading it first resolves the store import cycle
  // in the same order the app does.
  await import('@/stores/vnasStore')
  tl = await import('@/stores/aircraftTimelineStore')
  rest = await import('@/utils/aircraft/restingHeight')
})

function record(
  type: string | null,
  heightsFt: number[],
  groundspeedKt = 0,
  source: AircraftDataSource = 'vnas',
  callsign = 'AAL1',
) {
  for (const h of heightsFt) rest.recordRestingSample(callsign, type, h * FT, groundspeedKt, source)
}

/** Resting height (ft) an aircraft is drawn by; a callsign that recorded nothing reads its type's. */
function restFt(type: string | null, callsign = 'NONE1'): number | null {
  const r = rest.restingHeightFor(callsign, type)
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
    record('B77L', [13.6, 13.5, 16])
    expect(restFt('B77L')).toBeCloseTo(13.6, 9)
  })

  it('keeps only the last 9 samples', () => {
    record('C17', [15, 15, 15, 15, 15, 15, 15, 15, 15])
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

  it('above 16 ft', () => {
    record('A320', [16.1, 16.1, 16.1])
    expect(restFt('A320')).toBeNull()
    record('A320', [16, 16, 16])
    expect(restFt('A320')).toBeCloseTo(16, 9)
  })

  it('samples below -3 ft or above 16 ft are ignored', () => {
    record('A320', [-3.1, 16.1, -3.1, 16.1, -3.1, 16.1])
    expect(restFt('A320')).toBeNull()
    expect(restFt('A320', 'AAL1')).toBeNull()
    record('A320', [-3, -3, -3])
    expect(restFt('A320')).toBeCloseTo(-3, 9)
  })

  it('a sample at -0.3 ft is learned', () => {
    record('A320', [-0.3, -0.3, -0.3])
    expect(restFt('A320', 'AAL1')).toBeCloseTo(-0.3, 9)
    expect(restFt('A320')).toBeCloseTo(-0.3, 9)
  })

  it.each<AircraftDataSource>(['vatsim', 'realtraffic', 'replay', 'broadcast'])('from %s', (source) => {
    record('A320', [9, 9, 9], 0, source)
    expect(restFt('A320')).toBeNull()
  })

  it('without a height', () => {
    for (let i = 0; i < 3; i++) rest.recordRestingSample('AAL1', 'A320', undefined, 0, 'vnas')
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

  it.each<[string | null, boolean]>([
    ['A320', true],
    [' b77w ', true],
    ['UNKN', false],
    ['zzzz', false],
    ['  ', false],
    [null, false],
  ])('namesType("%s") is %s', (type, expected) => {
    expect(rest.namesType(type)).toBe(expected)
  })
})

describe('the callsign', () => {
  it("a callsign's own resting height wins over its type's", () => {
    record('A320', [9, 9, 9], 0, 'vnas', 'AAL1')
    record('A320', [0, 0, 0], 0, 'vnas', 'DAL2')
    expect(restFt('A320', 'DAL2')).toBeCloseTo(0, 9)
    expect(restFt('A320', 'AAL1')).toBeCloseTo(9, 9)
    expect(restFt('A320')).toBeCloseTo(4.5, 9)
    expect((rest.heightOverRest('DAL2', 'A320', 10 * FT) ?? Number.NaN) / FT).toBeCloseTo(10, 9)
  })

  it("an aircraft uses its type's value until it has learned its own", () => {
    record('A320', [9, 9, 9], 0, 'vnas', 'AAL1')
    record('A320', [0, 0], 0, 'vnas', 'DAL2')
    expect(restFt('A320', 'DAL2'), 'with 2 samples of its own').toBeCloseTo(9, 9)
    record('A320', [0], 0, 'vnas', 'DAL2')
    expect(restFt('A320', 'DAL2'), 'with 3 samples of its own').toBeCloseTo(0, 9)
  })

  it('forgetting a callsign drops its own value and falls back to the type', () => {
    record('A320', [9, 9, 9, 9, 9], 0, 'vnas', 'AAL1')
    record('A320', [0, 0, 0], 0, 'vnas', 'DAL2')
    rest.forgetCallsign('DAL2')
    expect(restFt('A320', 'DAL2')).toBeCloseTo(9, 9)
    // Two new samples are not enough to learn its own again: it reads the type's median of 0, 0, 0, 3, 3, 9, 9, 9, 9
    record('A320', [3, 3], 0, 'vnas', 'DAL2')
    expect(restFt('A320', 'DAL2'), 'its earlier samples are gone too').toBeCloseTo(3, 9)
  })
})

it('heightOverRest is the raw height less the resting height, and null until it is learned', () => {
  expect(rest.heightOverRest('AAL1', 'A320', 10 * FT)).toBeNull()
  record('A320', [9, 9, 9])
  expect((rest.heightOverRest('AAL1', 'A320', 10 * FT) ?? Number.NaN) / FT).toBeCloseTo(1, 9)
})

it('resetRestingHeightsForTests forgets every type and callsign', () => {
  record('A320', [9, 9, 9])
  rest.resetRestingHeightsForTests()
  expect(restFt('A320')).toBeNull()
  expect(restFt('A320', 'AAL1')).toBeNull()
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

  describe("an aircraft's own resting height lives as long as its timeline", () => {
    const OWN = 'ACA4LG'
    const TEACHER = 'DAL2'

    /** DAL2 teaches the A320 type 9 ft; ACA4LG learns its own 0 ft, which the type's median of 8 samples outvotes. */
    function learnOwnBesideType() {
      const store = tl.useAircraftTimelineStore.getState()
      for (let t = 0; t < 5; t++) store.addObservation(TEACHER, vnasSample(t, 9), METADATA)
      for (let t = 0; t < 3; t++) store.addObservation(OWN, vnasSample(t, 0), METADATA)
      expect(restFt('A320', OWN), 'its own').toBeCloseTo(0, 9)
      expect(restFt('A320'), "the type's").toBeCloseTo(9, 9)
    }

    it('removeAircraft forgets it', () => {
      learnOwnBesideType()
      tl.useAircraftTimelineStore.getState().removeAircraft(OWN)
      expect(restFt('A320', OWN)).toBeCloseTo(9, 9)
    })

    it('pruneStaleAircraft forgets it', () => {
      learnOwnBesideType()
      const now = vi.spyOn(Date, 'now').mockReturnValue(T0 + 10 * 60_000)
      try {
        tl.useAircraftTimelineStore.getState().pruneStaleAircraft()
      } finally {
        now.mockRestore()
      }
      expect(tl.useAircraftTimelineStore.getState().timelines.has(OWN), 'pruned').toBe(false)
      expect(restFt('A320', OWN)).toBeCloseTo(9, 9)
    })

    it('clear forgets it', () => {
      learnOwnBesideType()
      tl.useAircraftTimelineStore.getState().clear()
      expect(restFt('A320', OWN)).toBeCloseTo(9, 9)
    })

    it('addObservation with another type forgets it', () => {
      learnOwnBesideType()
      tl.useAircraftTimelineStore
        .getState()
        .addObservation(OWN, vnasSample(3, 0), { ...METADATA, aircraftType: 'B738' })
      expect(restFt('A320', OWN)).toBeCloseTo(9, 9)
    })

    it('addObservationBatch with another type forgets it', () => {
      learnOwnBesideType()
      const metadata = { ...METADATA, aircraftType: 'B738' }
      tl.useAircraftTimelineStore
        .getState()
        .addObservationBatch([{ callsign: OWN, observation: vnasSample(3, 0), metadata }])
      expect(restFt('A320', OWN)).toBeCloseTo(9, 9)
    })

    it.each<[string, string | null]>([
      ['a case or whitespace difference', ' a320 '],
      ['a placeholder type', 'UNKN'],
      ['no type', null],
    ])('a type that differs from %s keeps it', (_name, firstType) => {
      const store = tl.useAircraftTimelineStore.getState()
      for (let t = 0; t < 5; t++) store.addObservation(TEACHER, vnasSample(t, 9), METADATA)
      for (let t = 0; t < 3; t++) store.addObservation(OWN, vnasSample(t, 0), { ...METADATA, aircraftType: firstType })
      store.addObservation(OWN, vnasSample(3, 0), METADATA)
      expect(restFt('A320', OWN)).toBeCloseTo(0, 9)
    })
  })

  it('decides a stop again when the aircraft learns its own resting height beside a known type', () => {
    const store = tl.useAircraftTimelineStore.getState()
    for (let t = 0; t < 5; t++) store.addObservation('DAL2', vnasSample(t, 0), METADATA)
    // Standing still at 9 ft but reporting 5 kt: no resting-height sample of its own yet
    for (let t = 0; t < 4; t++) store.addObservation('ACA4LG', { ...vnasSample(t, 9), groundspeed: 5 }, METADATA)
    const decide = () => {
      const observations = tl.useAircraftTimelineStore.getState().timelines.get('ACA4LG')?.observations ?? []
      return tl.isStoppedVnasSample(observations, 3, 'ACA4LG', 'A320')
    }
    expect(decide(), "9 ft over the type's 0 ft").toBe(false)
    for (let t = 4; t < 7; t++) store.addObservation('ACA4LG', vnasSample(t, 9), METADATA)
    expect(restFt('A320', 'ACA4LG'), 'its own').toBeCloseTo(9, 9)
    expect(decide(), 'at its own 9 ft resting height').toBe(true)
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
