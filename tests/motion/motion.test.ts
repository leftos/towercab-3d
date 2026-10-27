// @vitest-environment node
/**
 * Aircraft-motion regression suite.
 *
 * Runs three scenarios through the real interpolation loop (see harness.ts) and asserts the quantities
 * the harness measures as correct today, each threshold set from the measured value plus a margin.
 * Everything still known to be wrong is an `it.todo` naming the work item that fixes it; those items
 * choose their own thresholds.
 *
 * The human-readable report (the per-segment tables) is written to .tmp/motion/report.txt only when
 * MOTION_REPORT=1.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ROLL_MIN_SPEED_KTS } from '@/constants'
import { knotsToMps } from '@/utils/coordinates'
import { GEAR_RETRACT_MIN_AIRBORNE_SECONDS } from '@/utils/gearAnimationController'
import { angleDiff, type FrameRecord, runScenario, type ScenarioResult } from './harness'

vi.mock('react', () => {
  const api = {
    useEffect: (fn: () => unknown) => {
      fn()
    },
    useState: <T>(v: T) => [v, () => {}],
  }
  return { ...api, default: api }
})

// Thresholds for the vNAS scenarios: about 3x the measured value plus a metre, so a constant that moves the
// drawn position is caught. The VATSIM margins stay wider because its 15 s chord path is an open finding.
const TAXI_POS_ERR_MAX_M = 2 // measured 0.3 m for straight taxi, 0.2 m for the 90 deg turns
const TAXI_HDG_ERR_MAX_DEG = 6.5 // measured 1.8 deg
const TAXI_PITCH_ROLL_MAX_DEG = 1.5 // measured 0.0 deg
const CRUISE_POS_ERR_MAX_M = 8.5 // measured 2.5 m
const VNAS_GLIDE_POS_ERR_MAX_M = 8.5 // measured 2.5 m
const CRUISE_AGL_ERR_MAX_M = 1 // measured 0.0 m
const VATSIM_CRUISE_POS_ERR_MAX_M = 90 // measured 30.1 m
const VATSIM_GLIDE_POS_ERR_MAX_M = 60 // measured 13.1 m
const GA_POS_ERR_MAX_M = 5.5 // measured 1.4 m
const MIN_GEAR_DOWN = 0.95 // measured 1.00
const PLAYBACK_OFF_FRACTION_MAX = 0.1 // measured 0.019 (1.9 % of moving frames)
const DEPARTURE_AGL_ERR_MAX_M = 2 // measured 0.5 m (1451 m while isOnGround stayed frozen)
// Contact is entered below 3 ft (0.91 m), the most an arrival can be drawn under its reported height before touchdown.
const ARRIVAL_BELOW_TRUTH_MAX_M = 1 // measured 0.66 m
// The sim's flare sinks at about 120 fpm through the last 3 ft, so contact starts before the wheels touch.
// The band where the 50 ft ground flag used to drop the AoA offset and leave the bare -3 deg flight-path angle.
const FLARE_CHECK_LOW_FT = 39
const FLARE_CHECK_HIGH_FT = 51
// The 5.2 check asks for pitch at or above 0 deg in that band: measured lowest 1.0 deg (vNAS, VATSIM seen first)
const TOUCHDOWN_EARLY_MAX_S = 2 // measured 1.3 s for both vNAS scenarios (7.1 s and 5.5 s with the landing blend)
const GEAR_LOOKBACK_S = 30
const VATSIM_GEAR_UP_LATE_MAX_S = 6 // measured 3.8 s
// Gear-up on a go-around without touchdown, before the early-climbing VATSIM chord is fixed (TC3D-53). Measured
// -5.6 s: the same retract instant as the 150 ft rule's -4.0 s under the old 12 s ease-in-out, which took 1.6 s
// to leave 0.99; the ease-out moves the gear at once.
const GA_GEAR_UP_START_S = -5.6
const GA_GEAR_UP_TOLERANCE_S = 0.5
const GEAR_UP_AFTER_CONTACT_MAX_S = 3 // measured 2.1 s (7.3 s at 150 ft); gear starts up 2.9 s after liftoff
const GEAR_TRANSITION_S = 8
// Ease-out cubic leaves 0.67 one second into an 8 s retraction; linear 0.875, the old cubic ease-in-out 0.99.
const GEAR_EASE_OUT_AT_1S_MAX = 0.75
// The vNAS line-up hold, from the hold to 15 s into the roll. The target display delay stays at the 1 Hz value, the
// 1000 ms receive interval plus the 150 ms jitter buffer, with 1 ms for float rounding (min(20 s, gap + 150 ms) when
// the silence counted). The drawn position while standing: 8.2 m of creep when the last sample was extrapolated.
const PARKED_DELAY_WINDOW_S = 15
const PARKED_TARGET_DELAY_MAX_MS = 1151
const PARKED_POS_ERR_MAX_M = 0.05
// The start of the roll after the hold: each frame step against the truth speed at that frame times this rate (the
// display delay easing down at 100 ms/s plays the timeline at 1.1x), plus a margin; and the drawn position against
// truth at the displayed instant. A regression pin: it measures the same with the hold and the statistics exclusion
// taken out, because the harness's last stopped sample reports its true speed of about 0 kt.
const ROLL_STEP_RATE_MAX = 1.2
const ROLL_STEP_MARGIN_M = 0.05 // measured 0.017 m over the allowance
const ROLL_POS_ERR_MAX_M = 2 // measured 0.61 m
// vNAS contact is entered below 3 ft, which the sim's flare (about 120 fpm through the last 3 ft) reaches 1.5 s
// before the wheels touch; the landing roll is shown from contact (measured 0.43 s before touchdown).
const CONTACT_BEFORE_TOUCHDOWN_S = 1.5
// The roll labels on the display clock: one 800 ms dwell, the 1 s phase tick and a 1 Hz vNAS sample after the
// display allows them (measured 1.89 s worst, DEP1 vNAS seen after VATSIM), or up to the contact lead before it
// (measured 0.47 s, DEP1 VATSIM, whose 15 s chord reaches 15 kt early; 0.43 s, ARR1 vNAS).
const ROLL_LABEL_LAG_MAX_S = 3
const ROLL_LABEL_LEAD_MAX_S = 1.5
// VATSIM reads the touchdown from the interpolated 15 s chord crossing the touchdown height (measured 3.79 s before
// the truth touchdown); the old 100 ft gate showed the landing roll 9-10 s early.
const VATSIM_ROLLOUT_LEAD_MAX_S = 5

const ROOT = resolve(__dirname, '../..')
const REPORT_PATH = resolve(ROOT, '.tmp/motion/report.txt')
const REPORT = process.env.MOTION_REPORT === '1'
const DURATION = Number(process.env.MOTION_DURATION ?? 720)

const f1 = (n: number | null | undefined) => (n === null || n === undefined ? '   -  ' : n.toFixed(1).padStart(6))

function framesFor(res: ScenarioResult, callsign: string): FrameRecord[] {
  return res.frames.get(callsign) ?? []
}

function inSegments(recs: FrameRecord[], names: string[]): FrameRecord[] {
  return recs.filter((r) => names.includes(r.truth.segment))
}

function maxPosErr(recs: FrameRecord[]): number {
  return recs.reduce((m, r) => Math.max(m, Math.hypot(r.x - r.truth.x, r.y - r.truth.y)), 0)
}

function maxHdgErr(recs: FrameRecord[]): number {
  return recs.reduce((m, r) => Math.max(m, Math.abs(angleDiff(r.heading, r.truth.heading))), 0)
}

function maxAbs(recs: FrameRecord[], pick: (r: FrameRecord) => number): number {
  return recs.reduce((m, r) => Math.max(m, Math.abs(pick(r))), 0)
}

function maxValue(recs: FrameRecord[], pick: (r: FrameRecord) => number): number {
  return recs.reduce((m, r) => Math.max(m, pick(r)), Number.NEGATIVE_INFINITY)
}

function minValue(recs: FrameRecord[], pick: (r: FrameRecord) => number): number {
  return recs.reduce((m, r) => Math.min(m, pick(r)), Number.POSITIVE_INFINITY)
}

/**
 * Seconds from a truth event to the first frame whose gear reads below fully down, looking back from
 * GEAR_LOOKBACK_S before the event; negative when the gear starts up early, +Infinity when it never does.
 */
