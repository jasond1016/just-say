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
    <section className="animate-[slideInUp_400ms_var(--ease-out-expo)_200ms] animate-fill-backwards">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="font-display text-lg italic text-foreground">
          {m.recentTranscripts.title}
        </h2>
        <button
          type="button"
          className="text-[13px] text-primary hover:underline underline-offset-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:rounded-sm"
          onClick={onViewAll}
        >
          {m.recentTranscripts.viewAll}
        </button>
      </div>

      {loading && (
        <p className="text-[13px] text-muted-foreground py-4">
          {m.recentTranscripts.loading}
        </p>
      )}

      {!loading && items.length === 0 && (
        <p className="text-[13px] text-muted-foreground py-4">
          {m.recentTranscripts.empty}
        </p>
      )}

      {!loading && items.length > 0 && (
        <div className="divide-y divide-border">
          {items.map((item) => {
            const mode = getTranscriptSourceMode(item)
            const isMeeting = mode === 'meeting'
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onOpenTranscript(item.id)}
                className="group flex w-full items-center gap-4 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30 -mx-2 px-2 rounded-sm"
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
                  <p className="truncate text-sm font-medium text-foreground">{item.title}</p>
                  <p className="mt-0.5 text-[12px] text-muted-foreground font-mono">
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
