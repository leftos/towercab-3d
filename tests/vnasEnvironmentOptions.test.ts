import { describe, expect, it } from 'vitest'
import { getVnasEnvironmentOptions, mustLeaveYaatLocal } from '../src/renderer/utils/vnasEnvironmentOptions'

describe('getVnasEnvironmentOptions', () => {
  it('offers YAAT Local last when the probe found a server', () => {
    const options = getVnasEnvironmentOptions(true)
    expect(options.map((option) => option.label)).toEqual([
      'Live',
      'Sweatbox 1',
      'Sweatbox 2',
      'Test',
      'YAAT1',
      'YAAT Local',
    ])
    expect(options.map((option) => option.value)).toEqual([
      'live',
      'sweatbox1',
      'sweatbox2',
      'test',
      'yaat1',
      'yaatlocal',
    ])
  })

  it('hides YAAT Local when the probe found no server, and keeps YAAT1', () => {
    const values = getVnasEnvironmentOptions(false).map((option) => option.value)
    expect(values).toEqual(['live', 'sweatbox1', 'sweatbox2', 'test', 'yaat1'])
    expect(values).not.toContain('yaatlocal')
  })
})

describe('mustLeaveYaatLocal', () => {
  it('moves off YAAT Local once the probe says it is unavailable', () => {
    expect(mustLeaveYaatLocal('yaatlocal', false)).toBe(true)
  })

  it('keeps YAAT Local while the probe is running or when it is available', () => {
    expect(mustLeaveYaatLocal('yaatlocal', null)).toBe(false)
    expect(mustLeaveYaatLocal('yaatlocal', true)).toBe(false)
  })

  it('never moves any other environment', () => {
    expect(mustLeaveYaatLocal('live', false)).toBe(false)
    expect(mustLeaveYaatLocal('yaat1', false)).toBe(false)
  })
})
