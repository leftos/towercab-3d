// @vitest-environment node
/**
 * Flight-phase detection on the final approach course.
 *
 * The positive control is an aircraft on a 3 deg glide about 4 nm from the threshold: the distance
 * branch labels it, and that label has to survive the altitude gate finals carry. An aircraft
 * overflying the same course at altitude is not labelled as being on final, and a go-around is
 * labelled as one once the aircraft has been on a sustained approach.
 */
import { expect, it, vi } from 'vitest'
import type { SmartSortContext } from '@/utils/aircraft/types'

const LAT0 = 37.72
const LON0 = -122.22
const M_PER_DEG_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180)

/**
 * Runway 09/27 at the test site: 09's threshold at the origin, 3000 m long, both ends at
 * `endElevationFt` on a field at `airportElevationFt` (10 ft MSL by default).
 */
function makeContext(endElevationFt = 10, airportElevationFt = 10): SmartSortContext {
  const far = { lat: LAT0, lon: LON0 + 3000 / M_PER_DEG_LON }
  return {
    airportLat: LAT0,
    airportLon: LON0,
    airportElevationFt,
    icao: 'KOAK',
    runways: [
      {
        ident: '09/27',
        lowEnd: {
          ident: '09',
          lat: LAT0,
          lon: LON0,
          headingTrue: 90,
          elevationFt: endElevationFt,
          displacedThresholdFt: 0,
        },
        highEnd: {
          ident: '27',
          lat: far.lat,
          lon: far.lon,
          headingTrue: 270,
          elevationFt: endElevationFt,
          displacedThresholdFt: 0,
        },
        lengthFt: 3000 / 0.3048,
        widthFt: 150,
        surface: 'ASPH',
        lighted: true,
        closed: false,
      },
    ],
  }
}

/** Longitude of a point `distNm` west of the 09 threshold, on its final approach course. */
function finalLon(distNm: number): number {
  return LON0 - (distNm * 1852) / M_PER_DEG_LON
}

/** Altitude in metres ellipsoidal, the unit `interpolatedAltitude` carries. */
async function ellipsoidalAltitude(lat: number, lon: number, altFt: number): Promise<number> {
  const geo = await import('@/services/GeoidService')
  return geo.geoidService.mslToEllipsoidal(lat, lon, altFt * 0.3048)
}

/** An aircraft on the 09 final approach course, `distNm` from the threshold at `altFt` MSL. */
async function onFinalCourse(
  callsign: string,
  distNm: number,
  altFt: number,
  groundspeed: number,
  verticalRateFpm: number,
) {
  const lon = finalLon(distNm)
  return {
    callsign,
    interpolatedLatitude: LAT0,
    interpolatedLongitude: lon,
    interpolatedAltitude: await ellipsoidalAltitude(LAT0, lon, altFt),
    interpolatedGroundspeed: groundspeed,
    interpolatedHeading: 90,
    track: 90,
    verticalRate: verticalRateFpm / 3.28084,
    acceleration: 0,
    departure: 'KLAX',
    arrival: 'KSEA',
    // The displayed instant follows the faked clock, as a source with no display delay
    get displayTime() {
      return Date.now()
    },
  }
}

/** An aircraft on runway 09, `eastM` past the threshold at field elevation, heading down the runway. */
async function onRunway(callsign: string, eastM: number, groundspeed: number, acceleration: number) {
  const lon = LON0 + eastM / M_PER_DEG_LON
  return {
    callsign,
    interpolatedLatitude: LAT0,
    interpolatedLongitude: lon,
    interpolatedAltitude: await ellipsoidalAltitude(LAT0, lon, 10),
    interpolatedGroundspeed: groundspeed,
    interpolatedHeading: 90,
    track: 90,
    verticalRate: 0,
    acceleration,
    departure: 'KOAK',
    arrival: 'KLAX',
    heightAboveGround: 0,
    inContact: true,
    get displayTime() {
      return Date.now()
    },
  }
}

it('an aircraft on a 3 deg glide 4 nm from the threshold is labelled long_final', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(Date.UTC(2026, 0, 1, 12))
    const { detectFlightPhase } = await import('@/utils/aircraft/flightPhaseDetector')
    const context = makeContext()
    // A 3 deg glide at 4 nm is 4 x 6076.12 x tan(3 deg) = 1274 ft above the threshold; at 140 kt that is -743 fpm.
    const aircraft = await onFinalCourse('GLIDE1', 4, 1300, 140, -743)
    let phase = ''
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(Date.now() + 1000)
      // biome-ignore lint/suspicious/noExplicitAny: partial state is enough for the detector
      phase = detectFlightPhase(aircraft as any, context).phase
    }
    expect(phase).toBe('long_final')
  } finally {
    vi.useRealTimers()
  }
})

