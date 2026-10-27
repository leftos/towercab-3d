/**
 * Landing gear animation types, used by `utils/gearAnimationController.ts` and its callers.
 */

/** Ground contact as the gear rule sees it */
export interface GearContact {
  /** Whether the aircraft is in ground contact */
  inContact: boolean
  /** Seconds since the aircraft was last in contact, or null when it has not been in contact since it was drawn */
  secondsSinceContact: number | null
}

/** One frame of aircraft state for the gear */
export interface GearFrameInput {
  /** Altitude in feet AGL */
  altitudeFt: number
  /** Vertical rate in feet per minute (positive = climbing) */
  verticalRateFpm: number
  /** Whether the aircraft is in ground contact */
  inContact: boolean
  /** Data-source time of this frame in milliseconds, the clock the time out of contact is counted on */
  dataTime: number
}
