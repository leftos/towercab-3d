// @vitest-environment node
/**
 * A remote browser maps the host's WebSocket observation into the timeline observation, carrying the height above
 * ground when the host sends it and leaving it absent when the key is missing (an older host, or a source without
 * a height).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { RemoteObservationData } from '@/types'

type RemoteModule = typeof import('@/hooks/useRemoteObservations')

const NOW = 1_700_000_000_000
let toTimelineObservation: RemoteModule['toTimelineObservation']

beforeAll(async () => {
  // vnasStore registers a removal listener at module init; loading it first resolves the store import cycle in
  // the order the app does
  await import('@/stores/vnasStore')
  ;({ toTimelineObservation } = await import('@/hooks/useRemoteObservations'))
})

function wireObservation(extra: Partial<RemoteObservationData> = {}): RemoteObservationData {
  return {
    callsign: 'DAL123',
    latitude: 37.72,
    longitude: -122.22,
    altitude: 10,
    heading: 90,
    groundspeed: 140,
    groundTrack: 90,
    verticalRate: 0,
    onGround: false,
    pitch: null,
    roll: null,
    source: 'vnas',
    observedAt: NOW - 500,
    receivedAt: NOW - 400,
    typeCode: 'B738',
    origin: 'KLAX',
    destination: 'KOAK',
    flightRules: null,
    ...extra,
  }
}

describe('toTimelineObservation', () => {
  it('carries heightAboveGround into the observation', () => {
    const { callsign, observation } = toTimelineObservation(wireObservation({ heightAboveGround: 1.25 }), NOW)
    expect(callsign).toBe('DAL123')
    expect(observation.heightAboveGround).toBe(1.25)
  })

  it('leaves heightAboveGround absent when the message has no such key', () => {
    const { observation } = toTimelineObservation(wireObservation(), NOW)
    expect(observation.heightAboveGround).toBeUndefined()
    expect(observation.receivedAt).toBe(NOW)
  })
})