function gearUpStartS(recs: FrameRecord[], eventT: number): number {
  const first = recs.find((r) => r.tLocal > eventT - GEAR_LOOKBACK_S && r.gearApp < 0.99)
  return first ? first.tLocal - eventT : Number.POSITIVE_INFINITY
}

function phaseOrder(res: ScenarioResult, callsign: string): string[] {
  return (res.phases.get(callsign) ?? []).map((p) => p.phase)
}

function isSubsequence(seq: string[], sub: string[]): boolean {
  let i = 0
  for (const s of seq) {
    if (s === sub[i]) i++
    if (i === sub.length) return true
  }
  return false
}

/**
 * Seconds from the displayed instant a roll label may first show to the first time it shows: for DEP1 the truth
 * reaching ROLL_MIN_SPEED_KTS on the takeoff roll (below it the aircraft reads lined up), for ARR1 the touchdown.
 * +Infinity when the label never shows.
 */
function rollLabelLagS(res: ScenarioResult, callsign: 'DEP1' | 'ARR1'): number {
  const flight = res.flights.find((f) => f.callsign === callsign)
  const phase = callsign === 'DEP1' ? 'departure_roll' : 'landing_roll'
  const shown = (res.phases.get(callsign) ?? []).find((p) => p.phase === phase)
  if (!flight || !shown) return Number.POSITIVE_INFINITY
  const allowedAt =
    callsign === 'DEP1'
      ? framesFor(res, callsign).find((r) => r.truth.segment === 'takeoff_roll' && r.truth.gs >= ROLL_MIN_SPEED_KTS)
          ?.tLocal
      : flight.events.rollout
  return allowedAt === undefined ? Number.POSITIVE_INFINITY : shown.tLocal - allowedAt
}

/**
 * Fraction of moving frames (>30 s after spawn) whose displayed-time rate is off by more than 10 %.
 * Returns NaN when no frame qualifies, so an empty sample fails the caller's threshold instead of passing.
 */
function playbackOffFraction(recs: FrameRecord[]): number {
  let off = 0
  let counted = 0
  for (let i = 30; i < recs.length; i++) {
    const a = recs[i - 30]
    const b = recs[i]
    if (b.frameTime - recs[0].frameTime < 30 || b.truth.gs < 1) continue
    const rate = (b.tLocal - a.tLocal) / (b.frameTime - a.frameTime)
    counted++
    if (rate < 0.9 || rate > 1.1) off++
  }
  return counted === 0 ? Number.NaN : off / counted
}

