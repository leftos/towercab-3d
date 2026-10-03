/**
 * Synthetic "truth" flights for the aircraft-motion review.
 *
 * Integrates three scripted flights at 10 Hz in a local east/north plane (metres) around an
 * airport whose runway 09/27 lies along +x. Each segment sets speed, turn rate, vertical speed
 * and crab targets; the integrator rate-limits them, so the truth is continuous and physical.
 */

const KT = 0.514444
const FT = 0.3048
const G = 9.80665
const DT = 0.1

export interface TruthSample {
  t: number // seconds since scenario start
  x: number
  y: number
  agl: number // metres
  heading: number // nose direction, deg true
  course: number // ground track, deg true
  gs: number // kt
  vs: number // fpm
  turnRate: number // deg/s of course
  bank: number // deg, coordinated-turn bank for the current turn rate and speed (0 on ground)
  onGround: boolean
  segment: string
}

interface State {
  t: number
  x: number
  y: number
  agl: number
  course: number
  crab: number
  reverse: boolean
  gs: number
  vs: number
  turnRate: number
  onGround: boolean
}

interface Controls {
  gsTarget?: number
  accel?: number // kt/s magnitude
  turnRate?: number // deg/s
  vsTarget?: number // fpm
  vsRate?: number // fpm/s magnitude
  reverse?: boolean
  crabTarget?: number // deg, heading = course + crab
}

export interface Segment {
  name: string
  until: (s: State, segT: number) => boolean
  ctl: (s: State, segT: number) => Controls
}

function approach(current: number, target: number, maxStep: number): number {
  if (Math.abs(target - current) <= maxStep) return target
  return current + Math.sign(target - current) * maxStep
}

function norm360(a: number): number {
  return ((a % 360) + 360) % 360
}

export function angleDiff(a: number, b: number): number {
  let d = norm360(b) - norm360(a)
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return d
}

export function simulate(start: Partial<State> & { x: number; y: number; course: number }, segments: Segment[]) {
  const s: State = {
    t: 0,
    agl: 0,
    crab: 0,
    reverse: false,
    gs: 0,
    vs: 0,
    turnRate: 0,
    onGround: true,
    ...start,
  }
  const out: TruthSample[] = []
  const events: Record<string, number> = {}
  for (const seg of segments) {
    events[seg.name] = s.t
    let segT = 0
    while (!seg.until(s, segT) && segT < 2000) {
      const c = seg.ctl(s, segT)
      if (c.reverse !== undefined && c.reverse !== s.reverse) {
        // Switching between pushback and forward taxi: the nose stays put, the direction of motion flips.
        s.course = norm360(s.course + 180)
        s.reverse = c.reverse
      }
      if (c.gsTarget !== undefined) s.gs = approach(s.gs, c.gsTarget, (c.accel ?? 1) * DT)
      s.turnRate = c.turnRate ?? 0
      s.course = norm360(s.course + s.turnRate * DT)
      if (c.vsTarget !== undefined) s.vs = approach(s.vs, c.vsTarget, (c.vsRate ?? 1e9) * DT)
      if (c.crabTarget !== undefined) s.crab = approach(s.crab, c.crabTarget, 2 * DT)
      const v = s.gs * KT
      s.x += v * Math.sin((s.course * Math.PI) / 180) * DT
      s.y += v * Math.cos((s.course * Math.PI) / 180) * DT
      s.agl = Math.max(0, s.agl + (s.vs / 60) * FT * DT)
      if (s.agl === 0 && s.vs < 0) s.vs = 0
      s.onGround = s.agl < 0.05
      s.t = Math.round((s.t + DT) * 10) / 10
      segT += DT
      const heading = norm360(s.course + (s.reverse ? 180 : 0) + s.crab)
      const bank = s.onGround ? 0 : (Math.atan((v * s.turnRate * Math.PI) / 180 / G) * 180) / Math.PI
      out.push({
        t: s.t,
        x: s.x,
        y: s.y,
        agl: s.agl,
        heading,
        course: s.course,
        gs: s.gs,
        vs: s.vs,
        turnRate: s.turnRate,
        bank,
        onGround: s.onGround,
        segment: seg.name,
      })
    }
  }
  return { samples: out, events }
}

export function truthAt(samples: TruthSample[], t: number): TruthSample | null {
  if (samples.length === 0 || t < samples[0].t || t > samples[samples.length - 1].t) return null
  const i = Math.min(samples.length - 2, Math.max(0, Math.floor((t - samples[0].t) / DT)))
  const a = samples[i]
  const b = samples[i + 1]
  const f = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)))
  const lerp = (p: number, q: number) => p + (q - p) * f
  return {
    ...a,
    t,
    x: lerp(a.x, b.x),
    y: lerp(a.y, b.y),
    agl: lerp(a.agl, b.agl),
    heading: norm360(a.heading + angleDiff(a.heading, b.heading) * f),
    course: norm360(a.course + angleDiff(a.course, b.course) * f),
    gs: lerp(a.gs, b.gs),
    vs: lerp(a.vs, b.vs),
    bank: lerp(a.bank, b.bank),
  }
}

const GLIDE_TAN = Math.tan((3 * Math.PI) / 180)

