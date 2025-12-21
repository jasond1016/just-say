import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// JustSay custom API
const api = {
  // Config
  getConfig: (): Promise<unknown> => ipcRenderer.invoke('get-config'),
  setConfig: (config: unknown): Promise<void> => ipcRenderer.invoke('set-config', config),

  // App control
  showSettings: (): Promise<void> => ipcRenderer.invoke('show-settings'),
  quit: (): Promise<void> => ipcRenderer.invoke('quit-app'),

  // Recording state events
  onRecordingState: (
    callback: (state: { recording: boolean; processing?: boolean }) => void
  ): void => {
    ipcRenderer.on('recording-state', (_event, state) => callback(state))
  },

  removeAllListeners: (channel: string): void => {
    ipcRenderer.removeAllListeners(channel)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
