/**
 * Broadcast Encoder Worker
 *
 * Offloads expensive MessagePack encoding and delta compression from the main thread.
 * This worker receives raw interpolated aircraft data and produces encoded broadcast
 * messages ready for transmission to consumers.
 *
 * Operations handled:
 * - Delta compression (comparing current vs last broadcast state)
 * - MessagePack encoding (binary serialization)
 * - Full sync message generation (for new consumers)
 *
 * The main thread no longer blocks on encoding during the render loop.
 */

import { encode } from '@msgpack/msgpack'
import type {
  AircraftFull,
  AircraftDelta,
  BroadcastMessage,
} from '../types/broadcast'
import { DELTA_THRESHOLDS } from '../types/broadcast'

// Types for worker communication
interface AircraftData {
  callsign: string
  interpolatedLatitude: number
  interpolatedLongitude: number
  interpolatedAltitude: number
  interpolatedHeading: number
  interpolatedGroundspeed: number
  interpolatedPitch: number
  interpolatedRoll: number
  verticalRate: number
  turnRate: number
  acceleration: number
  track: number
  aircraftType: string | null
  departure: string | null
  arrival: string | null
  // Model info for insets to render MSFS models
  modelUrl: string | null
  modelScale: [number, number, number] | null
  rotationOffset: number | null
  isFsltl: boolean | null
}

interface EncodeBroadcastRequest {
  type: 'encode-broadcast'
  requestId: number
  aircraft: AircraftData[]
  timestamp: number
  consumersNeedingFullSync: string[]
}

interface EncodeBroadcastResponse {
  type: 'broadcast-encoded'
  requestId: number
  /** Encoded delta message (null if no changes) */
  deltaEncoded: Uint8Array | null
  /** Encoded full sync message (null if no consumers need it) */
  fullSyncEncoded: Uint8Array | null
  /** Sequence number */
  sequence: number
}

// Worker state
interface AircraftSnapshot {
  la: number
  lo: number
  al: number
  hd: number
  gs: number
  pi: number
  ro: number
  vr: number
  tr: number
  ac: number
  tk: number
  ty: string | null
  dp: string | null
  ar: string | null
  // Model info
  mu: string | null
  sc: [number, number, number] | null
  ro_off: number | null
  fsltl: boolean | null
}

const lastBroadcast = new Map<string, AircraftSnapshot>()
let sequence = 0

/**
 * Quantize a number to a specific number of decimal places.
 */
function quantize(value: number, decimals: number): number {
  const multiplier = Math.pow(10, decimals)
  return Math.round(value * multiplier) / multiplier
}

/**
 * Calculate angle difference handling wraparound (0-360).
 */
function angleDiff(a: number, b: number): number {
  let diff = a - b
  if (diff > 180) diff -= 360
  if (diff < -180) diff += 360
  return Math.abs(diff)
}

/**
 * Convert aircraft data to full broadcast format.
 */
function toFull(aircraft: AircraftData): AircraftFull {
  return {
    c: aircraft.callsign,
    la: quantize(aircraft.interpolatedLatitude, 6),
    lo: quantize(aircraft.interpolatedLongitude, 6),
    al: Math.round(aircraft.interpolatedAltitude),
    hd: quantize(aircraft.interpolatedHeading, 1),
    gs: quantize(aircraft.interpolatedGroundspeed, 1),
    pi: quantize(aircraft.interpolatedPitch, 1),
    ro: quantize(aircraft.interpolatedRoll, 1),
    vr: Math.round(aircraft.verticalRate),
    tr: quantize(aircraft.turnRate, 1),
    ac: quantize(aircraft.acceleration, 1),
    tk: quantize(aircraft.track, 1),
    ty: aircraft.aircraftType ?? null,
    dp: aircraft.departure ?? null,
    ar: aircraft.arrival ?? null,
    // Model info for insets
    mu: aircraft.modelUrl ?? null,
    sc: aircraft.modelScale ?? null,
    ro_off: aircraft.rotationOffset ?? null,
    fsltl: aircraft.isFsltl ?? null,
  }
}

/**
 * Convert aircraft data to delta format (only changed fields).
 */
