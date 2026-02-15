import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Headphones, Languages, Play, Settings2, Square } from 'lucide-react'

import { Button } from '@/components/ui/button'

import { startSystemAudioCapture, stopSystemAudioCapture } from '../system-audio-capture'
import { stopMicrophoneCapture } from '../microphone-capture'

interface SentencePair {
  original: string
  translated?: string
}

interface SpeakerSegment {
  speaker: number
  text: string
  translatedText?: string
  sentencePairs?: SentencePair[]
  stableText?: string
  previewText?: string
  timestamp?: number
}

interface TranscriptSegment {
  isFinal: boolean
  speakerSegments?: SpeakerSegment[]
  currentSpeakerSegment?: SpeakerSegment
}

type TranscriptionStatus = 'idle' | 'transcribing' | 'error'

const speakerColors = ['#7C3AED', '#0EA5E9', '#16A34A', '#F97316', '#E11D48', '#2563EB']

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function splitStablePreview(prev: string, next: string): { stable: string; preview: string } {
  if (!next) {
    return { stable: '', preview: '' }
  }
  if (!prev) {
    return { stable: '', preview: next }
  }

  const max = Math.min(prev.length, next.length)
  let index = 0
  while (index < max && prev[index] === next[index]) {
    index += 1
  }

  return { stable: next.slice(0, index), preview: next.slice(index) }
}

interface MeetingTranscriptionProps {
  onOpenSettings?: () => void
}

