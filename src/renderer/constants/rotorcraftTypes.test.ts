import { describe, expect, it } from 'vitest'
import { isRotorcraftType, ROTORCRAFT_TYPES } from '@/constants'

// The designators generate-rotorcraft-types.py takes from yaat's AircraftSpecs.json
const GENERATED_COUNT = 226

describe('isRotorcraftType', () => {
  it.each([
    ['R22', 'a helicopter'],
    ['H47', 'an H-coded helicopter designator'],
    ['XNON', 'a gyrocopter'],
    ['V22', 'a tiltrotor'],
  ])('%s, %s, is a rotorcraft', (type) => {
    expect(isRotorcraftType(type)).toBe(true)
  })

  it.each([['B77L'], [''], [null], [undefined]])('%s is not a rotorcraft', (type) => {
    expect(isRotorcraftType(type)).toBe(false)
  })

  it(`holds the ${GENERATED_COUNT} designators the script generated`, () => {
    expect(ROTORCRAFT_TYPES.size).toBe(GENERATED_COUNT)
  })
})
