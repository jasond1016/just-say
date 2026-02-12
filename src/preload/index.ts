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

  // Secure API Key management
  getApiKey: (provider: 'soniox' | 'groq' | 'openai'): Promise<string | undefined> =>
    ipcRenderer.invoke('get-api-key', provider),
  setApiKey: (provider: 'soniox' | 'groq' | 'openai', apiKey: string): Promise<void> =>
    ipcRenderer.invoke('set-api-key', provider, apiKey),
  deleteApiKey: (provider: 'soniox' | 'groq' | 'openai'): Promise<void> =>
    ipcRenderer.invoke('delete-api-key', provider),
  hasApiKey: (provider: 'soniox' | 'groq' | 'openai'): Promise<boolean> =>
    ipcRenderer.invoke('has-api-key', provider),

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
  },

  // Output popup window
  onOutputText: (callback: (payload: { text: string }) => void): void => {
    ipcRenderer.on('output-text', (_event, payload) => callback(payload))
  },
  closeOutputWindow: (): Promise<void> => ipcRenderer.invoke('close-output-window'),
  copyToClipboard: (text: string): Promise<void> => ipcRenderer.invoke('copy-to-clipboard', text),

  // Model Management
  getLocalModels: (): Promise<string[]> => ipcRenderer.invoke('get-local-models'),
  downloadModel: (modelType: string): Promise<void> =>
    ipcRenderer.invoke('download-model', modelType),
  deleteModel: (modelType: string): Promise<void> => ipcRenderer.invoke('delete-model', modelType),
  testWhisperServer: (host: string, port: number): Promise<boolean> =>
    ipcRenderer.invoke('test-whisper-remote', { host, port }),
  onDownloadProgress: (
    callback: (progress: { model: string; percent: number; status: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      progress: { model: string; percent: number; status: string }
    ): void => callback(progress)
    ipcRenderer.on('download-progress', handler)
    return () => ipcRenderer.removeListener('download-progress', handler)
  },

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
  },

  // Transcript storage
  saveTranscript: (data: {
    title?: string
    note?: string
    duration_seconds: number
    translation_enabled: boolean
    target_language?: string
    include_microphone: boolean
    segments: {
      speaker: number
      text: string
      translated_text?: string
      sentence_pairs?: { original: string; translated?: string }[]
    }[]
  }): Promise<{
    id: string
    title: string
    note: string | null
    duration_seconds: number
    created_at: string
    updated_at: string
    translation_enabled: 0 | 1
    target_language: string | null
    include_microphone: 0 | 1
  }> => ipcRenderer.invoke('save-transcript', data),

  listTranscripts: (options?: {
    page?: number
    pageSize?: number
    orderBy?: string
    order?: string
  }): Promise<{
    items: unknown[]
    total: number
    page: number
    pageSize: number
    totalPages: number
  }> => ipcRenderer.invoke('list-transcripts', options),

  searchTranscripts: (options: {
    query: string
    page?: number
    pageSize?: number
  }): Promise<{
    items: unknown[]
    total: number
    page: number
    pageSize: number
    totalPages: number
  }> => ipcRenderer.invoke('search-transcripts', options),

  getTranscript: (id: string): Promise<unknown> => ipcRenderer.invoke('get-transcript', id),

  updateTranscript: (id: string, data: { title?: string; note?: string }): Promise<boolean> =>
    ipcRenderer.invoke('update-transcript', id, data),

  deleteTranscript: (id: string): Promise<boolean> => ipcRenderer.invoke('delete-transcript', id),

  exportTranscript: (id: string): Promise<string | null> => ipcRenderer.invoke('export-transcript', id)
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
