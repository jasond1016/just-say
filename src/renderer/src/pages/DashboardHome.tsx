import type { JSX } from 'react'
import { Headphones, Play } from 'lucide-react'
import { DashboardHeader } from '@/components/dashboard/DashboardHeader'
import { PttLiveIndicator } from '@/components/dashboard/PttLiveIndicator'
import { PttCard } from '@/components/dashboard/PttCard'
import { MeetingStatusBar } from '@/components/dashboard/MeetingStatusBar'
import { RecentTranscripts } from '@/components/dashboard/RecentTranscripts'
import { useHomeStats } from '@/hooks/useHomeStats'
import { useI18n } from '@/i18n/useI18n'

interface DashboardHomeProps {
  hotkey: string
  onNavigate: (view: 'ptt' | 'meeting' | 'history') => void
  onOpenTranscript: (id: string) => void
  meetingActive?: boolean
  meetingSeconds?: number
  onReturnToMeeting?: () => void
  onStopMeeting?: () => void
}

export function DashboardHome({
  hotkey,
  onNavigate,
  onOpenTranscript,
  meetingActive = false,
  meetingSeconds = 0,
  onReturnToMeeting,
  onStopMeeting
}: DashboardHomeProps): JSX.Element {
  const { stats, loading, error, updatedAt } = useHomeStats()
  const { m } = useI18n()

  return (
    <section className="flex min-w-0 flex-1 flex-col page-enter">
      <DashboardHeader
        title={m.header.homeTitle}
        subtitle={m.header.readyHint}
      />

      {/* Meeting in background — persistent status bar */}
      {meetingActive && onReturnToMeeting && onStopMeeting && (
        <MeetingStatusBar
          seconds={meetingSeconds}
          onReturn={onReturnToMeeting}
          onStop={onStopMeeting}
        />
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-auto px-8 pb-8">
        <div className="max-w-2xl">
          {/* ─── PTT: live state + last result ─── */}
          <div className="pt-5 pb-5 border-b border-border">
            <p className="text-[11px] font-semibold tracking-widest uppercase text-muted-foreground mb-3">
              {m.pttCard.title}
            </p>
            <PttLiveIndicator hotkey={hotkey} />
          </div>

          {/* ─── Start Meeting: horizontal CTA row ─── */}
          <div className="pt-4 pb-4 border-b border-border">
            <button
              type="button"
              onClick={() => onNavigate('meeting')}
              className="press-scale group flex w-full items-center gap-4 rounded-xl border border-border bg-card px-4 py-3.5 shadow-tinted-sm transition-all duration-200 hover:shadow-tinted-md hover:border-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 group-hover:bg-primary/15 transition-colors shrink-0">
                <Headphones className="h-[18px] w-[18px] text-primary" strokeWidth={1.8} />
              </div>
              <div className="flex-1 min-w-0 text-left">
                <p className="text-[13px] font-semibold text-foreground group-hover:text-primary transition-colors">
                  {m.quickActions.startMeetingTranscription}
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {m.quickActions.startMeetingDescription}
                </p>
              </div>
              <Play className="h-4 w-4 text-muted-foreground/40 group-hover:text-primary group-hover:translate-x-0.5 transition-all shrink-0" />
            </button>
          </div>

          {/* ─── Stats ─── */}
          <div className="pt-5 pb-5 border-b border-border">
            <PttCard
              hotkey={hotkey}
              todayCount={stats.todayPttCount}
              todayChars={stats.todayChars}
              todayCountDelta={stats.todayPttDelta}
              todayCharsDelta={stats.todayCharsDelta}
              dailyStats={stats.daily}
              loading={loading}
              error={error}
              updatedAt={updatedAt}
            />
          </div>

          {/* ─── Recent transcripts ─── */}
          <div className="pt-5">
            <RecentTranscripts
              onViewAll={() => onNavigate('history')}
              onOpenTranscript={onOpenTranscript}
            />
          </div>
        </div>
      </div>
    </section>
  )
}