function toDelta(aircraft: AircraftData, last: AircraftSnapshot): AircraftDelta | null {
  const delta: AircraftDelta = { c: aircraft.callsign }
  let hasChanges = false

  const la = quantize(aircraft.interpolatedLatitude, 6)
  if (Math.abs(la - last.la) > DELTA_THRESHOLDS.position) {
    delta.la = la
    hasChanges = true
  }

  const lo = quantize(aircraft.interpolatedLongitude, 6)
  if (Math.abs(lo - last.lo) > DELTA_THRESHOLDS.position) {
    delta.lo = lo
    hasChanges = true
  }

  const al = Math.round(aircraft.interpolatedAltitude)
  if (Math.abs(al - last.al) > DELTA_THRESHOLDS.altitude) {
    delta.al = al
    hasChanges = true
  }

  const hd = quantize(aircraft.interpolatedHeading, 1)
  if (angleDiff(hd, last.hd) > DELTA_THRESHOLDS.angle) {
    delta.hd = hd
    hasChanges = true
  }

  const gs = quantize(aircraft.interpolatedGroundspeed, 1)
  if (Math.abs(gs - last.gs) > DELTA_THRESHOLDS.speed) {
    delta.gs = gs
    hasChanges = true
  }

  const pi = quantize(aircraft.interpolatedPitch, 1)
  if (Math.abs(pi - last.pi) > DELTA_THRESHOLDS.angle) {
    delta.pi = pi
    hasChanges = true
  }

  const ro = quantize(aircraft.interpolatedRoll, 1)
  if (Math.abs(ro - last.ro) > DELTA_THRESHOLDS.angle) {
    delta.ro = ro
    hasChanges = true
  }

  const vr = Math.round(aircraft.verticalRate)
  if (Math.abs(vr - last.vr) > DELTA_THRESHOLDS.verticalRate) {
    delta.vr = vr
    hasChanges = true
  }

  const tr = quantize(aircraft.turnRate, 1)
  if (Math.abs(tr - last.tr) > DELTA_THRESHOLDS.turnRate) {
    delta.tr = tr
    hasChanges = true
  }

  const ac = quantize(aircraft.acceleration, 1)
  if (Math.abs(ac - last.ac) > DELTA_THRESHOLDS.acceleration) {
    delta.ac = ac
    hasChanges = true
  }

  const tk = quantize(aircraft.track, 1)
  if (angleDiff(tk, last.tk) > DELTA_THRESHOLDS.angle) {
    delta.tk = tk
    hasChanges = true
  }

  // Metadata rarely changes
  const ty = aircraft.aircraftType ?? null
  if (ty !== last.ty) {
    delta.ty = ty
    hasChanges = true
  }

  const dp = aircraft.departure ?? null
  if (dp !== last.dp) {
    delta.dp = dp
    hasChanges = true
  }

  const ar = aircraft.arrival ?? null
  if (ar !== last.ar) {
    delta.ar = ar
    hasChanges = true
  }

  // Model info - only include if changed
  const mu = aircraft.modelUrl ?? null
  if (mu !== last.mu) {
    delta.mu = mu
    hasChanges = true
  }

  const sc = aircraft.modelScale ?? null
  if (
    sc !== null && last.sc !== null &&
    (sc[0] !== last.sc[0] || sc[1] !== last.sc[1] || sc[2] !== last.sc[2])
  ) {
    delta.sc = sc
    hasChanges = true
  } else if ((sc === null) !== (last.sc === null)) {
    delta.sc = sc
    hasChanges = true
  }

  const ro_off = aircraft.rotationOffset ?? null
  if (ro_off !== last.ro_off) {
    delta.ro_off = ro_off
    hasChanges = true
  }

  const fsltl = aircraft.isFsltl ?? null
  if (fsltl !== last.fsltl) {
    delta.fsltl = fsltl
    hasChanges = true
  }

  return hasChanges ? delta : null
}

/**
 * Build delta broadcast message.
 */
