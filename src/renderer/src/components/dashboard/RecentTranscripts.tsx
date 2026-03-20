import { useEffect, useState, type JSX } from 'react'
import { Badge } from '@/components/ui/badge'
import type { Transcript } from '@/hooks/useTranscripts'
import { getTranscriptSourceMode } from '@/lib/transcript-source'
import { formatDurationShort, formatRelativeDateTime } from '@/i18n'
import { useI18n } from '@/i18n/useI18n'

interface RecentTranscriptsProps {
  onViewAll: () => void
  onOpenTranscript: (id: string) => void
}

function RecentItemSkeleton(): JSX.Element {
  return (
    <div className="flex items-center gap-4 py-3">
      <span className="skeleton h-8 w-[3px] rounded-full shrink-0" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="skeleton h-4 w-3/4 rounded" />
        <div className="skeleton h-3 w-1/3 rounded" />
      </div>
      <div className="skeleton h-5 w-14 rounded-sm shrink-0" />
    </div>
  )
}

export function RecentTranscripts({
  onViewAll,
  onOpenTranscript
}: RecentTranscriptsProps): JSX.Element {
  const { m, locale } = useI18n()
  const [items, setItems] = useState<Transcript[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    void window.api
      .listTranscripts({ page: 1, pageSize: 5 })
      .then((result) => {
        if (!active) return
        setItems((result.items as Transcript[]) || [])
      })
      .catch((err) => {
        console.error('Failed to load recent transcripts:', err)
        if (active) setItems([])
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => { active = false }
  }, [])

  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="font-display text-base text-foreground">
          {m.recentTranscripts.title}
        </h2>
        <button
          type="button"
          className="press-scale text-[13px] text-primary hover:underline underline-offset-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:rounded-sm"
          onClick={onViewAll}
        >
          {m.recentTranscripts.viewAll}
        </button>
      </div>

      {loading && (
        <div className="divide-y divide-border">
          <RecentItemSkeleton />
          <RecentItemSkeleton />
          <RecentItemSkeleton />
        </div>
      )}

      {!loading && items.length === 0 && (
        <div className="py-6 space-y-1.5 text-center">
          <p className="text-[13px] text-muted-foreground">
            {m.recentTranscripts.empty}
          </p>
          <p className="text-[12px] text-muted-foreground/70">
            {m.recentTranscripts.emptyGuide}
          </p>
        </div>
      )}

      {!loading && items.length > 0 && (
        <div className="divide-y divide-border">
          {items.map((item, index) => {
            const mode = getTranscriptSourceMode(item)
            const isMeeting = mode === 'meeting'
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onOpenTranscript(item.id)}
                className="press-scale group flex w-full items-center gap-4 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30 -mx-2 px-2 rounded-sm"
                style={{
                  animationName: 'staggerIn',
                  animationDuration: '300ms',
                  animationTimingFunction: 'var(--ease-out-expo)',
                  animationDelay: `${index * 50}ms`,
                  animationFillMode: 'backwards'
                }}
              >
                {/* Left color indicator */}
                <span
                  className="h-8 w-[3px] rounded-full shrink-0"
                  style={{
                    backgroundColor: isMeeting
                      ? 'var(--color-success)'
                      : 'var(--color-info)'
                  }}
                />

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground group-hover:text-primary transition-colors">{item.title}</p>
                  <p className="mt-0.5 text-[12px] text-muted-foreground font-mono tabular-nums">
                    {formatRelativeDateTime(item.created_at, locale)}
                    <span className="mx-1.5 opacity-40">·</span>
                    {formatDurationShort(item.duration_seconds, locale)}
                  </p>
                </div>

                {isMeeting ? (
                  <Badge variant="success">{m.recentTranscripts.meetingBadge}</Badge>
                ) : (
                  <Badge variant="info">{m.recentTranscripts.pttBadge}</Badge>
                )}
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}
