import { create } from 'zustand'

interface UIFeedbackStore {
  feedback: { message: string; type: 'success' | 'error' } | null
  showFeedback: (message: string, type: 'success' | 'error') => void
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
}

let feedbackTimeout: ReturnType<typeof setTimeout> | null = null

export const useUIFeedbackStore = create<UIFeedbackStore>((set, get) => ({
  feedback: null,
  showFeedback: (message, type) => {
    if (feedbackTimeout) clearTimeout(feedbackTimeout)
    set({ feedback: { message, type } })
    feedbackTimeout = setTimeout(() => set({ feedback: null }), 2000)
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
  toggleModelMatchingModal: () => set((state) => ({ showModelMatchingModal: !state.showModelMatchingModal }))
}))
