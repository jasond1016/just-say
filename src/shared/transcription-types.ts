export interface WordTiming {
  text: string
  startMs: number
  endMs: number
}

export interface SentencePair {
  original: string
  translated?: string | null
}

export type TranscriptSource = 'system' | 'microphone'

export interface SpeakerSegment {
  speaker: number
  source?: TranscriptSource
  text: string
  previewText?: string
  commitReadyText?: string
  unstableTailText?: string
  previewRevision?: number
  wordTimings?: WordTiming[]
  endpointReason?: string
  translatedText?: string
  timestamp?: number
  isFinal: boolean
  sentencePairs?: SentencePair[]
}

export interface PartialResult {
  segments: SpeakerSegment[]
  currentSegment: SpeakerSegment | null
  currentWordTimings?: WordTiming[]
  /** Combined visible text used for profiling and compatibility paths. */
  combined: string
  currentSpeaker?: number
  translationEnabled?: boolean
}

export interface MeetingTranscriptEvent {
  text: string
  translatedText?: string
  timestamp: number
  isFinal: boolean
  source?: TranscriptSource
  speaker?: number
  speakerSegments?: SpeakerSegment[]
  currentSpeakerSegment?: SpeakerSegment | null
  currentWordTimings?: WordTiming[]
  translationEnabled?: boolean
}
