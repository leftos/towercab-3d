import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AerodromeBoundary, AerodromeData, AerodromeRing } from '@/types/aerodromes'
import { AerodromeService, aerodromeService, pointInBoundary } from './AerodromeService'

/** A closed axis-aligned ring, counter-clockwise, as the data file holds it: [lon, lat] pairs. */
function square(west: number, south: number, east: number, north: number): AerodromeRing {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ]
}

const AIRPORT = square(0, 0, 10, 10)

/** A reply holding one airport whose boundary is `AIRPORT`. */
const DATA: AerodromeData = {
  _meta: { generator: 'test', licence: 'test', source: 'test' },
  airports: { KSFO: { p: [AIRPORT] } },
}

function jsonReply(): Response {
  return new Response(JSON.stringify(DATA), { status: 200 })
}

/** Makes the service take the remote path, with `fetch` answering from `fetchSpy`. */
function stubRemote(fetchSpy: ReturnType<typeof vi.fn<typeof fetch>>): void {
  vi.stubGlobal('window', {})
  vi.stubGlobal('fetch', fetchSpy)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('aerodrome boundaries', () => {
  it('inside an outer ring', () => {
    expect(pointInBoundary({ p: [AIRPORT] }, 5, 5)).toBe(true)
  })

  it('outside every ring', () => {
    expect(pointInBoundary({ p: [AIRPORT] }, 15, 5)).toBe(false)
    expect(pointInBoundary({ p: [AIRPORT] }, -1, -1)).toBe(false)
  })

  it('inside a hole is outside', () => {
    const boundary: AerodromeBoundary = { p: [AIRPORT], h: [square(4, 4, 6, 6)] }
    expect(pointInBoundary(boundary, 5, 5)).toBe(false)
    expect(pointInBoundary(boundary, 2, 2)).toBe(true)
  })

  it('a second outer ring counts', () => {
    const boundary: AerodromeBoundary = { p: [AIRPORT, square(20, 20, 30, 30)] }
    expect(pointInBoundary(boundary, 25, 25)).toBe(true)
    expect(pointInBoundary(boundary, 15, 15)).toBe(false)
  })

  it('an airport with no boundary is false', () => {
    expect(aerodromeService.contains('KXXX', 5, 5)).toBe(false)
  })
})

describe('AerodromeService load and contains', () => {
  it('answers from the loaded boundaries, by upper-cased ICAO code', async () => {
    stubRemote(vi.fn<typeof fetch>(async () => jsonReply()))
    const service = new AerodromeService()

    await service.load()

    expect(service.contains('ksfo', 5, 5)).toBe(true)
    expect(service.contains('KSFO', 15, 5)).toBe(false)
    expect(service.contains('KXXX', 5, 5)).toBe(false)
  })

  it('fetches once for two concurrent loads', async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => jsonReply())
    stubRemote(fetchSpy)
    const service = new AerodromeService()

    await Promise.all([service.load(), service.load()])

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('rejects and logs a failed load, and the next load fetches again', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchSpy = vi.fn<typeof fetch>()
    fetchSpy.mockResolvedValueOnce(new Response('boom', { status: 500, statusText: 'Server error' }))
    fetchSpy.mockResolvedValueOnce(jsonReply())
    stubRemote(fetchSpy)
    const service = new AerodromeService()

    await expect(service.load()).rejects.toThrow('HTTP 500')
    expect(errorLog).toHaveBeenCalled()
    expect(service.contains('KSFO', 5, 5)).toBe(false)

    await service.load()

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(service.contains('KSFO', 5, 5)).toBe(true)
  })
})
