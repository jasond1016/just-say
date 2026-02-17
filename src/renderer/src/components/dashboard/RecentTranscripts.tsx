import { useEffect, useState, type JSX } from 'react'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
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
      .listTranscripts({ page: 1, pageSize: 3 })
      .then((result) => {
        if (!active) return
        setItems((result.items as Transcript[]) || [])
      })
      .catch((err) => {
        console.error('Failed to load recent transcripts:', err)
        if (active) {
          setItems([])
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false)
        }
      })

    return () => {
      active = false
    }
  }, [])

  return (
    <section className="flex w-full flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">{m.recentTranscripts.title}</h2>
        <button
          type="button"
          className="rounded px-1 text-[13px] font-medium text-[#7C3AED] transition-colors hover:text-[#6D28D9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7C3AED]/40"
          onClick={onViewAll}
        >
          {m.recentTranscripts.viewAll}
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border">
        {loading && (
          <div className="px-4 py-3 text-[13px] text-muted-foreground">
            {m.recentTranscripts.loading}
          </div>
        )}

        {!loading && items.length === 0 && (
          <div className="px-4 py-3 text-[13px] text-muted-foreground">
            {m.recentTranscripts.empty}
          </div>
        )}

        {!loading &&
          items.map((item, index) => {
            const mode = getTranscriptSourceMode(item)
            const isMeeting = mode === 'meeting'
            return (
              <div key={item.id}>
                <button
                  type="button"
                  onClick={() => onOpenTranscript(item.id)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#7C3AED]/30"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium">{item.title}</p>
                    <p className="text-muted-foreground text-[11px]">
                      {formatRelativeDateTime(item.created_at, locale)} ·{' '}
                      {formatDurationShort(item.duration_seconds, locale)}
                    </p>
                  </div>
                  {isMeeting ? (
                    <Badge variant="success">{m.recentTranscripts.meetingBadge}</Badge>
                  ) : (
                    <Badge variant="info">{m.recentTranscripts.pttBadge}</Badge>
                  )}
                </button>
                {index < items.length - 1 && <Separator />}
              </div>
            )
          })}
      </div>
    </section>
  )
}
