/**
 * Drives the real interpolation singleton, timeline store, phase detector and gear controller
 * with synthetic VATSIM (15 s) and vNAS (1 Hz) observation feeds built from sim.ts truth, and
 * collects what a viewer would see each frame.
 *
 * Environment variables:
 * - `MOTION_LAT`, `MOTION_LON` — site for the local east/north plane (default 37.72 N, 122.22 W).
 * - `MOTION_DURATION` — scenario length in seconds (default 720).
 * - `MOTION_REPORT=1` — the test files write the human-readable segment report to
 *   `.tmp/motion/report.txt`; without it they write no file.
 */
import { vi } from 'vitest'
import { angleDiff, arrivalFlight, departureFlight, type LevelPass, type TruthSample, truthAt } from './sim'

type TimelineModule = typeof import('@/stores/aircraftTimelineStore')
type InterpModule = typeof import('@/hooks/useAircraftInterpolation')
type GearModule = typeof import('@/utils/gearAnimationController')
type SurfaceModule = typeof import('@/utils/surfaceAnimationController')
type SmartModule = typeof import('@/utils/smartSort')
type AircraftMap = ReturnType<InterpModule['useAircraftInterpolation']>
type AircraftEntry = NonNullable<ReturnType<AircraftMap['get']>>
type SortContext = Parameters<SmartModule['calculateSmartSort']>[1]

export const LAT0 = Number(process.env.MOTION_LAT ?? 37.72)
export const LON0 = Number(process.env.MOTION_LON ?? -122.22)
export const GROUND_MSL = 3
const M_PER_DEG_LAT = 111320
const M_PER_DEG_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180)
export const T0 = Date.UTC(2026, 0, 1, 12, 0, 0)

export function toLatLon(x: number, y: number) {
  return { lat: LAT0 + y / M_PER_DEG_LAT, lon: LON0 + x / M_PER_DEG_LON }
}
export function toXY(lat: number, lon: number) {
  return { x: (lon - LON0) * M_PER_DEG_LON, y: (lat - LAT0) * M_PER_DEG_LAT }
}

let rafCallback: ((t: number) => void) | null = null
;(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: (t: number) => void) => {
  rafCallback = cb
  return 1
}
;(globalThis as Record<string, unknown>).cancelAnimationFrame = () => {}

export interface Flight {
  callsign: string
  samples: TruthSample[]
  events: Record<string, number>
  offset: number // scenario seconds at which local t=0
  departure: string
  arrival: string
}

export interface ScenarioOptions {
  fps: number
  useVnas: boolean
  vnasFirst: boolean
  durationS: number
  /** Height of the drawn (Cesium) terrain above the sim's ground, in metres; 0 when omitted. */
  terrainOffsetM?: number
  /**
   * When set, no aircraft gets a terrain sample (as above 300 m AGL, or a sample dropped) and the reference airport
   * elevation is this many metres above the sim's ground.
   */
  unsampledReferenceOffsetM?: number
  /** Metres added to and taken from the vNAS height above ground on alternate samples (floored at 0); 0 when omitted. */
  vnasHeightJitterM?: number
  /** vNAS observations carry no height above ground, as in a replay recorded before the field existed. */
  vnasWithoutHeight?: boolean
  /** vNAS observations carry no 50/80 ft ground flag (null), as VATSIM's do. */
  vnasWithoutGroundFlag?: boolean
  /**
   * Scenario second, per callsign, before which that flight's VATSIM reports are dropped, so the aircraft is first
   * seen at the first 3 + 15 n report at or after it (mid-taxi, on the takeoff roll, on short final). Flights not
   * named report from their start.
   */
  vatsimFromS?: Partial<Record<string, number>>
  /** Scenario second per callsign before which its vNAS feed sends nothing; the feed's usual start when omitted. */
  vnasFromS?: Partial<Record<string, number>>
  /**
   * Feet the phase detector's field elevation sits below the sim's ground, so every reported altitude reads that much
   * above the field (a datum above the wheels, or scenery off the airport database); 0 when omitted.
   */
  fieldElevationBelowGroundFt?: number
  /** Aircraft type per callsign; B738 for flights not named. */
  aircraftTypes?: Partial<Record<string, string>>
  /**
   * Feet per aircraft type that the reported altitude and the vNAS height above ground read over the wheels (vNAS
   * reports a reference point: an A320 at rest reads 9 ft); 0 for types not named.
   */
  restingHeightsFt?: Partial<Record<string, number>>
  /**
   * Feet per callsign that its reported altitude and vNAS height above ground read over the wheels (two simulators of
   * one type rest differently); its type's `restingHeightsFt` value for callsigns not named.
   */
  restingByCallsignFt?: Partial<Record<string, number>>
  /** Height in feet at which GA1 begins its go-around; GO_AROUND_FT when omitted. */
  goAroundFt?: number
  /** GA1's glide ends at this height (ft), held level at 128 kt for this long (s) before its go-around; none when omitted. */
  levelPass?: LevelPass
}

