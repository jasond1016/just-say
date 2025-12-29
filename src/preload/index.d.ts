import { ElectronAPI } from '@electron-toolkit/preload'

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
  showSettings: () => Promise<void>
  showMeetingWindow: () => Promise<void>
  quit: () => Promise<void>
  onRecordingState: (
    callback: (state: { recording: boolean; processing?: boolean }) => void
  ) => void
  removeAllListeners: (channel: string) => void
  getLocalModels: () => Promise<string[]>
  downloadModel: (modelType: string) => Promise<void>

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
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: JustSayAPI
  }
}
