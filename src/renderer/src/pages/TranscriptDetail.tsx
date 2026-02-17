import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Copy, Download, Trash2 } from 'lucide-react'

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

const speakerColors = ['#7C3AED', '#0EA5E9', '#16A34A', '#F97316', '#E11D48', '#2563EB']

function formatSegmentTime(index: number, total: number, durationSeconds: number): string {
  if (total <= 1 || durationSeconds <= 0) {
    return '0:00'
  }
  const estimated = Math.floor((index / (total - 1)) * durationSeconds)
  const minutes = Math.floor(estimated / 60)
  const seconds = estimated % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export function TranscriptDetail({ id, onBack }: TranscriptDetailProps): React.JSX.Element {
  const { m, locale } = useI18n()
  const { currentTranscript, loading, error, getTranscript, deleteTranscript, exportTranscript } =
    useTranscripts()
  const [copyStatus, setCopyStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
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
        return `${m.detail.speakerLabel(segment.speaker + 1)}: ${pairLines}`
      })
      .join('\n\n')
  }, [currentTranscript, m])

  const speakerCount = useMemo(() => {
    if (!currentTranscript) return 0
    return new Set(currentTranscript.segments.map((segment) => segment.speaker)).size
  }, [currentTranscript])

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
                  style={{ color: speakerColors[segment.speaker % speakerColors.length] }}
                >
                  {m.detail.speakerLabel(segment.speaker + 1)}
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
