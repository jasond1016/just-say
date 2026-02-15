import type { Transcript } from '@/hooks/useTranscripts'

export type TranscriptSourceMode = 'ptt' | 'meeting'

export function getTranscriptSourceMode(transcript: Transcript): TranscriptSourceMode {
  if (transcript.source_mode === 'ptt' || transcript.source_mode === 'meeting') {
    return transcript.source_mode
  }

  // Backward compatibility: legacy records are meeting transcripts.
  return 'meeting'
}
