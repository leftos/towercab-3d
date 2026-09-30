/**
 * Which vNAS environments the picker offers.
 *
 * Pure functions, so the picker's decisions are testable without Tauri or React.
 */

import { VNAS_ENVIRONMENT_OPTIONS, type VnasEnvironmentOption } from '../constants/vnas'
import type { VnasEnvironment } from '../types/vnas'

/**
 * The environments the picker offers, in display order.
 *
 * @param yaatLocalAvailable - Whether a YAAT dev server answered at the configured YAAT Local URL
 * @returns Every environment, with YAAT Local only when it was detected
 */
export function getVnasEnvironmentOptions(yaatLocalAvailable: boolean): VnasEnvironmentOption[] {
  return VNAS_ENVIRONMENT_OPTIONS.filter((option) => option.value !== 'yaatlocal' || yaatLocalAvailable)
}

/**
 * Whether the picker must move its value off YAAT Local because the option is no longer offered.
 *
 * @param value - The picker's current value
 * @param yaatLocalAvailable - The probe result, or null while the probe is still running
 * @returns True when the value is YAAT Local and the probe said it is unavailable
 */
export function mustLeaveYaatLocal(value: VnasEnvironment, yaatLocalAvailable: boolean | null): boolean {
  return value === 'yaatlocal' && yaatLocalAvailable === false
}
