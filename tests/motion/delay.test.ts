// @vitest-environment node
/**
 * The per-aircraft display delay: where it starts, how it eases, and that saving it every frame does not
 * replace the store's timelines.
 */
import { beforeEach, expect, it, vi } from 'vitest'
import {
  DYNAMIC_DELAY_MAX_DECREASE_RATE,
  DYNAMIC_DELAY_MIN_MS,
  SOURCE_DISPLAY_DELAYS,
} from '@/constants/aircraft-timeline'
import type { AircraftDataSource, AircraftObservation, DynamicDelayState } from '@/types/aircraft-timeline'

type TimelineModule = typeof import('@/stores/aircraftTimelineStore')

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0)
const FRAME_MS = 1000 / 60
const METADATA = { cid: 1, aircraftType: 'B738', transponder: '1200', departure: null, arrival: null }

let tl: TimelineModule

beforeEach(async () => {
  vi.resetModules()
  // vnasStore registers a removal listener at module init; loading it first resolves the store import cycle
  // in the same order the app does.
  await import('@/stores/vnasStore')
  tl = await import('@/stores/aircraftTimelineStore')
})

function observation(source: AircraftDataSource): AircraftObservation {
  return {
    latitude: 37.72,
    longitude: -122.22,
    altitude: 10,
    heading: 90,
    groundspeed: 0,
    groundTrack: null,
    headingIsTrue: true,
    onGround: true,
    pitch: null,
    roll: null,
    verticalRate: null,
    observedAt: T0,
    receivedAt: T0 + 500,
    source,
    displayDelay: SOURCE_DISPLAY_DELAYS[source],
  }
}

function delayState(currentDelayMs: number, targetDelayMs: number): DynamicDelayState {
  return { currentDelayMs, targetDelayMs, lastUpdateTime: T0, intervalHistory: [15000], extrapolationBumpMs: 0 }
}

it('1.1 saving the display delay every frame does not replace the timelines map (TC3D-49)', () => {
  const store = tl.useAircraftTimelineStore
  store.getState().addObservation('AAL1', observation('vatsim'), METADATA)
  let notified = 0
  const unsubscribe = store.subscribe((state, prev) => {
    if (state.timelines !== prev.timelines) notified++
  })
  for (let i = 1; i <= 10; i++) store.getState().getInterpolatedStates(T0 + 500 + i * FRAME_MS)
  unsubscribe()
  expect(notified, 'timelines notifications across 10 frames with no new observation').toBe(0)
})

it('1.1 an aircraft held before its first report keeps its source delay, with no extrapolation bump (TC3D-49)', () => {
  const store = tl.useAircraftTimelineStore
  store.getState().addObservation('AAL1', observation('vatsim'), METADATA)
  const delays = new Set<number>()
  for (let t = T0 + 500; t <= T0 + 5500; t += FRAME_MS) {
    const result = store.getState().getInterpolatedStates(t).get('AAL1')
    if (result) delays.add(result.displayDelay)
  }
  expect([...delays]).toEqual([SOURCE_DISPLAY_DELAYS.vatsim])
})

it('1.1 a time step backward leaves the delay where it is (TC3D-49)', () => {
  const { delayMs, updatedState } = tl.applyDelayTransition(delayState(17000, 15150), T0 - 5000, false)
  expect(delayMs).toBe(17000)
  expect(updatedState.extrapolationBumpMs).toBe(0)
})

it('1.1 a long gap between frames moves the delay by at most 1 s worth of the rate limit (TC3D-49)', () => {
  const { delayMs } = tl.applyDelayTransition(delayState(17000, 15150), T0 + 60_000, false)
  expect(delayMs).toBeLessThan(17000)
  expect(17000 - delayMs).toBeLessThanOrEqual(1.0 * DYNAMIC_DELAY_MAX_DECREASE_RATE)
})

it('1.1 a 200 ms frame (5 fps) moves the delay by the full rate limit for that frame (TC3D-49)', () => {
  const { delayMs } = tl.applyDelayTransition(delayState(17000, 15150), T0 + 200, false)
  expect(17000 - delayMs).toBeCloseTo(0.2 * DYNAMIC_DELAY_MAX_DECREASE_RATE, 6)
})

it('1.1 a source whose delay is under the minimum starts at the minimum delay (TC3D-49)', () => {
  const store = tl.useAircraftTimelineStore
  store.getState().addObservation('AAL1', observation('broadcast'), METADATA)
  expect(store.getState().getInterpolatedState('AAL1', T0 + 500)?.displayDelay).toBe(DYNAMIC_DELAY_MIN_MS)
})
