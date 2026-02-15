import { useEffect, useState, type JSX } from 'react'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import type { Transcript } from '@/hooks/useTranscripts'
import { getTranscriptSourceMode } from '@/lib/transcript-source'

interface RecentTranscriptsProps {
  onViewAll: () => void
  onOpenTranscript: (id: string) => void
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
  if (minutes === 0) {
    return `${seconds}s`
  }
  return `${minutes} min`
}

export function RecentTranscripts({
  onViewAll,
  onOpenTranscript
}: RecentTranscriptsProps): JSX.Element {
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
        <h2 className="text-[15px] font-semibold">Recent Transcripts</h2>
        <button
          type="button"
          className="rounded px-1 text-[13px] font-medium text-[#7C3AED] transition-colors hover:text-[#6D28D9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7C3AED]/40"
          onClick={onViewAll}
        >
          View all →
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border">
        {loading && (
          <div className="px-4 py-3 text-[13px] text-muted-foreground">
            Loading recent transcripts...
          </div>
        )}

        {!loading && items.length === 0 && (
          <div className="px-4 py-3 text-[13px] text-muted-foreground">No transcripts yet.</div>
        )}

        {!loading &&
          items.map((item, index) => {
            const mode = getTranscriptSourceMode(item)
            const kind = mode === 'meeting' ? 'Meeting' : 'PTT'
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
                      {formatDateLabel(item.created_at)} · {formatDuration(item.duration_seconds)}
                    </p>
                  </div>
                  {kind === 'Meeting' ? (
                    <Badge variant="success">Meeting</Badge>
                  ) : (
                    <Badge variant="info">PTT</Badge>
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
