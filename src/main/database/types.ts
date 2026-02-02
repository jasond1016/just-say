// Transcript record types
export interface Transcript {
  id: string
  title: string
  note: string | null
  duration_seconds: number
  created_at: string
  updated_at: string
  translation_enabled: 0 | 1
  target_language: string | null
  include_microphone: 0 | 1
}

export interface TranscriptSegment {
  id: number
  transcript_id: string
  speaker: number
  text: string
  translated_text: string | null
  segment_order: number
}

export interface SentencePair {
  id: number
  segment_id: number
  original: string
  translated: string | null
  pair_order: number
}

// Full transcript with all related data
export interface TranscriptWithSegments extends Transcript {
  segments: TranscriptSegmentWithPairs[]
}

export interface TranscriptSegmentWithPairs extends TranscriptSegment {
  sentence_pairs: SentencePair[]
}

// Save request type
export interface SaveTranscriptRequest {
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
    sentence_pairs?: {
      original: string
      translated?: string
    }[]
  }[]
}

// List options
export interface ListTranscriptsOptions {
  page?: number
  pageSize?: number
  orderBy?: 'created_at' | 'updated_at' | 'duration_seconds'
  order?: 'ASC' | 'DESC'
}

// Search options
export interface SearchTranscriptsOptions extends ListTranscriptsOptions {
  query: string
}

// Pagination result
export interface PaginatedResult<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}
