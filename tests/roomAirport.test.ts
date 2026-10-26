import { describe, expect, it } from 'vitest'
import { decideRoomAirport, type RoomAirportInput, roomFacilityToIcao } from '../src/renderer/utils/roomAirport'

const AIRPORTS = new Set(['KOAK', 'KSFO', 'PHNL', 'KABCD'])
const hasAirport = (icao: string) => AIRPORTS.has(icao)

function input(overrides: Partial<RoomAirportInput>): RoomAirportInput {
  return {
    sessionKind: 'room',
    isRemote: false,
    facilityId: 'OAK',
    hasAirport,
    currentIcao: 'KSFO',
    ...overrides,
  }
}

describe('roomFacilityToIcao', () => {
  it('finds a 3-letter id with a K prefix', () => {
    expect(roomFacilityToIcao('OAK', hasAirport)).toBe('KOAK')
  })

  it('finds an id that is already an ICAO as given', () => {
    expect(roomFacilityToIcao('KOAK', hasAirport)).toBe('KOAK')
    expect(roomFacilityToIcao('PHNL', hasAirport)).toBe('PHNL')
  })

  it('has no airport for an empty id', () => {
    expect(roomFacilityToIcao('', hasAirport)).toBeNull()
  })

  it('has no airport for an id not in the list', () => {
    expect(roomFacilityToIcao('XYZ', hasAirport)).toBeNull()
    expect(roomFacilityToIcao('KXYZ', hasAirport)).toBeNull()
  })

  it('adds the K prefix only to a 3-letter id', () => {
    expect(roomFacilityToIcao('AK2', hasAirport)).toBeNull()
    expect(roomFacilityToIcao('SF', hasAirport)).toBeNull()
    // "KABCD" is listed, but a 4-letter id is never K-prefixed
    expect(roomFacilityToIcao('ABCD', hasAirport)).toBeNull()
  })
})

describe('decideRoomAirport', () => {
  it('switches to the room airport when it is listed and not the current one', () => {
    expect(decideRoomAirport(input({ facilityId: 'OAK' }))).toEqual({ action: 'switch', icao: 'KOAK' })
    expect(decideRoomAirport(input({ facilityId: 'KOAK' }))).toEqual({ action: 'switch', icao: 'KOAK' })
  })

  it('switches when no airport is selected yet', () => {
    expect(decideRoomAirport(input({ currentIcao: null }))).toEqual({ action: 'switch', icao: 'KOAK' })
  })

  it('stays when the room airport is already the current one', () => {
    expect(decideRoomAirport(input({ currentIcao: 'KOAK' }))).toEqual({ action: 'stay' })
  })

  it('keeps the airport with a notice when the room airport has no tower view', () => {
    expect(decideRoomAirport(input({ facilityId: 'XYZ' }))).toEqual({ action: 'notice', facilityId: 'XYZ' })
  })

  it('keeps the airport with a notice when the room names no airport', () => {
    expect(decideRoomAirport(input({ facilityId: '' }))).toEqual({ action: 'notice', facilityId: '' })
  })

  it('does nothing for a CRC session or with no session kind', () => {
    expect(decideRoomAirport(input({ sessionKind: 'crc' }))).toEqual({ action: 'none' })
    expect(decideRoomAirport(input({ sessionKind: 'crc', facilityId: '' }))).toEqual({ action: 'none' })
    expect(decideRoomAirport(input({ sessionKind: null }))).toEqual({ action: 'none' })
  })

  it('does nothing in a remote browser', () => {
    expect(decideRoomAirport(input({ isRemote: true }))).toEqual({ action: 'none' })
    expect(decideRoomAirport(input({ isRemote: true, facilityId: '' }))).toEqual({ action: 'none' })
  })
})