it('7.1 "Go Around" is shown after a go-around instead of "Climbing" (TC3D-49)', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(Date.UTC(2026, 0, 1, 12))
    const { detectFlightPhase } = await import('@/utils/aircraft/flightPhaseDetector')
    const context = makeContext()
    // A 30 s approach: longer than the 23 s the old expiry allowed before it lost the approach.
    const aircraft = await onFinalCourse('GA-SUSTAINED', 2.5, 750, 140, -743)
    let phase = ''
    for (let i = 0; i < 30; i++) {
      vi.setSystemTime(Date.now() + 1000)
      // biome-ignore lint/suspicious/noExplicitAny: partial state is enough for the detector
      phase = detectFlightPhase(aircraft as any, context).phase
    }
    expect(phase).toBe('long_final')
    aircraft.verticalRate = 2000 / 3.28084
    for (let i = 0; i < 6; i++) {
      vi.setSystemTime(Date.now() + 1000)
      // biome-ignore lint/suspicious/noExplicitAny: partial state is enough for the detector
      phase = detectFlightPhase(aircraft as any, context).phase
    }
    expect(phase).toBe('go_around')
  } finally {
    vi.useRealTimers()
  }
})

it('7.2 the go-around vertical-rate fallback compares fpm against its 300 threshold, not m/min (TC3D-49)', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(Date.UTC(2026, 0, 1, 12))
    const { stabilizePhase } = await import('@/utils/aircraft/phaseStabilization')
    const context = makeContext()
    const proximity = {
      runway: context.runways[0],
      endIdent: '09',
      distanceNm: 2.5,
      distanceFt: 2.5 * 6076.12,
      isAligned: true,
      isInbound: true,
      lateralOffsetFt: 0,
    }
    // 9 s on a sustained approach, then 5 s of a go-around whose current climb is the only
    // vertical-rate signal left: no timeline, so the fallback at phaseStabilization.ts decides.
    const goAround = async (callsign: string, climbFpm: number): Promise<string> => {
      const aircraft = await onFinalCourse(callsign, 2.5, 750, 140, -743)
      let phase: string = ''
      for (let i = 0; i < 9; i++) {
        vi.setSystemTime(Date.now() + 1000)
        phase = stabilizePhase(
          callsign,
          { phase: 'long_final', runway: '09', runwayDistance: 2.5 },
          // biome-ignore lint/suspicious/noExplicitAny: partial state is enough for the stabilizer
          aircraft as any,
          context,
          undefined,
          proximity,
        )
      }
      aircraft.verticalRate = climbFpm / 3.28084
      for (let i = 0; i < 5; i++) {
        vi.setSystemTime(Date.now() + 1000)
        phase = stabilizePhase(
          callsign,
          { phase: 'go_around', runway: '09', runwayDistance: 2.5 },
          // biome-ignore lint/suspicious/noExplicitAny: partial state is enough for the stabilizer
          aircraft as any,
          context,
          undefined,
          proximity,
        )
      }
      return phase
    }
    expect(await goAround('GA-FALLBACK-SLOW', 250)).toBe('departing_climb')
    expect(await goAround('GA-FALLBACK-CLIMB', 1000)).toBe('go_around')
  } finally {
    vi.useRealTimers()
  }
})