function segmentStats(recs: FrameRecord[]): string[] {
  const by = new Map<string, FrameRecord[]>()
  for (const r of recs) {
    const l = by.get(r.truth.segment) ?? []
    l.push(r)
    by.set(r.truth.segment, l)
  }
  const lines: string[] = []
  for (const [seg, l] of by) {
    let maxPos = 0
    let maxXt = 0
    let maxHdg = 0
    let maxMotion = 0
    let maxAglErr = 0
    let pMin = 99
    let pMax = -99
    let pSum = 0
    for (const r of l) {
      const ex = r.x - r.truth.x
      const ey = r.y - r.truth.y
      const c = (r.truth.course * Math.PI) / 180
      maxPos = Math.max(maxPos, Math.hypot(ex, ey))
      maxXt = Math.max(maxXt, Math.abs(ex * Math.cos(c) - ey * Math.sin(c)))
      maxHdg = Math.max(maxHdg, Math.abs(angleDiff(r.heading, r.truth.heading)))
      if (r.motionBearing !== null && r.truth.gs > 2) {
        maxMotion = Math.max(maxMotion, Math.abs(angleDiff(r.motionBearing, r.truth.course)))
      }
      maxAglErr = Math.max(maxAglErr, Math.abs(r.agl - r.truth.agl))
      pMin = Math.min(pMin, r.pitch)
      pMax = Math.max(pMax, r.pitch)
      pSum += r.pitch
    }
    lines.push(
      `  ${seg.padEnd(24)} n=${String(l.length).padStart(5)} posErr=${f1(maxPos)}m xtrk=${f1(maxXt)}m hdgErr=${f1(maxHdg)} ` +
        `motionVsTrack=${f1(maxMotion)} aglErr=${f1(maxAglErr)}m pitch[min/mean/max]=${f1(pMin)}/${f1(pSum / l.length)}/${f1(pMax)}`,
    )
  }
  return lines
}

function report(res: ScenarioResult, label: string): void {
  const out: string[] = [
    `\n==================== ${label} (geoid N at site = ${res.geoidN.toFixed(1)} m) ====================`,
  ]
  for (const f of res.flights) {
    const recs = framesFor(res, f.callsign)
    if (recs.length === 0) continue
    const delays = recs.map((r) => r.displayDelayMs).sort((a, b) => a - b)
    const median = delays[Math.floor(delays.length / 2)]?.toFixed(0)
    out.push(`\n--- ${f.callsign} (${recs.length} frames) events(local s): ${JSON.stringify(f.events)}`)
    out.push(
      `  displayDelay ms min/median/max = ${Math.min(...delays).toFixed(0)}/${median}/${Math.max(...delays).toFixed(0)}; ` +
        `extrapolating frames=${recs.filter((r) => r.extrapolating).length}`,
    )
    out.push(...segmentStats(recs))
    const offPercent = (100 * playbackOffFraction(recs)).toFixed(1)
    out.push(
      `  playback rate (displayed time / wall time, moving, >30 s after spawn): off by >10% in ${offPercent}% of frames`,
    )
    const mismatched = recs.filter((r) => r.isOnGroundEntry !== r.onGroundTimeline).length
    out.push(`  frames where entry.isOnGround != timeline onGround: ${mismatched}/${recs.length}`)
    const ph = res.phases.get(f.callsign) ?? []
    out.push(
      `  phase changes (${ph.length}): ${ph.map((p) => `${p.tLocal.toFixed(0)}s:${p.phase}[${p.segment}]`).join(' > ')}`,
    )
    if (f.callsign === 'DEP1' || f.callsign === 'ARR1') {
      out.push(`  roll label shown ${rollLabelLagS(res, f.callsign).toFixed(2)} s after the display allows it`)
    }
    const gearEvent = f.callsign === 'GA1' ? 'go_around' : 'initial_climb'
    if (f.callsign !== 'ARR1') {
      out.push(`  gear retract starts at ${gearUpStartS(recs, f.events[gearEvent]).toFixed(1)} s after ${gearEvent}`)
    }
    const leftContact = recs.findIndex((r, i) => i > 0 && recs[i - 1].inContact === true && r.inContact === false)
    if (leftContact > 0) {
      out.push(`  leaves contact at ${(recs[leftContact].tLocal - f.events.initial_climb).toFixed(1)} s after liftoff`)
    }
    const wheelsOn = recs.find((r) => r.tLocal > f.events.rollout - 60 && r.agl < 0.2)
    if (f.callsign === 'ARR1' && wheelsOn) {
      out.push(
        `  rendered wheels-on-runway (agl<0.2m) at ${(wheelsOn.tLocal - f.events.rollout).toFixed(1)} s after truth touchdown`,
      )
    }
  }
  appendFileSync(REPORT_PATH, `${out.join('\n')}\n`, 'utf8')
}

