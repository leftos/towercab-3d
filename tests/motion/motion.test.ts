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
import { beforeAll, describe, expect, it, vi } from 'vitest'
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
const CRUISE_AGL_ERR_MAX_M = 16 // measured 5.0 m
const VATSIM_CRUISE_POS_ERR_MAX_M = 90 // measured 30.1 m
const VATSIM_GLIDE_POS_ERR_MAX_M = 60 // measured 13.1 m
const GA_POS_ERR_MAX_M = 5.5 // measured 1.4 m
const MIN_GEAR_DOWN = 0.95 // measured 1.00
const PLAYBACK_OFF_FRACTION_MAX = 0.1 // measured 0.019 (1.9 % of moving frames)

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
    const gearRetract = recs.find((r) => r.tLocal > f.events.initial_climb - 30 && r.gearApp < 0.99)
    if (f.callsign === 'DEP1' && gearRetract) {
      out.push(
        `  gear retract starts (app AGL) at ${(gearRetract.tLocal - f.events.initial_climb).toFixed(1)} s after liftoff`,
      )
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

let vatsim: ScenarioResult
let vnas: ScenarioResult
let vnasFirst: ScenarioResult

beforeAll(async () => {
  vatsim = await runScenario({ fps: 60, useVnas: false, vnasFirst: false, durationS: DURATION })
  vnas = await runScenario({ fps: 60, useVnas: true, vnasFirst: false, durationS: DURATION })
  vnasFirst = await runScenario({ fps: 60, useVnas: true, vnasFirst: true, durationS: DURATION })
  if (REPORT) {
    mkdirSync(dirname(REPORT_PATH), { recursive: true })
    writeFileSync(REPORT_PATH, '', 'utf8')
    report(vatsim, 'VATSIM only (15 s), 60 fps')
    report(vnas, 'vNAS 1 Hz + VATSIM, VATSIM first, 60 fps')
    report(vnasFirst, 'vNAS 1 Hz + VATSIM, vNAS first, 60 fps')
  }
}, 300_000)

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

  it(`an airborne aircraft is drawn within ${CRUISE_AGL_ERR_MAX_M} m of its true height in level cruise (measured 5.0 m)`, () => {
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

  it('a VATSIM-only departure walks through pushback, stopped taxi, active taxi, a roll and a departure climb in order', () => {
    const phases = phaseOrder(vatsim, 'DEP1')
    expect(phases.length).toBeGreaterThan(3)
    expect(phases[0]).toBe('pushback')
    expect(
      isSubsequence(phases, ['pushback', 'stopped_taxi', 'active_taxi', 'departure_roll', 'departing_climb']),
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
  it.todo('1.2 a VATSIM sample does not delete a fresh vNAS sample (TC3D-49)')
  it.todo('3.6 an airborne aircraft is drawn at its reported altitude, not 5 m above it (TC3D-49)')
  it.todo('6.1 gear height uses one datum, via the extracted helper the harness then calls (TC3D-49)')
  it.todo('7.5 a climbing aircraft over the far threshold is labelled climbing, not "Short Final" (TC3D-49)')
  // TC3D-50
  it.todo(
    '3.1 isOnGround follows the timeline after the first frame, so a vNAS-first departure is not glued to the runway (TC3D-50)',
  )
  it.todo('5.1 an arrival is not drawn on the runway before it touches down (TC3D-50)')
  it.todo('5.2 a vNAS arrival does not pitch nose-down through the flare (TC3D-50)')
  it.todo('6.2 a VATSIM aircraft does not start its gear up before liftoff or before a go-around (TC3D-50)')
  it.todo('6.3 gear retraction starts a few seconds after liftoff, with an 8 s transition (TC3D-50)')
  // TC3D-51
  it.todo('1.3 vNAS silence from a stationary aircraft does not inflate the display delay (TC3D-51)')
  it.todo('1.4 a stopped aircraft does not extrapolate forward after the last vNAS sample (TC3D-51)')
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
  // TC3D-65. The tightened check is: every departure_roll falls in
  // [events.takeoff_roll, events.initial_climb], and every landing_roll falls at or after events.rollout.
  // Both fail today, so the check is recorded here rather than weakened back to the sequence assertion.
  it.todo(
    '7.4 the departure roll is shown between the start of the takeoff roll and the initial climb, and the landing roll after touchdown (TC3D-65)',
  )
  it.todo('7.6 phase windows and dwell times run on the data-source time, not wall time (TC3D-65)')
})
