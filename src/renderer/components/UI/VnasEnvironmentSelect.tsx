/**
 * vNAS Environment Select
 *
 * The environment picker shared by every vNAS connect UI. It probes the configured
 * YAAT Local URL and offers YAAT Local only when a YAAT dev server answers there.
 */

import type { CSSProperties } from 'react'
import { useEffect, useState } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import type { VnasEnvironment } from '../../types/vnas'
import { isRemoteMode } from '../../utils/remoteMode'
import { getVnasEnvironmentOptions, mustLeaveYaatLocal } from '../../utils/vnasEnvironmentOptions'

interface VnasEnvironmentSelectProps {
  value: VnasEnvironment
  onChange: (environment: VnasEnvironment) => void
  className?: string
  style?: CSSProperties
}

/**
 * Ask the host whether a YAAT dev server answers at the URL.
 *
 * @param url - The configured YAAT Local URL
 * @returns True when the host found a YAAT dev server with VATSIM auth off
 */
async function probeYaatLocal(url: string): Promise<boolean> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const result = await invoke<{ available: boolean }>('vnas_probe_yaat_local', { url })
    return result.available
  } catch (error) {
    console.warn(`[vNAS] YAAT Local probe of ${url} failed:`, error)
    return false
  }
}

export function VnasEnvironmentSelect({ value, onChange, className, style }: VnasEnvironmentSelectProps) {
  const yaatLocalUrl = useSettingsStore((state) => state.vnas.yaatLocalUrl)
  // null while the probe runs; remote browsers never probe, since vNAS sign-in is host-only
  const [yaatLocalAvailable, setYaatLocalAvailable] = useState<boolean | null>(isRemoteMode() ? false : null)

  useEffect(() => {
    if (isRemoteMode()) return
    let cancelled = false
    setYaatLocalAvailable(null)
    probeYaatLocal(yaatLocalUrl).then((available) => {
      if (!cancelled) setYaatLocalAvailable(available)
    })
    return () => {
      cancelled = true
    }
  }, [yaatLocalUrl])

  useEffect(() => {
    if (mustLeaveYaatLocal(value, yaatLocalAvailable)) {
      onChange('live')
    }
  }, [value, yaatLocalAvailable, onChange])

  const options = getVnasEnvironmentOptions(yaatLocalAvailable === true)

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as VnasEnvironment)}
      className={className}
      style={style}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}