// The scenarios run at the top level, where collection has no timeout (tests/setup/hookBudget.ts).
const vatsim: ScenarioResult = await runScenario({ fps: 60, useVnas: false, vnasFirst: false, durationS: DURATION })
const vnas: ScenarioResult = await runScenario({ fps: 60, useVnas: true, vnasFirst: false, durationS: DURATION })
const vnasFirst: ScenarioResult = await runScenario({ fps: 60, useVnas: true, vnasFirst: true, durationS: DURATION })
if (REPORT) {
  mkdirSync(dirname(REPORT_PATH), { recursive: true })
  writeFileSync(REPORT_PATH, '', 'utf8')
  report(vatsim, 'VATSIM only (15 s), 60 fps')
  report(vnas, 'vNAS 1 Hz + VATSIM, VATSIM first, 60 fps')
  report(vnasFirst, 'vNAS 1 Hz + VATSIM, vNAS first, 60 fps')
}

describe('ground taxi motion under vNAS', () => {
  it(`straight taxi position error stays within ${TAXI_POS_ERR_MAX_M} m (measured 0.3 m)`, () => {
    const recs = inSegments(framesFor(vnas, 'DEP1'), ['taxi_straight1', 'taxi_straight2'])
    expect(recs.length).toBeGreaterThan(100)
    expect(maxPosErr(recs)).toBeLessThanOrEqual(TAXI_POS_ERR_MAX_M)
  })

  it(`90 deg taxi turns stay within ${TAXI_POS_ERR_MAX_M} m and ${TAXI_HDG_ERR_MAX_DEG} deg of truth (measured 0.2 m / 1.8 deg)`, () => {
    const recs = inSegments(framesFor(vnas, 'DEP1'), ['taxi_turn_left', 'taxi_turn_right_lineup'])
    expect(recs.length).toBeGreaterThan(100)
    expect(maxPosErr(recs)).toBeLessThanOrEqual(TAXI_POS_ERR_MAX_M)
    expect(maxHdgErr(recs)).toBeLessThanOrEqual(TAXI_HDG_ERR_MAX_DEG)
  })

  it(`pitch and roll stay at zero through the taxi (measured 0.0 deg, within ${TAXI_PITCH_ROLL_MAX_DEG} deg)`, () => {
    const recs = inSegments(framesFor(vnas, 'DEP1'), [
      'push_straight',
      'push_curve',
      'push_stop',
      'taxi_straight1',
      'taxi_turn_left',
      'taxi_straight2',
      'taxi_turn_right_lineup',
      'lined_up',
    ])
    expect(recs.length).toBeGreaterThan(100)
    expect(maxAbs(recs, (r) => r.pitch)).toBeLessThanOrEqual(TAXI_PITCH_ROLL_MAX_DEG)
    expect(maxAbs(recs, (r) => r.roll)).toBeLessThanOrEqual(TAXI_PITCH_ROLL_MAX_DEG)
  })

  it(`gear is down through the taxi below 40 kt, the only speed the gear rule is exercised at (measured 1.00, at least ${MIN_GEAR_DOWN})`, () => {
    const recs = inSegments(framesFor(vnas, 'DEP1'), [
      'taxi_straight1',
      'taxi_straight2',
      'taxi_turn_right_lineup',
      'lined_up',
    ])
    expect(recs.length).toBeGreaterThan(100)
    expect(minValue(recs, (r) => r.gearApp)).toBeGreaterThanOrEqual(MIN_GEAR_DOWN)
  })
})

describe('airborne motion under vNAS', () => {
  it(`straight-line cruise position error stays within ${CRUISE_POS_ERR_MAX_M} m (measured 2.5 m)`, () => {
    const recs = inSegments(framesFor(vnas, 'DEP1'), ['cruise'])
    expect(recs.length).toBeGreaterThan(100)
    expect(maxPosErr(recs)).toBeLessThanOrEqual(CRUISE_POS_ERR_MAX_M)
  })

  it(`3.6 an airborne aircraft is drawn within ${CRUISE_AGL_ERR_MAX_M} m of its reported height in level cruise, not 5 m above it (measured 0.0 m, TC3D-49)`, () => {
    const recs = inSegments(framesFor(vnas, 'DEP1'), ['cruise'])
    expect(recs.length).toBeGreaterThan(100)
    expect(maxAbs(recs, (r) => r.agl - r.truth.agl)).toBeLessThanOrEqual(CRUISE_AGL_ERR_MAX_M)
  })

  it(`the gliding arrival tracks truth within ${VNAS_GLIDE_POS_ERR_MAX_M} m (measured 2.5 m)`, () => {
    const recs = inSegments(framesFor(vnas, 'ARR1'), ['glide'])
    expect(recs.length).toBeGreaterThan(100)
    expect(maxPosErr(recs)).toBeLessThanOrEqual(VNAS_GLIDE_POS_ERR_MAX_M)
  })

  it(`the go-around tracks truth within ${GA_POS_ERR_MAX_M} m and pitches up (measured 1.4 m, pitch up to 14.6 deg)`, () => {
    const recs = inSegments(framesFor(vnasFirst, 'GA1'), ['go_around'])
    expect(recs.length).toBeGreaterThan(100)
    expect(maxPosErr(recs)).toBeLessThanOrEqual(GA_POS_ERR_MAX_M)
    expect(maxValue(recs, (r) => r.pitch)).toBeGreaterThanOrEqual(10)
  })
})

