export interface WordTiming {
  text: string
  startMs: number
  endMs: number
}

export interface SentencePair {
  original: string
  translated?: string | null
}

export interface SpeakerSegment {
  speaker: number
  text: string
  stableText?: string
  unstableText?: string
  /** Deprecated alias for unstableText. Prefer unstableText for new code. */
  previewText?: string
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
  speaker?: number
  speakerSegments?: SpeakerSegment[]
  currentSpeakerSegment?: SpeakerSegment | null
  currentWordTimings?: WordTiming[]
  translationEnabled?: boolean
}
