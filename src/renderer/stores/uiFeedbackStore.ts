import { create } from 'zustand'

/** How a feedback toast reads: green success, red error, or accent-coloured information */
export type FeedbackType = 'success' | 'error' | 'info'

/** How long a feedback toast stays up unless the call says otherwise */
const DEFAULT_FEEDBACK_MS = 2000

interface UIFeedbackStore {
  feedback: { message: string; type: FeedbackType } | null
  /** Show a toast for `durationMs` (2 s when omitted), replacing any toast still up */
  showFeedback: (message: string, type: FeedbackType, durationMs?: number) => void
  clearFeedback: () => void
  // When true, keyboard input should be blocked from camera controls etc.
  isCommandInputActive: boolean
  setCommandInputActive: (active: boolean) => void
  // Track open modals - when > 0, keyboard input should be blocked
  openModalCount: number
  pushModal: () => void
  popModal: () => void
  // Helper to check if any input-blocking UI is active
  isInputBlocked: () => boolean
  // Debug overlay visibility (accessible from touch controls)
  showPerformanceHUD: boolean
  setShowPerformanceHUD: (show: boolean) => void
  togglePerformanceHUD: () => void
  showModelMatchingModal: boolean
  setShowModelMatchingModal: (show: boolean) => void
  toggleModelMatchingModal: () => void
  showTimelineDebugModal: boolean
  setShowTimelineDebugModal: (show: boolean) => void
  toggleTimelineDebugModal: () => void
  // Terrain cache clear request (handled by CesiumViewer)
  clearTerrainCacheRequested: boolean
  requestClearTerrainCache: () => void
  acknowledgeClearTerrainCache: () => void
  // Settings modal open request (handled by ControlsBar, which owns the modal)
  settingsOpenRequested: boolean
  requestOpenSettings: () => void
  acknowledgeOpenSettings: () => void
}

let feedbackTimeout: ReturnType<typeof setTimeout> | null = null

export const useUIFeedbackStore = create<UIFeedbackStore>((set, get) => ({
  feedback: null,
  showFeedback: (message, type, durationMs = DEFAULT_FEEDBACK_MS) => {
    if (feedbackTimeout) clearTimeout(feedbackTimeout)
    set({ feedback: { message, type } })
    feedbackTimeout = setTimeout(() => set({ feedback: null }), durationMs)
  },
  clearFeedback: () => {
    if (feedbackTimeout) clearTimeout(feedbackTimeout)
    set({ feedback: null })
  },
  isCommandInputActive: false,
  setCommandInputActive: (active) => set({ isCommandInputActive: active }),
  openModalCount: 0,
  pushModal: () => set((state) => ({ openModalCount: state.openModalCount + 1 })),
  popModal: () => set((state) => ({ openModalCount: Math.max(0, state.openModalCount - 1) })),
  isInputBlocked: () => {
    const state = get()
    return state.isCommandInputActive || state.openModalCount > 0
  },
  // Debug overlays
  showPerformanceHUD: false,
  setShowPerformanceHUD: (show) => set({ showPerformanceHUD: show }),
  togglePerformanceHUD: () => set((state) => ({ showPerformanceHUD: !state.showPerformanceHUD })),
  showModelMatchingModal: false,
  setShowModelMatchingModal: (show) => set({ showModelMatchingModal: show }),
  toggleModelMatchingModal: () => set((state) => ({ showModelMatchingModal: !state.showModelMatchingModal })),
  showTimelineDebugModal: false,
  setShowTimelineDebugModal: (show) => set({ showTimelineDebugModal: show }),
  toggleTimelineDebugModal: () => set((state) => ({ showTimelineDebugModal: !state.showTimelineDebugModal })),
  // Terrain cache clear
  clearTerrainCacheRequested: false,
  requestClearTerrainCache: () => set({ clearTerrainCacheRequested: true }),
  acknowledgeClearTerrainCache: () => set({ clearTerrainCacheRequested: false }),
  // Settings modal open
  settingsOpenRequested: false,
  requestOpenSettings: () => set({ settingsOpenRequested: true }),
  acknowledgeOpenSettings: () => set({ settingsOpenRequested: false }),
}))
