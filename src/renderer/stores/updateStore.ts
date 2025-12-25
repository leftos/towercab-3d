import { create } from 'zustand'

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'
  | 'up-to-date'

export interface UpdateInfo {
  version: string
  currentVersion: string
  date: string | null
  body: string | null  // Release notes
}

export interface UpdateProgress {
  downloaded: number
  total: number | null
}

interface UpdateStore {
  status: UpdateStatus
  updateInfo: UpdateInfo | null
  progress: UpdateProgress | null
  error: string | null

  setStatus: (status: UpdateStatus) => void
  setUpdateInfo: (info: UpdateInfo | null) => void
  setProgress: (progress: UpdateProgress | null) => void
  setError: (error: string | null) => void
  reset: () => void
}

export const useUpdateStore = create<UpdateStore>((set) => ({
  status: 'idle',
  updateInfo: null,
  progress: null,
  error: null,

  setStatus: (status) => set({ status }),
  setUpdateInfo: (updateInfo) => set({ updateInfo }),
  setProgress: (progress) => set({ progress }),
  setError: (error) => set({ error, status: error ? 'error' : 'idle' }),
  reset: () => set({ status: 'idle', updateInfo: null, progress: null, error: null })
}))
