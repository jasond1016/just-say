import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Headphones, Languages, Play, Settings2, Square } from 'lucide-react'

import { Button } from '@/components/ui/button'

export interface SentencePair {
  original: string
  translated?: string
}

export interface SpeakerSegment {
  speaker: number
  text: string
  translatedText?: string
  sentencePairs?: SentencePair[]
  stableText?: string
  previewText?: string
  timestamp?: number
}

export type TranscriptionStatus = 'idle' | 'starting' | 'transcribing' | 'stopping' | 'error'

export interface MeetingSessionState {
  status: TranscriptionStatus
  isPreconnecting: boolean
  preconnectFailed: boolean
  seconds: number
  startedAt: number | null
  segments: SpeakerSegment[]
  currentSegment: SpeakerSegment | null
  lastError: string | null
}

interface MeetingTranscriptionProps {
  state: MeetingSessionState
  onOpenSettings?: () => void
  onStart: () => Promise<void>
  onStopAndReturn: () => Promise<void>
  onReturnToWorkspace: () => void
}

const speakerColors = ['#7C3AED', '#0EA5E9', '#16A34A', '#F97316', '#E11D48', '#2563EB']

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export function MeetingTranscription({
  state,
  onOpenSettings,
  onStart,
  onStopAndReturn,
  onReturnToWorkspace
}: MeetingTranscriptionProps): React.JSX.Element {
  const transcriptRef = useRef<HTMLDivElement>(null)
  const [actionInProgress, setActionInProgress] = useState(false)
  const isTranscribing =
    state.status === 'starting' || state.status === 'transcribing' || state.status === 'stopping'
  const hasContent = state.segments.length > 0 || state.currentSegment

  const formatSegmentTime = useMemo(
    () =>
      (timestamp?: number): string => {
        if (!timestamp || !state.startedAt) {
          return '--:--'
        }
        const elapsed = Math.max(0, Math.floor((timestamp - state.startedAt) / 1000))
        return formatClock(elapsed)
      },
    [state.startedAt]
  )

  const runAction = async (action: () => Promise<void>): Promise<void> => {
    if (actionInProgress) return
    setActionInProgress(true)
    try {
      await action()
    } finally {
      setActionInProgress(false)
    }
  }

  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
    }
  }, [state.segments, state.currentSegment])

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background">
      <header className="flex h-[53px] items-center justify-between border-b px-6">
        <div className="flex items-center gap-3">
          <Headphones className="h-5 w-5 text-[#7C3AED]" />
          <h1 className="text-[18px] leading-none font-semibold">Meeting Transcription</h1>
          {state.status === 'transcribing' && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#FEF2F2] px-2.5 py-1 text-xs font-medium text-red-500">
              <span className="h-2 w-2 rounded-full bg-red-500" />
              <span>Recording · {formatClock(state.seconds)}</span>
            </span>
          )}
          {state.status === 'error' && (
            <span className="inline-flex items-center rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-500">
              Connection error
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {!isTranscribing && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 px-4 text-sm font-medium"
                onClick={onReturnToWorkspace}
              >
                <ArrowLeft className="h-4 w-4" />
                <span>Back</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 px-4 text-sm font-medium"
                onClick={onOpenSettings}
              >
                <Settings2 className="h-4 w-4" />
                <span>Settings</span>
              </Button>
            </>
          )}

          {isTranscribing ? (
            <Button
              type="button"
              size="sm"
              className="h-8 bg-red-500 px-4 text-sm text-white hover:bg-red-600"
              onClick={() => void runAction(onStopAndReturn)}
              disabled={actionInProgress || state.status === 'starting'}
            >
              <Square className="h-4 w-4" />
              <span>Stop & Return</span>
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              className="h-8 bg-[#171717] px-4 text-sm text-white hover:bg-[#262626]"
              onClick={() => void runAction(onStart)}
              disabled={actionInProgress}
            >
              <Play className="h-4 w-4" />
              <span>Start Recording</span>
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
              {state.isPreconnecting && !state.preconnectFailed && (
                <p className="text-muted-foreground text-xs">
                  Warming up in background. You can start now, but the first response may be slower.
                </p>
              )}
              {state.preconnectFailed && (
                <p className="text-xs text-amber-600">
                  Warm-up failed, first start may take longer.
                </p>
              )}
              {state.lastError && <p className="text-xs text-red-500">{state.lastError}</p>}
            </div>
            <Button
              type="button"
              size="sm"
              className="h-8 bg-[#171717] px-4 text-sm text-white hover:bg-[#262626]"
              onClick={() => void runAction(onStart)}
              disabled={actionInProgress}
            >
              <Play className="h-4 w-4" />
              <span>Start Recording</span>
            </Button>
          </div>
        ) : (
          <div className="space-y-5">
            {state.segments.map((segment, index) => {
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

            {state.currentSegment && (
              <div className="flex gap-3 text-sm opacity-80">
                <span className="w-10 shrink-0 pt-0.5 text-xs text-muted-foreground">
                  {formatSegmentTime(state.currentSegment.timestamp)}
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <p
                    className="text-[13px] font-semibold"
                    style={{
                      color: speakerColors[state.currentSegment.speaker % speakerColors.length]
                    }}
                  >
                    Speaker {state.currentSegment.speaker + 1}
                  </p>
                  <p className="text-sm leading-[1.5]">
                    <span>{state.currentSegment.stableText}</span>
                    {state.currentSegment.previewText && (
                      <span className="text-muted-foreground">
                        {state.currentSegment.previewText}
                      </span>
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
