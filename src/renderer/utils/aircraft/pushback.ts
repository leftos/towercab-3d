/**
 * Pushback detection, shared by the flight phase detector and the wheel spin.
 */

import { PUSHBACK_MAX_SPEED_KTS, PUSHBACK_MIN_SPEED_KTS } from '@/constants/flightPhase'
import { headingDifference } from '@/utils/aircraft/geoMath'

/**
 * Whether an aircraft is pushing back: moving between 0.5 kt and pushback speed with its track more than 90° from
 * its heading (backwards, or sideways in a curved push). Below 0.5 kt the track defaults to the heading, so a
 * standing aircraft never reads as pushing back.
 *
 * @param speedKts - Groundspeed in knots
 * @param headingDeg - Heading in degrees
 * @param trackDeg - Ground track (direction of movement) in degrees
 * @returns True when moving backwards
 */
export function isPushingBack(speedKts: number, headingDeg: number, trackDeg: number): boolean {
  if (speedKts <= PUSHBACK_MIN_SPEED_KTS || speedKts >= PUSHBACK_MAX_SPEED_KTS) return false
  return Math.abs(headingDifference(trackDeg, headingDeg)) > 90
}
