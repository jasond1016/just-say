import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Headphones, Play, Square } from 'lucide-react'
import type { SpeakerSegment } from '../../../shared/transcription-types'

import { BilingualSegment } from '@/components/transcript/BilingualSegment'
import {
  toSentencePairsFromCurrentLive,
  toSentencePairsFromLive
} from '@/lib/transcript-segmentation'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n/useI18n'

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
  onStart: () => Promise<void>
  onStop: () => Promise<void>
  onReturnToWorkspace: () => void
}

const speakerColors = ['#B8632F', '#3B6B96', '#5D7A4F', '#B8862F', '#8B4F6F', '#4F6B8B']
const BOTTOM_FOLLOW_THRESHOLD_PX = 24

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function isNearBottom(element: HTMLDivElement, thresholdPx = BOTTOM_FOLLOW_THRESHOLD_PX): boolean {
  return element.scrollHeight - (element.scrollTop + element.clientHeight) <= thresholdPx
}

function getInlinePreviewText(segment: SpeakerSegment): string | undefined {
  const previewText = segment.unstableTailText || ''
  if (!previewText.trim()) return undefined
  return segment.text.endsWith(previewText) && segment.text !== previewText
    ? previewText
    : undefined
}

function getSegmentLabel(
  segment: SpeakerSegment,
  labels: {
    microphone: string
    system: string
    speakerLabel: (index: number) => string
  }
): string {
  if (segment.source === 'microphone') return labels.microphone
  if (segment.source === 'system') return labels.system
  return labels.speakerLabel(segment.speaker + 1)
}

function getSegmentColor(segment: SpeakerSegment): string {
  if (segment.source === 'microphone') return '#8B4F6F'
  if (segment.source === 'system') return '#3B6B96'
  return speakerColors[segment.speaker % speakerColors.length]
}

