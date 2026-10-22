// @vitest-environment node
/**
 * The spoiler, reverser and wheel-spin rules (TC3D-54). Spoilers deploy at a touchdown above 60 kt and reversers
 * 1.5 s after it while decelerating (the groundspeed falling over the last 0.5 s of data time); both stow at 60 kt or
 * on contact loss; a contact flicker on the rollout, an aircraft first seen in contact and a takeoff roll deploy
 * nothing. Wheels spin at groundspeed over the wheel circumference, backwards in a pushback, and coast to a stop over
 * 5 s after liftoff. Everything runs on data time: a paused replay holds every pose, and a seek (including a switch
 * between replay and live) snaps the surfaces to their targets.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { KNOTS_TO_MS } from '@/constants/precipitation'
import { isPushingBack } from '@/utils/aircraft/pushback'
import {
  clearAllSurfaceStates,
  reverserTarget,
  type SurfaceFrameInput,
  type SurfacePose,
  spoilerTarget,
  surfaceFrameFor,
  updateSurfaceAnimation,
  wheelRadiusForWingspan,
  wheelSpinRate,
} from '@/utils/surfaceAnimationController'

const rule = (inContact: boolean, groundspeedKts: number, accelerationKtsPerSec: number, sst: number | null) => ({
  inContact,
  groundspeedKts,
  accelerationKtsPerSec,
  secondsSinceTouchdown: sst,
  reverserLatched: false,
})

describe('spoilerTarget', () => {
  it.each([
    ['deploys at the touchdown above 60 kt', rule(true, 130, -3, 0), 1],
    ['stays deployed on the rollout above 60 kt, accelerating or not', rule(true, 61, 0, 12), 1],
    ['stows at 60 kt', rule(true, 60, -3, 15), 0],
    ['stays stowed in contact without a touchdown (first seen in contact, takeoff roll)', rule(true, 130, 2, null), 0],
    ['stows on contact loss', rule(false, 130, 0, 3), 0],
  ])('%s', (_label, input, expected) => {
    expect(spoilerTarget(input)).toBe(expected)
  })
})

describe('reverserTarget', () => {
  it.each([
    ['stays stowed for the first 1.5 s after touchdown', rule(true, 130, -3, 1.49), 0],
    ['deploys 1.5 s after touchdown while decelerating', rule(true, 128, -3, 1.5), 1],
    ['stays stowed while accelerating', rule(true, 128, 0.5, 3), 0],
    ['stays deployed once latched, accelerating or not', { ...rule(true, 128, 0.5, 3), reverserLatched: true }, 1],
    ['a latch ends at 60 kt', { ...rule(true, 60, -3, 15), reverserLatched: true }, 0],
    ['a latch ends on contact loss', { ...rule(false, 128, -3, 5), reverserLatched: true }, 0],
    ['stays stowed at a steady speed', rule(true, 128, 0, 3), 0],
    ['stows at 60 kt', rule(true, 60, -3, 15), 0],
    ['stays stowed without a touchdown (takeoff roll, first seen in contact)', rule(true, 130, -3, null), 0],
    ['stows on contact loss', rule(false, 130, -3, 3), 0],
  ])('%s', (_label, input, expected) => {
    expect(reverserTarget(input)).toBe(expected)
  })
})

describe('wheelSpinRate', () => {
  const wheel = (inContact: boolean, gs: number, pushingBack: boolean, liftoff: number, sinceLiftoff: number | null) => ({
    inContact,
    groundspeedKts: gs,
    pushingBack,
    wheelRadiusM: 0.55,
    liftoffRevPerSec: liftoff,
    secondsSinceLiftoff: sinceLiftoff,
  })
  const revPerSec = (kts: number) => (kts * KNOTS_TO_MS) / (2 * Math.PI * 0.55)

  it.each([
    ['rolls at groundspeed over the circumference', wheel(true, 100, false, 0, null), revPerSec(100)],
    ['turns backwards in a pushback', wheel(true, 3, true, 0, null), -revPerSec(3)],
    ['stands still when stopped or held (groundspeed 0)', wheel(true, 0, false, 0, null), 0],
    ['keeps the liftoff spin at liftoff', wheel(false, 150, false, 40, 0), 40],
    ['coasts down linearly after liftoff', wheel(false, 150, false, 40, 2.5), 20],
    ['has stopped 5 s after liftoff', wheel(false, 150, false, 40, 5), 0],
    ['stays stopped after that', wheel(false, 150, false, 40, 30), 0],
    ['stands still in the air without a liftoff seen', wheel(false, 140, false, 0, null), 0],
  ])('%s', (_label, input, expected) => {
    expect(wheelSpinRate(input)).toBeCloseTo(expected, 9)
  })
})

describe('isPushingBack', () => {
  it.each([
    ['moving opposite to the heading at 3 kt', 3, 90, 270, true],
    ['moving more than 90 degrees off the heading in a curved push', 3, 90, 185, true],
    ['moving along the heading', 3, 90, 100, false],
    ['faster than a pushback', 10, 90, 270, false],
    ['below the 0.5 kt floor', 0.4, 90, 270, false],
  ])('%s is %s', (_label, gs, heading, track, expected) => {
    expect(isPushingBack(gs, heading, track)).toBe(expected)
  })
})

describe('wheelRadiusForWingspan', () => {
  it.each([
    [28.0, 0.45],
    [30.0, 0.45],
    [35.8, 0.55],
    [42.0, 0.55],
    [64.8, 0.7],
    [null, 0.55],
  ])('wingspan %s m gives a %s m wheel', (wingspan, radius) => {
    expect(wheelRadiusForWingspan(wingspan)).toBe(radius)
  })
})

describe('updateSurfaceAnimation', () => {
  beforeEach(() => {
    clearAllSurfaceStates()
  })

  const T0 = 1_000_000
  /** One frame: contact, groundspeed (kt) and seconds from T0 of data time. */
  type Step = [boolean, number, number]
  const input = ([inContact, gs, s]: Step, heading = 90, track = 90): SurfaceFrameInput => ({
    inContact,
    groundBlendWeight: null,
    groundBlendDescending: null,
    groundspeedKts: gs,
    headingDeg: heading,
    trackDeg: track,
    dataTime: T0 + Math.round(s * 1000),
    wheelRadiusM: 0.55,
    isReplay: false,
  })
  /**
   * Feeds each step's frame and 10 Hz frames up to the next step (with the earlier step's contact and the groundspeed
   * running linearly to the next step's), and returns the last pose. A frame's targets apply over the interval that
   * ends at it.
   */
  const fly = (callsign: string, steps: Step[], isReplay = false): SurfacePose => {
    let pose: SurfacePose | null = null
    for (let i = 0; i < steps.length; i++) {
      const [inContact, gs, s] = steps[i]
      const next = steps[i + 1]
      pose = updateSurfaceAnimation(callsign, { ...input(steps[i]), isReplay })
      if (!next) break
      const fromMs = Math.round(s * 1000)
      const toMs = Math.round(next[2] * 1000)
      for (let ms = fromMs + 100; ms < toMs; ms += 100) {
        const speed = gs + ((next[1] - gs) * (ms - fromMs)) / (toMs - fromMs)
        pose = updateSurfaceAnimation(callsign, { ...input([inContact, speed, ms / 1000]), isReplay })
      }
    }
    return pose as SurfacePose
  }
  /** Final for 3 s, then a touchdown at 130 kt at data time 3 s. */
  const FINAL_AND_TOUCHDOWN: Step[] = [
    [false, 140, 0],
    [true, 130, 3],
  ]

  it('a landing: spoilers fully out 1 s after touchdown, reversers from 1.5 s after it over 2 s', () => {
    expect(fly('LAND', [...FINAL_AND_TOUCHDOWN, [true, 127, 4]])).toMatchObject({ spoiler: 1, reverser: 0 })
    expect(fly('LAND', [[true, 125, 4.4]]).reverser).toBe(0)
    // Deploying from the frame at TD+1.5 s, whose interval began at TD+1.4 s: 1.1 s of a 2 s travel by TD+2.5 s
    expect(
      fly('LAND', [
        [true, 124, 4.5],
        [true, 124, 5.5],
      ]).reverser,
    ).toBeCloseTo(0.55, 9)
    expect(fly('LAND', [[true, 120, 6.3]]).reverser).toBeCloseTo(0.95, 9)
    expect(fly('LAND', [[true, 120, 6.4]]).reverser).toBeCloseTo(1, 9)
  })

  it('a landing: both stow at 60 kt, spoilers over 1.5 s and reversers over 2 s', () => {
    const atStow = fly('STOW', [...FINAL_AND_TOUCHDOWN, [true, 100, 10], [true, 61, 19.9]])
    expect(atStow).toMatchObject({ spoiler: 1, reverser: 1 })
    const stowing = fly('STOW', [
      [true, 60, 20],
      [true, 59, 20.65],
    ])
    expect(stowing.spoiler).toBeCloseTo(0.5, 9)
    expect(stowing.reverser).toBeCloseTo(0.625, 9)
    expect(fly('STOW', [[true, 55, 22.1]])).toMatchObject({ spoiler: 0, reverser: 0 })
  })

  it('a landing at a steady groundspeed deploys the spoilers but no reversers', () => {
    expect(fly('STEADY', [...FINAL_AND_TOUCHDOWN, [true, 130, 8]])).toMatchObject({ spoiler: 1, reverser: 0 })
  })

  it('a landing driven at 150 ms frame steps deploys the reversers', () => {
    updateSurfaceAnimation('SLOWFPS', input([false, 140, 0]))
    let pose = updateSurfaceAnimation('SLOWFPS', input([true, 130, 3]))
    for (let k = 1; k <= 30; k++) pose = updateSurfaceAnimation('SLOWFPS', input([true, 130 - k * 0.45, 3 + k * 0.15]))
    expect(pose.reverser).toBeGreaterThan(0)
  })

  it('a touchdown at or below 60 kt deploys nothing', () => {
    expect(
      fly('SLOW', [
        [false, 58, 0],
        [true, 58, 3],
        [true, 50, 8],
      ]),
    ).toMatchObject({ spoiler: 0, reverser: 0 })
  })

  it('an aircraft first seen in contact on the rollout deploys nothing', () => {
    expect(
      fly('SPAWN', [
        [true, 120, 0],
        [true, 100, 6],
      ]),
    ).toMatchObject({ spoiler: 0, reverser: 0 })
  })

  it('a contact flicker under 2 s on a rollout without a touchdown seen is not a touchdown', () => {
    expect(
      fly('FLICKER', [
        [true, 120, 0],
        [false, 118, 2],
        [true, 115, 3.9],
        [true, 110, 6],
      ]),
    ).toMatchObject({ spoiler: 0, reverser: 0 })
  })

  it('a contact flicker on the rollout stows toward 0 and resumes the same rollout, with no new reverser delay', () => {
    fly('ROLL', [...FINAL_AND_TOUCHDOWN, [true, 115, 8]])
    const inFlicker = fly('ROLL', [[false, 113, 8.5]])
    expect(inFlicker.spoiler).toBeLessThan(1)
    expect(inFlicker.reverser).toBeLessThan(1)
    const after = fly('ROLL', [
      [true, 112, 9],
      [true, 110, 10],
    ])
    expect(after.spoiler).toBe(1)
    expect(after.reverser).toBe(1)
  })

  it('a takeoff roll deploys nothing and the wheels coast to a stop 5 s after liftoff', () => {
    const roll = fly('TKOF', [
      [true, 0, 0],
      [true, 60, 2],
      [true, 150, 32],
    ])
    expect(roll).toMatchObject({ spoiler: 0, reverser: 0 })
    const liftoffRate = roll.wheelRevPerSec
    expect(liftoffRate).toBeCloseTo((150 * KNOTS_TO_MS) / (2 * Math.PI * 0.55), 9)
    const coasting = fly('TKOF', [
      [false, 152, 32.1],
      [false, 155, 34.6],
    ])
    expect(coasting).toMatchObject({ spoiler: 0, reverser: 0 })
    expect(coasting.wheelRevPerSec).toBeCloseTo(liftoffRate / 2, 9)
    expect(fly('TKOF', [[false, 160, 37.1]]).wheelRevPerSec).toBe(0)
  })

  it('a pushback turns the wheels backwards', () => {
    updateSurfaceAnimation('PUSH', input([true, 0, 0], 90, 90))
    const pose = updateSurfaceAnimation('PUSH', input([true, 3, 1], 90, 270))
    expect(pose.wheelRevPerSec).toBeLessThan(0)
    expect(pose.wheelPhase).toBeGreaterThan(0.5)
  })

  it('a paused replay (constant data time) holds the reverser mid-travel and the wheels still', () => {
    const before = fly('PAUSE', [...FINAL_AND_TOUCHDOWN, [true, 124, 5.5]])
    expect(before.reverser).toBeCloseTo(0.55, 9)
    for (let i = 0; i < 30; i++) updateSurfaceAnimation('PAUSE', input([true, 124, 5.5]))
    const held = updateSurfaceAnimation('PAUSE', input([true, 124, 5.5]))
    expect(held.reverser).toBe(before.reverser)
    expect(held.spoiler).toBe(1)
    expect(held.wheelPhase).toBe(before.wheelPhase)
  })

  it('a seek back snaps the surfaces to their targets and keeps the wheel phase', () => {
    const before = fly('SEEKB', [...FINAL_AND_TOUCHDOWN, [true, 124, 5.5]])
    const after = updateSurfaceAnimation('SEEKB', input([false, 140, 1]))
    expect(after).toMatchObject({ spoiler: 0, reverser: 0 })
    expect(after.wheelPhase).toBe(before.wheelPhase)
  })

  it('a replay seek forward over 5 s snaps the surfaces to their targets and keeps the wheel phase', () => {
    const before = fly('SEEKF', [...FINAL_AND_TOUCHDOWN, [true, 124, 5.5]], true)
    const after = updateSurfaceAnimation('SEEKF', { ...input([true, 50, 30]), isReplay: true })
    expect(after).toMatchObject({ spoiler: 0, reverser: 0 })
    expect(after.wheelPhase).toBe(before.wheelPhase)
  })

  it('replay scrubbed to an airborne moment, then live on a takeoff roll above 60 kt, deploys nothing', () => {
    fly(
      'LIVEA',
      [
        [false, 140, 0],
        [false, 140, 1],
      ],
      true,
    )
    expect(
      fly('LIVEA', [
        [true, 80, 600],
        [true, 85, 601],
      ]),
    ).toMatchObject({ spoiler: 0, reverser: 0 })
  })

  it('replay mid-rollout, then live on a takeoff roll, stows the surfaces and leaves the reversers unlatched', () => {
    expect(fly('LIVEB', [...FINAL_AND_TOUCHDOWN, [true, 115, 8]], true)).toMatchObject({ spoiler: 1, reverser: 1 })
    expect(updateSurfaceAnimation('LIVEB', input([true, 70, 600]))).toMatchObject({ spoiler: 0, reverser: 0 })
    expect(
      fly('LIVEB', [
        [true, 75, 601],
        [true, 65, 604],
      ]),
    ).toMatchObject({ spoiler: 0, reverser: 0 })
  })

  it("takes the frame's replay flag from the aircraft state: replay mid-rollout, then a live state, is a seek", () => {
    /** A vNAS aircraft in contact at `gs` knots, `s` seconds of data time from T0 */
    const aircraftAt = (gs: number, s: number, isReplay: boolean) => ({
      inContact: true,
      heightAboveGround: 0,
      groundBlendWeight: 1,
      groundBlendDescending: false,
      interpolatedGroundspeed: gs,
      interpolatedHeading: 90,
      track: 90,
      timestamp: T0 + s * 1000,
      isReplay,
    })
    expect(surfaceFrameFor(aircraftAt(115, 8, true), 0.55).isReplay).toBe(true)
    fly('STATEB', [...FINAL_AND_TOUCHDOWN, [true, 115, 8]], true)
    const live = surfaceFrameFor(aircraftAt(70, 600, false), 0.55)
    expect(live.isReplay).toBe(false)
    expect(updateSurfaceAnimation('STATEB', live)).toMatchObject({ spoiler: 0, reverser: 0 })
  })

  it('live: a 6 s data gap mid-rollout continues the rollout instead of snapping', () => {
    fly('GAP', [...FINAL_AND_TOUCHDOWN, [true, 115, 8]])
    expect(updateSurfaceAnimation('GAP', input([true, 100, 14]))).toMatchObject({ spoiler: 1, reverser: 1 })
  })

  it('a touch-and-go: re-accelerating 10 kt above the rollout minimum stows both before liftoff', () => {
    fly('TGO', [...FINAL_AND_TOUCHDOWN, [true, 110, 10]])
    const stowed = fly('TGO', [
      [true, 115, 10.1],
      [true, 121, 11],
      [true, 125, 13.5],
    ])
    expect(stowed).toMatchObject({ spoiler: 0, reverser: 0 })
  })

  it('an aircraft first seen out of contact 1 s before touchdown deploys the spoilers at touchdown', () => {
    const pose = fly('LATE', [
      [false, 140, 0],
      [true, 130, 1],
      [true, 128, 2.1],
    ])
    expect(pose.spoiler).toBe(1)
  })

  it('once deployed, the reversers stay out through groundspeed noise around a steady speed', () => {
    expect(fly('NOISE', [...FINAL_AND_TOUCHDOWN, [true, 120, 6.5]]).reverser).toBe(1)
    let pose = fly('NOISE', [[true, 119, 6.6]])
    for (let k = 1; k <= 20; k++) {
      pose = updateSurfaceAnimation('NOISE', input([true, k % 2 === 0 ? 118.2 : 117.8, 6.6 + k * 0.1]))
    }
    expect(pose.reverser).toBe(1)
  })

  describe('surfaceFrameFor', () => {
    /** An aircraft in the shared contact at a 0.9 landing-blend weight, with or without a height above ground */
    const aircraft = (heightAboveGround: number | null) => ({
      inContact: true,
      heightAboveGround,
      groundBlendWeight: 0.9,
      groundBlendDescending: true,
      interpolatedGroundspeed: 100,
      interpolatedHeading: 90,
      track: 90,
      timestamp: T0,
      isReplay: false,
    })

    it('passes the blend weight and whether it came from the landing blend through for a source without a height above ground', () => {
      expect(surfaceFrameFor(aircraft(null), 0.55)).toMatchObject({ groundBlendWeight: 0.9, groundBlendDescending: true })
    })

    it('passes null for both with a height above ground (vNAS)', () => {
      expect(surfaceFrameFor(aircraft(2), 0.55)).toMatchObject({ groundBlendWeight: null, groundBlendDescending: null })
    })
  })

  describe('surface contact for a source without a height above ground', () => {
    /** A frame at 100 kt with the shared contact, blend weight and landing-blend flag given, `s` seconds from T0 */
    const heightless = (inContact: boolean, descending: boolean, weight: number, s: number): SurfaceFrameInput => ({
      ...input([inContact, 100, s]),
      groundBlendWeight: weight,
      groundBlendDescending: descending,
    })

    it.each([
      ['in the landing blend at a 0.9 weight is out of contact', true, true, 0.9, false],
      ['in the landing blend at a 0.99 weight is in contact', true, true, 0.99, true],
      ['in the departure blend at a 0.9 weight is in contact', true, false, 0.9, true],
      ['out of the shared contact at a 1.0 weight is out of contact', false, false, 1, false],
      ['out of the shared contact in the landing blend at a 1.0 weight is out of contact', false, true, 1, false],
    ])('%s', (_label, inContact, descending, weight, contact) => {
      updateSurfaceAnimation('HEIGHTLESS', heightless(inContact, descending, weight, 0))
      const pose = updateSurfaceAnimation('HEIGHTLESS', heightless(inContact, descending, weight, 0.1))
      expect(pose.wheelRevPerSec > 0).toBe(contact)
    })

    it('first seen above 5 kt in the departure blend at a 0.9 weight (RealTraffic-like, no held frames) is in contact', () => {
      updateSurfaceAnimation('RTSPAWN', heightless(true, false, 0.9, 0))
      const pose = updateSurfaceAnimation('RTSPAWN', heightless(true, false, 0.9, 0.1))
      expect(pose.wheelRevPerSec).toBeGreaterThan(0)
      expect(pose).toMatchObject({ spoiler: 0, reverser: 0 })
    })

    it('a replay seek onto a rollout in the departure blend at a 0.9 weight turns the wheels and deploys nothing', () => {
      updateSurfaceAnimation('SEEKROLL', { ...heightless(true, false, 1, 0), isReplay: true })
      for (let k = 1; k <= 3; k++) {
        updateSurfaceAnimation('SEEKROLL', { ...heightless(true, false, 0.9, k * 0.1), isReplay: true })
      }
      updateSurfaceAnimation('SEEKROLL', { ...heightless(true, false, 0.9, 0.1), isReplay: true })
      const pose = updateSurfaceAnimation('SEEKROLL', { ...heightless(true, false, 0.9, 0.2), isReplay: true })
      expect(pose.wheelRevPerSec).toBeGreaterThan(0)
      expect(pose).toMatchObject({ spoiler: 0, reverser: 0 })
    })
  })
})