it('7.3 an overflying aircraft at altitude is not labelled "Short Final" or "Final" (TC3D-49)', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(Date.UTC(2026, 0, 1, 12))
    const { detectFlightPhase } = await import('@/utils/aircraft/flightPhaseDetector')
    const context = makeContext()
    // Aligned with the course and inbound, but nowhere near the glidepath to the threshold.
    const jet = await onFinalCourse('OVER-JET', 1.5, 35000, 450, 0)
    const mid = await onFinalCourse('OVER-MID', 4, 12000, 250, 0)
    // The positive control: a normal 3 deg approach at 4 nm is still on final.
    const glide = await onFinalCourse('ON-GLIDE', 4, 1300, 140, -743)
    const phases = new Map<string, string>()
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(Date.now() + 1000)
      phases.set(
        'OVER-JET',
        // biome-ignore lint/suspicious/noExplicitAny: partial state is enough for the detector
        detectFlightPhase(jet as any, context).phase,
      )
      phases.set(
        'OVER-MID',
        // biome-ignore lint/suspicious/noExplicitAny: partial state is enough for the detector
        detectFlightPhase(mid as any, context).phase,
      )
      phases.set(
        'ON-GLIDE',
        // biome-ignore lint/suspicious/noExplicitAny: partial state is enough for the detector
        detectFlightPhase(glide as any, context).phase,
      )
    }
    expect(phases.get('OVER-JET')).not.toBe('short_final')
    expect(phases.get('OVER-JET')).not.toBe('long_final')
    expect(phases.get('OVER-MID')).not.toBe('short_final')
    expect(phases.get('OVER-MID')).not.toBe('long_final')
    expect(phases.get('ON-GLIDE')).toBe('long_final')
  } finally {
    vi.useRealTimers()
  }
})

it('7.3 finals still show at a field whose runway end elevations are missing, parsed as 0 (TC3D-49)', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(Date.UTC(2026, 0, 1, 12))
    const { detectFlightPhase } = await import('@/utils/aircraft/flightPhaseDetector')
    // A 5000 ft field whose runway ends carry no elevation: RunwayService parses the blank as 0.
    const context = makeContext(0, 5000)
    const at4 = await onFinalCourse('NO-ELEV-4NM', 4, 5000 + 1274, 140, -743)
    const at1 = await onFinalCourse('NO-ELEV-1NM', 1, 5000 + 319, 140, -743)
    let far = ''
    let near = ''
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(Date.now() + 1000)
      // biome-ignore lint/suspicious/noExplicitAny: partial state is enough for the detector
      far = detectFlightPhase(at4 as any, context).phase
      // biome-ignore lint/suspicious/noExplicitAny: partial state is enough for the detector
      near = detectFlightPhase(at1 as any, context).phase
    }
    expect(far).toBe('long_final')
    expect(near).toBe('short_final')
  } finally {
    vi.useRealTimers()
  }
})

it('7.3 a descending overflight at altitude is not labelled "Final" (TC3D-49)', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(Date.UTC(2026, 0, 1, 12))
    const { detectFlightPhase } = await import('@/utils/aircraft/flightPhaseDetector')
    const context = makeContext()
    // Aligned, inbound and descending 1500 fpm inside 2 nm, but 8000 ft above the field: the
    // base-to-final branch has to apply the same glidepath ceiling as the finals branch.
    const overflight = await onFinalCourse('OVER-DESC', 1.5, 8010, 250, -1500)
    let phase = ''
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(Date.now() + 1000)
      // biome-ignore lint/suspicious/noExplicitAny: partial state is enough for the detector
      phase = detectFlightPhase(overflight as any, context).phase
    }
    expect(phase).not.toBe('short_final')
    expect(phase).not.toBe('long_final')
  } finally {
    vi.useRealTimers()
  }
})

/** Runs the detector once per simulated second on each state in turn, returning every phase it reports. */
async function detectEachSecond(states: Array<() => Promise<unknown>>, context: SmartSortContext): Promise<string[]> {
  const { detectFlightPhase } = await import('@/utils/aircraft/flightPhaseDetector')
  const phases: string[] = []
  for (const state of states) {
    vi.setSystemTime(Date.now() + 1000)
    // biome-ignore lint/suspicious/noExplicitAny: partial state is enough for the detector
    phases.push(detectFlightPhase((await state()) as any, context).phase)
  }
  return phases
}

it('7.4 a runway aircraft below 15 kt reads lined_up, not a roll', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(Date.UTC(2026, 0, 1, 12))
    const context = makeContext()
    // Turning onto the runway at a steady 8 kt with a departure filed from here
    const steady = await detectEachSecond(
      Array.from({ length: 5 }, () => () => onRunway('LINEUP-STEADY', 300, 8, 0)),
      context,
    )
    expect(steady).not.toContain('departure_roll')
    expect(steady.at(-1)).toBe('lined_up')
    // Lining up at 8 kt and decelerating to a stop
    const speeds = [8, 6, 4, 2, 0, 0, 0]
    const stopping = await detectEachSecond(
      speeds.map((gs) => () => onRunway('LINEUP-STOP', 300, gs, gs > 0 ? -2 : 0)),
      context,
    )
    expect(stopping).not.toContain('departure_roll')
    expect(stopping).not.toContain('landing_roll')
    expect(stopping.at(-1)).toBe('lined_up')
  } finally {
    vi.useRealTimers()
  }
})

