// @vitest-environment node
/**
 * Spoilers, reversers and wheel spin over the synthetic vNAS flights (TC3D-54): the arrival deploys spoilers at
 * touchdown and reversers after it and stows both at 60 kt, with the wheels rolling at groundspeed; the departure
 * deploys nothing, turns its wheels backwards in the pushback and lets them coast to a stop after liftoff; the
 * go-around never touches down and deploys nothing.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { KNOTS_TO_MS } from '@/constants/precipitation'
import { buildFlights, type Flight, type FrameRecord, runScenario, type ScenarioResult } from './harness'
import { truthAt } from './sim'

vi.mock('react', () => {
  const api = {
    useEffect: (fn: () => unknown) => {
      fn()
    },
    useState: <T>(v: T) => [v, () => {}],
  }
  return { ...api, default: api }
})

const WHEEL_RADIUS_M = 0.55 // the harness flies a B738
const revPerSec = (kts: number) => (kts * KNOTS_TO_MS) / (2 * Math.PI * WHEEL_RADIUS_M)

let result: ScenarioResult

beforeAll(async () => {
  result = await runScenario({ fps: 60, useVnas: true, vnasFirst: false, durationS: 720 })
}, 300_000)

const framesOf = (callsign: string): FrameRecord[] => result.frames.get(callsign) ?? []

/** The displayed instant (truth local seconds) of the first frame in contact after one out of contact. */
function touchdownAt(recs: FrameRecord[]): number {
  const i = recs.findIndex((r, k) => k > 0 && r.inContact === true && recs[k - 1].inContact === false)
  expect(i).toBeGreaterThan(0)
  return recs[i].tLocal
}

/** The displayed instant of the first frame out of contact after one in contact. */
function liftoffAt(recs: FrameRecord[]): number {
  const i = recs.findIndex((r, k) => k > 0 && r.inContact === false && recs[k - 1].inContact === true)
  expect(i).toBeGreaterThan(0)
  return recs[i].tLocal
}

const between = (recs: FrameRecord[], from: number, to: number) => recs.filter((r) => r.tLocal >= from && r.tLocal < to)

describe('the arrival', () => {
  it('keeps everything stowed and the wheels still on final', () => {
    const recs = framesOf('ARR1')
    const final = between(recs, Number.NEGATIVE_INFINITY, touchdownAt(recs))
    expect(final.length).toBeGreaterThan(100)
    expect(final.every((r) => r.spoiler === 0 && r.reverser === 0 && r.wheelRevPerSec === 0)).toBe(true)
  })

  it('deploys the spoilers fully within 1 s of touchdown', () => {
    const recs = framesOf('ARR1')
    const td = touchdownAt(recs)
    expect(between(recs, td + 1.05, td + 1.2).every((r) => r.spoiler === 1)).toBe(true)
  })

  it('deploys the reversers from 1.5 s after touchdown, fully 2 s later', () => {
    const recs = framesOf('ARR1')
    const td = touchdownAt(recs)
    expect(between(recs, td, td + 1.45).every((r) => r.reverser === 0)).toBe(true)
    expect(between(recs, td + 3.6, td + 4).every((r) => r.reverser === 1)).toBe(true)
  })

  it('stows both at 60 kt: spoilers within 1.5 s and reversers within 2 s', () => {
    const recs = framesOf('ARR1')
    const td = touchdownAt(recs)
    const slow = recs.find((r) => r.tLocal > td && r.gs <= 60) as FrameRecord
    expect(slow).toBeDefined()
    const deployed = between(recs, td + 4, slow.tLocal)
    expect(deployed.length).toBeGreaterThan(100)
    expect(deployed.every((r) => r.spoiler === 1 && r.reverser === 1)).toBe(true)
    expect(between(recs, slow.tLocal + 1.55, slow.tLocal + 1.7).every((r) => r.spoiler === 0)).toBe(true)
    expect(between(recs, slow.tLocal + 2.05, Number.POSITIVE_INFINITY).every((r) => r.reverser === 0)).toBe(true)
  })

  it('rolls the wheels at groundspeed over the circumference in contact', () => {
    const rolling = framesOf('ARR1').filter((r) => r.inContact === true)
    expect(rolling.length).toBeGreaterThan(1000)
    for (const r of rolling) expect(r.wheelRevPerSec).toBeCloseTo(revPerSec(r.gs), 9)
  })
})

