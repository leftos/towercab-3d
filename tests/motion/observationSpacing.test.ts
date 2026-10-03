// @vitest-environment node
/**
 * The minimum spacing between observations applies per source: a VATSIM sample that arrives just before a
 * vNAS packet must not cause the store to drop that packet.
 */
import { beforeAll, expect, it } from 'vitest'
import type { AircraftMetadata, AircraftObservation } from '@/types/aircraft-timeline'

type TimelineModule = typeof import('@/stores/aircraftTimelineStore')

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0)
const META: AircraftMetadata = { cid: 1, aircraftType: 'B738', transponder: '1200', departure: 'KOAK', arrival: 'KLAX' }

let tl: TimelineModule

beforeAll(async () => {
  // vnasStore first resolves the store import cycle in the order the app does (see harness.ts).
  await import('@/stores/vnasStore')
  tl = await import('@/stores/aircraftTimelineStore')
})

function observation(source: 'vatsim' | 'vnas', observedAt: number, receivedAt: number): AircraftObservation {
  return {
    latitude: 37.72,
    longitude: -122.22,
    altitude: 100,
    heading: 90,
    groundspeed: 140,
    groundTrack: source === 'vnas' ? 90 : null,
    headingIsTrue: true,
    onGround: false,
    pitch: null,
    roll: null,
    verticalRate: null,
    observedAt,
    receivedAt,
    source,
    displayDelay: source === 'vnas' ? 1500 : 17000,
  }
}

it('1.2 a VATSIM sample does not delete a fresh vNAS sample (TC3D-49)', () => {
  const store = tl.useAircraftTimelineStore.getState()
  // vNAS at 1 Hz; a VATSIM sample with a newer observedAt lands 50 ms before the next vNAS packet.
  store.addObservation('SPC1', observation('vnas', T0, T0 + 80), META)
  store.addObservationBatch([
    { callsign: 'SPC1', observation: observation('vatsim', T0 + 900, T0 + 1030), metadata: META },
  ])
  store.addObservation('SPC1', observation('vnas', T0 + 1000, T0 + 1080), META)

  const kept = tl.useAircraftTimelineStore.getState().timelines.get('SPC1')?.observations ?? []
  expect(kept.filter((o) => o.source === 'vnas').map((o) => o.observedAt)).toEqual([T0, T0 + 1000])
  expect(kept.filter((o) => o.source === 'vatsim').map((o) => o.observedAt)).toEqual([T0 + 900])
})
