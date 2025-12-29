import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// JustSay custom API
const api = {
  // Config
  getConfig: (): Promise<unknown> => ipcRenderer.invoke('get-config'),
  setConfig: (config: unknown): Promise<void> => ipcRenderer.invoke('set-config', config),

  // App control
  showSettings: (): Promise<void> => ipcRenderer.invoke('show-settings'),
  showMeetingWindow: (): Promise<void> => ipcRenderer.invoke('show-meeting-window'),
  quit: (): Promise<void> => ipcRenderer.invoke('quit-app'),

  // Recording state events
  onRecordingState: (
    callback: (state: { recording: boolean; processing?: boolean }) => void
  ): void => {
    ipcRenderer.on('recording-state', (_event, state) => callback(state))
  },

  removeAllListeners: (channel: string): void => {
    ipcRenderer.removeAllListeners(channel)
  },

  // Model Management
  getLocalModels: (): Promise<string[]> => ipcRenderer.invoke('get-local-models'),
  downloadModel: (modelType: string): Promise<void> =>
    ipcRenderer.invoke('download-model', modelType),

  // Meeting Transcription
  startMeetingTranscription: (options: {
    includeMicrophone: boolean
    translationEnabled?: boolean
    targetLanguage?: string
  }): Promise<void> => ipcRenderer.invoke('start-meeting-transcription', options),

  stopMeetingTranscription: (): Promise<void> => ipcRenderer.invoke('stop-meeting-transcription'),

  getSystemAudioSources: (): Promise<Array<{ id: string; name: string; isDefault?: boolean }>> =>
    ipcRenderer.invoke('get-system-audio-sources'),

  onMeetingTranscript: (
    callback: (segment: { text: string; timestamp: number; isFinal: boolean }) => void
  ): void => {
    ipcRenderer.on('meeting-transcript', (_event, segment) => callback(segment))
  },

  onMeetingStatus: (callback: (status: string) => void): void => {
    ipcRenderer.on('meeting-status', (_event, status) => callback(status))
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
