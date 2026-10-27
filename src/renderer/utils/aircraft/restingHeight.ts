/**
 * Resting height per aircraft and per aircraft type, learned from vNAS.
 *
 * vNAS reports the height above ground of a reference point, not of the wheels, so an aircraft standing on the
 * ground reads a steady height near its resting height, which differs by type and by simulator. Each vNAS sample of a
 * slow aircraft low over the ground is a sample of that aircraft's resting height and of its type's; once either has
 * enough samples its resting height is their median. An aircraft is drawn by its own resting height, by its type's
 * until it has learned its own. An aircraft's own value lives as long as its timeline (`forgetCallsign`); the type
 * table is kept for the session.
 */

import {
  RESTING_HEIGHT_MAX_GROUNDSPEED_KTS,
  RESTING_HEIGHT_MAX_SAMPLE_METERS,
  RESTING_HEIGHT_MIN_SAMPLE_METERS,
  RESTING_HEIGHT_MIN_SAMPLES,
  RESTING_HEIGHT_SAMPLE_WINDOW,
} from '@/constants'
import type { AircraftDataSource } from '@/types/aircraft-timeline'

/** Type codes that name no type and never key the table */
const PLACEHOLDER_TYPES = new Set(['', 'UNKN', 'ZZZZ'])

/** The newest qualifying samples per normalized type code, oldest first (metres) */
const samplesByType = new Map<string, number[]>()

/** The learned resting height per normalized type code (metres): the median of its samples, once it has enough */
const restByType = new Map<string, number>()

/** The newest qualifying samples per normalized callsign, oldest first (metres) */
const samplesByCallsign = new Map<string, number[]>()

/** The learned resting height per normalized callsign (metres): the median of its samples, once it has enough */
const restByCallsign = new Map<string, number>()

/** The table key for a type code, or null for a missing or placeholder type. */
function typeKey(type: string | null | undefined): string | null {
  if (type === null || type === undefined) return null
  const key = type.trim().toUpperCase()
  return PLACEHOLDER_TYPES.has(key) ? null : key
}

/**
 * Whether `next` names a different type than `previous`: both name a type (neither missing nor a placeholder) and their
 * keys differ, so a case or whitespace difference, or a type named for the first time, is no change.
 */
export function isRestingTypeChange(previous: string | null | undefined, next: string | null | undefined): boolean {
  const before = typeKey(previous)
  const after = typeKey(next)
  return before !== null && after !== null && before !== after
}

/** The table key for a callsign, or null for a blank one. */
function callsignKey(callsign: string): string | null {
  const key = callsign.trim().toUpperCase()
  return key === '' ? null : key
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * Whether an observation is a resting-height sample: a vNAS sample with a height above ground from
 * RESTING_HEIGHT_MIN_SAMPLE_METERS to RESTING_HEIGHT_MAX_SAMPLE_METERS, under RESTING_HEIGHT_MAX_GROUNDSPEED_KTS.
 */
function qualifies(heightM: number | undefined, groundspeedKt: number, source: AircraftDataSource): heightM is number {
  return (
    source === 'vnas' &&
    heightM !== undefined &&
    Number.isFinite(heightM) &&
    heightM >= RESTING_HEIGHT_MIN_SAMPLE_METERS &&
    heightM <= RESTING_HEIGHT_MAX_SAMPLE_METERS &&
    groundspeedKt < RESTING_HEIGHT_MAX_GROUNDSPEED_KTS
  )
}

/** Add a sample to one key's window and learn the median once the window holds enough. */
function addSample(samplesByKey: Map<string, number[]>, restByKey: Map<string, number>, key: string, heightM: number) {
  const samples = samplesByKey.get(key) ?? []
  samples.push(heightM)
  if (samples.length > RESTING_HEIGHT_SAMPLE_WINDOW) samples.shift()
  samplesByKey.set(key, samples)
  if (samples.length >= RESTING_HEIGHT_MIN_SAMPLES) restByKey.set(key, median(samples))
}

/**
 * Record one observation as a resting-height sample of its aircraft and of its type when it qualifies: a vNAS sample
 * with a height above ground from RESTING_HEIGHT_MIN_SAMPLE_METERS to RESTING_HEIGHT_MAX_SAMPLE_METERS, under
 * RESTING_HEIGHT_MAX_GROUNDSPEED_KTS. A placeholder type feeds only the aircraft's own samples.
 *
 * @param callsign - The aircraft's callsign
 * @param type - The aircraft type code as the metadata carries it
 * @param heightM - The raw height above ground the source reports (metres), undefined when it reports none
 * @param groundspeedKt - The observation's groundspeed (kt)
 * @param source - The observation's source
 */
export function recordRestingSample(
  callsign: string,
  type: string | null | undefined,
  heightM: number | undefined,
  groundspeedKt: number,
  source: AircraftDataSource,
): void {
  if (!qualifies(heightM, groundspeedKt, source)) return
  const ownKey = callsignKey(callsign)
  if (ownKey !== null) addSample(samplesByCallsign, restByCallsign, ownKey, heightM)
  const key = typeKey(type)
  if (key !== null) addSample(samplesByType, restByType, key, heightM)
}

/**
 * The resting height an aircraft is drawn by (metres): the median of its own last RESTING_HEIGHT_SAMPLE_WINDOW
 * samples once it has RESTING_HEIGHT_MIN_SAMPLES, else its type's likewise.
 *
 * @returns The resting height, or null while neither the aircraft nor its type has learned one
 */
export function restingHeightFor(callsign: string, type: string | null | undefined): number | null {
  const ownKey = callsignKey(callsign)
  const own = ownKey === null ? undefined : restByCallsign.get(ownKey)
  if (own !== undefined) return own
  const key = typeKey(type)
  if (key === null) return null
  return restByType.get(key) ?? null
}

/**
 * Height above ground over the aircraft's resting height (`restingHeightFor`): the raw height less the resting height.
 *
 * @returns The height over rest (metres), or null while neither the aircraft nor its type has learned one
 */
export function heightOverRest(callsign: string, type: string | null | undefined, heightM: number): number | null {
  const rest = restingHeightFor(callsign, type)
  return rest === null ? null : heightM - rest
}

/** Forget an aircraft's own samples and resting height, as when its timeline is removed or its type changes. */
export function forgetCallsign(callsign: string): void {
  const key = callsignKey(callsign)
  if (key === null) return
  samplesByCallsign.delete(key)
  restByCallsign.delete(key)
}

/** Forget every learned resting height. Tests only: the type table is kept for the session. */
export function resetRestingHeightsForTests(): void {
  samplesByType.clear()
  restByType.clear()
  samplesByCallsign.clear()
  restByCallsign.clear()
}
