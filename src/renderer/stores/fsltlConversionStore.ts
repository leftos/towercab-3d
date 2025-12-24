/**
 * FSLTL Conversion Store
 *
 * Manages the state of FSLTL model conversion process.
 * This state persists across Settings panel open/close.
 */

import { create } from 'zustand'
import type { ConversionProgress } from '../types/fsltl'
import * as fsltlApi from '../services/fsltlApi'

type ConversionState = 'idle' | 'converting' | 'complete' | 'error'

interface FsltlConversionState {
  // Conversion state
  conversionState: ConversionState
  progress: ConversionProgress
  conversionStartTime: number | null
  progressFilePath: string | null
  isCancelling: boolean
  error: string | null

  // Polling interval ID (stored as number for cleanup)
  pollIntervalId: ReturnType<typeof setInterval> | null

  // Actions
  startConversion: (progressFilePath: string) => void
  updateProgress: (progress: ConversionProgress) => void
  completeConversion: () => void
  cancelConversion: () => Promise<void>
  setError: (error: string | null) => void
  reset: () => void

  // Internal actions
  setPollInterval: (id: ReturnType<typeof setInterval> | null) => void
  cleanup: () => void
}

const initialProgress: ConversionProgress = {
  status: 'idle',
  total: 0,
  completed: 0,
  current: null,
  errors: []
}

export const useFsltlConversionStore = create<FsltlConversionState>((set, get) => ({
  // Initial state
  conversionState: 'idle',
  progress: initialProgress,
  conversionStartTime: null,
  progressFilePath: null,
  isCancelling: false,
  error: null,
  pollIntervalId: null,

  startConversion: (progressFilePath: string) => {
    set({
      conversionState: 'converting',
      progress: { ...initialProgress, status: 'converting' },
      conversionStartTime: Date.now(),
      progressFilePath,
      isCancelling: false,
      error: null
    })
  },

  updateProgress: (progress: ConversionProgress) => {
    set({ progress })
  },

  completeConversion: () => {
    const state = get()
    // Clear polling interval
    if (state.pollIntervalId) {
      clearInterval(state.pollIntervalId)
    }
    set({
      conversionState: 'complete',
      pollIntervalId: null
    })
  },

  cancelConversion: async () => {
    const state = get()
    set({ isCancelling: true })

    try {
      // Stop polling first
      if (state.pollIntervalId) {
        clearInterval(state.pollIntervalId)
      }

      // Kill the converter process
      await fsltlApi.cancelFsltlConversion()

      set({
        conversionState: 'idle',
        progress: initialProgress,
        conversionStartTime: null,
        progressFilePath: null,
        isCancelling: false,
        pollIntervalId: null
      })
    } catch (err) {
      console.warn('[fsltlConversionStore] Cancel failed:', err)
      // Still reset state even if cancel fails
      set({
        conversionState: 'idle',
        progress: initialProgress,
        conversionStartTime: null,
        progressFilePath: null,
        isCancelling: false,
        pollIntervalId: null
      })
    }
  },

  setError: (error: string | null) => {
    set({
      error,
      conversionState: error ? 'error' : get().conversionState
    })
  },

  reset: () => {
    const state = get()
    if (state.pollIntervalId) {
      clearInterval(state.pollIntervalId)
    }
    set({
      conversionState: 'idle',
      progress: initialProgress,
      conversionStartTime: null,
      progressFilePath: null,
      isCancelling: false,
      error: null,
      pollIntervalId: null
    })
  },

  setPollInterval: (id: ReturnType<typeof setInterval> | null) => {
    set({ pollIntervalId: id })
  },

  // Cleanup function for app close
  cleanup: () => {
    const state = get()
    if (state.pollIntervalId) {
      clearInterval(state.pollIntervalId)
    }
    // Cancel conversion synchronously if running
    if (state.conversionState === 'converting') {
      // Fire and forget - we're closing the app
      fsltlApi.cancelFsltlConversion().catch(() => {
        // Ignore errors during cleanup
      })
    }
  }
}))

// Helper to get ETA string
export function getConversionEta(startTime: number | null, completed: number, total: number): string {
  if (!startTime || completed === 0 || total === 0) {
    return 'Calculating...'
  }

  const elapsedMs = Date.now() - startTime
  const msPerModel = elapsedMs / completed
  const remaining = total - completed
  const remainingMs = remaining * msPerModel

  const totalSeconds = Math.round(remainingMs / 1000)
  if (totalSeconds < 60) {
    return `~${totalSeconds}s remaining`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) {
    return `~${minutes}m ${seconds}s remaining`
  }
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return `~${hours}h ${mins}m remaining`
}