it('7.4 a landing roll slowing through 15 kt on the runway keeps reading landing_roll, not lined_up', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(Date.UTC(2026, 0, 1, 12))
    const context = makeContext()
    // The ARR1 rollout: 60 kt down to the 12-20 kt of its exit turn, still aligned on the runway
    const speeds = [60, 50, 40, 30, 20, 16, 14, 12, 12, 12, 12, 12]
    const phases = await detectEachSecond(
      speeds.map(
        (gs, i) => async () => ({
          ...(await onRunway('ROLLOUT-SLOW', 1500 + i * 15, gs, gs > 12 ? -4 : 0)),
          departure: 'KLAX',
          arrival: 'KOAK',
        }),
      ),
      context,
    )
    expect(phases).not.toContain('lined_up')
    expect(phases.at(-1)).toBe('landing_roll')
  } finally {
    vi.useRealTimers()
  }
})

it('7.6 stabilizePhase confirms a candidate after its dwell on the display clock while Date.now() stands still', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(Date.UTC(2026, 0, 1, 12))
    const { stabilizePhase } = await import('@/utils/aircraft/phaseStabilization')
    const context = makeContext()
    const aircraft = { ...(await onRunway('CLOCK-DWELL', -500, 10, 0)), displayTime: Date.UTC(2026, 0, 1, 11, 59) }
    const raw = (phase: 'stopped_taxi' | 'active_taxi') => ({ phase, runway: null, runwayDistance: null })
    // biome-ignore lint/suspicious/noExplicitAny: partial state is enough for the stabilizer
    stabilizePhase('CLOCK-DWELL', raw('stopped_taxi'), aircraft as any, context, undefined, null)
    let phase = ''
    // active_taxi dwells 2000 ms: five display seconds confirm it
    for (let i = 0; i < 5; i++) {
      aircraft.displayTime += 1000
      // biome-ignore lint/suspicious/noExplicitAny: partial state is enough for the stabilizer
      phase = stabilizePhase('CLOCK-DWELL', raw('active_taxi'), aircraft as any, context, undefined, null)
    }
    expect(phase).toBe('active_taxi')
  } finally {
    vi.useRealTimers()
  }
})

/** A timeline holding only the groundspeed of each observation at its `observedAt`, enough for the window. */
function timelineOf(points: Array<[number, number]>) {
  return {
    callsign: 'WINDOW',
    observations: points.map(([observedAt, groundspeed]) => ({ observedAt, groundspeed })),
  }
}

it('7.6 the acceleration window spans two VATSIM samples 15 s apart at the display time, whatever Date.now() reads', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const t0 = Date.UTC(2026, 0, 1, 12)
    const { computeWindowedAcceleration } = await import('@/utils/aircraft/phaseStabilization')
    // Displayed at the second sample while the wall clock runs 20 s ahead of it
    vi.setSystemTime(t0 + 15000 + 20000)
    const timeline = timelineOf([
      [t0, 8],
      [t0 + 15000, 40],
    ])
    // biome-ignore lint/suspicious/noExplicitAny: partial timeline is enough for the window
    const result = computeWindowedAcceleration(timeline as any, t0 + 15000)
    expect(result.confidence).toBeGreaterThan(0)
    expect(result.acceleration).toBeCloseTo(32 / 15, 5)
  } finally {
    vi.useRealTimers()
  }
})

it('7.6 an observation newer than the display time is left out of the acceleration window', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const t0 = Date.UTC(2026, 0, 1, 12)
    const { computeWindowedAcceleration } = await import('@/utils/aircraft/phaseStabilization')
    vi.setSystemTime(t0 + 4000)
    // 1 Hz: accelerating 2 kt/s up to the displayed instant, braking hard in the samples after it
    const timeline = timelineOf([
      [t0, 10],
      [t0 + 1000, 12],
      [t0 + 2000, 14],
      [t0 + 3000, 16],
      [t0 + 4000, 18],
      [t0 + 5000, 10],
      [t0 + 6000, 5],
      [t0 + 7000, 0],
    ])
    // biome-ignore lint/suspicious/noExplicitAny: partial timeline is enough for the window
    const result = computeWindowedAcceleration(timeline as any, t0 + 4000)
    expect(result.acceleration).toBeCloseTo(2, 5)
  } finally {
    vi.useRealTimers()
  }
})

