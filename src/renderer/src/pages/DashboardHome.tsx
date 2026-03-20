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
  onOpenSettings: () => void
  onOpenTranscript: (id: string) => void
  meetingActive?: boolean
  meetingSeconds?: number
  onReturnToMeeting?: () => void
  onStopMeeting?: () => void
}

export function DashboardHome({
  hotkey,
  onNavigate,
  onOpenSettings,
  onOpenTranscript,
  meetingActive = false,
  meetingSeconds = 0,
  onReturnToMeeting,
  onStopMeeting
}: DashboardHomeProps): JSX.Element {
  const { stats, loading, error, updatedAt } = useHomeStats()
  const { m } = useI18n()

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <DashboardHeader
        title={m.header.homeTitle}
        subtitle={m.header.readyHint}
        onOpenSettings={onOpenSettings}
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
        {/* ─── PTT: live state + last result ─── */}
        <div className="pt-6 pb-6 border-b border-border">
          <p className="text-[11px] font-medium tracking-widest uppercase text-muted-foreground mb-4">
            {m.pttCard.title}
          </p>
          <PttLiveIndicator hotkey={hotkey} />
        </div>

        {/* ─── Start Meeting: prominent CTA ─── */}
        <div className="pt-5 pb-5 border-b border-border">
          <button
            type="button"
            onClick={() => onNavigate('meeting')}
            className="group flex w-full items-center gap-4 py-3 text-left transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded-sm -mx-1 px-1"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 group-hover:bg-primary/15 transition-colors">
              <Headphones className="h-5 w-5 text-primary" strokeWidth={1.8} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[14px] font-medium text-foreground group-hover:text-primary transition-colors">
                {m.quickActions.startMeetingTranscription}
              </p>
              <p className="text-[12px] text-muted-foreground">
                {m.quickActions.startMeetingDescription}
              </p>
            </div>
            <Play className="h-4 w-4 text-muted-foreground/50 group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
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
        <div className="pt-6">
          <RecentTranscripts
            onViewAll={() => onNavigate('history')}
            onOpenTranscript={onOpenTranscript}
          />
        </div>
      </div>
    </section>
  )
}
