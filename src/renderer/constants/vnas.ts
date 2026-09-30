/**
 * vNAS Constants
 *
 * The environments the vNAS picker can offer, in display order.
 */

import type { VnasEnvironment } from '../types/vnas'

/** One vNAS environment and the label the picker shows for it */
export interface VnasEnvironmentOption {
  value: VnasEnvironment
  label: string
}

/** Every vNAS environment with its picker label, in display order */
export const VNAS_ENVIRONMENT_OPTIONS: readonly VnasEnvironmentOption[] = [
  { value: 'live', label: 'Live' },
  { value: 'sweatbox1', label: 'Sweatbox 1' },
  { value: 'sweatbox2', label: 'Sweatbox 2' },
  { value: 'test', label: 'Test' },
  { value: 'yaat1', label: 'YAAT1' },
  { value: 'yaatlocal', label: 'YAAT Local' },
]
