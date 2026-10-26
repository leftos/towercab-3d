import { describe, expect, it } from 'vitest'
import type { VnasEnvironment, VnasStatus } from '../src/renderer/types/vnas'
import {
  getRoomAirportNotice,
  getVnasErrorLine,
  getVnasFacilityChip,
  getVnasSessionEndNote,
  getVnasStateLabel,
} from '../src/renderer/utils/vnasStatusText'

function status(overrides: Partial<VnasStatus>): VnasStatus {
  return {
    state: 'waitingForSession',
    environment: 'yaat1',
    subscribedFacilities: [],
    error: null,
    available: true,
    lastSessionEnd: null,
    sessionKind: null,
    ...overrides,
  }
}

const YAAT: VnasEnvironment[] = ['yaat1', 'yaatlocal']
const VNAS: VnasEnvironment[] = ['live', 'sweatbox1', 'sweatbox2', 'test']

describe('vNAS status text', () => {
  it('row 1: waits for a YAAT room or CRC on YAAT servers', () => {
    for (const environment of YAAT) {
      expect(getVnasStateLabel(status({ environment })), environment).toBe('Waiting for a YAAT room or CRC...')
    }
  })

  it('keeps "Waiting for CRC..." on Live, Sweatbox and Test', () => {
    for (const environment of VNAS) {
      expect(getVnasStateLabel(status({ environment })), environment).toBe('Waiting for CRC...')
    }
  })

  it('row 2: between rooms, the same label with the last reason as the note', () => {
    const between = status({ lastSessionEnd: { reason: 'Room closed', forcible: false } })
    expect(getVnasStateLabel(between)).toBe('Waiting for a YAAT room or CRC...')
    expect(getVnasSessionEndNote(between)).toBe('Room closed')
    expect(getVnasSessionEndNote(status({}))).toBeNull()
  })

  it('row 3: joining a room while subscribing; a CRC session keeps its label', () => {
    expect(getVnasStateLabel(status({ state: 'subscribing', sessionKind: 'room' }))).toBe('Joining room...')
    expect(getVnasStateLabel(status({ state: 'subscribing', sessionKind: 'crc' }))).toBe('Ready for vNAS Airport...')
    expect(getVnasStateLabel(status({ state: 'subscribing', sessionKind: null }))).toBe('Ready for vNAS Airport...')
  })

  it('row 4: connected in a room marks the facility chip; a CRC session keeps the plain chip', () => {
    const room = status({ state: 'connected', sessionKind: 'room', subscribedFacilities: ['OAK'] })
    expect(getVnasStateLabel(room)).toBe('Connected')
    expect(getVnasFacilityChip(room)).toBe('OAK · room')

    const crc = status({ state: 'connected', sessionKind: 'crc', subscribedFacilities: ['OAK', 'SFO'] })
    expect(getVnasStateLabel(crc)).toBe('Connected')
    expect(getVnasFacilityChip(crc)).toBe('OAK, SFO')
  })

  it('shows no chip before connected or with no facility', () => {
    expect(getVnasFacilityChip(status({ state: 'subscribing', subscribedFacilities: ['OAK'] }))).toBeNull()
    expect(getVnasFacilityChip(status({ state: 'connected', sessionKind: 'room' }))).toBeNull()
  })

  it('row 5: a kick reads as removed by the instructor', () => {
    const kicked = status({
      state: 'disconnected',
      error: 'Removed from the room',
      lastSessionEnd: { reason: 'Removed from the room', forcible: true },
    })
    expect(getVnasStateLabel(kicked)).toBe('Disconnected')
    expect(getVnasErrorLine(kicked)).toBe('Removed from the room by the instructor')
    expect(getVnasSessionEndNote(kicked)).toBeNull()
  })

  it('shows any other error as given', () => {
    expect(getVnasErrorLine(status({ state: 'disconnected', error: 'Connection failed: boom' }))).toBe(
      'Connection failed: boom',
    )
    expect(getVnasErrorLine(status({ state: 'disconnected' }))).toBeNull()
  })

  it('row 6: names the room airport that has no tower view', () => {
    expect(getRoomAirportNotice('XYZ')).toBe('No tower view for XYZ; showing your current airport')
    expect(getRoomAirportNotice('')).toBe("No tower view for the room's airport; showing your current airport")
  })

  it('keeps the other state labels', () => {
    const labels: [VnasStatus['state'], string][] = [
      ['disconnected', 'Disconnected'],
      ['authenticating', 'Authenticating...'],
      ['connecting', 'Connecting...'],
      ['joiningSession', 'Joining Session...'],
      ['unavailable', 'Not Available'],
    ]
    for (const [state, label] of labels) {
      expect(getVnasStateLabel(status({ state }))).toBe(label)
    }
  })
})
