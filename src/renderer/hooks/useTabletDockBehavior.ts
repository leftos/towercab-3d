import { useEffect, useRef } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { useMatchMedia } from './useMatchMedia'

/**
 * Tablet width threshold below which the aircraft panel auto-collapses to
 * its edge-dock strip. Picked between the existing 1049/1199 ControlsBar
 * breakpoints so iPad-Pro-landscape (1366px) stays "desktop" and
 * iPad-portrait (1024px) becomes "tablet".
 */
export const TABLET_BREAKPOINT_PX = 1100

/**
 * Module-level session flag for "user manually toggled the dock state during
 * the current tablet stretch." Set by `markAircraftPanelDockUserOverride()`
 * (called from the panel's collapse button and the dock strip's expand
 * button), cleared by `useTabletDockBehavior` on `tablet → desktop`. Module
 * scope is intentional: the hook mounts once in App.tsx but the override
 * signal originates in sibling components, so a per-instance ref wouldn't
 * be visible to the toggling components.
 */
let userOverrodeAutoCollapse = false

export function markAircraftPanelDockUserOverride(): void {
  userOverrodeAutoCollapse = true
}

/**
 * Drives the auto-collapse-on-tablet behaviour for the aircraft panel.
 *
 * Behaviour:
 * - On first mount in tablet range: flip `aircraftPanelEdgeDocked` to true.
 * - On `desktop → tablet` transition: flip to true, unless the user has
 *   overridden during the current tablet session.
 * - On `tablet → desktop` transition: clear the override flag and force
 *   `aircraftPanelEdgeDocked` to false (the dock UI is wrong at desktop
 *   sizes).
 *
 * Mount this once near the React root. Components that toggle the dock
 * state manually must call `markAircraftPanelDockUserOverride()` so the
 * next viewport-driven auto-collapse is suppressed.
 */
export function useTabletDockBehavior(): { isTablet: boolean } {
  const isTablet = useMatchMedia(`(max-width: ${TABLET_BREAKPOINT_PX}px)`)
  const updateUISettings = useSettingsStore((state) => state.updateUISettings)
  const prevTabletRef = useRef(isTablet)
  const initRef = useRef(false)

  useEffect(() => {
    const wasTablet = prevTabletRef.current
    const justInitialized = !initRef.current
    initRef.current = true

    if (justInitialized) {
      if (isTablet) {
        updateUISettings({ aircraftPanelEdgeDocked: true })
      }
      prevTabletRef.current = isTablet
      return
    }

    if (!wasTablet && isTablet) {
      if (!userOverrodeAutoCollapse) {
        updateUISettings({ aircraftPanelEdgeDocked: true })
      }
    } else if (wasTablet && !isTablet) {
      userOverrodeAutoCollapse = false
      updateUISettings({ aircraftPanelEdgeDocked: false })
    }
    prevTabletRef.current = isTablet
  }, [isTablet, updateUISettings])

  return { isTablet }
}