/** GA1's go-around height (ft) when a scenario names none. */
export const GO_AROUND_FT = 200

/** What each vNAS observation carries besides its position. */
interface VnasFeedOptions {
  jitterM: number
  withHeight: boolean
  withGroundFlag: boolean
}

/** The aircraft type a flight reports and how far above its wheels its reported heights read (m). */
interface FlightReport {
  aircraftType: string
  restM: number
}

export interface FrameRecord {
  frameTime: number // scenario seconds (wall)
  tLocal: number // truth local time at the displayed instant
  truth: TruthSample
  x: number
  y: number
  agl: number
  /** The altitude the datablock and the aircraft list show (`reportedAltitude`) over the ground (m) */
  reportedAgl: number
  heading: number
  pitch: number
  roll: number
  gs: number
  vsFpm: number
  motionBearing: number | null
  isOnGroundEntry: boolean | null
  onGroundTimeline: boolean | null
  inContact: boolean | null
  gearApp: number
  gearEllipsoidal: number
  /** Spoiler deployment, as useAircraftModels draws it (B738 wheel radius) */
  spoiler: number
  /** Reverser deployment */
  reverser: number
  /** Wheel spin in revolutions per second (negative = backwards) */
  wheelRevPerSec: number
  displayDelayMs: number
  /** The delay the display delay is easing toward, from the receive intervals; null without a delay state. */
  targetDelayMs: number | null
  extrapolating: boolean
}

export interface PhaseChange {
  tLocal: number
  phase: string
  segment: string
}

export interface ScenarioResult {
  frames: Map<string, FrameRecord[]>
  phases: Map<string, PhaseChange[]>
  flights: Flight[]
  groundEllip: number
  geoidN: number
}

interface Observation {
  callsign: string
  receivedAt: number
  isVatsim: boolean
  // biome-ignore lint/suspicious/noExplicitAny: the store's observation payload is passed through untyped
  observation: any
  // biome-ignore lint/suspicious/noExplicitAny: the store's metadata payload is passed through untyped
  metadata: any
}

interface FeedState {
  frames: Map<string, FrameRecord[]>
  phases: Map<string, PhaseChange[]>
  lastPhase: Map<string, string>
  gearInit: Set<string>
  prevXY: Map<string, { x: number; y: number }>
}

interface FrameDeps {
  tl: TimelineModule
  interp: InterpModule
  gear: GearModule
  surface: SurfaceModule
  groundEllip: number
  flightByCs: Map<string, Flight>
}

/** The scenario's flights; GA1 goes around at `goAroundFt`, after a level pass when `levelPass` is given. */
export function buildFlights(
  goAroundFt: number,
  levelPass: LevelPass | null = null,
): { flights: Flight[]; runwayThr: { x: number; y: number } } {
  const dep = departureFlight()
  const lineup = dep.samples.find((s) => s.t >= dep.events.lined_up) as TruthSample
  const thr = { x: lineup.x, y: lineup.y }
  const arr = arrivalFlight(thr.x + 300, thr.y, null, null)
  const ga = arrivalFlight(thr.x + 300, thr.y, goAroundFt, levelPass)
  const depLiftoff = dep.events.initial_climb
  const arrOffset = depLiftoff + 90 - arr.events.rollout
  return {
    runwayThr: thr,
    flights: [
      { callsign: 'DEP1', ...dep, offset: 5, departure: 'KOAK', arrival: 'KLAX' },
      { callsign: 'ARR1', ...arr, offset: arrOffset, departure: 'KLAX', arrival: 'KOAK' },
      { callsign: 'GA1', ...ga, offset: arrOffset + 120, departure: 'KLAX', arrival: 'KOAK' },
    ],
  }
}

/** Scenario seconds at which the 15 s VATSIM feed reports this flight. */
function vatsimTimes(f: Flight, durationS: number): number[] {
  const end = f.samples[f.samples.length - 1].t
  const times: number[] = []
  for (let n = 0; 3 + 15 * n <= durationS; n++) {
    const tg = 3 + 15 * n
    if (tg >= f.offset && tg - f.offset <= end) times.push(tg)
  }
  return times
}