describe('motion under the 15 s VATSIM feed alone', () => {
  it(`straight-line cruise position error stays within ${VATSIM_CRUISE_POS_ERR_MAX_M} m (measured 30.1 m)`, () => {
    const recs = inSegments(framesFor(vatsim, 'DEP1'), ['cruise'])
    expect(recs.length).toBeGreaterThan(100)
    expect(maxPosErr(recs)).toBeLessThanOrEqual(VATSIM_CRUISE_POS_ERR_MAX_M)
  })

  it(`the arriving aircraft tracks its straight-line glide within ${VATSIM_GLIDE_POS_ERR_MAX_M} m (measured 13.1 m)`, () => {
    const recs = inSegments(framesFor(vatsim, 'ARR1'), ['glide'])
    expect(recs.length).toBeGreaterThan(100)
    expect(maxPosErr(recs)).toBeLessThanOrEqual(VATSIM_GLIDE_POS_ERR_MAX_M)
  })

  it('displayed time runs within 10 % of wall time on at least 90 % of moving frames (measured 98.1 %)', () => {
    const recs = framesFor(vatsim, 'DEP1')
    expect(recs.length).toBeGreaterThan(1000)
    expect(playbackOffFraction(recs)).toBeLessThanOrEqual(PLAYBACK_OFF_FRACTION_MAX)
  })

  it('a VATSIM-only departure walks through pushback, stopped taxi, active taxi, lined up, a roll and a departure climb in order', () => {
    const phases = phaseOrder(vatsim, 'DEP1')
    expect(phases.length).toBeGreaterThan(3)
    // Held standing still before its first report, the aircraft may read stopped before the pushback shows.
    const first = phases[0] === 'stopped_taxi' ? phases[1] : phases[0]
    expect(first).toBe('pushback')
    expect(
      isSubsequence(phases, ['pushback', 'stopped_taxi', 'active_taxi', 'lined_up', 'departure_roll', 'departing_climb']),
    ).toBe(true)
  })

  it('a VATSIM-only arrival walks through long final, short final and a landing roll in order', () => {
    const phases = phaseOrder(vatsim, 'ARR1')
    expect(phases.length).toBeGreaterThan(3)
    expect(isSubsequence(phases, ['long_final', 'short_final', 'landing_roll'])).toBe(true)
  })
})

