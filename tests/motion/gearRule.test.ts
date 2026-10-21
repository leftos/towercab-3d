// @vitest-environment node
/**
 * The gear rule driven by ground contact (findings 6.2 and 6.3): down in contact; up once the aircraft has been out
 * of contact for 2 s and climbs, rather than at 150 ft; an aircraft not in contact since it was drawn keeps the
 * 150 ft rule; the existing extension below 2000 ft when descending; and an 8 s ease-out transition.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  calculateTargetGearProgress,
  clearAllGearStates,
  initializeGearState,
  updateGearAnimation,
} from '@/utils/gearAnimationController'

const CLIMB_FPM = 2000
const LEVEL_FPM = 0
const DESCENT_FPM = -700
const IN_CONTACT = { inContact: true, secondsSinceContact: 0 }
const NEVER_IN_CONTACT = { inContact: false, secondsSinceContact: null }
const outOfContactFor = (seconds: number) => ({ inContact: false, secondsSinceContact: seconds })

describe('calculateTargetGearProgress', () => {
  it('keeps the gear down in contact, even when the reported rate climbs', () => {
    expect(calculateTargetGearProgress(0, CLIMB_FPM, IN_CONTACT, false)).toBe(1)
  })

  it('holds the gear down for the first 2 s out of contact, even when climbing', () => {
    expect(calculateTargetGearProgress(10, CLIMB_FPM, outOfContactFor(1.9), true)).toBe(1)
  })

  it('retracts 2 s after leaving contact with a positive climb, well below 150 ft', () => {
    expect(calculateTargetGearProgress(10, CLIMB_FPM, outOfContactFor(2), true)).toBe(0)
  })

  it('holds the gear down out of contact until the climb is above 100 fpm', () => {
    expect(calculateTargetGearProgress(10, 50, outOfContactFor(5), true)).toBe(1)
  })

  it('an aircraft not in contact since it was drawn retracts only above 150 ft', () => {
    expect(calculateTargetGearProgress(100, CLIMB_FPM, NEVER_IN_CONTACT, true)).toBe(1)
    expect(calculateTargetGearProgress(200, CLIMB_FPM, NEVER_IN_CONTACT, true)).toBe(0)
  })

  it('extends when descending below 2000 ft', () => {
    expect(calculateTargetGearProgress(1500, DESCENT_FPM, NEVER_IN_CONTACT, false)).toBe(1)
    expect(calculateTargetGearProgress(1500, DESCENT_FPM, outOfContactFor(60), false)).toBe(1)
  })

  it('holds the current state in level flight', () => {
    expect(calculateTargetGearProgress(1500, LEVEL_FPM, outOfContactFor(60), false)).toBe(0)
    expect(calculateTargetGearProgress(1500, LEVEL_FPM, outOfContactFor(60), true)).toBe(1)
  })
})

describe('updateGearAnimation', () => {
  beforeEach(() => {
    clearAllGearStates()
  })

  const frame = (inContact: boolean, altitudeFt: number, verticalRateFpm: number, dataTime: number) => ({
    altitudeFt,
    verticalRateFpm,
    inContact,
    dataTime,
  })

  it('an aircraft spawned in contact starts with the gear down', () => {
    initializeGearState('SPAWN', 0, LEVEL_FPM, true)
    expect(updateGearAnimation('SPAWN', frame(true, 0, LEVEL_FPM, 0), 0)).toBe(1)
  })

  it('retracts 2 s after leaving contact, over 8 s with an ease-out curve', () => {
    const t0 = 1_000_000
    initializeGearState('DEP', 0, LEVEL_FPM, true)
    expect(updateGearAnimation('DEP', frame(true, 0, LEVEL_FPM, t0), t0)).toBe(1)
    expect(updateGearAnimation('DEP', frame(false, 10, CLIMB_FPM, t0 + 1900), t0 + 1900)).toBe(1)
    expect(updateGearAnimation('DEP', frame(false, 30, CLIMB_FPM, t0 + 2000), t0 + 2000)).toBe(1)
    // Ease-out cubic: 1 - (1 - 1/8)^3 of the travel done one second in
    expect(updateGearAnimation('DEP', frame(false, 60, CLIMB_FPM, t0 + 3000), t0 + 3000)).toBeCloseTo((7 / 8) ** 3, 6)
    expect(updateGearAnimation('DEP', frame(false, 200, CLIMB_FPM, t0 + 9999), t0 + 9999)).toBeGreaterThan(0)
    expect(updateGearAnimation('DEP', frame(false, 200, CLIMB_FPM, t0 + 10_000), t0 + 10_000)).toBe(0)
  })

  it('the 2 s out of contact count on the data time, not the transition clock', () => {
    const t0 = 1_000_000
    initializeGearState('REPLAY', 0, LEVEL_FPM, true)
    updateGearAnimation('REPLAY', frame(true, 0, LEVEL_FPM, t0), 0)
    expect(updateGearAnimation('REPLAY', frame(false, 10, CLIMB_FPM, t0 + 1900), 60_000)).toBe(1)
    // A wall-clock count would have started the retraction on the call above and moved the gear by now
    expect(updateGearAnimation('REPLAY', frame(false, 10, CLIMB_FPM, t0 + 1900), 61_000)).toBe(1)
  })

  it('a seek back before the last contact forgets it, so the gear does not hold down for good', () => {
    const t0 = 1_000_000
    initializeGearState('SEEK', 0, LEVEL_FPM, true)
    updateGearAnimation('SEEK', frame(true, 0, LEVEL_FPM, t0), 0)
    // Seek 60 s back to the aircraft climbing out at 2000 ft: not in contact since the seek, so the 150 ft rule
    updateGearAnimation('SEEK', frame(false, 2000, CLIMB_FPM, t0 - 60_000), 1000)
    expect(updateGearAnimation('SEEK', frame(false, 2050, CLIMB_FPM, t0 - 59_000), 2000)).toBeLessThan(1)
  })
})

describe('updateGearAnimation after the leave-contact retract', () => {
  beforeEach(() => {
    clearAllGearStates()
  })

  const t0 = 1_000_000
  const BRIEF_CLIMB_FPM = 300
  /** One step of a flight: contact, height (ft), vertical rate (fpm) and seconds from t0, on both clocks. */
  type Step = [boolean, number, number, number]
  /** Feeds the steps in order and returns the gear progress after the last one. */
  const fly = (callsign: string, steps: Step[]): number => {
    let progress = Number.NaN
    for (const [inContact, altitudeFt, verticalRateFpm, s] of steps) {
      const time = t0 + s * 1000
      progress = updateGearAnimation(callsign, { altitudeFt, verticalRateFpm, inContact, dataTime: time }, time)
    }
    return progress
  }
  const LIFTOFF_AND_RETRACT: Step[] = [
    [true, 0, LEVEL_FPM, 0],
    [false, 10, CLIMB_FPM, 1],
    [false, 30, CLIMB_FPM, 2],
  ]
  /** Pattern at 1000 ft, then a descent onto a short final below 150 ft with the gear down. */
  const PATTERN_TO_SHORT_FINAL: Step[] = [
    [false, 1000, CLIMB_FPM, 40],
    [false, 1000, LEVEL_FPM, 60],
    [false, 800, DESCENT_FPM, 100],
    [false, 120, DESCENT_FPM, 200],
    [false, 100, DESCENT_FPM, 210],
  ]

  it('pattern traffic: a brief climb on a short final below 150 ft does not start the gear up', () => {
    initializeGearState('PATTERN', 0, LEVEL_FPM, true)
    expect(fly('PATTERN', [...LIFTOFF_AND_RETRACT, [false, 60, CLIMB_FPM, 3]])).toBeLessThan(1)
    expect(fly('PATTERN', PATTERN_TO_SHORT_FINAL)).toBe(1)
    expect(fly('PATTERN', [[false, 102, BRIEF_CLIMB_FPM, 211]])).toBe(1)
    expect(fly('PATTERN', [[false, 104, BRIEF_CLIMB_FPM, 212]])).toBe(1)
    expect(fly('PATTERN', [[false, 100, DESCENT_FPM, 213]])).toBe(1)
  })

  it('touch-and-go: the leave-contact retract fires again 2 s after the second liftoff', () => {
    initializeGearState('TGO', 0, LEVEL_FPM, true)
    fly('TGO', [...LIFTOFF_AND_RETRACT, ...PATTERN_TO_SHORT_FINAL])
    expect(
      fly('TGO', [
        [true, 0, DESCENT_FPM, 230],
        [true, 0, LEVEL_FPM, 235],
        [false, 10, CLIMB_FPM, 236],
        [false, 20, CLIMB_FPM, 237.9],
      ]),
    ).toBe(1)
    fly('TGO', [[false, 30, CLIMB_FPM, 238]])
    expect(fly('TGO', [[false, 60, CLIMB_FPM, 239]])).toBeLessThan(1)
  })

  it('a liftoff that passes 150 ft before climbing faster than 100 fpm retracts by the 150 ft rule, and only then', () => {
    initializeGearState('SLOW', 0, LEVEL_FPM, true)
    expect(
      fly('SLOW', [
        [true, 0, LEVEL_FPM, 0],
        [false, 10, 50, 1],
        [false, 100, 50, 5],
        [false, 160, 50, 8],
      ]),
    ).toBe(1)
    fly('SLOW', [[false, 200, CLIMB_FPM, 10]])
    expect(fly('SLOW', [[false, 260, CLIMB_FPM, 11]])).toBeLessThan(1)
    expect(fly('SLOW', PATTERN_TO_SHORT_FINAL)).toBe(1)
    expect(fly('SLOW', [[false, 102, BRIEF_CLIMB_FPM, 211]])).toBe(1)
    expect(fly('SLOW', [[false, 104, BRIEF_CLIMB_FPM, 212]])).toBe(1)
  })

  it('a go-around from a low pattern keeps the gear down below 150 ft and retracts by the 150 ft rule above it', () => {
    initializeGearState('LOWGA', 0, LEVEL_FPM, true)
    fly('LOWGA', [...LIFTOFF_AND_RETRACT, [false, 100, LEVEL_FPM, 20]])
    expect(
      fly('LOWGA', [
        [false, 80, DESCENT_FPM, 30],
        [false, 40, DESCENT_FPM, 40],
      ]),
    ).toBe(1)
    expect(fly('LOWGA', [[false, 50, CLIMB_FPM, 41]])).toBe(1)
    expect(fly('LOWGA', [[false, 80, CLIMB_FPM, 42]])).toBe(1)
    fly('LOWGA', [[false, 160, CLIMB_FPM, 45]])
    expect(fly('LOWGA', [[false, 200, CLIMB_FPM, 46]])).toBeLessThan(1)
  })
})
