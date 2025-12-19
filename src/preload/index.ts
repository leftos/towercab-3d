import { contextBridge, ipcRenderer } from 'electron'

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // File system access for mods
  getModsPath: () => ipcRenderer.invoke('get-mods-path'),
  readModManifest: (modPath: string) => ipcRenderer.invoke('read-mod-manifest', modPath),
  listModDirectories: (type: 'aircraft' | 'towers') => ipcRenderer.invoke('list-mod-directories', type)
})

// Type definitions for the exposed API
declare global {
  interface Window {
    electronAPI: {
      getModsPath: () => Promise<string>
      readModManifest: (modPath: string) => Promise<unknown>
      listModDirectories: (type: 'aircraft' | 'towers') => Promise<string[]>
    }
  }
}
