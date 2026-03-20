import type { JSX } from 'react'
import { Clock3, Headphones, Home, Mic } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/useI18n'

export type DashboardView = 'ptt' | 'meeting' | 'history'

interface DashboardSidebarProps {
  activeView: DashboardView
  onNavigate: (view: DashboardView) => void
  meetingSessionLocked?: boolean
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
  meetingSessionLocked = false
}: DashboardSidebarProps): JSX.Element {
  const { m } = useI18n()

  const labelMap: Record<DashboardView, string> = {
    ptt: m.sidebar.navHome,
    meeting: m.sidebar.navMeeting,
    history: m.sidebar.navHistory
  }

  return (
    <aside
      className="flex h-full w-16 shrink-0 flex-col items-center bg-[var(--sidebar-bg)] py-5"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Logo mark */}
      <div className="mb-8 flex h-9 w-9 items-center justify-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <Mic className="h-5 w-5 text-[var(--sidebar-active)]" />
      </div>

      {/* Navigation */}
      <nav className="flex flex-1 flex-col items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = activeView === item.id
          const isLocked = meetingSessionLocked && item.id !== 'meeting'

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                if (!isLocked) onNavigate(item.id)
              }}
              disabled={isLocked}
              title={labelMap[item.id]}
              aria-label={labelMap[item.id]}
              className={cn(
                'group relative flex h-10 w-10 items-center justify-center transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sidebar-active)]/40',
                'disabled:opacity-30 disabled:cursor-not-allowed',
                isActive
                  ? 'text-[var(--sidebar-active)]'
                  : 'text-[var(--sidebar-muted)] hover:text-[var(--sidebar-fg)]'
              )}
            >
              {/* Active indicator — left bar */}
              {isActive && (
                <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-[var(--sidebar-active)]" />
              )}
              <Icon className="h-[18px] w-[18px]" strokeWidth={isActive ? 2.2 : 1.8} />
            </button>
          )
        })}
      </nav>

      {/* Bottom spacer — keeps nav vertically centered */}
      <div className="h-9" />
    </aside>
  )
}