describe('findings the review measured that are still bugs today', () => {
  // TC3D-49
  it('7.5 a climbing aircraft over the runway stops reading "Short Final" when it climbs, not when it passes the threshold (TC3D-49)', () => {
    // GA1 starts its go-around 863 m before the 09 threshold and passes it about 10 s later. With
    // the finals check ahead of the climb check it stays Short Final until it has crossed the
    // threshold; with the climb check first it leaves the final phases as soon as it climbs.
    const goAroundFrames = framesFor(vnas, 'GA1').filter((r) => r.truth.segment === 'go_around')
    expect(goAroundFrames.length).toBeGreaterThan(0)
    const truthStartS = minValue(goAroundFrames, (r) => r.tLocal)
    const leftFinals = (vnas.phases.get('GA1') ?? []).find(
      (p) => p.segment === 'go_around' && p.phase !== 'short_final' && p.phase !== 'long_final',
    )
    const offsetS = leftFinals ? leftFinals.tLocal - truthStartS : Number.POSITIVE_INFINITY
    expect(offsetS, `left the final phases ${offsetS.toFixed(1)} s after the go-around began`).toBeLessThanOrEqual(8)
  })
  // TC3D-50
  it(`3.1 isOnGround follows the timeline after the first frame, so a vNAS-first departure is not glued to the runway (TC3D-50)`, () => {
    const recs = framesFor(vnasFirst, 'DEP1')
    expect(recs.length).toBeGreaterThan(1000)
    const mismatched = recs.filter((r) => r.isOnGroundEntry !== r.onGroundTimeline).length
    expect(mismatched, 'frames where entry.isOnGround differs from the timeline onGround').toBe(0)
    const airborne = inSegments(recs, ['climbing_turn', 'climb', 'level_off', 'cruise'])
    expect(airborne.length).toBeGreaterThan(100)
    const worst = maxAbs(airborne, (r) => r.agl - r.truth.agl)
    expect(worst, `drawn AGL error after liftoff ${worst.toFixed(1)} m`).toBeLessThanOrEqual(DEPARTURE_AGL_ERR_MAX_M)
  })

  it('5.1 an arrival is not drawn on the runway before it touches down (TC3D-50)', () => {
    for (const [label, res] of [
      ['vNAS, VATSIM seen first', vnas],
      ['vNAS seen first', vnasFirst],
    ] as const) {
      const flight = res.flights.find((f) => f.callsign === 'ARR1')
      expect(flight, label).toBeDefined()
      if (!flight) return
      const recs = framesFor(res, 'ARR1')
      const descent = inSegments(recs, ['glide', 'flare']).filter((r) => r.tLocal < flight.events.rollout)
      expect(descent.length, label).toBeGreaterThan(100)
      const sink = maxValue(descent, (r) => r.truth.agl - r.agl)
      expect(sink, `${label}: drawn ${sink.toFixed(2)} m below truth before touchdown`).toBeLessThanOrEqual(
        ARRIVAL_BELOW_TRUTH_MAX_M,
      )
      const wheelsOn = recs.find((r) => r.tLocal > flight.events.rollout - 60 && r.agl < 0.2)
      const earlyS = wheelsOn ? flight.events.rollout - wheelsOn.tLocal : Number.POSITIVE_INFINITY
      expect(earlyS, `${label}: drawn on the runway ${earlyS.toFixed(2)} s before truth touchdown`).toBeLessThanOrEqual(
        TOUCHDOWN_EARLY_MAX_S,
      )
    }
  })
  it('5.2 a vNAS arrival does not pitch nose-down through the flare (TC3D-50)', () => {
    for (const [label, res] of [
      ['vNAS, VATSIM seen first', vnas],
      ['vNAS seen first', vnasFirst],
    ] as const) {
      const recs = inSegments(framesFor(res, 'ARR1'), ['glide', 'flare']).filter(
        (r) => r.truth.agl >= FLARE_CHECK_LOW_FT * 0.3048 && r.truth.agl <= FLARE_CHECK_HIGH_FT * 0.3048,
      )
      expect(recs.length, label).toBeGreaterThan(30)
      const lowest = minValue(recs, (r) => r.pitch)
      expect(lowest, `${label}: pitch ${lowest.toFixed(1)} deg between ${FLARE_CHECK_LOW_FT} and ${FLARE_CHECK_HIGH_FT} ft`).toBeGreaterThanOrEqual(0)
    }
  })
  it('6.2 a VATSIM aircraft does not start its gear up before liftoff (TC3D-50)', () => {
    const flight = vatsim.flights.find((f) => f.callsign === 'DEP1')
    expect(flight).toBeDefined()
    if (!flight) return
    const liftoff = flight.events.initial_climb
    const recs = framesFor(vatsim, 'DEP1')
    expect(recs.filter((r) => r.tLocal > liftoff - GEAR_LOOKBACK_S && r.tLocal < liftoff).length).toBeGreaterThan(100)
    const startS = gearUpStartS(recs, liftoff)
    expect(startS, `gear started up ${startS.toFixed(1)} s after liftoff`).toBeGreaterThanOrEqual(0)
    expect(startS, `gear started up ${startS.toFixed(1)} s after liftoff`).toBeLessThanOrEqual(VATSIM_GEAR_UP_LATE_MAX_S)
  })
  it.todo(
    '6.2 a VATSIM aircraft does not start its gear up before a go-around: the 15 s chord climbs early, finding 1.5 (TC3D-53)',
  )
  it(`a VATSIM go-around that never touched down keeps the 150 ft gear rule, gear up ${GA_GEAR_UP_START_S} s from it (TC3D-50)`, () => {
    const flight = vatsim.flights.find((f) => f.callsign === 'GA1')
    expect(flight).toBeDefined()
    if (!flight) return
    const startS = gearUpStartS(framesFor(vatsim, 'GA1'), flight.events.go_around)
    expect(startS, `gear started up ${startS.toFixed(1)} s after the go-around`).toBeGreaterThanOrEqual(
      GA_GEAR_UP_START_S - GA_GEAR_UP_TOLERANCE_S,
    )
    expect(startS, `gear started up ${startS.toFixed(1)} s after the go-around`).toBeLessThanOrEqual(
      GA_GEAR_UP_START_S + GA_GEAR_UP_TOLERANCE_S,
    )
  })

  it('6.3 gear retraction starts a few seconds after liftoff, with an 8 s transition (TC3D-50)', () => {
    for (const [label, res] of [
      ['vNAS, VATSIM seen first', vnas],
      ['vNAS seen first', vnasFirst],
    ] as const) {
      const recs = framesFor(res, 'DEP1')
      const leftContact = recs.findIndex((r, i) => i > 0 && recs[i - 1].inContact === true && r.inContact === false)
      expect(leftContact, `${label}: the departure leaves contact`).toBeGreaterThan(0)
      const moving = recs.findIndex((r, i) => i >= leftContact && r.gearApp < 1)
      expect(moving, `${label}: the gear starts up`).toBeGreaterThan(0)
      // The transition starts on the frame before the gear first moves (zero elapsed time, progress still 1)
      const start = recs[moving - 1]
      const delayS = start.frameTime - recs[leftContact].frameTime
      expect(delayS, `${label}: gear started up ${delayS.toFixed(2)} s after leaving contact`).toBeGreaterThanOrEqual(
        GEAR_RETRACT_MIN_AIRBORNE_SECONDS - 0.05,
      )
      expect(delayS, `${label}: gear started up ${delayS.toFixed(2)} s after leaving contact`).toBeLessThanOrEqual(
        GEAR_UP_AFTER_CONTACT_MAX_S,
      )
      const oneSecondIn = recs.find((r) => r.frameTime >= start.frameTime + 1)
      expect(oneSecondIn?.gearApp, `${label}: an ease-out moves most at the start`).toBeLessThanOrEqual(
        GEAR_EASE_OUT_AT_1S_MAX,
      )
      const up = recs.find((r) => r.frameTime > start.frameTime && r.gearApp === 0)
      const transitionS = (up?.frameTime ?? Number.POSITIVE_INFINITY) - start.frameTime
      expect(transitionS, `${label}: gear transition ${transitionS.toFixed(2)} s`).toBeCloseTo(GEAR_TRANSITION_S, 1)
    }
  })
  // TC3D-51
  it('1.3 vNAS silence from a stationary aircraft does not inflate the display delay (TC3D-51)', () => {
    for (const [label, res] of [
      ['vNAS, VATSIM seen first', vnas],
      ['vNAS seen first', vnasFirst],
    ] as const) {
      const flight = res.flights.find((f) => f.callsign === 'DEP1')
      expect(flight, label).toBeDefined()
      if (!flight) return
      const recs = framesFor(res, 'DEP1').filter(
        (r) => r.tLocal >= flight.events.lined_up && r.tLocal <= flight.events.takeoff_roll + PARKED_DELAY_WINDOW_S,
      )
      expect(recs.length, label).toBeGreaterThan(1000)
      // The target, not the current delay: with VATSIM seen first the current delay is still easing down from the
      // VATSIM value here, which would hide a raised target
      const worst = maxValue(recs, (r) => r.targetDelayMs ?? Number.POSITIVE_INFINITY)
      expect(worst, `${label}: target display delay up to ${worst.toFixed(0)} ms around the line-up hold`).toBeLessThanOrEqual(
        PARKED_TARGET_DELAY_MAX_MS,
      )
    }
  })

  it('1.4 a stopped aircraft does not extrapolate forward after the last vNAS sample (TC3D-51)', () => {
    for (const [label, res] of [
      ['vNAS, VATSIM seen first', vnas],
      ['vNAS seen first', vnasFirst],
    ] as const) {
      const flight = res.flights.find((f) => f.callsign === 'DEP1')
      expect(flight, label).toBeDefined()
      if (!flight) return
      // Frames shown before the first sample of the roll can be bracketed: the hold alone, not the start of the roll
      const held = framesFor(res, 'DEP1').filter(
        (r) => r.truth.segment === 'lined_up' && r.truth.gs === 0 && r.tLocal <= flight.events.takeoff_roll - 1.5,
      )
      expect(held.length, label).toBeGreaterThan(600)
      expect(held.filter((r) => r.extrapolating).length, `${label}: held frames extrapolating`).toBe(0)
      const drift = maxPosErr(held)
      expect(drift, `${label}: drawn ${drift.toFixed(2)} m from where it stands`).toBeLessThanOrEqual(PARKED_POS_ERR_MAX_M)
    }
  })

  it('1.3 regression pin: the takeoff roll after a long stop keeps starting from the held spot with no jump (TC3D-51)', () => {
    for (const [label, res] of [
      ['vNAS, VATSIM seen first', vnas],
      ['vNAS seen first', vnasFirst],
    ] as const) {
      const flight = res.flights.find((f) => f.callsign === 'DEP1')
      expect(flight, label).toBeDefined()
      if (!flight) return
      const recs = framesFor(res, 'DEP1').filter(
        (r) => r.tLocal >= flight.events.lined_up && r.tLocal <= flight.events.takeoff_roll + PARKED_DELAY_WINDOW_S,
      )
      expect(recs.length, label).toBeGreaterThan(1000)
      let worstExcess = Number.NEGATIVE_INFINITY
      for (let i = 1; i < recs.length; i++) {
        const step = Math.hypot(recs[i].x - recs[i - 1].x, recs[i].y - recs[i - 1].y)
        const truthSpeedMps = knotsToMps(Math.max(recs[i].truth.gs, recs[i - 1].truth.gs))
        const allowed = truthSpeedMps * (recs[i].frameTime - recs[i - 1].frameTime) * ROLL_STEP_RATE_MAX
        worstExcess = Math.max(worstExcess, step - allowed)
      }
      expect(worstExcess, `${label}: a frame step exceeds the truth speed allowance by ${worstExcess.toFixed(3)} m`).toBeLessThanOrEqual(
        ROLL_STEP_MARGIN_M,
      )
      const posErr = maxPosErr(recs)
      expect(posErr, `${label}: drawn up to ${posErr.toFixed(2)} m from truth at the displayed instant`).toBeLessThanOrEqual(
        ROLL_POS_ERR_MAX_M,
      )
    }
  })
  // TC3D-52
  it.todo('3.2 bank is a coordinated turn at airliner speeds, not half of one (TC3D-52)')
  it.todo('3.4 the approach pitch is near 2.5-3 deg, not about 1 deg (TC3D-52)')
  it.todo('5.3 a VATSIM departure does not roll down the runway nose-up (TC3D-52)')
  it.todo('5.4 the aircraft rotates before liftoff (TC3D-52)')
  it.todo('5.5 the flare and de-rotation come from the vNAS path, not from thresholds on the reported AGL (TC3D-52)')
  // TC3D-53
  it.todo('2.1 VATSIM ground turns follow a path, not a chord with the nose sliding sideways (TC3D-53)')
  it.todo('2.2 the ground nose does not lead the turn or lag the path on a straight VATSIM taxi (TC3D-53)')
  it.todo('1.5 a VATSIM climb or descent does not begin up to one sample early (TC3D-53)')
  it.todo('3.3 the bank does not lag a VATSIM turn or outlive it (TC3D-53)')
  it('7.4 the departure roll is shown between the start of the takeoff roll and the initial climb', () => {
    for (const [label, res] of [
      ['VATSIM only', vatsim],
      ['vNAS, VATSIM seen first', vnas],
      ['vNAS seen first', vnasFirst],
    ] as const) {
      const flight = res.flights.find((f) => f.callsign === 'DEP1')
      expect(flight, label).toBeDefined()
      if (!flight) return
      const rolls = (res.phases.get('DEP1') ?? []).filter((p) => p.phase === 'departure_roll')
      expect(rolls.length, `${label}: DEP1 shows a departure roll`).toBeGreaterThan(0)
      for (const p of rolls) {
        expect(p.tLocal, `${label}: departure roll shown at ${p.tLocal.toFixed(1)} s`).toBeGreaterThanOrEqual(
          flight.events.takeoff_roll,
        )
        expect(p.tLocal, `${label}: departure roll shown at ${p.tLocal.toFixed(1)} s`).toBeLessThanOrEqual(
          flight.events.initial_climb,
        )
      }
    }
  })

  it('7.4 the landing roll is shown, and the rollout slowing through 15 kt never reads lined up', () => {
    for (const [label, res] of [
      ['VATSIM only', vatsim],
      ['vNAS, VATSIM seen first', vnas],
      ['vNAS seen first', vnasFirst],
    ] as const) {
      const phases = (res.phases.get('ARR1') ?? []).map((p) => p.phase)
      expect(phases, `${label}: ARR1 shows a landing roll`).toContain('landing_roll')
      expect(phases, label).not.toContain('lined_up')
    }
  })

  it('7.4 a vNAS landing roll is shown at or after touchdown, not from the 100 ft gate', () => {
    for (const [label, res] of [
      ['vNAS, VATSIM seen first', vnas],
      ['vNAS seen first', vnasFirst],
    ] as const) {
      const flight = res.flights.find((f) => f.callsign === 'ARR1')
      expect(flight, label).toBeDefined()
      if (!flight) return
      const rolls = (res.phases.get('ARR1') ?? []).filter((p) => p.phase === 'landing_roll')
      expect(rolls.length, `${label}: ARR1 shows a landing roll`).toBeGreaterThan(0)
      for (const p of rolls) {
        expect(p.tLocal, `${label}: landing roll shown at ${p.tLocal.toFixed(1)} s`).toBeGreaterThanOrEqual(
          flight.events.rollout - CONTACT_BEFORE_TOUCHDOWN_S,
        )
      }
    }
  })
  it(`7.4 a VATSIM landing roll is shown at most ${VATSIM_ROLLOUT_LEAD_MAX_S} s before touchdown, not from the 100 ft gate`, () => {
    const flight = vatsim.flights.find((f) => f.callsign === 'ARR1')
    expect(flight).toBeDefined()
    if (!flight) return
    const rolls = (vatsim.phases.get('ARR1') ?? []).filter((p) => p.phase === 'landing_roll')
    expect(rolls.length, 'ARR1 shows a landing roll').toBeGreaterThan(0)
    for (const p of rolls) {
      expect(p.tLocal, `landing roll shown at ${p.tLocal.toFixed(1)} s`).toBeGreaterThanOrEqual(
        flight.events.rollout - VATSIM_ROLLOUT_LEAD_MAX_S,
      )
    }
  })
  // The interpolated VATSIM altitude crosses the 10 ft touchdown height before the truth touchdown.
  it.todo('7.4 VATSIM touchdown read about 3.8 s early from the interpolated height')
  it(`7.6 the roll labels follow the display from at most their lead before it allows them to ${ROLL_LABEL_LAG_MAX_S} s after`, () => {
    const cases = [
      ['VATSIM only', vatsim, 'DEP1', ROLL_LABEL_LEAD_MAX_S],
      ['vNAS, VATSIM seen first', vnas, 'DEP1', ROLL_LABEL_LEAD_MAX_S],
      ['vNAS seen first', vnasFirst, 'DEP1', ROLL_LABEL_LEAD_MAX_S],
      ['VATSIM only', vatsim, 'ARR1', VATSIM_ROLLOUT_LEAD_MAX_S],
      ['vNAS, VATSIM seen first', vnas, 'ARR1', ROLL_LABEL_LEAD_MAX_S],
      ['vNAS seen first', vnasFirst, 'ARR1', ROLL_LABEL_LEAD_MAX_S],
    ] as const
    for (const [label, res, callsign, leadMaxS] of cases) {
      const lagS = rollLabelLagS(res, callsign)
      const message = `${label}: ${callsign} roll label shown ${lagS.toFixed(2)} s after the display allows it`
      expect(lagS, message).toBeGreaterThanOrEqual(-leadMaxS)
      expect(lagS, message).toBeLessThanOrEqual(ROLL_LABEL_LAG_MAX_S)
    }
  })
})

