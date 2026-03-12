/**
 * Indexing Store
 *
 * Manages state for long-running indexing operations (FSLTL, AIG).
 * Shows a blocking modal with progress while indexing is in progress.
 */

import { create } from 'zustand'
import type { MSFSModelSource } from '@/types'

interface IndexingState {
  /** Whether an indexing operation is in progress */
  isIndexing: boolean

  /** Current indexing progress (0-100) */
  progress: number

  /** Status message to display */
  status: string

  /** Which source is being indexed */
  source: MSFSModelSource | null

  // Actions
  /** Start an indexing operation */
  startIndexing: (source: MSFSModelSource) => void

  /** Update progress during indexing */
  updateProgress: (progress: number, status: string) => void

  /** Complete the indexing operation */
  finishIndexing: () => void

  /** Cancel the indexing operation */
  cancel: () => void
}

export const useIndexingStore = create<IndexingState>()((set) => ({
  isIndexing: false,
  progress: 0,
  status: '',
  source: null,

  startIndexing: (source: MSFSModelSource) => {
    set({
      isIndexing: true,
      progress: 0,
      status: `Indexing ${source.toUpperCase()} models...`,
      source,
    })
  },

  updateProgress: (progress: number, status: string) => {
    set({
      progress: Math.min(100, Math.max(0, progress)),
      status,
    })
  },

  finishIndexing: () => {
    set({
      isIndexing: false,
      progress: 100,
      status: 'Complete',
      source: null,
    })
    // Clear the modal after a short delay so user sees completion
    setTimeout(() => {
      set({
        progress: 0,
        status: '',
      })
    }, 500)
  },

  cancel: () => {
    set({
      isIndexing: false,
      progress: 0,
      status: '',
      source: null,
    })
  },
}))