export function MeetingTranscription({
  state,
  onStart,
  onStop,
  onReturnToWorkspace
}: MeetingTranscriptionProps): React.JSX.Element {
  const { m } = useI18n()
  const transcriptRef = useRef<HTMLDivElement>(null)
  const autoFollowRef = useRef(true)
  const [actionInProgress, setActionInProgress] = useState(false)
  const isTranscribing =
    state.status === 'starting' || state.status === 'transcribing' || state.status === 'stopping'
  const hasContent = state.segments.length > 0 || state.currentSegment
  const currentInlinePreviewText = state.currentSegment
    ? getInlinePreviewText(state.currentSegment)
    : undefined

  const formatSegmentTime = useMemo(
    () =>
      (timestamp?: number): string => {
        if (!timestamp || !state.startedAt) return '--:--'
        const elapsed = Math.max(0, Math.floor((timestamp - state.startedAt) / 1000))
        return formatClock(elapsed)
      },
    [state.startedAt]
  )

  const runAction = async (action: () => Promise<void>): Promise<void> => {
    if (actionInProgress) return
    setActionInProgress(true)
    try { await action() } finally { setActionInProgress(false) }
  }

  const handleTranscriptScroll = (event: React.UIEvent<HTMLDivElement>): void => {
    autoFollowRef.current = isNearBottom(event.currentTarget)
  }

  useEffect(() => {
    if (!hasContent) autoFollowRef.current = true
  }, [hasContent])

  useEffect(() => {
    const container = transcriptRef.current
    if (!container || !autoFollowRef.current) return
    container.scrollTop = container.scrollHeight
  }, [state.segments, state.currentSegment])

  const segmentLabels = useMemo(
    () => ({
      microphone: m.meeting.microphoneLabel,
      system: m.meeting.systemLabel,
      speakerLabel: m.meeting.speakerLabel
    }),
    [m]
  )

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background">
      <header
        className="flex items-end justify-between px-8 pb-2"
        style={{ WebkitAppRegion: 'drag', minHeight: 52 } as React.CSSProperties}
      >
        <div className="flex items-baseline gap-3" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <h1 className="font-display text-2xl text-foreground italic">{m.meeting.title}</h1>

          {state.status === 'transcribing' && (
            <span className="inline-flex items-center gap-2 text-[13px] text-[var(--color-recording)]">
              <span className="h-2 w-2 rounded-full bg-[var(--color-recording)] animate-[pulseRecord_1.5s_ease-in-out_infinite]" />
              <span className="font-mono">{formatClock(state.seconds)}</span>
            </span>
          )}

          {state.status === 'error' && (
            <span className="text-[13px] text-destructive">{m.meeting.connectionError}</span>
          )}
        </div>

        <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {!isTranscribing && (
            <Button variant="ghost" size="sm" onClick={onReturnToWorkspace}>
              <ArrowLeft className="h-4 w-4" />
              <span>{m.meeting.back}</span>
            </Button>
          )}

          {isTranscribing ? (
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={() => void runAction(onStop)}
              disabled={actionInProgress || state.status === 'starting'}
            >
              <Square className="h-3.5 w-3.5" />
              <span>{m.meeting.stop}</span>
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={() => void runAction(onStart)}
              disabled={actionInProgress}
            >
              <Play className="h-3.5 w-3.5" />
              <span>{m.meeting.startRecording}</span>
            </Button>
          )}
        </div>
      </header>

      <div className="mx-8 border-t border-border" />

      {/* Transcript body */}
      <div
        className="min-h-0 flex-1 overflow-auto px-8 py-6"
        ref={transcriptRef}
        onScroll={handleTranscriptScroll}
      >
        {!hasContent && !isTranscribing ? (
          /* ─── Empty state: guided setup ─── */
          <div className="flex h-full min-h-[280px] flex-col items-start justify-center gap-6 max-w-lg">
            <div className="space-y-3">
              <Headphones className="h-6 w-6 text-primary mb-2" strokeWidth={1.6} />
              <p className="font-display text-xl italic text-foreground">{m.meeting.emptyTitle}</p>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {m.meeting.emptyDescription}
              </p>
            </div>

            {/* Setup steps */}
            <div className="space-y-2 text-[13px] text-muted-foreground leading-relaxed">
              <p>{m.meeting.emptyStep1}</p>
              <p>{m.meeting.emptyStep2}</p>
              <p>{m.meeting.emptyStep3}</p>
            </div>

            {state.isPreconnecting && !state.preconnectFailed && (
              <p className="text-xs text-muted-foreground">{m.meeting.warmingUp}</p>
            )}
            {state.preconnectFailed && (
              <p className="text-xs text-[var(--color-warning)]">{m.meeting.warmupFailed}</p>
            )}
            {state.lastError && <p className="text-xs text-destructive">{state.lastError}</p>}

            <Button
              type="button"
              size="sm"
              onClick={() => void runAction(onStart)}
              disabled={actionInProgress}
            >
              <Play className="h-3.5 w-3.5" />
              <span>{m.meeting.startRecording}</span>
            </Button>
          </div>
        ) : (
          /* ─── Transcript timeline ─── */
          <div className="relative">
            <div className="absolute left-[52px] top-0 bottom-0 w-px bg-border" />

            <div className="space-y-0">
              {state.segments.map((segment) => {
                const speakerColor = getSegmentColor(segment)
                const segmentKey =
                  typeof segment.timestamp === 'number'
                    ? `${segment.source || 'unknown'}-${segment.timestamp}`
                    : `${segment.source || 'unknown'}-${segment.speaker}-${segment.text}`

                return (
                  <div key={segmentKey} className="flex gap-4 py-3 animate-[staggerIn_300ms_var(--ease-out-expo)] animate-fill-backwards">
                    <span className="w-[44px] shrink-0 pt-0.5 text-right font-mono text-[11px] text-muted-foreground">
                      {formatSegmentTime(segment.timestamp)}
                    </span>
                    <div className="relative flex shrink-0 items-start pt-1.5">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: speakerColor }} />
                    </div>
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="text-[12px] font-semibold tracking-wide uppercase" style={{ color: speakerColor }}>
                        {getSegmentLabel(segment, segmentLabels)}
                      </p>
                      <BilingualSegment pairs={toSentencePairsFromLive(segment)} />
                    </div>
                  </div>
                )
              })}

              {state.currentSegment && (
                <div className="flex gap-4 py-3">
                  <span className="w-[44px] shrink-0 pt-0.5 text-right font-mono text-[11px] text-muted-foreground">
                    {formatSegmentTime(state.currentSegment.timestamp)}
                  </span>
                  <div className="relative flex shrink-0 items-start pt-1.5">
                    <span
                      className="h-2 w-2 rounded-full animate-[pulseRecord_1.5s_ease-in-out_infinite]"
                      style={{ backgroundColor: getSegmentColor(state.currentSegment) }}
                    />
                  </div>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p
                      className="text-[12px] font-semibold tracking-wide uppercase"
                      style={{ color: getSegmentColor(state.currentSegment) }}
                    >
                      {getSegmentLabel(state.currentSegment, segmentLabels)}
                    </p>
                    {state.currentSegment.endpointReason && (
                      <p className="text-[11px] text-muted-foreground">
                        {m.meeting.endpointLabel}: {state.currentSegment.endpointReason}
                      </p>
                    )}
                    <BilingualSegment
                      pairs={toSentencePairsFromCurrentLive(state.currentSegment)}
                      previewText={currentInlinePreviewText}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
