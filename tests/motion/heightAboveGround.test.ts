// @vitest-environment node
/**
 * The height above ground a source reports (vNAS) reaches the interpolated timeline state: lerped between two
 * samples, carried while extrapolating past the last one, absent for sources without it (VATSIM), and dropped
 * once the source's samples are older than the vNAS preference window.
 */
import { beforeEach, expect, it, vi } from 'vitest'
import { SOURCE_DISPLAY_DELAYS, VNAS_PREFERENCE_THRESHOLD_MS } from '@/constants/aircraft-timeline'
import type { AircraftDataSource, AircraftObservation } from '@/types/aircraft-timeline'

type TimelineModule = typeof import('@/stores/aircraftTimelineStore')

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0)
const RECEIVE_LAG_MS = 80
const METADATA = { cid: 0, aircraftType: 'B738', transponder: '', departure: null, arrival: null }

let tl: TimelineModule

beforeEach(async () => {
  vi.resetModules()
  // vnasStore registers a removal listener at module init; loading it first resolves the store import cycle
  // in the same order the app does.
  await import('@/stores/vnasStore')
  tl = await import('@/stores/aircraftTimelineStore')
})

function observation(
  source: AircraftDataSource,
  observedAt: number,
  heightAboveGround: number | undefined,
): AircraftObservation {
  return {
    latitude: 37.72,
    longitude: -122.22 + (observedAt - T0) * 1e-8,
    altitude: 100,
    heading: 90,
    groundspeed: 140,
    groundTrack: 90,
    headingIsTrue: true,
    onGround: null,
    pitch: null,
    roll: null,
    verticalRate: null,
    observedAt,
    receivedAt: observedAt + RECEIVE_LAG_MS,
    source,
    displayDelay: SOURCE_DISPLAY_DELAYS[source],
    ...(heightAboveGround === undefined ? {} : { heightAboveGround }),
  }
}

/** Feeds two vNAS samples one second apart, at 10 m and then 4 m above ground. */
function feedTwoVnasSamples(): void {
  const store = tl.useAircraftTimelineStore.getState()
  store.addObservation('VNAS1', observation('vnas', T0, 10), METADATA)
  store.addObservation('VNAS1', observation('vnas', T0 + 1000, 4), METADATA)
}

it('the height above ground is lerped between the two vNAS samples around the displayed instant', () => {
  feedTwoVnasSamples()
  const now = T0 + RECEIVE_LAG_MS + SOURCE_DISPLAY_DELAYS.vnas + 400
  const result = tl.useAircraftTimelineStore.getState().getInterpolatedState('VNAS1', now)
  expect(result).not.toBeNull()
  if (!result) return
  expect(result.isExtrapolating).toBe(false)
  const fraction = (result.displayTime - T0) / 1000
  expect(fraction, 'display time falls inside the segment').toBeGreaterThan(0)
  expect(fraction).toBeLessThan(1)
  expect(result.heightAboveGround).toBeCloseTo(10 + (4 - 10) * fraction, 6)
})

it('a VATSIM aircraft has no height above ground', () => {
  const store = tl.useAircraftTimelineStore.getState()
  store.addObservation('VAT1', observation('vatsim', T0, undefined), METADATA)
  store.addObservation('VAT1', observation('vatsim', T0 + 15000, undefined), METADATA)
  const result = store.getInterpolatedState('VAT1', T0 + RECEIVE_LAG_MS + SOURCE_DISPLAY_DELAYS.vatsim + 5000)
  expect(result).not.toBeNull()
  expect(result?.heightAboveGround).toBeNull()
})

it('the last vNAS height is carried while extrapolating past the last sample', () => {
  feedTwoVnasSamples()
  const now = T0 + 1000 + RECEIVE_LAG_MS + 5000
  const result = tl.useAircraftTimelineStore.getState().getInterpolatedState('VNAS1', now)
  expect(result?.isExtrapolating).toBe(true)
  expect(result?.heightAboveGround).toBe(4)
})

it('the height is dropped once the vNAS samples are older than the vNAS preference window', () => {
  feedTwoVnasSamples()
  const now = T0 + 1000 + RECEIVE_LAG_MS + VNAS_PREFERENCE_THRESHOLD_MS
  const result = tl.useAircraftTimelineStore.getState().getInterpolatedState('VNAS1', now)
  expect(result).not.toBeNull()
  expect(result?.heightAboveGround).toBeNull()
})
