import { ElectronAPI } from '@electron-toolkit/preload'
import { DesktopCapturerSource, SourcesOptions } from 'electron'

interface DesktopCapturerAPI {
  getSources: (options: SourcesOptions) => Promise<DesktopCapturerSource[]>
}

interface MeetingTranscriptSegment {
  text: string
  timestamp: number
  isFinal: boolean
  speakerSegments?: Array<{
    speaker: number
    text: string
    translatedText?: string
  }>
  currentSpeakerSegment?: {
    speaker: number
    text: string
    translatedText?: string
  }
}

interface JustSayAPI {
  getConfig: () => Promise<unknown>
  setConfig: (config: unknown) => Promise<void>

  // Secure API Key management
  getApiKey: (provider: 'soniox' | 'groq' | 'openai') => Promise<string | undefined>
  setApiKey: (provider: 'soniox' | 'groq' | 'openai', apiKey: string) => Promise<void>
  deleteApiKey: (provider: 'soniox' | 'groq' | 'openai') => Promise<void>
  hasApiKey: (provider: 'soniox' | 'groq' | 'openai') => Promise<boolean>

  showSettings: () => Promise<void>
  quit: () => Promise<void>
  onRecordingState: (
    callback: (state: { recording: boolean; processing?: boolean }) => void
  ) => void
  removeAllListeners: (channel: string) => void

  // Output popup window
  onOutputText: (callback: (payload: { text: string }) => void) => void
  closeOutputWindow: () => Promise<void>
  copyToClipboard: (text: string) => Promise<void>

  getLocalModels: () => Promise<string[]>
  downloadModel: (modelType: string) => Promise<void>
  deleteModel: (modelType: string) => Promise<void>
  testWhisperServer: (host: string, port: number) => Promise<boolean>
  onDownloadProgress: (
    callback: (progress: { model: string; percent: number; status: string }) => void
  ) => () => void

  // Meeting transcription
  preconnectMeetingTranscription: () => Promise<boolean>
  startMeetingTranscription: (options: {
    includeMicrophone: boolean
    translationEnabled?: boolean
    targetLanguage?: string
  }) => Promise<void>
  stopMeetingTranscription: () => Promise<void>
  getSystemAudioSources: () => Promise<Array<{ id: string; name: string; isDefault?: boolean }>>
  onMeetingTranscript: (callback: (segment: MeetingTranscriptSegment) => void) => void
  onMeetingStatus: (callback: (status: string) => void) => void

  // System audio capture (renderer-side)
  sendSystemAudioChunk: (chunk: ArrayBuffer) => void
  notifySystemAudioStarted: () => void
  notifySystemAudioStopped: () => void
  notifySystemAudioError: (message: string) => void

  // Microphone capture (renderer-side)
  sendMicrophoneAudioChunk: (chunk: ArrayBuffer) => void
  notifyMicrophoneStarted: () => void
  notifyMicrophoneStopped: () => void
  notifyMicrophoneError: (message: string) => void

  // Push-to-talk audio capture (hidden window)
  onStartPttCapture: (callback: () => void) => void
  onStopPttCapture: (callback: () => void) => void
  sendPttAudioChunk: (chunk: ArrayBuffer) => void
  notifyPttStarted: () => void
  notifyPttStopped: () => void
  notifyPttError: (message: string) => void

  // Non-streaming recording (hidden window)
  onStartRecording: (callback: () => void) => void
  onStopRecording: (callback: () => void) => void
  sendRecordingAudioChunk: (chunk: ArrayBuffer) => void
  notifyRecordingStarted: () => void
  notifyRecordingStopped: () => void
  notifyRecordingError: (message: string) => void

  // Transcript storage
  saveTranscript: (data: {
    title?: string
    note?: string
    duration_seconds: number
    translation_enabled: boolean
    target_language?: string
    include_microphone: boolean
    source_mode?: 'ptt' | 'meeting'
    segments: {
      speaker: number
      text: string
      translated_text?: string
      sentence_pairs?: { original: string; translated?: string }[]
    }[]
  }) => Promise<{
    id: string
    title: string
    note: string | null
    duration_seconds: number
    created_at: string
    updated_at: string
    translation_enabled: 0 | 1
    target_language: string | null
    include_microphone: 0 | 1
    source_mode: 'ptt' | 'meeting'
  }>

  listTranscripts: (options?: {
    page?: number
    pageSize?: number
    orderBy?: string
    order?: string
    sourceMode?: 'ptt' | 'meeting'
  }) => Promise<{
    items: unknown[]
    total: number
    page: number
    pageSize: number
    totalPages: number
  }>

  searchTranscripts: (options: {
    query: string
    page?: number
    pageSize?: number
    sourceMode?: 'ptt' | 'meeting'
  }) => Promise<{
    items: unknown[]
    total: number
    page: number
    pageSize: number
    totalPages: number
  }>

  getTranscript: (id: string) => Promise<unknown>

  updateTranscript: (id: string, data: { title?: string; note?: string }) => Promise<boolean>

  deleteTranscript: (id: string) => Promise<boolean>

  exportTranscript: (id: string) => Promise<string | null>

  getHomeStats: () => Promise<{
    todayPttCount: number
    todayChars: number
    todayPttDelta: number
    todayCharsDelta: number
    daily: Array<{
      start_ms: number
      ptt_count: number
      chars_sum: number
    }>
  }>

  onHomeStatsUpdated: (callback: () => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: JustSayAPI
    desktopCapturer: DesktopCapturerAPI
  }
}
