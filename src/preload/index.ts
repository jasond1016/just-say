import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Desktop capturer API for system audio capture (via IPC to main process)
const desktopCapturerAPI = {
  getSources: (options: { types: string[] }): Promise<Electron.DesktopCapturerSource[]> =>
    ipcRenderer.invoke('get-desktop-capturer-sources', options)
}

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
  },

  // System audio capture (renderer-side) - send audio data to main
  sendSystemAudioChunk: (chunk: ArrayBuffer): void => {
    ipcRenderer.send('system-audio-chunk', chunk)
  },
  notifySystemAudioStarted: (): void => {
    ipcRenderer.send('system-audio-started')
  },
  notifySystemAudioStopped: (): void => {
    ipcRenderer.send('system-audio-stopped')
  },
  notifySystemAudioError: (message: string): void => {
    ipcRenderer.send('system-audio-error', message)
  },

  // Microphone capture (renderer-side) - send audio data to main
  sendMicrophoneAudioChunk: (chunk: ArrayBuffer): void => {
    ipcRenderer.send('microphone-audio-chunk', chunk)
  },
  notifyMicrophoneStarted: (): void => {
    ipcRenderer.send('microphone-started')
  },
  notifyMicrophoneStopped: (): void => {
    ipcRenderer.send('microphone-stopped')
  },
  notifyMicrophoneError: (message: string): void => {
    ipcRenderer.send('microphone-error', message)
  },

  // Push-to-talk audio capture (hidden window)
  onStartPttCapture: (callback: () => void): void => {
    ipcRenderer.on('start-ptt-capture', () => callback())
  },
  onStopPttCapture: (callback: () => void): void => {
    ipcRenderer.on('stop-ptt-capture', () => callback())
  },
  sendPttAudioChunk: (chunk: ArrayBuffer): void => {
    ipcRenderer.send('ptt-audio-chunk', chunk)
  },
  notifyPttStarted: (): void => {
    ipcRenderer.send('ptt-started')
  },
  notifyPttStopped: (): void => {
    ipcRenderer.send('ptt-stopped')
  },
  notifyPttError: (message: string): void => {
    ipcRenderer.send('ptt-error', message)
  },

  // Non-streaming recording (hidden window)
  onStartRecording: (callback: () => void): void => {
    ipcRenderer.on('start-recording', () => callback())
  },
  onStopRecording: (callback: () => void): void => {
    ipcRenderer.on('stop-recording', () => callback())
  },
  sendRecordingAudioChunk: (chunk: ArrayBuffer): void => {
    ipcRenderer.send('recording-audio-chunk', chunk)
  },
  notifyRecordingStarted: (): void => {
    ipcRenderer.send('recording-started')
  },
  notifyRecordingStopped: (): void => {
    ipcRenderer.send('recording-stopped')
  },
  notifyRecordingError: (message: string): void => {
    ipcRenderer.send('recording-error', message)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('desktopCapturer', desktopCapturerAPI)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore - required for non-isolated context
  window.electron = electronAPI
  // @ts-ignore - required for non-isolated context
  window.api = api
  // @ts-ignore - required for non-isolated context
  window.desktopCapturer = desktopCapturerAPI
}
