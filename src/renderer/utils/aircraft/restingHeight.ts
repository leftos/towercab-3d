/**
 * Resting height per aircraft type, learned from vNAS for the session.
 *
 * vNAS reports the height above ground of a reference point, not of the wheels, so a type standing on the ground
 * reads a steady 6 to 14 ft. Each vNAS sample of a slow aircraft low over the ground is a sample of its type's
 * resting height; once a type has enough samples its resting height is their median, shared by every aircraft of
 * that type. The table is kept for the session: clearing or removing timelines leaves it.
 */

import {
  RESTING_HEIGHT_MAX_GROUNDSPEED_KTS,
  RESTING_HEIGHT_MAX_SAMPLE_METERS,
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

/** The table key for a type code, or null for a missing or placeholder type. */
function typeKey(type: string | null | undefined): string | null {
  if (type === null || type === undefined) return null
  const key = type.trim().toUpperCase()
  return PLACEHOLDER_TYPES.has(key) ? null : key
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * Whether an observation is a resting-height sample: a vNAS sample with a height above ground under
 * RESTING_HEIGHT_MAX_SAMPLE_METERS, under RESTING_HEIGHT_MAX_GROUNDSPEED_KTS.
 */
function qualifies(heightM: number | undefined, groundspeedKt: number, source: AircraftDataSource): heightM is number {
  return (
    source === 'vnas' &&
    heightM !== undefined &&
    Number.isFinite(heightM) &&
    heightM < RESTING_HEIGHT_MAX_SAMPLE_METERS &&
    groundspeedKt < RESTING_HEIGHT_MAX_GROUNDSPEED_KTS
  )
}

/**
 * Record one observation as a resting-height sample of its type when it qualifies: a vNAS sample with a height
 * above ground under RESTING_HEIGHT_MAX_SAMPLE_METERS, under RESTING_HEIGHT_MAX_GROUNDSPEED_KTS, of a named type.
 *
 * @param type - The aircraft type code as the metadata carries it
 * @param heightM - The raw height above ground the source reports (metres), undefined when it reports none
 * @param groundspeedKt - The observation's groundspeed (kt)
 * @param source - The observation's source
 */
export function recordRestingSample(
  type: string | null | undefined,
  heightM: number | undefined,
  groundspeedKt: number,
  source: AircraftDataSource,
): void {
  const key = typeKey(type)
  if (key === null || !qualifies(heightM, groundspeedKt, source)) return
  const samples = samplesByType.get(key) ?? []
  samples.push(heightM)
  if (samples.length > RESTING_HEIGHT_SAMPLE_WINDOW) samples.shift()
  samplesByType.set(key, samples)
  if (samples.length >= RESTING_HEIGHT_MIN_SAMPLES) restByType.set(key, median(samples))
}

/**
 * The learned resting height of a type (metres): the median of its last RESTING_HEIGHT_SAMPLE_WINDOW samples.
 *
 * @returns The resting height, or null until the type has RESTING_HEIGHT_MIN_SAMPLES samples
 */
export function restingHeightFor(type: string | null | undefined): number | null {
  const key = typeKey(type)
  if (key === null) return null
  return restByType.get(key) ?? null
}

/**
 * Height above ground over the type's resting height: the raw height less the resting height.
 *
 * @returns The height over rest (metres), or null while the type's resting height is not learned
 */
export function heightOverRest(type: string | null | undefined, heightM: number): number | null {
  const rest = restingHeightFor(type)
  return rest === null ? null : heightM - rest
}

/** Forget every learned resting height. Tests only: the table is kept for the session. */
export function resetRestingHeightsForTests(): void {
  samplesByType.clear()
  restByType.clear()
}
