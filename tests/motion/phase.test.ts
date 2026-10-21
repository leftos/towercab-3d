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
