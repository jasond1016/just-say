import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Headphones, Play, Square } from 'lucide-react'
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
  onViewLastTranscript?: () => void
}

const SPEAKER_COLOR_VARS = [
  'var(--speaker-1)',
  'var(--speaker-2)',
  'var(--speaker-3)',
  'var(--speaker-4)',
  'var(--speaker-5)',
  'var(--speaker-6)'
]
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
  if (segment.source === 'microphone') return 'var(--speaker-mic)'
  if (segment.source === 'system') return 'var(--speaker-system)'
  return SPEAKER_COLOR_VARS[segment.speaker % SPEAKER_COLOR_VARS.length]
}

export function MeetingTranscription({
  state,
  onStart,
  onStop,
  onViewLastTranscript
}: MeetingTranscriptionProps): React.JSX.Element {
  const { m } = useI18n()
  const transcriptRef = useRef<HTMLDivElement>(null)
  const autoFollowRef = useRef(true)
  const [actionInProgress, setActionInProgress] = useState(false)
  const isTranscribing =
    state.status === 'starting' || state.status === 'transcribing' || state.status === 'stopping'
  const hasContent = state.segments.length > 0 || state.currentSegment
  const isStoppedWithContent = !isTranscribing && hasContent
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
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background page-enter">
      {/* ─── Header ─── */}
      <header className="flex items-center gap-3 px-8 py-3">
        <h1 className="font-display text-2xl text-foreground">{m.meeting.title}</h1>

        {/* Recording: timer + stop */}
        {state.status === 'transcribing' && (
          <>
            <span className="inline-flex items-center gap-2 text-[13px] text-[var(--color-recording)]">
              <span className="h-2 w-2 rounded-full bg-[var(--color-recording)] animate-[pulseRecord_1.5s_ease-in-out_infinite]" />
              <span className="font-mono tabular-nums">{formatClock(state.seconds)}</span>
            </span>
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={() => void runAction(onStop)}
              disabled={actionInProgress}
            >
              <Square className="h-3 w-3" />
              <span>{m.meeting.stop}</span>
            </Button>
          </>
        )}

        {state.status === 'error' && (
          <span className="text-[13px] text-destructive">{m.meeting.connectionError}</span>
        )}
      </header>

      <div className="mx-8 border-t border-border" />

      {/* ─── Content ─── */}
      <div
        className="min-h-0 flex-1 overflow-auto px-8 py-6"
        ref={transcriptRef}
        onScroll={handleTranscriptScroll}
      >
        {!hasContent && !isTranscribing ? (
          /* ─── State 1: Empty — guided setup ─── */
          <div className="flex h-full min-h-[280px] flex-col items-start justify-center gap-5 max-w-md">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10">
              <Headphones className="h-5 w-5 text-primary" strokeWidth={1.8} />
            </div>

            <div className="space-y-2">
              <p className="font-display text-xl text-foreground">{m.meeting.emptyTitle}</p>
              <p className="text-[14px] text-muted-foreground leading-relaxed">
                {m.meeting.emptyDescription}
              </p>
            </div>

            <ol className="space-y-1.5 text-[13px] text-muted-foreground leading-relaxed list-none">
              <li className="flex gap-2">
                <span className="font-mono tabular-nums text-muted-foreground/60 shrink-0">1.</span>
                <span>{m.meeting.emptyStep1.replace(/^1\.\s*/, '')}</span>
              </li>
              <li className="flex gap-2">
                <span className="font-mono tabular-nums text-muted-foreground/60 shrink-0">2.</span>
                <span>{m.meeting.emptyStep2.replace(/^2\.\s*/, '')}</span>
              </li>
              <li className="flex gap-2">
                <span className="font-mono tabular-nums text-muted-foreground/60 shrink-0">3.</span>
                <span>{m.meeting.emptyStep3.replace(/^3\.\s*/, '')}</span>
              </li>
            </ol>

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
          /* ─── State 2 & 3: Timeline (recording or stopped-with-content) ─── */
          <div className="relative max-w-3xl">
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
                    <span className="w-[44px] shrink-0 pt-0.5 text-right font-mono tabular-nums text-[11px] text-muted-foreground">
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
                  <span className="w-[44px] shrink-0 pt-0.5 text-right font-mono tabular-nums text-[11px] text-muted-foreground">
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

      {/* ─── State 3: Stopped-with-content footer ─── */}
      {isStoppedWithContent && (
        <footer className="flex items-center gap-3 border-t border-border px-8 py-3 animate-[slideInUp_200ms_var(--ease-out-expo)]">
          <span className="inline-flex items-center gap-1.5 text-[13px] text-[var(--color-success)]">
            <Check className="h-3.5 w-3.5" />
            {m.meeting.savedToHistory}
          </span>

          <div className="flex items-center gap-2 ml-auto">
            {onViewLastTranscript && (
              <Button variant="outline" size="sm" onClick={onViewLastTranscript}>
                {m.meeting.viewTranscript}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              onClick={() => void runAction(onStart)}
              disabled={actionInProgress}
            >
              <Play className="h-3.5 w-3.5" />
              <span>{m.meeting.newRecording}</span>
            </Button>
          </div>
        </footer>
      )}
    </div>
  )
}
