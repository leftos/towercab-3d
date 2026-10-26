/**
 * The words the vNAS status shows the user, shared by the TopBar popover and the
 * Settings tab so both read the same.
 */
import type { VnasEnvironment, VnasStatus } from '../types/vnas'

/** The YAAT training servers, where a room fills the wait as well as a CRC session */
const YAAT_ENVIRONMENTS: readonly VnasEnvironment[] = ['yaat1', 'yaatlocal']

/** The label for the connection state; waiting and subscribing read by server and session kind. */
export function getVnasStateLabel(status: Pick<VnasStatus, 'state' | 'environment' | 'sessionKind'>): string {
  switch (status.state) {
    case 'disconnected':
      return 'Disconnected'
    case 'authenticating':
      return 'Authenticating...'
    case 'connecting':
      return 'Connecting...'
    case 'joiningSession':
      return 'Joining Session...'
    case 'waitingForSession':
      return waitingLabel(status.environment)
    case 'subscribing':
      return subscribingLabel(status.sessionKind)
    case 'connected':
      return 'Connected'
    case 'unavailable':
      return 'Not Available'
    default:
      return status.state
  }
}

function waitingLabel(environment: VnasEnvironment): string {
  return YAAT_ENVIRONMENTS.includes(environment) ? 'Waiting for a YAAT room or CRC...' : 'Waiting for CRC...'
}

function subscribingLabel(sessionKind: VnasStatus['sessionKind']): string {
  return sessionKind === 'room' ? 'Joining room...' : 'Ready for vNAS Airport...'
}

/**
 * The subscribed facilities while connected, marked "· room" in a YAAT room session;
 * null when there is no chip to show.
 */
export function getVnasFacilityChip(
  status: Pick<VnasStatus, 'state' | 'subscribedFacilities' | 'sessionKind'>,
): string | null {
  if (status.state !== 'connected' || status.subscribedFacilities.length === 0) {
    return null
  }
  const facilities = status.subscribedFacilities.join(', ')
  return status.sessionKind === 'room' ? `${facilities} · room` : facilities
}

/** What the error line reads after a YAAT room's instructor removed this user. */
export const ROOM_KICK_MESSAGE = 'Removed from the room by the instructor'

/**
 * The error line: the kick message while disconnected by a forcible end (a kick from a
 * YAAT room), else the status error; null when there is nothing to show.
 */
export function getVnasErrorLine(status: Pick<VnasStatus, 'state' | 'error' | 'lastSessionEnd'>): string | null {
  if (status.state === 'disconnected' && status.lastSessionEnd?.forcible) {
    return ROOM_KICK_MESSAGE
  }
  return status.error
}

/**
 * The notice that a YAAT room's airport (`facilityId`, its position id as the server
 * gave it; "" when it names none) has no tower view.
 */
export function getRoomAirportNotice(facilityId: string): string {
  const airport = facilityId === '' ? "the room's airport" : facilityId
  return `No tower view for ${airport}; showing your current airport`
}

/**
 * The dim note under the state label: why the server ended the last session (e.g. "Room
 * closed"), shown only while waiting for the next one. A forcible end shows as the error
 * line instead.
 */
export function getVnasSessionEndNote(status: Pick<VnasStatus, 'state' | 'lastSessionEnd'>): string | null {
  if (status.state !== 'waitingForSession' || !status.lastSessionEnd || status.lastSessionEnd.forcible) {
    return null
  }
  return status.lastSessionEnd.reason
}
