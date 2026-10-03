// @vitest-environment node
/**
 * Flight-phase detection for an aircraft on the final approach course.
 *
 * The positive control is an aircraft on a 3 deg glide about 4 nm from the threshold: the distance
 * branch labels it, and that label has to survive the altitude gate finals are missing today. An
 * aircraft overflying the same course at altitude is labelled as being on final, which is wrong, so
 * those cases stay as todos.
 */
import { expect, it, vi } from 'vitest'

it('an aircraft on a 3 deg glide 4 nm from the threshold is labelled long_final', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(Date.UTC(2026, 0, 1, 12))
    const geo = await import('@/services/GeoidService')
    const { detectFlightPhase } = await import('@/utils/aircraft/flightPhaseDetector')
    const lat0 = 37.72
    const lon0 = -122.22
    const mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180)
    const threshold = { lat: lat0, lon: lon0 }
    const far = { lat: lat0, lon: lon0 + 3000 / mPerDegLon }
    const context = {
      airportLat: lat0,
      airportLon: lon0,
      airportElevationFt: 10,
      icao: 'KOAK',
      runways: [
        {
          ident: '09/27',
          lowEnd: {
            ident: '09',
            lat: threshold.lat,
            lon: threshold.lon,
            headingTrue: 90,
            elevationFt: 10,
            displacedThresholdFt: 0,
          },
          highEnd: {
            ident: '27',
            lat: far.lat,
            lon: far.lon,
            headingTrue: 270,
            elevationFt: 10,
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
    // A 3 deg glide at 4 nm is 4 x 6076.12 x tan(3 deg) = 1274 ft above the threshold; at 140 kt that is -743 fpm.
    const distNm = 4
    const altFt = 1300
    const lon = lon0 - (distNm * 1852) / mPerDegLon
    const aircraft = {
      callsign: 'GLIDE1',
      interpolatedLatitude: lat0,
      interpolatedLongitude: lon,
      interpolatedAltitude: geo.geoidService.mslToEllipsoidal(lat0, lon, altFt * 0.3048),
      interpolatedGroundspeed: 140,
      interpolatedHeading: 90,
      track: 90,
      verticalRate: -743 * 0.3048,
      acceleration: 0,
      departure: 'KLAX',
      arrival: 'KSEA',
    }
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

it.todo('7.1 "Go Around" is shown after a go-around instead of "Climbing" (TC3D-49)')
it.todo('7.2 the go-around vertical-rate fallback compares fpm against its 300 threshold, not m/min (TC3D-49)')
it.todo('7.3 an overflying aircraft at altitude is not labelled "Short Final" or "Final" (TC3D-49)')