describe('the departure', () => {
  it('deploys neither spoilers nor reversers through the pushback, taxi and takeoff roll', () => {
    const recs = framesOf('DEP1')
    expect(recs.every((r) => r.spoiler === 0 && r.reverser === 0)).toBe(true)
  })

  it('turns its wheels backwards in the straight pushback', () => {
    const push = framesOf('DEP1').filter((r) => r.truth.segment === 'push_straight' && r.gs > 1)
    expect(push.length).toBeGreaterThan(100)
    expect(push.every((r) => r.wheelRevPerSec < 0)).toBe(true)
  })

  it('lets the wheels coast linearly from the liftoff spin to a stop 5 s after liftoff', () => {
    const recs = framesOf('DEP1')
    const lo = liftoffAt(recs)
    const atLiftoff = recs.find((r) => r.tLocal >= lo) as FrameRecord
    const lastRolling = recs[recs.indexOf(atLiftoff) - 1]
    const halfway = recs.find((r) => r.tLocal >= lo + 2.5) as FrameRecord
    expect(atLiftoff.wheelRevPerSec).toBeCloseTo(lastRolling.wheelRevPerSec, 9)
    // The coast counts on data time, which the truth instant tLocal follows to within a frame (1/60 s, 0.0033 here)
    const coastRatio = halfway.wheelRevPerSec / lastRolling.wheelRevPerSec
    expect(Math.abs(coastRatio - (1 - (halfway.tLocal - lo) / 5))).toBeLessThan(0.004)
    expect(between(recs, lo + 5, Number.POSITIVE_INFINITY).every((r) => r.wheelRevPerSec === 0)).toBe(true)
  })
})

describe('the go-around', () => {
  it('never touches down and deploys nothing', () => {
    const recs = framesOf('GA1')
    expect(recs.length).toBeGreaterThan(100)
    expect(recs.every((r) => r.spoiler === 0 && r.reverser === 0 && r.wheelRevPerSec === 0)).toBe(true)
  })
})

/** Drawn height above the terrain (metres) at or below which the drawn aircraft is on it (the 0.1 m terrain offset). */
const ON_TERRAIN_M = 0.5

describe('a VATSIM arrival (no height above ground)', () => {
  let vatsim: ScenarioResult

  beforeAll(async () => {
    vatsim = await runScenario({ fps: 60, useVnas: false, vnasFirst: false, durationS: 720 })
  }, 300_000)

  it('keeps the spoilers stowed while the drawn aircraft is above the terrain and deploys them after the drawn touchdown', () => {
    const recs = vatsim.frames.get('ARR1') ?? []
    const drawnTouchdown = recs.findIndex((r) => r.agl <= ON_TERRAIN_M)
    expect(drawnTouchdown).toBeGreaterThan(0)
    expect(recs.slice(0, drawnTouchdown).every((r) => r.spoiler === 0)).toBe(true)
    expect(recs.slice(drawnTouchdown).some((r) => r.spoiler === 1)).toBe(true)
  })
})

describe('a VATSIM arrival reported 8 m above the drawn terrain', () => {
  const TERRAIN_OFFSET_M = -8
  let high: ScenarioResult

  beforeAll(async () => {
    high = await runScenario({
      fps: 60,
      useVnas: false,
      vnasFirst: false,
      durationS: 720,
      terrainOffsetM: TERRAIN_OFFSET_M,
    })
  }, 300_000)

  it('deploys the spoilers fully within 2 s of the drawn touchdown and keeps them out through the rollout to 60 kt', () => {
    const recs = high.frames.get('ARR1') ?? []
    const drawnTouchdown = recs.find((r) => r.agl - TERRAIN_OFFSET_M <= ON_TERRAIN_M) as FrameRecord
    expect(drawnTouchdown).toBeDefined()
    // Contact for the surfaces begins at a 0.99 blend weight, a few tenths of a second after the drawn 0.5 m
    const deployed = recs.find((r) => r.spoiler === 1) as FrameRecord
    expect(deployed).toBeDefined()
    expect(deployed.tLocal - drawnTouchdown.tLocal).toBeLessThan(2)
    const slow = recs.find((r) => r.tLocal > deployed.tLocal && r.gs <= 60) as FrameRecord
    expect(slow).toBeDefined()
    const rollout = between(recs, deployed.tLocal, slow.tLocal)
    expect(rollout.length).toBeGreaterThan(100)
    expect(rollout.every((r) => r.spoiler === 1)).toBe(true)
  })

  it('turns the wheels through the taxi in', () => {
    const taxi = (high.frames.get('ARR1') ?? []).filter((r) => r.truth.segment === 'taxi_in' && r.gs > 1)
    expect(taxi.length).toBeGreaterThan(100)
    expect(taxi.every((r) => r.wheelRevPerSec > 0)).toBe(true)
  })
})

