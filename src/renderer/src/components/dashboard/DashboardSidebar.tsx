import type { JSX } from 'react'
import { Clock3, Headphones, Home, Mic, Settings } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/useI18n'

export type DashboardView = 'ptt' | 'meeting' | 'history'

interface DashboardSidebarProps {
  activeView: DashboardView
  onNavigate: (view: DashboardView) => void
  onOpenSettings: () => void
  meetingActive?: boolean
}

const navItems: Array<{
  id: DashboardView
  icon: typeof Home
}> = [
  { id: 'ptt', icon: Home },
  { id: 'meeting', icon: Headphones },
  { id: 'history', icon: Clock3 }
]

export function DashboardSidebar({
  activeView,
  onNavigate,
  onOpenSettings,
  meetingActive = false
}: DashboardSidebarProps): JSX.Element {
  const { m } = useI18n()

  const labelMap: Record<DashboardView, string> = {
    ptt: m.sidebar.navHome,
    meeting: m.sidebar.navMeeting,
    history: m.sidebar.navHistory
  }

  return (
    <aside className="flex h-full w-16 shrink-0 flex-col items-center bg-[var(--sidebar-bg)]">
      {/* Drag region — fills the title-bar overlay height */}
      <div
        className="w-full pt-2 pb-4 flex items-end justify-center"
        style={{ WebkitAppRegion: 'drag', minHeight: 52 } as React.CSSProperties}
      >
        <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <Mic className="h-5 w-5 text-[var(--sidebar-active)]" />
        </div>
      </div>

      {/* Navigation */}
      <nav
        className="flex flex-1 flex-col items-center gap-1"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = activeView === item.id
          const showMeetingDot = item.id === 'meeting' && meetingActive && !isActive

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              title={labelMap[item.id]}
              aria-label={labelMap[item.id]}
              className={cn(
                'group relative flex h-10 w-10 items-center justify-center transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sidebar-active)]/40',
                isActive
                  ? 'text-[var(--sidebar-active)]'
                  : 'text-[var(--sidebar-muted)] hover:text-[var(--sidebar-fg)]'
              )}
            >
              {isActive && (
                <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-[var(--sidebar-active)]" />
              )}
              {showMeetingDot && (
                <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-[var(--color-recording)] animate-[pulseRecord_1.5s_ease-in-out_infinite]" />
              )}
              <Icon className="h-[18px] w-[18px]" strokeWidth={isActive ? 2.2 : 1.8} />
            </button>
          )
        })}
      </nav>

      {/* Settings — pinned to bottom */}
      <div className="pb-4" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          type="button"
          onClick={onOpenSettings}
          title={m.settings.title}
          aria-label={m.header.openSettingsAria}
          className="flex h-10 w-10 items-center justify-center text-[var(--sidebar-muted)] hover:text-[var(--sidebar-fg)] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sidebar-active)]/40"
        >
          <Settings className="h-[18px] w-[18px]" strokeWidth={1.8} />
        </button>
      </div>
    </aside>
  )
}
