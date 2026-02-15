import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Clock3, Search } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useTranscripts, type TranscriptFilterMode } from '../hooks/useTranscripts'
import { getTranscriptSourceMode } from '@/lib/transcript-source'

interface TranscriptHistoryProps {
  onNavigateToDetail: (id: string) => void
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
  const remainingSeconds = seconds % 60
  if (minutes === 0) {
    return `${remainingSeconds}s`
  }
  return `${minutes} min`
}

export function TranscriptHistory({
  onNavigateToDetail
}: TranscriptHistoryProps): React.JSX.Element {
  const { transcripts, loading, error, pagination, listTranscripts, searchTranscripts } =
    useTranscripts()
  const [query, setQuery] = useState('')
  const [filterMode, setFilterMode] = useState<TranscriptFilterMode>('all')
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const isSearching = query.trim().length > 0
  const isFiltering = filterMode !== 'all'

  useEffect(() => {
    const timer = setTimeout(() => {
      if (query.trim()) {
        searchTranscripts(query.trim(), 1, filterMode)
      } else {
        listTranscripts(1, filterMode)
      }
    }, 240)

    return () => clearTimeout(timer)
  }, [filterMode, listTranscripts, query, searchTranscripts])

  const handlePageChange = useCallback(
    (page: number) => {
      if (isSearching) {
        searchTranscripts(query.trim(), page, filterMode)
      } else {
        listTranscripts(page, filterMode)
      }
    },
    [filterMode, isSearching, listTranscripts, query, searchTranscripts]
  )

  const items = useMemo(() => transcripts, [transcripts])

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent): void => {
      const activeElement = document.activeElement
      const isTypingTarget =
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        (activeElement instanceof HTMLElement && activeElement.isContentEditable)

      if (
        event.key === '/' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isTypingTarget
      ) {
        event.preventDefault()
        searchInputRef.current?.focus()
        return
      }

      if (event.key === 'Escape' && activeElement === searchInputRef.current && query) {
        event.preventDefault()
        setQuery('')
      }
    }

    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [query])

  const filterOptions: Array<{ id: TranscriptFilterMode; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'ptt', label: 'PTT' },
    { id: 'meeting', label: 'Meeting' }
  ]

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background">
      <header className="flex h-[53px] items-center justify-between border-b px-6">
        <div className="flex items-center gap-3">
          <Clock3 className="h-5 w-5 text-[#7C3AED]" />
          <h1 className="text-[18px] leading-none font-semibold">Transcript History</h1>
          <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {pagination.total}
          </span>
          <div className="ml-1 flex items-center gap-1">
            {filterOptions.map((option) => {
              const active = filterMode === option.id
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setFilterMode(option.id)}
                  className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7C3AED]/35 ${
                    active
                      ? 'border-[#7C3AED]/30 bg-[#F5F3FF] text-[#6D28D9]'
                      : 'border-border text-muted-foreground hover:bg-muted/30'
                  }`}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="relative w-[220px]">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search transcripts..."
            aria-label="Search transcripts"
            className="h-8 w-full rounded-md border border-input bg-background pr-3 pl-9 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-[#7C3AED]/35"
          />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading transcripts...
          </div>
        )}

        {!loading && error && (
          <div className="px-6 py-4 text-sm text-red-600">Failed to load transcripts: {error}</div>
        )}

        {!loading && !error && items.length === 0 && (
          <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
            {isSearching
              ? 'No matching transcripts.'
              : isFiltering
                ? 'No transcripts in this filter.'
                : 'No transcripts yet.'}
          </div>
        )}

        {!loading && !error && items.length > 0 && (
          <div className="py-2">
            {items.map((transcript, index) => {
              const mode = getTranscriptSourceMode(transcript)
              const kind = mode === 'meeting' ? 'Meeting' : 'PTT'
              return (
                <button
                  key={transcript.id}
                  type="button"
                  onClick={() => onNavigateToDetail(transcript.id)}
                  className={`flex w-full items-center justify-between px-6 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#7C3AED]/35 ${
                    index === 0 ? 'bg-secondary' : 'hover:bg-muted/30'
                  } ${index < items.length - 1 ? 'border-b border-border' : ''}`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{transcript.title}</p>
                    <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{formatDateLabel(transcript.created_at)}</span>
                      <span>· {formatDuration(transcript.duration_seconds)}</span>
                    </div>
                  </div>

                  <div className="ml-4 flex items-center gap-3">
                    {kind === 'Meeting' ? (
                      <Badge variant="success" className="px-2 py-[3px] text-[11px]">
                        Meeting
                      </Badge>
                    ) : (
                      <Badge variant="info" className="px-2 py-[3px] text-[11px]">
                        PTT
                      </Badge>
                    )}
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {!loading && pagination.totalPages > 1 && (
        <footer className="flex items-center justify-center gap-4 border-t px-6 py-3">
          <Button
            variant="outline"
            size="sm"
            disabled={pagination.page <= 1}
            onClick={() => handlePageChange(pagination.page - 1)}
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            Page {pagination.page} / {pagination.totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={pagination.page >= pagination.totalPages}
            onClick={() => handlePageChange(pagination.page + 1)}
          >
            Next
          </Button>
        </footer>
      )}
    </div>
  )
}