/** The flights as the harness builds them, for choosing when a feed starts. */
const FLIGHTS = buildFlights().flights
const flightOf = (callsign: string) => FLIGHTS.find((f) => f.callsign === callsign) as Flight

/** The first scenario second of the 15 s VATSIM report grid (3 + 15 n) at or after `s`. */
const reportAtOrAfter = (s: number) => 3 + 15 * Math.ceil((s - 3) / 15)

/** The first VATSIM report of `f` whose truth is on the glide between 12 m and 30 m AGL: short final, in the landing blend. */
function shortFinalReport(f: Flight): number {
  for (let tg = 3; tg <= 720; tg += 15) {
    const truth = truthAt(f.samples, tg - f.offset)
    if (truth && truth.segment === 'glide' && truth.agl > 12 && truth.agl < 30) return tg
  }
  throw new Error('no VATSIM report falls on the short final')
}

describe('a VATSIM aircraft first seen 8 m above the drawn terrain', () => {
  const TERRAIN_OFFSET_M = -8

  describe('taxiing in', () => {
    let taxiing: ScenarioResult

    beforeAll(async () => {
      const arr = flightOf('ARR1')
      taxiing = await runScenario({
        fps: 60,
        useVnas: false,
        vnasFirst: false,
        durationS: 420,
        terrainOffsetM: TERRAIN_OFFSET_M,
        vatsimFromS: { ARR1: reportAtOrAfter(arr.offset + arr.events.taxi_in + 5) },
      })
    }, 300_000)

    it('spins its wheels on every taxi frame', () => {
      const recs = taxiing.frames.get('ARR1') ?? []
      expect(recs.every((r) => r.truth.segment === 'taxi_in' || r.truth.segment === 'taxi_in_stop')).toBe(true)
      const taxi = recs.filter((r) => r.truth.segment === 'taxi_in' && r.gs > 1)
      expect(taxi.length).toBeGreaterThan(100)
      expect(taxi.every((r) => r.wheelRevPerSec > 0)).toBe(true)
    })
  })

  describe('on a takeoff roll above 60 kt', () => {
    let rolling: ScenarioResult

    beforeAll(async () => {
      const dep = flightOf('DEP1')
      rolling = await runScenario({
        fps: 60,
        useVnas: false,
        vnasFirst: false,
        durationS: 300,
        terrainOffsetM: TERRAIN_OFFSET_M,
        vatsimFromS: { DEP1: reportAtOrAfter(dep.offset + dep.events.takeoff_roll + 18) },
      })
    }, 300_000)

    it('deploys nothing through liftoff', () => {
      const recs = rolling.frames.get('DEP1') ?? []
      expect(recs[0]?.truth.segment).toBe('takeoff_roll')
      expect(recs.some((r) => r.truth.segment === 'initial_climb')).toBe(true)
      expect(recs.every((r) => r.spoiler === 0 && r.reverser === 0)).toBe(true)
    })
  })
})

describe('a VATSIM arrival first seen on short final below 30 m', () => {
  let late: ScenarioResult

  beforeAll(async () => {
    late = await runScenario({
      fps: 60,
      useVnas: false,
      vnasFirst: false,
      durationS: 420,
      vatsimFromS: { ARR1: shortFinalReport(flightOf('ARR1')) },
    })
  }, 300_000)

  it('deploys the spoilers after the drawn touchdown', () => {
    const recs = late.frames.get('ARR1') ?? []
    expect(recs[0]?.truth.segment).toBe('glide')
    const drawnTouchdown = recs.findIndex((r) => r.gs > 5 && r.agl <= ON_TERRAIN_M)
    expect(drawnTouchdown).toBeGreaterThan(0)
    expect(recs.slice(0, drawnTouchdown).every((r) => r.spoiler === 0)).toBe(true)
    expect(recs.slice(drawnTouchdown).some((r) => r.spoiler === 1)).toBe(true)
  })
})

describe('an arrival drawn at 150 ms frame steps', () => {
  let slow: ScenarioResult

  beforeAll(async () => {
    slow = await runScenario({ fps: 1000 / 150, useVnas: true, vnasFirst: false, durationS: 720 })
  }, 300_000)

  it('deploys the reversers on the rollout', () => {
    const recs = slow.frames.get('ARR1') ?? []
    expect(recs.some((r) => r.reverser === 1)).toBe(true)
  })
})
