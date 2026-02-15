import React, { useCallback, useEffect, useMemo } from 'react'
import { ArrowLeft, Copy, Download, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTranscripts } from '../hooks/useTranscripts'

interface TranscriptDetailProps {
  id: string
  onBack: () => void
}

function formatDateLabel(isoString: string): string {
  const date = new Date(isoString)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

  if (isToday) {
    return `Today, ${time}`
  }

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday, ${time}`
  }

  return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  if (minutes === 0) {
    return `${remaining}s`
  }
  return `${minutes} min`
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

export function TranscriptDetail({ id, onBack }: TranscriptDetailProps): React.JSX.Element {
  const { currentTranscript, loading, error, getTranscript, deleteTranscript, exportTranscript } =
    useTranscripts()

  useEffect(() => {
    void getTranscript(id)
  }, [getTranscript, id])

  const fullText = useMemo(() => {
    if (!currentTranscript) return ''
    return currentTranscript.segments
      .map((segment) => {
        const translated = segment.translated_text ? `\n${segment.translated_text}` : ''
        return `Speaker ${segment.speaker + 1}: ${segment.text}${translated}`
      })
      .join('\n\n')
  }, [currentTranscript])

  const speakerCount = useMemo(() => {
    if (!currentTranscript) return 0
    return new Set(currentTranscript.segments.map((segment) => segment.speaker)).size
  }, [currentTranscript])

  const handleCopy = useCallback(async () => {
    if (!fullText) return
    try {
      await navigator.clipboard.writeText(fullText)
    } catch (err) {
      console.error('Failed to copy transcript:', err)
    }
  }, [fullText])

  const handleDelete = useCallback(async () => {
    if (!currentTranscript) return
    const confirmed = window.confirm('Delete this transcript? This action cannot be undone.')
    if (!confirmed) return

    const ok = await deleteTranscript(currentTranscript.id)
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
        Loading transcript...
      </div>
    )
  }

  if (error || !currentTranscript) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <p>{error || 'Transcript not found.'}</p>
        <Button onClick={onBack}>Back</Button>
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
              Back
            </Button>
            <h1 className="truncate text-base font-semibold">{currentTranscript.title}</h1>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {formatDateLabel(currentTranscript.created_at)} ·{' '}
            {formatDuration(currentTranscript.duration_seconds)} · {speakerCount} speakers
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 px-4 text-sm font-medium shadow-[0_1px_2px_rgba(0,0,0,0.05)]"
            onClick={handleCopy}
          >
            <Copy className="h-4 w-4" />
            Copy
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
            Export
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 border-red-300 px-4 text-sm font-medium text-red-500 hover:bg-red-50 hover:text-red-600"
            onClick={handleDelete}
          >
            <Trash2 className="h-4 w-4" />
            Delete
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
                <p className="text-[13px] font-semibold text-[#7C3AED]">
                  Speaker {segment.speaker + 1}
                </p>
                <p className="text-sm leading-[1.5]">{segment.text}</p>
                {segment.translated_text && (
                  <p className="text-sm leading-[1.5] text-emerald-500">
                    {segment.translated_text}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