export function MeetingTranscription({
  onOpenSettings
}: MeetingTranscriptionProps): React.JSX.Element {
  const [status, setStatus] = useState<TranscriptionStatus>('idle')
  const [isPreconnecting, setIsPreconnecting] = useState(false)
  const [preconnectFailed, setPreconnectFailed] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [segments, setSegments] = useState<SpeakerSegment[]>([])
  const [currentSegment, setCurrentSegment] = useState<SpeakerSegment | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)

  const transcriptRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const lastCurrentTextRef = useRef('')
  const stopInProgressRef = useRef(false)
  const startedAtRef = useRef<number | null>(null)

  const formatSegmentTime = useCallback((timestamp?: number): string => {
    if (!timestamp || !startedAtRef.current) {
      return '--:--'
    }
    const elapsed = Math.max(0, Math.floor((timestamp - startedAtRef.current) / 1000))
    return formatClock(elapsed)
  }, [])

  const startTranscription = async (): Promise<void> => {
    if (stopInProgressRef.current || isPreconnecting) return

    try {
      setLastError(null)
      await window.api.startMeetingTranscription({
        includeMicrophone: false,
        translationEnabled: false
      })
      await startSystemAudioCapture(null)

      setStatus('transcribing')
      setSeconds(0)
      setSegments([])
      setCurrentSegment(null)
      lastCurrentTextRef.current = ''
      startedAtRef.current = Date.now()

      timerRef.current = setInterval(() => {
        setSeconds((value) => value + 1)
      }, 1000)
    } catch (err) {
      setStatus('error')
      setLastError(err instanceof Error ? err.message : String(err))
      stopSystemAudioCapture()
      stopMicrophoneCapture()
    }
  }

  const stopTranscription = useCallback(async (): Promise<void> => {
    if (stopInProgressRef.current || status !== 'transcribing') return
    stopInProgressRef.current = true

    try {
      stopSystemAudioCapture()
      stopMicrophoneCapture()

      try {
        await window.api.stopMeetingTranscription()
      } catch (err) {
        console.error('Stop error:', err)
      }

      const allSegments = [...segments, ...(currentSegment ? [currentSegment] : [])]
      if (allSegments.length > 0) {
        await window.api.saveTranscript({
          duration_seconds: seconds,
          translation_enabled: false,
          include_microphone: false,
          segments: allSegments.map((segment) => ({
            speaker: segment.speaker,
            text: segment.text,
            translated_text: segment.translatedText,
            sentence_pairs: segment.sentencePairs?.map((pair) => ({
              original: pair.original,
              translated: pair.translated
            }))
          }))
        })
      }

      setStatus('idle')
      setCurrentSegment(null)
      startedAtRef.current = null
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    } finally {
      stopInProgressRef.current = false
    }
  }, [currentSegment, seconds, segments, status])

  const handleTranscript = useCallback((segment: TranscriptSegment) => {
    if (segment.isFinal) {
      setSegments((prev) => {
        if (segment.currentSpeakerSegment && segment.currentSpeakerSegment.text.trim()) {
          return [...prev, { ...segment.currentSpeakerSegment, timestamp: Date.now() }]
        }
        return prev
      })
      setCurrentSegment(null)
      lastCurrentTextRef.current = ''
      return
    }

    const speakerSegments = segment.speakerSegments || []
    if (speakerSegments.length > 0) {
      setSegments((prev) => {
        const newSegments = speakerSegments
          .slice(prev.length)
          .filter((item) => item.text.trim())
          .map((item) => ({ ...item, timestamp: Date.now() }))
        return [...prev, ...newSegments]
      })
    }

    if (segment.currentSpeakerSegment && segment.currentSpeakerSegment.text.trim()) {
      const { stable, preview } = splitStablePreview(
        lastCurrentTextRef.current,
        segment.currentSpeakerSegment.text
      )
      lastCurrentTextRef.current = segment.currentSpeakerSegment.text
      setCurrentSegment({
        ...segment.currentSpeakerSegment,
        stableText: stable,
        previewText: preview,
        timestamp: Date.now()
      })
    } else {
      setCurrentSegment(null)
      lastCurrentTextRef.current = ''
    }
  }, [])

  useEffect(() => {
    window.api.onMeetingTranscript(handleTranscript)
    window.api.onMeetingStatus((nextStatus: string) => {
      if (nextStatus === 'idle' && status === 'transcribing') {
        void stopTranscription()
      } else if (nextStatus === 'error') {
        setStatus('error')
      }
    })

    return () => {
      window.api.removeAllListeners?.('meeting-transcript')
      window.api.removeAllListeners?.('meeting-status')
    }
  }, [handleTranscript, status, stopTranscription])

  useEffect(() => {
    let active = true
    setIsPreconnecting(true)
    setPreconnectFailed(false)

    void window.api
      .preconnectMeetingTranscription()
      .then((ok) => {
        if (!ok) {
          throw new Error('Preconnect unavailable')
        }
      })
      .catch(() => {
        if (active) {
          setPreconnectFailed(true)
        }
      })
      .finally(() => {
        if (active) {
          setIsPreconnecting(false)
        }
      })

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
    }
  }, [segments, currentSegment])

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
      }
    }
  }, [])

  const isTranscribing = status === 'transcribing'
  const hasContent = segments.length > 0 || currentSegment

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background">
      <header className="flex h-[53px] items-center justify-between border-b px-6">
        <div className="flex items-center gap-3">
          <Headphones className="h-5 w-5 text-[#7C3AED]" />
          <h1 className="text-[18px] leading-none font-semibold">Meeting Transcription</h1>
          {isTranscribing && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#FEF2F2] px-2.5 py-1 text-xs font-medium text-red-500">
              <span className="h-2 w-2 rounded-full bg-red-500" />
              <span>Recording · {formatClock(seconds)}</span>
            </span>
          )}
          {status === 'error' && (
            <span className="inline-flex items-center rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-500">
              Connection error
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {!isTranscribing && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 px-4 text-sm font-medium"
              onClick={onOpenSettings}
            >
              <Settings2 className="h-4 w-4" />
              <span>Settings</span>
            </Button>
          )}

          {isTranscribing ? (
            <Button
              type="button"
              size="sm"
              className="h-8 bg-red-500 px-4 text-sm text-white hover:bg-red-600"
              onClick={stopTranscription}
            >
              <Square className="h-4 w-4" />
              <span>Stop</span>
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              className="h-8 bg-[#171717] px-4 text-sm text-white hover:bg-[#262626]"
              onClick={startTranscription}
              disabled={isPreconnecting}
            >
              <Play className="h-4 w-4" />
              <span>{isPreconnecting ? 'Preparing...' : 'Start Recording'}</span>
            </Button>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5" ref={transcriptRef}>
        {!hasContent && !isTranscribing ? (
          <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-6 text-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[#F3F0FF]">
              <Headphones className="h-7 w-7 text-[#7C3AED]" />
            </div>
            <div className="space-y-1">
              <p className="text-[20px] leading-[1.2] font-semibold">No active transcription</p>
              <p className="text-muted-foreground max-w-sm text-sm">
                Click Start Recording to begin capturing audio from your microphone and system
                audio.
              </p>
              {preconnectFailed && (
                <p className="text-xs text-amber-600">
                  Warm-up failed, first start may take longer.
                </p>
              )}
              {lastError && <p className="text-xs text-red-500">{lastError}</p>}
            </div>
            <Button
              type="button"
              size="sm"
              className="h-8 bg-[#171717] px-4 text-sm text-white hover:bg-[#262626]"
              onClick={startTranscription}
              disabled={isPreconnecting}
            >
              <Play className="h-4 w-4" />
              <span>{isPreconnecting ? 'Preparing...' : 'Start Recording'}</span>
            </Button>
          </div>
        ) : (
          <div className="space-y-5">
            {segments.map((segment, index) => {
              const speakerColor = speakerColors[segment.speaker % speakerColors.length]
              const pairs =
                segment.sentencePairs && segment.sentencePairs.length > 0
                  ? segment.sentencePairs
                  : [{ original: segment.text, translated: segment.translatedText }]

              return (
                <div key={`${segment.speaker}-${index}`} className="flex gap-3 text-sm">
                  <span className="w-10 shrink-0 pt-0.5 text-xs text-muted-foreground">
                    {formatSegmentTime(segment.timestamp)}
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-[13px] font-semibold" style={{ color: speakerColor }}>
                      Speaker {segment.speaker + 1}
                    </p>
                    {pairs.map((pair, pairIndex) => (
                      <div key={pairIndex} className="space-y-1">
                        <p className="text-sm leading-[1.5]">{pair.original}</p>
                        {pair.translated && (
                          <div className="flex items-start gap-2 rounded-md bg-emerald-50 px-3 py-2 text-emerald-600">
                            <Languages className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <p className="text-sm leading-[1.5]">{pair.translated}</p>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}

            {currentSegment && (
              <div className="flex gap-3 text-sm opacity-80">
                <span className="w-10 shrink-0 pt-0.5 text-xs text-muted-foreground">
                  {formatSegmentTime(currentSegment.timestamp)}
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <p
                    className="text-[13px] font-semibold"
                    style={{ color: speakerColors[currentSegment.speaker % speakerColors.length] }}
                  >
                    Speaker {currentSegment.speaker + 1}
                  </p>
                  <p className="text-sm leading-[1.5]">
                    <span>{currentSegment.stableText}</span>
                    {currentSegment.previewText && (
                      <span className="text-muted-foreground">{currentSegment.previewText}</span>
                    )}
                  </p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