function makeObservation(
  f: Flight,
  tg: number,
  source: 'vatsim' | 'vnas',
  groundState: boolean | null,
  groundEllip: number,
  report: FlightReport,
) {
  const s = truthAt(f.samples, tg - f.offset) as TruthSample
  const { lat, lon } = toLatLon(s.x, s.y)
  return {
    latitude: lat,
    longitude: lon,
    altitude: groundEllip + s.agl + report.restM,
    heading: s.heading,
    groundspeed: s.gs,
    groundTrack: source === 'vnas' ? s.course : null,
    headingIsTrue: true,
    onGround: groundState,
    pitch: null,
    roll: null,
    verticalRate: null,
    observedAt: T0 + tg * 1000,
    receivedAt: 0,
    source,
    displayDelay: source === 'vnas' ? 1500 : 17000,
    ...(source === 'vnas' ? { heightAboveGround: s.agl + report.restM } : {}),
  }
}

function vatsimObservations(f: Flight, times: number[], groundEllip: number, report: FlightReport): Observation[] {
  const meta = {
    cid: 1,
    aircraftType: report.aircraftType,
    transponder: '1200',
    departure: f.departure,
    arrival: f.arrival,
  }
  return times.map((tg) => {
    const observation = makeObservation(f, tg, 'vatsim', null, groundEllip, report)
    observation.receivedAt = observation.observedAt + 400 + ((tg * 7919) % 1000)
    return { callsign: f.callsign, receivedAt: observation.receivedAt, isVatsim: true, observation, metadata: meta }
  })
}

/** vNAS at 1 Hz, receiving 80 ms later, with the 50/80 ft ground hysteresis and silence while parked. */
function vnasObservations(
  f: Flight,
  start: number,
  durationS: number,
  groundEllip: number,
  feed: VnasFeedOptions,
  report: FlightReport,
): Observation[] {
  const out: Observation[] = []
  const meta = { cid: 0, aircraftType: report.aircraftType, transponder: '', departure: null, arrival: null }
  const end = f.samples[f.samples.length - 1].t
  let onGround: boolean | undefined
  for (let tg = Math.ceil(start) + 0.37; tg - f.offset <= end && tg <= durationS; tg += 1) {
    const s = truthAt(f.samples, tg - f.offset) as TruthSample
    const prevS = truthAt(f.samples, tg - f.offset - 2)
    if (s.gs < 1 && prevS && prevS.gs < 1) continue
    onGround = onGround ? s.agl / 0.3048 < 80 : s.agl / 0.3048 < 50
    const observation = makeObservation(f, tg, 'vnas', feed.withGroundFlag ? onGround : null, groundEllip, report)
    if (feed.withHeight) {
      const jittered = Math.max(0, s.agl + (out.length % 2 === 0 ? -feed.jitterM : feed.jitterM))
      observation.heightAboveGround = jittered + report.restM
    } else {
      delete observation.heightAboveGround
    }
    observation.receivedAt = observation.observedAt + 80
    out.push({ callsign: f.callsign, receivedAt: observation.receivedAt, isVatsim: false, observation, metadata: meta })
  }
  return out
}

function buildObservations(flights: Flight[], opts: ScenarioOptions, groundEllip: number): Observation[] {
  const out: Observation[] = []
  for (const f of flights) {
    const aircraftType = opts.aircraftTypes?.[f.callsign] ?? 'B738'
    const restFt = opts.restingByCallsignFt?.[f.callsign] ?? opts.restingHeightsFt?.[aircraftType] ?? 0
    const report: FlightReport = { aircraftType, restM: restFt * 0.3048 }
    const times = vatsimTimes(f, opts.durationS)
    const vnasFirstStart = opts.useVnas && opts.vnasFirst ? f.offset + 5 : 0
    const vatsimStart = Math.max(vnasFirstStart, opts.vatsimFromS?.[f.callsign] ?? 0)
    out.push(
      ...vatsimObservations(
        f,
        times.filter((tg) => tg >= vatsimStart),
        groundEllip,
        report,
      ),
    )
    if (opts.useVnas) {
      const firstVatsim = times[0] ?? f.offset
      const start = Math.max(opts.vnasFirst ? f.offset : firstVatsim + 20, opts.vnasFromS?.[f.callsign] ?? 0)
      const feed: VnasFeedOptions = {
        jitterM: opts.vnasHeightJitterM ?? 0,
        withHeight: !opts.vnasWithoutHeight,
        withGroundFlag: !opts.vnasWithoutGroundFlag,
      }
      out.push(...vnasObservations(f, start, opts.durationS, groundEllip, feed, report))
    }
  }
  out.sort((a, b) => a.receivedAt - b.receivedAt)
  return out
}

