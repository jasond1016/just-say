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
  getApiKey: (provider: 'soniox' | 'groq') => Promise<string | undefined>
  setApiKey: (provider: 'soniox' | 'groq', apiKey: string) => Promise<void>
  deleteApiKey: (provider: 'soniox' | 'groq') => Promise<void>
  hasApiKey: (provider: 'soniox' | 'groq') => Promise<boolean>

  showSettings: () => Promise<void>
  showMeetingWindow: () => Promise<void>
  quit: () => Promise<void>
  onRecordingState: (
    callback: (state: { recording: boolean; processing?: boolean }) => void
  ) => void
  removeAllListeners: (channel: string) => void
  getLocalModels: () => Promise<string[]>
  downloadModel: (modelType: string) => Promise<void>
  deleteModel: (modelType: string) => Promise<void>
  onDownloadProgress: (
    callback: (progress: { model: string; percent: number; status: string }) => void
  ) => () => void

  // Meeting transcription
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
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: JustSayAPI
    desktopCapturer: DesktopCapturerAPI
  }
}
