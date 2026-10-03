// @vitest-environment node
/**
 * Gear height uses one datum (finding 6.1). Run at EDDF, where the geoid is +48 m above the ellipsoid: a gear
 * height that subtracts the MSL ground from the ellipsoidal altitude reads ~158 ft on the runway there, so the
 * gear starts up at liftoff and only the 40 kt ground rule keeps it down on the ground.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type FrameRecord, runScenario, type ScenarioResult } from './harness'

// The harness reads its site when it is first imported, so the site is set before any import runs.
const previousSite = vi.hoisted(() => {
  const previous = { lat: process.env.MOTION_LAT, lon: process.env.MOTION_LON }
  process.env.MOTION_LAT = '50.033'
  process.env.MOTION_LON = '8.570'
  return previous
})

vi.mock('react', () => {
  const api = {
    useEffect: (fn: () => unknown) => {
      fn()
    },
    useState: <T>(v: T) => [v, () => {}],
  }
  return { ...api, default: api }
})

const MIN_RETRACT_DELAY_AFTER_LIFTOFF_S = 2
const MIN_GEAR_DOWN = 0.95

let res: ScenarioResult

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeAll(async () => {
  res = await runScenario({ fps: 60, useVnas: true, vnasFirst: false, durationS: 720 })
}, 300_000)

afterAll(() => {
  restoreEnv('MOTION_LAT', previousSite.lat)
  restoreEnv('MOTION_LON', previousSite.lon)
})

function framesFor(callsign: string): FrameRecord[] {
  return res.frames.get(callsign) ?? []
}

describe('6.1 gear height uses one datum, via the extracted helper the harness then calls (TC3D-49)', () => {
  it('runs at a site with a positive geoid height', () => {
    expect(res.geoidN).toBeGreaterThan(40)
  })

  it(`gear retraction starts no earlier than ${MIN_RETRACT_DELAY_AFTER_LIFTOFF_S} s after liftoff`, () => {
    const dep = res.flights.find((f) => f.callsign === 'DEP1')
    expect(dep).toBeDefined()
    const liftoff = dep?.events.initial_climb ?? Number.NaN
    const retract = framesFor('DEP1').find((r) => r.tLocal > liftoff - 30 && r.gearApp < 0.99)
    expect(retract).toBeDefined()
    const delay = (retract?.tLocal ?? Number.NaN) - liftoff
    expect(delay, `gear started up ${delay.toFixed(1)} s after liftoff`).toBeGreaterThanOrEqual(
      MIN_RETRACT_DELAY_AFTER_LIFTOFF_S,
    )
  })

  it('the gear reads down through the rollout and taxi-in', () => {
    const recs = framesFor('ARR1').filter((r) => ['rollout', 'exit_turn', 'taxi_in'].includes(r.truth.segment))
    expect(recs.length).toBeGreaterThan(100)
    expect(recs.reduce((m, r) => Math.min(m, r.gearApp), Number.POSITIVE_INFINITY)).toBeGreaterThanOrEqual(
      MIN_GEAR_DOWN,
    )
  })
})