function buildDeltaMessage(aircraft: AircraftData[], timestamp: number): BroadcastMessage | null {
  const full: AircraftFull[] = []
  const deltas: AircraftDelta[] = []
  const removed: string[] = []
  const currentCallsigns = new Set<string>()

  for (const ac of aircraft) {
    currentCallsigns.add(ac.callsign)
    const last = lastBroadcast.get(ac.callsign)

    if (!last) {
      // New aircraft - send full state
      full.push(toFull(ac))
    } else {
      // Existing aircraft - send delta if changed
      const delta = toDelta(ac, last)
      if (delta) deltas.push(delta)
    }
  }

  // Find removed aircraft
  for (const callsign of lastBroadcast.keys()) {
    if (!currentCallsigns.has(callsign)) {
      removed.push(callsign)
    }
  }

  // Skip if nothing changed
  if (full.length === 0 && deltas.length === 0 && removed.length === 0) {
    return null
  }

  return {
    seq: sequence + 1,
    t: timestamp,
    f: full,
    d: deltas,
    r: removed,
  }
}

/**
 * Build full sync message with all aircraft.
 */
function buildFullSyncMessage(aircraft: AircraftData[], timestamp: number): BroadcastMessage {
  const full: AircraftFull[] = aircraft.map(toFull)
  return {
    seq: sequence + 1,
    t: timestamp,
    f: full,
    d: [],
    r: [],
  }
}

/**
 * Update last broadcast state after encoding.
 */
function updateLastBroadcast(aircraft: AircraftData[]): void {
  const currentCallsigns = new Set<string>()

  for (const ac of aircraft) {
    currentCallsigns.add(ac.callsign)
    lastBroadcast.set(ac.callsign, {
      la: quantize(ac.interpolatedLatitude, 6),
      lo: quantize(ac.interpolatedLongitude, 6),
      al: Math.round(ac.interpolatedAltitude),
      hd: quantize(ac.interpolatedHeading, 1),
      gs: quantize(ac.interpolatedGroundspeed, 1),
      pi: quantize(ac.interpolatedPitch, 1),
      ro: quantize(ac.interpolatedRoll, 1),
      vr: Math.round(ac.verticalRate),
      tr: quantize(ac.turnRate, 1),
      ac: quantize(ac.acceleration, 1),
      tk: quantize(ac.track, 1),
      ty: ac.aircraftType ?? null,
      dp: ac.departure ?? null,
      ar: ac.arrival ?? null,
      // Model info
      mu: ac.modelUrl ?? null,
      sc: ac.modelScale ?? null,
      ro_off: ac.rotationOffset ?? null,
      fsltl: ac.isFsltl ?? null,
    })
  }

  // Remove aircraft no longer present
  for (const callsign of lastBroadcast.keys()) {
    if (!currentCallsigns.has(callsign)) {
      lastBroadcast.delete(callsign)
    }
  }
}

/**
 * Handle encode broadcast request.
 */
function handleEncodeBroadcast(request: EncodeBroadcastRequest): void {
  const { requestId, aircraft, timestamp, consumersNeedingFullSync } = request

  // Build delta message
  const deltaMessage = buildDeltaMessage(aircraft, timestamp)
  const deltaEncoded = deltaMessage ? encode(deltaMessage) : null

  // Build full sync if any consumers need it
  let fullSyncEncoded: Uint8Array | null = null
  if (consumersNeedingFullSync.length > 0) {
    const fullSyncMessage = buildFullSyncMessage(aircraft, timestamp)
    fullSyncEncoded = encode(fullSyncMessage)
  }

  sequence++
  updateLastBroadcast(aircraft)

  // Send response back to main thread
  const response: EncodeBroadcastResponse = {
    type: 'broadcast-encoded',
    requestId,
    deltaEncoded,
    fullSyncEncoded,
    sequence,
  }

  // Use transferable objects for efficiency
  const transferables: Transferable[] = []
  if (deltaEncoded) transferables.push(deltaEncoded.buffer)
  if (fullSyncEncoded) transferables.push(fullSyncEncoded.buffer)

  self.postMessage(response, transferables)
}

// Message handler
self.onmessage = (event: MessageEvent) => {
  const message = event.data

  switch (message.type) {
    case 'encode-broadcast':
      handleEncodeBroadcast(message as EncodeBroadcastRequest)
      break

    case 'reset':
      // Reset state (e.g., when switching airports)
      lastBroadcast.clear()
      sequence = 0
      break
  }
}

export {}
