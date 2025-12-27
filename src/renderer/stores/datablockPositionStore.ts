/**
 * Datablock Position Store
 *
 * Manages datablock (aircraft label) positioning state:
 * - Per-aircraft position overrides (session-only, not persisted)
 * - Pending direction for input mode (user typed 1-9, waiting for Enter or click)
 *
 * Position mapping (numpad style):
 *   7=top-left    8=top-center    9=top-right
 *   4=left        (5=default)     6=right
 *   1=bottom-left 2=bottom-center 3=bottom-right
 *
 * Note: Position 5 is special - it means "reset to app default"
 */

import { create } from 'zustand'

/** Numpad-style position (1-9, excluding 5 which is center reference) */
export type DatablockPosition = 1 | 2 | 3 | 4 | 6 | 7 | 8 | 9

/** Pending direction input (includes 5 for "reset to default") */
export type PendingDirection = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

/** Label screen bounds for click detection */
export interface LabelBounds {
  x: number
  y: number
  width: number
  height: number
}

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
   * Value 5 means "reset to app default"
   */
  pendingDirection: PendingDirection | null

  /**
   * Label screen bounds for click detection (session-only)
   * Key: callsign, Value: screen bounds { x, y, width, height }
   * Updated each frame by useBabylonLabels
   */
  labelBounds: Map<string, LabelBounds>

  // Actions
  setPendingDirection: (direction: PendingDirection | null) => void
  setAircraftPosition: (callsign: string, position: DatablockPosition) => void
  clearAircraftOverride: (callsign: string) => void
  clearAllOverrides: () => void
  getAircraftPosition: (callsign: string) => DatablockPosition | null
  setLabelBounds: (callsign: string, bounds: LabelBounds) => void
  clearLabelBounds: (callsign: string) => void
  clearAllLabelBounds: () => void
  findLabelAtPosition: (x: number, y: number) => string | null
}

export const useDatablockPositionStore = create<DatablockPositionStore>((set, get) => ({
  aircraftOverrides: new Map(),
  pendingDirection: null,
  labelBounds: new Map(),

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

  getAircraftPosition: (callsign) => get().aircraftOverrides.get(callsign) ?? null,

  setLabelBounds: (callsign, bounds) => {
    const labelBounds = get().labelBounds
    labelBounds.set(callsign, bounds)
    // Note: We don't call set() here to avoid unnecessary re-renders
    // The bounds map is mutated in place since we only need it for click detection
  },

  clearLabelBounds: (callsign) => {
    const labelBounds = get().labelBounds
    labelBounds.delete(callsign)
  },

  clearAllLabelBounds: () => {
    get().labelBounds.clear()
  },

  findLabelAtPosition: (x, y) => {
    const { labelBounds } = get()
    for (const [callsign, bounds] of labelBounds) {
      if (
        x >= bounds.x &&
        x <= bounds.x + bounds.width &&
        y >= bounds.y &&
        y <= bounds.y + bounds.height
      ) {
        return callsign
      }
    }
    return null
  }
}))
