import type { JSX } from 'react'
import { DashboardHeader } from '@/components/dashboard/DashboardHeader'
import { PttCard } from '@/components/dashboard/PttCard'
import { QuickActions } from '@/components/dashboard/QuickActions'
import { RecentTranscripts } from '@/components/dashboard/RecentTranscripts'
import { useHomeStats } from '@/hooks/useHomeStats'
import { useI18n } from '@/i18n/useI18n'

interface DashboardHomeProps {
  hotkey: string
  onNavigate: (view: 'ptt' | 'meeting' | 'history') => void
  onOpenSettings: () => void
  onOpenTranscript: (id: string) => void
}

export function DashboardHome({
  hotkey,
  onNavigate,
  onOpenSettings,
  onOpenTranscript
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

      <div className="flex min-h-0 flex-1 flex-col overflow-auto px-8 pb-8">
        {/* PTT section */}
        <div className="pt-4 pb-8 border-b border-border">
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

        {/* Quick actions */}
        <div className="pt-4 pb-4 border-b border-border">
          <QuickActions
            onMeetingClick={() => onNavigate('meeting')}
            onSettingsClick={onOpenSettings}
          />
        </div>

        {/* Recent transcripts */}
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
