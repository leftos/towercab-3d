// @vitest-environment node
/**
 * Which glTF animation clips gear progress drives: retraction clips, not the nose-wheel steering clips that MSFS
 * models also name with GEAR (finding 4.1).
 */
import { expect, it } from 'vitest'
import { isGearClip } from '@/utils/gltfAnimationParser'

it.each([
  ['GEAR_ANIM', true],
  ['gear_retract', true],
  ['LANDING_GEAR', true],
  ['GEAR_STEER', false],
  ['NoseGearSteering', false],
  ['STEER_GEAR_L', false],
  ['FLAPS', false],
  ['SPOILER', false],
])('4.1 isGearClip(%s) is %s (TC3D-49)', (name, expected) => {
  expect(isGearClip(name)).toBe(expected)
})