/** Departure: pushback with a curve, taxi with two 90 deg turns, line-up, takeoff, climbing turn, level-off, cruise turn. */
export function departureFlight() {
  return simulate({ x: -900, y: -400, course: 180, reverse: true }, [
    { name: 'push_straight', until: (_s, t) => t >= 25, ctl: () => ({ gsTarget: 3, accel: 0.5, reverse: true }) },
    { name: 'push_curve', until: (_s, t) => t >= 30, ctl: () => ({ gsTarget: 3, reverse: true, turnRate: 3 }) },
    {
      name: 'push_stop',
      until: (s, t) => s.gs === 0 && t >= 15,
      ctl: () => ({ gsTarget: 0, accel: 1, reverse: true }),
    },
    { name: 'taxi_straight1', until: (_s, t) => t >= 40, ctl: () => ({ gsTarget: 15, accel: 1, reverse: false }) },
    {
      name: 'taxi_turn_left',
      until: (s) => Math.abs(angleDiff(s.course, 0)) < 0.5,
      ctl: (s) => ({ gsTarget: 12, accel: 1, turnRate: angleDiff(s.course, 0) < 0 ? -9 : 0 }),
    },
    { name: 'taxi_straight2', until: (_s, t) => t >= 25, ctl: () => ({ gsTarget: 15, accel: 1, turnRate: 0 }) },
    {
      name: 'taxi_turn_right_lineup',
      until: (s) => Math.abs(angleDiff(s.course, 90)) < 0.5,
      ctl: (s) => ({ gsTarget: 8, accel: 1.5, turnRate: angleDiff(s.course, 90) > 0 ? 8 : 0 }),
    },
    { name: 'lined_up', until: (s, t) => s.gs === 0 && t >= 25, ctl: () => ({ gsTarget: 0, accel: 2 }) },
    { name: 'takeoff_roll', until: (s) => s.gs >= 150, ctl: () => ({ gsTarget: 150, accel: 3.5 }) },
    {
      name: 'initial_climb',
      until: (s) => s.agl >= 1000 * FT,
      ctl: () => ({ gsTarget: 175, accel: 1, vsTarget: 2500, vsRate: 600 }),
    },
    {
      name: 'climbing_turn',
      until: (_s, t) => t >= 30,
      ctl: () => ({ gsTarget: 210, accel: 1, vsTarget: 2500, turnRate: 3 }),
    },
    { name: 'climb', until: (s) => s.agl >= 4500 * FT, ctl: () => ({ gsTarget: 250, accel: 1, vsTarget: 2500 }) },
    {
      name: 'level_off',
      until: (s, t) => s.vs === 0 && t > 3,
      ctl: () => ({ gsTarget: 250, vsTarget: 0, vsRate: 200 }),
    },
    { name: 'cruise', until: (_s, t) => t >= 40, ctl: () => ({ gsTarget: 250, vsTarget: 0 }) },
    { name: 'cruise_turn', until: (_s, t) => t >= 45, ctl: () => ({ gsTarget: 250, vsTarget: 0, turnRate: -2.04 }) },
  ])
}

/** Approach with a crosswind crab, 3 deg glide, exponential flare from 30 ft, de-crab, rollout, 90 deg exit, taxi-in. */
export function arrivalFlight(aimX: number, aimY: number, goAround: boolean) {
  const startDist = 8 * 1852
  const segs: Segment[] = [
    {
      name: 'level_intercept',
      until: (s) => aimX - s.x <= (2000 * FT) / GLIDE_TAN,
      ctl: () => ({ gsTarget: 140, accel: 1, vsTarget: 0, crabTarget: -6 }),
    },
    {
      name: 'glide',
      until: (s) => s.agl <= (goAround ? 200 : 30) * FT,
      ctl: (s) => ({
        gsTarget: 140,
        accel: 1,
        vsTarget: -s.gs * (6076.12 / 60) * GLIDE_TAN,
        vsRate: 150,
        crabTarget: -6,
      }),
    },
  ]
  if (goAround) {
    segs.push(
      {
        name: 'go_around',
        until: (s) => s.agl >= 2000 * FT,
        ctl: () => ({ gsTarget: 165, accel: 1.5, vsTarget: 2000, vsRate: 400, crabTarget: -6 }),
      },
      {
        name: 'ga_level',
        until: (s, t) => s.vs === 0 && t > 2,
        ctl: () => ({ gsTarget: 165, vsTarget: 0, vsRate: 300, crabTarget: 0 }),
      },
      { name: 'crosswind_turn', until: (_s, t) => t >= 60, ctl: () => ({ gsTarget: 165, vsTarget: 0, turnRate: -3 }) },
      { name: 'downwind', until: (_s, t) => t >= 60, ctl: () => ({ gsTarget: 165, vsTarget: 0 }) },
    )
  } else {
    segs.push(
      {
        name: 'flare',
        until: (s) => s.agl <= 0,
        ctl: (s) => ({ gsTarget: 132, accel: 1, vsTarget: -Math.max(120, (743 * s.agl) / (30 * FT)), crabTarget: 0 }),
      },
      {
        name: 'rollout',
        until: (s) => s.gs <= 20,
        ctl: () => ({ gsTarget: 20, accel: 4, vsTarget: 0, crabTarget: 0 }),
      },
      {
        name: 'exit_turn',
        until: (s) => Math.abs(angleDiff(s.course, 180)) < 0.5,
        ctl: (s) => ({ gsTarget: 12, accel: 1.5, turnRate: angleDiff(s.course, 180) > 0 ? 8 : 0 }),
      },
      { name: 'taxi_in', until: (_s, t) => t >= 40, ctl: () => ({ gsTarget: 15, accel: 1 }) },
      { name: 'taxi_in_stop', until: (s, t) => s.gs === 0 && t > 3, ctl: () => ({ gsTarget: 0, accel: 2 }) },
    )
  }
  return simulate(
    { x: aimX - startDist, y: aimY, course: 90, agl: 2000 * FT, gs: 160, onGround: false, crab: -6 },
    segs,
  )
}
