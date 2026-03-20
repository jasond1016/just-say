import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  CheckSquare,
  Copy,
  Download,
  FileText,
  Loader2,
  MoreHorizontal,
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

const speakerColors = ['#B8632F', '#3B6B96', '#5D7A4F', '#B8862F', '#8B4F6F', '#4F6B8B']

function getStoredSegmentLabel(
  segment: { source: 'system' | 'microphone' | null; speaker: number },
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

function getStoredSegmentColor(segment: {
  source: 'system' | 'microphone' | null
  speaker: number
}): string {
  if (segment.source === 'microphone') return '#8B4F6F'
  if (segment.source === 'system') return '#3B6B96'
  return speakerColors[segment.speaker % speakerColors.length]
}

function formatSegmentTime(index: number, total: number, durationSeconds: number): string {
  if (total <= 1 || durationSeconds <= 0) return '0:00'
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
  } catch { /* ignore */ }
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
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [actionItemsLoading, setActionItemsLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void getTranscript(id)
  }, [getTranscript, id])

  useEffect(() => {
    return () => {
      if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current)
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
    if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current)

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

  const handleDelete = useCallback(() => { setDeleteDialogOpen(true) }, [])

  const handleDeleteConfirm = useCallback(async () => {
    if (!currentTranscript) return
    const ok = await deleteTranscript(currentTranscript.id)
    setDeleteDialogOpen(false)
    if (ok) onBack()
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
        return { ...prev, summary: result.summary, summary_generated_at: result.generatedAt, summary_ai_model: result.model }
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
        return { ...prev, action_items: JSON.stringify(result.items), action_items_generated_at: result.generatedAt, action_items_ai_model: result.model }
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
        <Button variant="outline" size="sm" onClick={onBack}>{m.detail.back}</Button>
      </div>
    )
  }

  const isMeeting = currentTranscript.source_mode === 'meeting'

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background">
      <header
        className="flex flex-col justify-end px-8 pb-3 pr-[140px]"
        style={{ WebkitAppRegion: 'drag', minHeight: 52 } as React.CSSProperties}
      >
        <div className="flex items-center gap-3 mb-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
            <ArrowLeft className="h-4 w-4" />
            {m.detail.back}
          </Button>
        </div>

        <div className="flex items-start justify-between" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-2xl italic text-foreground truncate">
              {currentTranscript.title}
            </h1>
            <p className="mt-1 font-mono text-[12px] text-muted-foreground">
              {formatRelativeDateTime(currentTranscript.created_at, locale)}
              <span className="mx-1.5 opacity-40">·</span>
              {formatDurationShort(currentTranscript.duration_seconds, locale)}
              <span className="mx-1.5 opacity-40">·</span>
              {m.detail.speakerCount(speakerCount)}
            </p>
          </div>

          {/* Primary action: Copy (most common read-mode action) */}
          <div className="flex items-center gap-1.5 shrink-0 ml-4">
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopy}
              className={
                copyStatus === 'success'
                  ? 'text-[var(--color-success)] border-[var(--color-success)]/30'
                  : copyStatus === 'error'
                    ? 'text-destructive border-destructive/30'
                    : ''
              }
            >
              <Copy className="h-3.5 w-3.5" />
              {copyStatus === 'success' ? m.detail.copySuccess : copyStatus === 'error' ? m.detail.copyFailed : m.detail.copy}
            </Button>

            {/* Secondary actions — dropdown */}
            <div className="relative">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setMoreMenuOpen((prev) => !prev)}
                className="text-muted-foreground"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>

              {moreMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setMoreMenuOpen(false)} />
                  <div className="absolute right-0 top-full mt-1 z-50 w-56 bg-card border border-border py-1 rounded-md shadow-lg animate-[slideInUp_150ms_var(--ease-out-expo)]">
                    {isMeeting && (
                      <>
                        <button
                          type="button"
                          className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] text-foreground hover:bg-accent transition-colors disabled:opacity-40"
                          onClick={() => { setMoreMenuOpen(false); void handleGenerateSummary() }}
                          disabled={summaryLoading}
                        >
                          {summaryLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5 text-muted-foreground" />}
                          {summaryLoading ? m.detail.generating : currentTranscript.summary ? m.detail.regenerate + ' ' + m.detail.generateSummary : m.detail.generateSummary}
                        </button>
                        <button
                          type="button"
                          className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] text-foreground hover:bg-accent transition-colors disabled:opacity-40"
                          onClick={() => { setMoreMenuOpen(false); void handleGenerateActionItems() }}
                          disabled={actionItemsLoading}
                        >
                          {actionItemsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckSquare className="h-3.5 w-3.5 text-muted-foreground" />}
                          {actionItemsLoading ? m.detail.generating : hasGeneratedActionItems ? m.detail.regenerate + ' ' + m.detail.generateActionItems : m.detail.generateActionItems}
                        </button>
                        <div className="my-1 border-t border-border" />
                      </>
                    )}
                    <button
                      type="button"
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] text-foreground hover:bg-accent transition-colors"
                      onClick={() => { setMoreMenuOpen(false); void handleExport() }}
                    >
                      <Download className="h-3.5 w-3.5 text-muted-foreground" />
                      {m.detail.export}
                    </button>
                    <div className="my-1 border-t border-border" />
                    <button
                      type="button"
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] text-destructive hover:bg-accent transition-colors"
                      onClick={() => { setMoreMenuOpen(false); handleDelete() }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {m.detail.delete}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="mx-8 border-t border-border" />

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-auto px-8 py-6">
        {/* AI error banner */}
        {aiError && (
          <div className="mb-5 border-l-2 border-destructive bg-[var(--color-danger-bg)] px-4 py-3 text-sm text-destructive">
            {aiError}
          </div>
        )}

        {/* Summary */}
        {currentTranscript.summary && (
          <div className="mb-6 border-l-2 border-primary bg-primary/5 px-5 py-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-primary">
                <FileText className="h-3.5 w-3.5" />
                {m.detail.summaryTitle}
              </h3>
              {currentTranscript.summary_ai_model && (
                <span className="font-mono text-[11px] text-muted-foreground">
                  {m.detail.aiGeneratedAt(currentTranscript.summary_ai_model)}
                </span>
              )}
            </div>
            <div className="text-sm leading-relaxed text-foreground whitespace-pre-wrap">
              {currentTranscript.summary}
            </div>
          </div>
        )}

        {/* Action items */}
        {hasGeneratedActionItems && (
          <div className="mb-6 border-l-2 border-[var(--color-warning)] bg-[var(--color-warning-bg)] px-5 py-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-warning)]">
                <CheckSquare className="h-3.5 w-3.5" />
                {m.detail.actionItemsTitle}
              </h3>
              {currentTranscript.action_items_ai_model && (
                <span className="font-mono text-[11px] text-muted-foreground">
                  {m.detail.aiGeneratedAt(currentTranscript.action_items_ai_model)}
                </span>
              )}
            </div>
            {storedActionItems.length > 0 ? (
              <ul className="space-y-2">
                {storedActionItems.map((item, index) => (
                  <li key={index} className="flex items-start gap-3 text-sm">
                    <span className="font-mono text-[12px] text-[var(--color-warning)] font-medium shrink-0 pt-0.5 w-5 text-right">
                      {index + 1}.
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="text-foreground">{item.content}</span>
                      {item.assignee && (
                        <span className="ml-2 inline-flex items-center gap-1 text-[12px] text-[var(--color-warning)]">
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

        {/* Transcript segments — screenplay format */}
        <div className="relative">
          {/* Timeline rail */}
          <div className="absolute left-[52px] top-0 bottom-0 w-px bg-border" />

          <div className="space-y-0">
            {currentTranscript.segments.map((segment, index) => (
              <div
                key={segment.id}
                className="flex gap-4 py-3"
                style={{
                  animationName: 'staggerIn',
                  animationDuration: '300ms',
                  animationTimingFunction: 'var(--ease-out-expo)',
                  animationDelay: `${Math.min(index * 30, 600)}ms`,
                  animationFillMode: 'backwards'
                }}
              >
                <span className="w-[44px] shrink-0 pt-0.5 text-right font-mono text-[11px] text-muted-foreground">
                  {formatSegmentTime(index, currentTranscript.segments.length, currentTranscript.duration_seconds)}
                </span>

                {/* Timeline dot */}
                <div className="relative flex shrink-0 items-start pt-1.5">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: getStoredSegmentColor(segment) }}
                  />
                </div>

                <div className="min-w-0 flex-1 space-y-0.5">
                  <p
                    className="text-[12px] font-semibold tracking-wide uppercase"
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
