/**
 * Datablock Position Store
 *
 * Manages datablock (aircraft label) positioning state:
 * - Per-aircraft position overrides (session-only, not persisted)
 * - Pending direction for input mode (user typed 1-9, waiting for Enter or click)
 *
 * Position mapping (numpad style):
 *   7=top-left    8=top-center    9=top-right
 *   4=left        (5=reference)   6=right
 *   1=bottom-left 2=bottom-center 3=bottom-right
 *
 * Note: 5 is not a valid position - it's the center reference point
 */

import { create } from 'zustand'

/** Numpad-style position (1-9, excluding 5 which is center reference) */
export type DatablockPosition = 1 | 2 | 3 | 4 | 6 | 7 | 8 | 9

interface DatablockPositionStore {
  /**
   * Per-aircraft position overrides (session-only)
   * Key: callsign, Value: position (1-9)
   * These are cleared on app restart and when global position is set
   */
  aircraftOverrides: Map<string, DatablockPosition>

  /**
   * Pending direction for input mode
   * Set when user presses 1-9, cleared on Enter/click/Escape
   */
  pendingDirection: DatablockPosition | null

  // Actions
  setPendingDirection: (direction: DatablockPosition | null) => void
  setAircraftPosition: (callsign: string, position: DatablockPosition) => void
  clearAircraftOverride: (callsign: string) => void
  clearAllOverrides: () => void
  getAircraftPosition: (callsign: string) => DatablockPosition | null
}

export const useDatablockPositionStore = create<DatablockPositionStore>((set, get) => ({
  aircraftOverrides: new Map(),
  pendingDirection: null,

  setPendingDirection: (direction) => set({ pendingDirection: direction }),

  setAircraftPosition: (callsign, position) => {
    const overrides = new Map(get().aircraftOverrides)
    overrides.set(callsign, position)
    set({ aircraftOverrides: overrides })
  },

  clearAircraftOverride: (callsign) => {
    const overrides = new Map(get().aircraftOverrides)
    overrides.delete(callsign)
    set({ aircraftOverrides: overrides })
  },

  clearAllOverrides: () => set({ aircraftOverrides: new Map() }),

  getAircraftPosition: (callsign) => get().aircraftOverrides.get(callsign) ?? null
}))
