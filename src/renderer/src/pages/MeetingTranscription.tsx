import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Headphones, Play, Settings2, Square } from 'lucide-react'
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
  onOpenSettings?: () => void
  onStart: () => Promise<void>
  onStopAndReturn: () => Promise<void>
  onReturnToWorkspace: () => void
}

const speakerColors = ['#7C3AED', '#0EA5E9', '#16A34A', '#F97316', '#E11D48', '#2563EB']
const BOTTOM_FOLLOW_THRESHOLD_PX = 24

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function isNearBottom(element: HTMLDivElement, thresholdPx = BOTTOM_FOLLOW_THRESHOLD_PX): boolean {
  const distanceToBottom = element.scrollHeight - (element.scrollTop + element.clientHeight)
  return distanceToBottom <= thresholdPx
}

function getInlinePreviewText(segment: SpeakerSegment): string | undefined {
  const previewText = segment.unstableText || ''
  if (!previewText.trim()) {
    return undefined
  }

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
  if (segment.source === 'microphone') {
    return labels.microphone
  }
  if (segment.source === 'system') {
    return labels.system
  }
  return labels.speakerLabel(segment.speaker + 1)
}

function getSegmentColor(segment: SpeakerSegment): string {
  if (segment.source === 'microphone') {
    return '#E11D48'
  }
  if (segment.source === 'system') {
    return '#2563EB'
  }
  return speakerColors[segment.speaker % speakerColors.length]
}

export function MeetingTranscription({
  state,
  onOpenSettings,
  onStart,
  onStopAndReturn,
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

  const handleTranscriptScroll = (event: React.UIEvent<HTMLDivElement>): void => {
    autoFollowRef.current = isNearBottom(event.currentTarget)
  }

  useEffect(() => {
    if (!hasContent) {
      autoFollowRef.current = true
    }
  }, [hasContent])

  useEffect(() => {
    const container = transcriptRef.current
    if (!container || !autoFollowRef.current) {
      return
    }
    container.scrollTop = container.scrollHeight
  }, [state.segments, state.currentSegment])

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background">
      <header className="flex h-[53px] items-center justify-between border-b px-6">
        <div className="flex items-center gap-3">
          <Headphones className="h-5 w-5 text-[#7C3AED]" />
          <h1 className="text-[18px] leading-none font-semibold">{m.meeting.title}</h1>
          {state.status === 'transcribing' && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#FEF2F2] px-2.5 py-1 text-xs font-medium text-red-500">
              <span className="h-2 w-2 rounded-full bg-red-500" />
              <span>
                {m.meeting.recording} · {formatClock(state.seconds)}
              </span>
            </span>
          )}
          {state.status === 'error' && (
            <span className="inline-flex items-center rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-500">
              {m.meeting.connectionError}
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
                <span>{m.meeting.back}</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 px-4 text-sm font-medium"
                onClick={onOpenSettings}
              >
                <Settings2 className="h-4 w-4" />
                <span>{m.meeting.settings}</span>
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
              <span>{m.meeting.stopAndReturn}</span>
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
              <span>{m.meeting.startRecording}</span>
            </Button>
          )}
        </div>
      </header>

      <div
        className="min-h-0 flex-1 overflow-auto px-6 py-5"
        ref={transcriptRef}
        onScroll={handleTranscriptScroll}
      >
        {!hasContent && !isTranscribing ? (
          <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-6 text-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[#F3F0FF]">
              <Headphones className="h-7 w-7 text-[#7C3AED]" />
            </div>
            <div className="space-y-1">
              <p className="text-[20px] leading-[1.2] font-semibold">{m.meeting.emptyTitle}</p>
              <p className="text-muted-foreground max-w-sm text-sm">{m.meeting.emptyDescription}</p>
              {state.isPreconnecting && !state.preconnectFailed && (
                <p className="text-muted-foreground text-xs">{m.meeting.warmingUp}</p>
              )}
              {state.preconnectFailed && (
                <p className="text-xs text-amber-600">{m.meeting.warmupFailed}</p>
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
              <span>{m.meeting.startRecording}</span>
            </Button>
          </div>
        ) : (
          <div className="space-y-5">
            {state.segments.map((segment) => {
              const speakerColor = getSegmentColor(segment)
              const segmentKey =
                typeof segment.timestamp === 'number'
                  ? `${segment.source || 'unknown'}-${segment.timestamp}`
                  : `${segment.source || 'unknown'}-${segment.speaker}-${segment.text}`

              return (
                <div key={segmentKey} className="flex gap-3 text-sm">
                  <span className="w-10 shrink-0 pt-0.5 text-xs text-muted-foreground">
                    {formatSegmentTime(segment.timestamp)}
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-[13px] font-semibold" style={{ color: speakerColor }}>
                      {getSegmentLabel(segment, {
                        microphone: m.meeting.microphoneLabel,
                        system: m.meeting.systemLabel,
                        speakerLabel: m.meeting.speakerLabel
                      })}
                    </p>
                    <BilingualSegment pairs={toSentencePairsFromLive(segment)} />
                  </div>
                </div>
              )
            })}

            {state.currentSegment && (
              <div className="flex gap-3 text-sm">
                <span className="w-10 shrink-0 pt-0.5 text-xs text-muted-foreground">
                  {formatSegmentTime(state.currentSegment.timestamp)}
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <p
                    className="text-[13px] font-semibold"
                    style={{ color: getSegmentColor(state.currentSegment) }}
                  >
                    {getSegmentLabel(state.currentSegment, {
                      microphone: m.meeting.microphoneLabel,
                      system: m.meeting.systemLabel,
                      speakerLabel: m.meeting.speakerLabel
                    })}
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
                  {/* <WordTimingTrail
                    wordTimings={state.currentSegment.wordTimings}
                    previewText={state.currentSegment.unstableText}
                    label={m.meeting.liveWordTimings}
                    previewLabel={m.meeting.previewTail}
                  /> */}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
