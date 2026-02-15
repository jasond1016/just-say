import type { JSX } from 'react'
import { DashboardHeader } from '@/components/dashboard/DashboardHeader'
import { PttCard } from '@/components/dashboard/PttCard'
import { QuickActions } from '@/components/dashboard/QuickActions'
import { RecentTranscripts } from '@/components/dashboard/RecentTranscripts'
import { useHomeStats } from '@/hooks/useHomeStats'

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

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <DashboardHeader onOpenSettings={onOpenSettings} />

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-6">
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
        <QuickActions
          onMeetingClick={() => onNavigate('meeting')}
          onSettingsClick={onOpenSettings}
        />
        <RecentTranscripts
          onViewAll={() => onNavigate('history')}
          onOpenTranscript={onOpenTranscript}
        />
      </div>
    </section>
  )
}
