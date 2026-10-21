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

const KTS = 0.514444
const M_PER_DEG_LON = 111320 * Math.cos((37.72 * Math.PI) / 180)
const VNAS_LOST_S = 60
const SPEED_CHANGE_S = 70

/**
 * Eastbound cruise for the vNAS→VATSIM flip: 250 kt, accelerating to 290 kt at 70 s, so a 15 s gap
 * interpolated or extrapolated at the old speed drifts and the guessing is observable.
 */
function cruiseObservation(t: number, source: AircraftDataSource): AircraftObservation {
  const x = 250 * KTS * Math.min(t, SPEED_CHANGE_S) + 290 * KTS * Math.max(0, t - SPEED_CHANGE_S)
  return {
    latitude: 37.72,
    longitude: -122.22 + x / M_PER_DEG_LON,
    altitude: 3000,
    heading: 90,
    groundspeed: t < SPEED_CHANGE_S ? 250 : 290,
    groundTrack: source === 'vnas' ? 90 : null,
    headingIsTrue: true,
    onGround: false,
    pitch: null,
    roll: null,
    verticalRate: null,
    observedAt: T0 + t * 1000,
    receivedAt: T0 + t * 1000 + (source === 'vnas' ? 80 : 500),
    source,
    displayDelay: SOURCE_DISPLAY_DELAYS[source],
  }
}

it('1.6 after vNAS is lost the display delay rises at 500 ms/s and stops guessing within a minute (TC3D-188)', () => {
  const store = tl.useAircraftTimelineStore
  const feeds: { at: number; observation: AircraftObservation }[] = []
  for (let t = 0; t <= VNAS_LOST_S; t++) feeds.push({ at: t * 1000 + 80, observation: cruiseObservation(t, 'vnas') })
  for (let t = 3; t <= 200; t += 15) feeds.push({ at: t * 1000 + 500, observation: cruiseObservation(t, 'vatsim') })
  feeds.sort((a, b) => a.at - b.at)

  const frames: { t: number; delay: number; target: number; extrapolating: boolean }[] = []
  let next = 0
  for (let f = 0; f <= 200 * 60; f++) {
    const now = T0 + f * FRAME_MS
    while (next < feeds.length && T0 + feeds[next].at <= now) {
      store.getState().addObservation('AAL1', feeds[next].observation, METADATA)
      next++
    }
    const result = store.getState().getInterpolatedStates(now).get('AAL1')
    const delayState = store.getState().dynamicDelays.get('AAL1')
    if (!result || !delayState) continue
    frames.push({
      t: (now - T0) / 1000,
      delay: result.displayDelay,
      target: delayState.targetDelayMs,
      extrapolating: result.isExtrapolating,
    })
  }

  let maxRate = 0
  for (let i = 1; i < frames.length; i++) {
    const dt = frames[i].t - frames[i - 1].t
    if (dt <= 0) continue
    maxRate = Math.max(maxRate, (frames[i].delay - frames[i - 1].delay) / dt)
  }
  expect(maxRate, `display delay rose at ${maxRate.toFixed(1)} ms/s`).toBeLessThanOrEqual(500 * 1.01)

  const raised = frames.findIndex((f) => f.target > 5000)
  expect(raised, 'the VATSIM target was never raised after the loss').toBeGreaterThan(-1)
  const target = frames[raised].target
  const settled = frames.findIndex((f, i) => i >= raised && Math.abs(f.delay - target) <= 500)
  expect(settled, 'the delay never reached the VATSIM target').toBeGreaterThan(-1)
  const settledS = frames[settled].t - frames[raised].t
  expect(settledS, `delay took ${settledS.toFixed(1)} s to reach the ${target} ms target`).toBeLessThanOrEqual(40)

  const guessS = frames.filter((f) => f.t > VNAS_LOST_S && f.extrapolating).length * (FRAME_MS / 1000)
  expect(guessS, `display time stayed ahead of the newest report for ${guessS.toFixed(1)} s after the loss`).toBeLessThan(60)
})
