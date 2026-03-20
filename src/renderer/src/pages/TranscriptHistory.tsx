import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useTranscripts, type TranscriptFilterMode } from '../hooks/useTranscripts'
import { getTranscriptSourceMode } from '@/lib/transcript-source'
import { formatDurationShort, formatRelativeDateTime } from '@/i18n'
import { useI18n } from '@/i18n/useI18n'

interface TranscriptHistoryProps {
  onNavigateToDetail: (id: string) => void
}

function ListItemSkeleton(): React.JSX.Element {
  return (
    <div className="flex items-center gap-4 py-4">
      <span className="skeleton h-10 w-[3px] rounded-full shrink-0" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="skeleton h-4 w-2/3 rounded" />
        <div className="skeleton h-3 w-1/4 rounded" />
      </div>
      <div className="skeleton h-5 w-14 rounded-sm shrink-0" />
    </div>
  )
}

export function TranscriptHistory({
  onNavigateToDetail
}: TranscriptHistoryProps): React.JSX.Element {
  const { m, locale } = useI18n()
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

      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !isTypingTarget) {
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
    { id: 'all', label: m.history.filterAll },
    { id: 'ptt', label: m.history.filterPtt },
    { id: 'meeting', label: m.history.filterMeeting }
  ]

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background page-enter">
      <header className="px-8 py-3 space-y-2">
        <div className="flex items-center gap-3">
          <h1 className="font-display text-2xl text-foreground">{m.history.title}</h1>
          <span className="font-mono tabular-nums text-[12px] text-muted-foreground">
            {pagination.total}
          </span>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-0.5">
            {filterOptions.map((option) => {
              const active = filterMode === option.id
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setFilterMode(option.id)}
                  className={`press-scale relative px-2.5 py-1.5 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded-md ${
                    active
                      ? 'text-primary'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {option.label}
                  {active && (
                    <span className="absolute bottom-0 left-2.5 right-2.5 h-[2px] bg-primary rounded-full" />
                  )}
                </button>
              )
            })}
          </div>

          <div className="relative w-[200px]">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={searchInputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={m.history.searchPlaceholder}
              aria-label={m.history.searchAria}
              className="h-8 w-full border border-border bg-transparent pr-3 pl-9 text-[13px] rounded-md outline-none placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:shadow-tinted-sm transition-shadow"
            />
          </div>
        </div>
      </header>

      <div className="mx-8 border-t border-border" />

      {/* List */}
      <div className="min-h-0 flex-1 overflow-auto px-8">
        {loading && (
          <div className="divide-y divide-border">
            <ListItemSkeleton />
            <ListItemSkeleton />
            <ListItemSkeleton />
            <ListItemSkeleton />
            <ListItemSkeleton />
          </div>
        )}

        {!loading && error && (
          <div className="py-6 text-sm text-destructive">
            {m.history.loadFailedPrefix}: {error}
          </div>
        )}

        {!loading && !error && items.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm text-muted-foreground">
              {isSearching
                ? m.history.emptySearch
                : isFiltering
                  ? m.history.emptyFilter
                  : m.history.emptyDefault}
            </p>
            {!isSearching && !isFiltering && (
              <p className="text-[13px] text-muted-foreground/70 max-w-xs">
                {m.history.emptyDefaultGuide}
              </p>
            )}
          </div>
        )}

        {!loading && !error && items.length > 0 && (
          <div className="divide-y divide-border">
            {items.map((transcript, index) => {
              const mode = getTranscriptSourceMode(transcript)
              const kind = mode === 'meeting' ? m.history.meetingBadge : m.history.pttBadge
              const isMeeting = mode === 'meeting'
              return (
                <button
                  key={transcript.id}
                  type="button"
                  onClick={() => onNavigateToDetail(transcript.id)}
                  className="press-scale group flex w-full items-center gap-4 py-4 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30 -mx-2 px-2 rounded-sm"
                  style={{
                    animationName: 'staggerIn',
                    animationDuration: '250ms',
                    animationTimingFunction: 'var(--ease-out-expo)',
                    animationDelay: `${index * 40}ms`,
                    animationFillMode: 'backwards'
                  }}
                >
                  {/* Color indicator */}
                  <span
                    className="h-10 w-[3px] rounded-full shrink-0"
                    style={{
                      backgroundColor: isMeeting
                        ? 'var(--color-success)'
                        : 'var(--color-info)'
                    }}
                  />

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground group-hover:text-primary transition-colors">
                      {transcript.title}
                    </p>
                    <p className="mt-1 font-mono tabular-nums text-[11px] text-muted-foreground">
                      {formatRelativeDateTime(transcript.created_at, locale)}
                      <span className="mx-1.5 opacity-40">·</span>
                      {formatDurationShort(transcript.duration_seconds, locale)}
                    </p>
                  </div>

                  {isMeeting ? (
                    <Badge variant="success">{kind}</Badge>
                  ) : (
                    <Badge variant="info">{kind}</Badge>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Pagination */}
      {!loading && pagination.totalPages > 1 && (
        <footer className="flex items-center justify-center gap-4 border-t border-border px-8 py-3">
          <Button
            variant="ghost"
            size="sm"
            disabled={pagination.page <= 1}
            onClick={() => handlePageChange(pagination.page - 1)}
          >
            {m.history.previous}
          </Button>
          <span className="font-mono tabular-nums text-[11px] text-muted-foreground">
            {m.history.pageLabel(pagination.page, pagination.totalPages)}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={pagination.page >= pagination.totalPages}
            onClick={() => handlePageChange(pagination.page + 1)}
          >
            {m.history.next}
          </Button>
        </footer>
      )}
    </div>
  )
}
