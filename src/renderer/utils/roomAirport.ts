/**
 * Where the view goes when a YAAT room session is joined.
 *
 * A room session names one Tower Cab airport as its position id, as the server gives
 * it: an FAA id ("OAK"), an ICAO ("KOAK") or nothing (""). The view follows the room to
 * that airport when the app has it, and otherwise keeps the current airport and tells
 * the user why.
 */
import type { VnasSessionKind } from '../types/vnas'

/** What to do with the current airport once a session is joined. */
export type RoomAirportDecision =
  /** Not a room session on the host: leave the airport to the user */
  | { action: 'none' }
  /** The room is at the current airport already */
  | { action: 'stay' }
  /** Switch the view to the room's airport */
  | { action: 'switch'; icao: string }
  /** The room's airport has no tower view: keep the current airport and say so */
  | { action: 'notice'; facilityId: string }

export interface RoomAirportInput {
  /** The joined session's kind; null when the host has not reported it */
  sessionKind: VnasSessionKind | null
  /** Whether this window is a remote browser, which never follows the room */
  isRemote: boolean
  /** The room session's position id, "" when it names none */
  facilityId: string
  /** Whether the app's airport list has this ICAO */
  hasAirport: (icao: string) => boolean
  /** The current airport's ICAO, null when none is selected */
  currentIcao: string | null
}

/**
 * The ICAO of a room's position id in the airport list: the id as given, else a 3-letter
 * id with a "K" prefix (US airports). Null for an empty id or one the list does not have.
 */
export function roomFacilityToIcao(facilityId: string, hasAirport: (icao: string) => boolean): string | null {
  if (facilityId === '') {
    return null
  }
  if (hasAirport(facilityId)) {
    return facilityId
  }
  const prefixed = `K${facilityId}`
  if (facilityId.length === 3 && hasAirport(prefixed)) {
    return prefixed
  }
  return null
}

/** Decide where the view goes for a joined session (see `RoomAirportDecision`). */
export function decideRoomAirport(input: RoomAirportInput): RoomAirportDecision {
  if (input.sessionKind !== 'room' || input.isRemote) {
    return { action: 'none' }
  }
  const icao = roomFacilityToIcao(input.facilityId, input.hasAirport)
  if (icao === null) {
    return { action: 'notice', facilityId: input.facilityId }
  }
  if (icao === input.currentIcao) {
    return { action: 'stay' }
  }
  return { action: 'switch', icao }
}