// The run is at the top level, where collection has no timeout (tests/setup/hookBudget.ts).
const high: ScenarioResult = await runScenario({
  fps: 60,
  useVnas: false,
  vnasFirst: false,
  durationS: DURATION,
  fieldElevationBelowGroundFt: 15,
})

describe('phases when the reported altitude reads above the field', () => {
  it('7.4 a VATSIM arrival reported 15 ft above the field reads the landing roll, not short final, after touchdown', () => {
    const flight = high.flights.find((f) => f.callsign === 'ARR1')
    expect(flight).toBeDefined()
    if (!flight) return
    const { rollout, exit_turn: turnOff } = flight.events
    const changes = high.phases.get('ARR1') ?? []
    const summary = changes.map((p) => `${p.tLocal.toFixed(1)}s:${p.phase}`).join(' > ')
    const shownAtTurnOff = changes.filter((p) => p.tLocal <= turnOff).at(-1)?.phase
    expect(shownAtTurnOff, `touchdown ${rollout.toFixed(1)} s, turn-off ${turnOff.toFixed(1)} s: ${summary}`).toBe(
      'landing_roll',
    )
    const shortFinalAfterTouchdown = changes.filter(
      (p) => p.phase === 'short_final' && p.tLocal >= rollout && p.tLocal <= turnOff,
    )
    expect(shortFinalAfterTouchdown, summary).toEqual([])
  })
})