it('7.4 a VATSIM arrival flying level at 80 ft over the runway after an approach, then climbing away, never reads landing_roll', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(Date.UTC(2026, 0, 1, 12))
    const context = makeContext()
    const approach = Array.from({ length: 10 }, (_, i) => () => onFinalCourse('LOW-PASS', 1.2 - i * 0.07, 400 - i * 25, 130, -700))
    // A low approach: level at 80 ft over the runway at 120 kt (about 62 m/s), then a 1000 fpm climb; no height above
    // ground and no ground flag, as VATSIM reports
    const overRunway = (i: number, climbFpm: number) => async () => {
      const eastM = 200 + i * 62
      return {
        ...(await onRunway('LOW-PASS', eastM, 120, 0)),
        interpolatedAltitude: await ellipsoidalAltitude(LAT0, LON0 + eastM / M_PER_DEG_LON, 90 + (climbFpm / 60) * Math.max(0, i - 10)),
        verticalRate: climbFpm / 3.28084,
        departure: 'KLAX',
        arrival: 'KOAK',
        heightAboveGround: null,
        inContact: null,
        isOnGround: null,
      }
    }
    const level = Array.from({ length: 10 }, (_, i) => overRunway(i, 0))
    const climb = Array.from({ length: 10 }, (_, i) => overRunway(10 + i, 1000))
    const phases = await detectEachSecond([...approach, ...level, ...climb], context)
    expect(phases).not.toContain('landing_roll')
  } finally {
    vi.useRealTimers()
  }
})

it('7.6 a replay scrubbed back past an approach shows no go-around from the approach it left behind', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(Date.UTC(2026, 0, 1, 12))
    const { detectFlightPhase } = await import('@/utils/aircraft/flightPhaseDetector')
    const context = makeContext()
    // The 30 s sustained approach that makes a climb near the runway a go-around (as in 7.1)
    const aircraft = await onFinalCourse('SCRUB-BACK', 2.5, 750, 140, -743)
    for (let i = 0; i < 30; i++) {
      vi.setSystemTime(Date.now() + 1000)
      // biome-ignore lint/suspicious/noExplicitAny: partial state is enough for the detector
      detectFlightPhase(aircraft as any, context)
    }
    // Scrubbed back two minutes, to before that approach, where the aircraft climbs near the runway
    vi.setSystemTime(Date.now() - 120000)
    aircraft.verticalRate = 2000 / 3.28084
    const phases: string[] = []
    for (let i = 0; i < 6; i++) {
      vi.setSystemTime(Date.now() + 1000)
      // biome-ignore lint/suspicious/noExplicitAny: partial state is enough for the detector
      phases.push(detectFlightPhase(aircraft as any, context).phase)
    }
    expect(phases).not.toContain('go_around')
  } finally {
    vi.useRealTimers()
  }
})

it('7.6 a display time stepping back by less than the tolerance neither ends nor restarts the landing roll hold', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(Date.UTC(2026, 0, 1, 12))
    const { stabilizePhase } = await import('@/utils/aircraft/phaseStabilization')
    const context = makeContext()
    const entry = Date.UTC(2026, 0, 1, 12, 5)
    const aircraft = {
      ...(await onRunway('JITTER-HOLD', 1500, 20, 0)),
      departure: 'KLAX',
      arrival: 'KOAK',
      displayTime: entry,
    }
    const at = (offsetMs: number, phase: 'landing_roll' | 'active_taxi'): string => {
      aircraft.displayTime = entry + offsetMs
      const raw = { phase, runway: '09', runwayDistance: null }
      // biome-ignore lint/suspicious/noExplicitAny: partial state is enough for the stabilizer
      return stabilizePhase('JITTER-HOLD', raw, aircraft as any, context, undefined, null)
    }
    expect(at(0, 'landing_roll')).toBe('landing_roll')
    // Down to taxi speed from 1 s in; at 2 s the display time steps back 1.5 s as live data re-anchors
    at(1000, 'active_taxi')
    at(2000, 'active_taxi')
    at(500, 'active_taxi')
    const shown = [1000, 2000, 3000, 4000, 5000].map((offsetMs) => at(offsetMs, 'active_taxi'))
    // The phase clock holds at 2 s through the step back, so the 5 s hold ends at 5 s, neither earlier nor later
    expect(shown).toEqual(['landing_roll', 'landing_roll', 'landing_roll', 'landing_roll', 'active_taxi'])
  } finally {
    vi.useRealTimers()
  }
})
