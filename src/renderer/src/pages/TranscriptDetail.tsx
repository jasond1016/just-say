import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  CheckSquare,
  Copy,
  Download,
  FileText,
  Loader2,
  RefreshCw,
  Trash2,
  User
} from 'lucide-react'

import { BilingualSegment } from '@/components/transcript/BilingualSegment'
import { toSentencePairsFromStored } from '@/lib/transcript-segmentation'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useTranscripts } from '../hooks/useTranscripts'
import { formatDurationShort, formatRelativeDateTime } from '@/i18n'
import { useI18n } from '@/i18n/useI18n'

interface TranscriptDetailProps {
  id: string
  onBack: () => void
}

interface ActionItem {
  content: string
  assignee?: string
}

const speakerColors = ['#7C3AED', '#0EA5E9', '#16A34A', '#F97316', '#E11D48', '#2563EB']

function getStoredSegmentLabel(
  segment: { source: 'system' | 'microphone' | null; speaker: number },
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

function getStoredSegmentColor(segment: {
  source: 'system' | 'microphone' | null
  speaker: number
}): string {
  if (segment.source === 'microphone') {
    return '#E11D48'
  }
  if (segment.source === 'system') {
    return '#2563EB'
  }
  return speakerColors[segment.speaker % speakerColors.length]
}

function formatSegmentTime(index: number, total: number, durationSeconds: number): string {
  if (total <= 1 || durationSeconds <= 0) {
    return '0:00'
  }
  const estimated = Math.floor((index / (total - 1)) * durationSeconds)
  const minutes = Math.floor(estimated / 60)
  const seconds = estimated % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function parseStoredActionItems(json: string | null): ActionItem[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    if (Array.isArray(parsed)) {
      return parsed
        .map((item: unknown) => {
          if (typeof item === 'object' && item !== null) {
            const obj = item as Record<string, unknown>
            return {
              content: String(obj.content || ''),
              assignee: obj.assignee ? String(obj.assignee) : undefined
            }
          }
          return { content: String(item) }
        })
        .filter((item) => item.content.trim().length > 0)
    }
  } catch {
    // ignore
  }
  return []
}

export function TranscriptDetail({ id, onBack }: TranscriptDetailProps): React.JSX.Element {
  const { m, locale } = useI18n()
  const {
    currentTranscript,
    loading,
    error,
    getTranscript,
    deleteTranscript,
    exportTranscript,
    setCurrentTranscript
  } = useTranscripts()
  const [copyStatus, setCopyStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [actionItemsLoading, setActionItemsLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void getTranscript(id)
  }, [getTranscript, id])

  useEffect(() => {
    return () => {
      if (copyFeedbackTimerRef.current) {
        clearTimeout(copyFeedbackTimerRef.current)
      }
    }
  }, [])

  const fullText = useMemo(() => {
    if (!currentTranscript) return ''
    return currentTranscript.segments
      .map((segment) => {
        const pairLines = toSentencePairsFromStored(segment)
          .map((pair) => {
            const translated = pair.translated ? `\n${pair.translated}` : ''
            return `${pair.original}${translated}`
          })
          .join('\n')
        return `${getStoredSegmentLabel(segment, {
          microphone: m.detail.microphoneLabel,
          system: m.detail.systemLabel,
          speakerLabel: m.detail.speakerLabel
        })}: ${pairLines}`
      })
      .join('\n\n')
  }, [currentTranscript, m])

  const speakerCount = useMemo(() => {
    if (!currentTranscript) return 0
    return new Set(
      currentTranscript.segments.map((segment) =>
        segment.source ? `source:${segment.source}` : `speaker:${segment.speaker}`
      )
    ).size
  }, [currentTranscript])

  const storedActionItems = useMemo(
    () => parseStoredActionItems(currentTranscript?.action_items ?? null),
    [currentTranscript?.action_items]
  )
  const hasGeneratedActionItems = currentTranscript?.action_items != null

  const handleCopy = useCallback(async () => {
    if (!fullText) return

    if (copyFeedbackTimerRef.current) {
      clearTimeout(copyFeedbackTimerRef.current)
    }

    try {
      await navigator.clipboard.writeText(fullText)
      setCopyStatus('success')
    } catch (err) {
      console.error('Failed to copy transcript:', err)
      setCopyStatus('error')
    }

    copyFeedbackTimerRef.current = setTimeout(() => {
      setCopyStatus('idle')
      copyFeedbackTimerRef.current = null
    }, 1600)
  }, [fullText])

  const handleDelete = useCallback(() => {
    setDeleteDialogOpen(true)
  }, [])

  const handleDeleteConfirm = useCallback(async () => {
    if (!currentTranscript) return

    const ok = await deleteTranscript(currentTranscript.id)
    setDeleteDialogOpen(false)
    if (ok) {
      onBack()
    }
  }, [currentTranscript, deleteTranscript, onBack])

  const handleExport = useCallback(async () => {
    await exportTranscript(id)
  }, [exportTranscript, id])

  const handleGenerateSummary = useCallback(async () => {
    if (summaryLoading) return
    setSummaryLoading(true)
    setAiError(null)
    try {
      const result = await window.api.generateMeetingSummary(id)
      setCurrentTranscript((prev) => {
        if (!prev || prev.id !== id) return prev
        return {
          ...prev,
          summary: result.summary,
          summary_generated_at: result.generatedAt,
          summary_ai_model: result.model
        }
      })
    } catch (err) {
      console.error('Failed to generate summary:', err)
      setAiError(m.detail.aiError)
    } finally {
      setSummaryLoading(false)
    }
  }, [id, summaryLoading, m, setCurrentTranscript])

  const handleGenerateActionItems = useCallback(async () => {
    if (actionItemsLoading) return
    setActionItemsLoading(true)
    setAiError(null)
    try {
      const result = await window.api.generateMeetingActionItems(id)
      setCurrentTranscript((prev) => {
        if (!prev || prev.id !== id) return prev
        return {
          ...prev,
          action_items: JSON.stringify(result.items),
          action_items_generated_at: result.generatedAt,
          action_items_ai_model: result.model
        }
      })
    } catch (err) {
      console.error('Failed to generate action items:', err)
      setAiError(m.detail.aiError)
    } finally {
      setActionItemsLoading(false)
    }
  }, [id, actionItemsLoading, m, setCurrentTranscript])

  if (loading) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        {m.detail.loading}
      </div>
    )
  }

  if (error || !currentTranscript) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <p>{error || m.detail.notFound}</p>
        <Button onClick={onBack}>{m.detail.back}</Button>
      </div>
    )
  }

  const isMeeting = currentTranscript.source_mode === 'meeting'

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background">
      <header className="flex h-[53px] items-center justify-between border-b px-6">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 rounded-md px-2.5 text-[13px] font-medium"
              onClick={onBack}
            >
              <ArrowLeft className="h-4 w-4" />
              {m.detail.back}
            </Button>
            <h1 className="truncate text-base font-semibold">{currentTranscript.title}</h1>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {formatRelativeDateTime(currentTranscript.created_at, locale)} ·{' '}
            {formatDurationShort(currentTranscript.duration_seconds, locale)} ·{' '}
            {m.detail.speakerCount(speakerCount)}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isMeeting && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-1.5 px-4 text-sm font-medium shadow-[0_1px_2px_rgba(0,0,0,0.05)]"
                onClick={() => void handleGenerateSummary()}
                disabled={summaryLoading}
              >
                {summaryLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : currentTranscript.summary ? (
                  <RefreshCw className="h-4 w-4" />
                ) : (
                  <FileText className="h-4 w-4" />
                )}
                {summaryLoading
                  ? m.detail.generating
                  : currentTranscript.summary
                    ? m.detail.regenerate
                    : m.detail.generateSummary}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-1.5 px-4 text-sm font-medium shadow-[0_1px_2px_rgba(0,0,0,0.05)]"
                onClick={() => void handleGenerateActionItems()}
                disabled={actionItemsLoading}
              >
                {actionItemsLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : hasGeneratedActionItems ? (
                  <RefreshCw className="h-4 w-4" />
                ) : (
                  <CheckSquare className="h-4 w-4" />
                )}
                {actionItemsLoading
                  ? m.detail.generating
                  : hasGeneratedActionItems
                    ? m.detail.regenerate
                    : m.detail.generateActionItems}
              </Button>
            </>
          )}
          <Button
            variant="outline"
            size="sm"
            className={`h-9 gap-1.5 px-4 text-sm font-medium shadow-[0_1px_2px_rgba(0,0,0,0.05)] ${
              copyStatus === 'success'
                ? 'border-emerald-300 bg-emerald-50 text-emerald-600 hover:bg-emerald-100 hover:text-emerald-700'
                : copyStatus === 'error'
                  ? 'border-red-300 bg-red-50 text-red-600 hover:bg-red-100 hover:text-red-700'
                  : ''
            }`}
            onClick={handleCopy}
          >
            <Copy className="h-4 w-4" />
            {copyStatus === 'success'
              ? m.detail.copySuccess
              : copyStatus === 'error'
                ? m.detail.copyFailed
                : m.detail.copy}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 px-4 text-sm font-medium shadow-[0_1px_2px_rgba(0,0,0,0.05)]"
            onClick={() => {
              void handleExport()
            }}
          >
            <Download className="h-4 w-4" />
            {m.detail.export}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 border-red-300 px-4 text-sm font-medium text-red-500 hover:bg-red-50 hover:text-red-600"
            onClick={handleDelete}
          >
            <Trash2 className="h-4 w-4" />
            {m.detail.delete}
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {/* AI error banner */}
        {aiError && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            {aiError}
          </div>
        )}

        {/* Summary card */}
        {currentTranscript.summary && (
          <div className="mb-5 rounded-lg border border-violet-200 bg-violet-50/50 p-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-violet-700">
                <FileText className="h-4 w-4" />
                {m.detail.summaryTitle}
              </h3>
              {currentTranscript.summary_ai_model && (
                <span className="text-xs text-muted-foreground">
                  {m.detail.aiGeneratedAt(currentTranscript.summary_ai_model)}
                </span>
              )}
            </div>
            <div className="prose prose-sm max-w-none text-sm leading-relaxed text-foreground whitespace-pre-wrap">
              {currentTranscript.summary}
            </div>
          </div>
        )}

        {/* Action items card */}
        {hasGeneratedActionItems && (
          <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50/50 p-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-amber-700">
                <CheckSquare className="h-4 w-4" />
                {m.detail.actionItemsTitle}
              </h3>
              {currentTranscript.action_items_ai_model && (
                <span className="text-xs text-muted-foreground">
                  {m.detail.aiGeneratedAt(currentTranscript.action_items_ai_model)}
                </span>
              )}
            </div>
            {storedActionItems.length > 0 ? (
              <ul className="space-y-2">
                {storedActionItems.map((item, index) => (
                  <li key={index} className="flex items-start gap-2 text-sm">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-amber-300 bg-white text-xs font-medium text-amber-600">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="text-foreground">{item.content}</span>
                      {item.assignee && (
                        <span className="ml-2 inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                          <User className="h-3 w-3" />
                          {m.detail.assignee}: {item.assignee}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{m.detail.noActionItems}</p>
            )}
          </div>
        )}

        {/* Transcript segments */}
        <div className="space-y-5">
          {currentTranscript.segments.map((segment, index) => (
            <div key={segment.id} className="flex gap-3">
              <span className="w-10 shrink-0 pt-0.5 text-xs text-muted-foreground">
                {formatSegmentTime(
                  index,
                  currentTranscript.segments.length,
                  currentTranscript.duration_seconds
                )}
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <p
                  className="text-[13px] font-semibold"
                  style={{ color: getStoredSegmentColor(segment) }}
                >
                  {getStoredSegmentLabel(segment, {
                    microphone: m.detail.microphoneLabel,
                    system: m.detail.systemLabel,
                    speakerLabel: m.detail.speakerLabel
                  })}
                </p>
                <BilingualSegment
                  pairs={toSentencePairsFromStored(segment)}
                  originalText={segment.text}
                  translatedText={segment.translated_text}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      <ConfirmDialog
        open={deleteDialogOpen}
        title={m.detail.deleteDialogTitle}
        description={m.detail.deleteConfirm}
        confirmLabel={m.detail.delete}
        cancelLabel={m.common.cancel}
        closeAriaLabel={m.common.close}
        onClose={() => setDeleteDialogOpen(false)}
        onConfirm={handleDeleteConfirm}
      />
    </div>
  )
}