function buildRunwayContext(runwayThr: { x: number; y: number }, fieldBelowGroundFt: number): SortContext {
  const thr = toLatLon(runwayThr.x, runwayThr.y)
  const far = toLatLon(runwayThr.x + 3000, runwayThr.y)
  return {
    airportLat: LAT0,
    airportLon: LON0,
    airportElevationFt: GROUND_MSL * 3.28084 - fieldBelowGroundFt,
    icao: 'KOAK',
    runways: [
      {
        ident: '09/27',
        lowEnd: { ident: '09', lat: thr.lat, lon: thr.lon, headingTrue: 90, elevationFt: 10, displacedThresholdFt: 0 },
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
}

/** Flat terrain under every aircraft below 300 m AGL or 40 kt, the gate useGroundAircraftTerrain uses. */
function terrainFor(
  map: AircraftMap,
  groundEllip: number,
  terrainHeight: number,
): Map<string, { height: number; slopeDegrees: number }> {
  const terrain = new Map<string, { height: number; slopeDegrees: number }>()
  for (const e of map.values()) {
    if (e.interpolatedGroundspeed < 40 || e.interpolatedAltitude - groundEllip < 300) {
      terrain.set(e.callsign, { height: terrainHeight, slopeDegrees: 0 })
    }
  }
  return terrain
}

/** Feeds every observation whose receive time has passed; VATSIM in a batch, vNAS one at a time. */
function drainObservations(tl: TimelineModule, observations: Observation[], from: number, now: number): number {
  const batch: Observation[] = []
  let i = from
  while (i < observations.length && observations[i].receivedAt <= now) {
    const o = observations[i++]
    if (o.isVatsim) batch.push(o)
    else tl.useAircraftTimelineStore.getState().addObservation(o.callsign, o.observation, o.metadata)
  }
  if (batch.length > 0) tl.useAircraftTimelineStore.getState().addObservationBatch(batch)
  return i
}

function recordFrame(deps: FrameDeps, feed: FeedState, e: AircraftEntry, now: number): void {
  const flight = deps.flightByCs.get(e.callsign)
  if (!flight) return
  const ts = deps.tl.useAircraftTimelineStore.getState().getInterpolatedState(e.callsign, now)
  if (!ts) return
  const tLocal = (ts.displayTime - T0) / 1000 - flight.offset
  const truth = truthAt(flight.samples, tLocal)
  if (!truth) return

  const { x, y } = toXY(e.interpolatedLatitude, e.interpolatedLongitude)
  const prev = feed.prevXY.get(e.callsign)
  const moved = prev !== undefined && Math.hypot(x - prev.x, y - prev.y) > 0.02
  const motionBearing = moved ? ((Math.atan2(x - prev.x, y - prev.y) * 180) / Math.PI + 360) % 360 : null
  feed.prevXY.set(e.callsign, { x, y })

  // The gear's ground input is the entry's contact, as useAircraftModels passes it
  const onGroundApp = e.inContact === true
  const vrFpm = e.verticalRate * 3.28084
  const aglFtApp =
    deps.gear.gearHeightAboveGroundMeters(
      e.interpolatedAltitude,
      GROUND_MSL,
      e.interpolatedLatitude,
      e.interpolatedLongitude,
    ) * 3.28084
  const aglFtEll = (e.interpolatedAltitude - deps.groundEllip) * 3.28084
  if (!feed.gearInit.has(e.callsign)) {
    feed.gearInit.add(e.callsign)
    deps.gear.initializeGearState(e.callsign, aglFtApp, vrFpm, onGroundApp)
    deps.gear.initializeGearState(`${e.callsign}#ell`, aglFtEll, vrFpm, onGroundApp)
  }

  const surfaces = deps.surface.updateSurfaceAnimation(
    e.callsign,
    deps.surface.surfaceFrameFor(e, deps.surface.wheelRadiusForWingspan(35.78)),
  )

  const list = feed.frames.get(e.callsign) ?? []
  list.push({
    frameTime: (now - T0) / 1000,
    tLocal,
    truth,
    x,
    y,
    agl: e.interpolatedAltitude - deps.groundEllip,
    reportedAgl: e.reportedAltitude - deps.groundEllip,
    heading: e.interpolatedHeading,
    pitch: e.interpolatedPitch,
    roll: e.interpolatedRoll,
    gs: e.interpolatedGroundspeed,
    vsFpm: vrFpm,
    motionBearing,
    isOnGroundEntry: e.isOnGround,
    onGroundTimeline: ts.onGround,
    inContact: e.inContact,
    gearApp: deps.gear.updateGearAnimation(
      e.callsign,
      { altitudeFt: aglFtApp, verticalRateFpm: vrFpm, inContact: onGroundApp, dataTime: e.timestamp },
      now,
    ),
    gearEllipsoidal: deps.gear.updateGearAnimation(
      `${e.callsign}#ell`,
      { altitudeFt: aglFtEll, verticalRateFpm: vrFpm, inContact: onGroundApp, dataTime: e.timestamp },
      now,
    ),
    spoiler: surfaces.spoiler,
    reverser: surfaces.reverser,
    wheelRevPerSec: surfaces.wheelRevPerSec,
    displayDelayMs: ts.displayDelay,
    targetDelayMs: deps.tl.useAircraftTimelineStore.getState().dynamicDelays.get(e.callsign)?.targetDelayMs ?? null,
    extrapolating: ts.isExtrapolating,
  })
  feed.frames.set(e.callsign, list)
}

function samplePhases(smart: SmartModule, context: SortContext, feed: FeedState, map: AircraftMap): void {
  for (const r of smart.calculateSmartSort(Array.from(map.values()), context)) {
    const last = feed.frames.get(r.callsign)?.at(-1)
    if (!last || feed.lastPhase.get(r.callsign) === r.phase) continue
    feed.lastPhase.set(r.callsign, r.phase)
    const list = feed.phases.get(r.callsign) ?? []
    list.push({ tLocal: last.tLocal, phase: r.phase, segment: last.truth.segment })
    feed.phases.set(r.callsign, list)
  }
}

export async function runScenario(opts: ScenarioOptions): Promise<ScenarioResult> {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(T0)
    vi.resetModules()
    // vnasStore registers a removal listener at module init; loading it first resolves the
    // timelineStore <-> replayStore <-> ... <-> vnasStore cycle in the same order the app does.
    await import('@/stores/vnasStore')
    const tl = await import('@/stores/aircraftTimelineStore')
    const vat = await import('@/stores/vatsimStore')
    const interp = await import('@/hooks/useAircraftInterpolation')
    const geo = await import('@/services/GeoidService')
    const gear = await import('@/utils/gearAnimationController')
    const smart = await import('@/utils/smartSort')
    const surface = await import('@/utils/surfaceAnimationController')

    const groundEllip = geo.geoidService.mslToEllipsoidal(LAT0, LON0, GROUND_MSL)
    const terrainHeight = groundEllip + (opts.terrainOffsetM ?? 0)
    const unsampled = opts.unsampledReferenceOffsetM !== undefined
    const { flights, runwayThr } = buildFlights(opts.goAroundFt ?? GO_AROUND_FT, opts.levelPass ?? null)
    const observations = buildObservations(flights, opts, groundEllip)
    const deps: FrameDeps = {
      tl,
      interp,
      gear,
      surface,
      groundEllip,
      flightByCs: new Map(flights.map((f) => [f.callsign, f])),
    }
    const feed: FeedState = {
      frames: new Map(),
      phases: new Map(),
      lastPhase: new Map(),
      gearInit: new Set(),
      prevXY: new Map(),
    }
    const context = buildRunwayContext(runwayThr, opts.fieldElevationBelowGroundFt ?? 0)

    vat.useVatsimStore.setState({ referencePosition: { latitude: LAT0, longitude: LON0 } })
    rafCallback = null
    // biome-ignore lint/correctness/useHookAtTopLevel: this is the interpolation singleton, driven once per scenario outside React
    const map = interp.useAircraftInterpolation()

    let obsIdx = 0
    let nextPhaseAt = 0
    const totalFrames = Math.floor(opts.durationS * opts.fps)
    for (let f = 0; f < totalFrames; f++) {
      const now = T0 + (f * 1000) / opts.fps
      vi.setSystemTime(now)
      obsIdx = drainObservations(tl, observations, obsIdx, now)
      const terrain = unsampled ? new Map() : terrainFor(map, groundEllip, terrainHeight)
      interp.setInterpolationTerrainData(terrain, GROUND_MSL + (opts.unsampledReferenceOffsetM ?? 0))

      const cb = rafCallback as ((t: number) => void) | null
      rafCallback = null
      if (!cb) throw new Error('interpolation loop did not re-arm requestAnimationFrame')
      cb(now)

      for (const e of map.values()) recordFrame(deps, feed, e, now)
      if (now - T0 >= nextPhaseAt) {
        nextPhaseAt += 1000
        samplePhases(smart, context, feed, map)
      }
    }
    return {
      frames: feed.frames,
      phases: feed.phases,
      flights,
      groundEllip,
      geoidN: groundEllip - GROUND_MSL,
    }
  } finally {
    vi.useRealTimers()
  }
}

export { angleDiff }
