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
    <aside className="flex h-full w-[180px] shrink-0 flex-col bg-[var(--sidebar-bg)]">
      {/* ─── Brand / drag region ─── */}
      <div
        className="flex items-center gap-2.5 px-5 pt-3 pb-4"
        style={{ WebkitAppRegion: 'drag', minHeight: 52 } as React.CSSProperties}
      >
        <div
          className="flex items-center gap-2.5"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--sidebar-active)]/15">
            <Mic className="h-3.5 w-3.5 text-[var(--sidebar-active)]" strokeWidth={2.2} />
          </div>
          <span className="text-[14px] font-semibold tracking-tight text-[var(--sidebar-fg)]">
            JustSay
          </span>
        </div>
      </div>

      {/* ─── Navigation ─── */}
      <nav
        className="flex flex-1 flex-col gap-0.5 px-3"
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
              aria-label={labelMap[item.id]}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'press-scale group relative flex h-9 w-full items-center gap-3 rounded-md px-3 text-[13px] font-medium transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sidebar-active)]/40',
                isActive
                  ? 'bg-[var(--sidebar-hover)] text-[var(--sidebar-active)]'
                  : 'text-[var(--sidebar-muted)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-fg)]'
              )}
            >
              {/* Active indicator — left edge bar */}
              {isActive && (
                <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-[var(--sidebar-active)]" />
              )}

              <Icon className="h-[16px] w-[16px] shrink-0" strokeWidth={isActive ? 2.2 : 1.8} />

              <span className="truncate">{labelMap[item.id]}</span>

              {/* Meeting-active dot */}
              {showMeetingDot && (
                <span className="ml-auto flex h-2 w-2 shrink-0 rounded-full bg-[var(--color-recording)] animate-[pulseRecord_1.5s_ease-in-out_infinite]" />
              )}
            </button>
          )
        })}
      </nav>

      {/* ─── Settings — pinned to bottom ─── */}
      <div className="px-3 pb-4" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label={m.header.openSettingsAria}
          className={cn(
            'press-scale flex h-9 w-full items-center gap-3 rounded-md px-3 text-[13px] font-medium transition-colors duration-150',
            'text-[var(--sidebar-muted)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-fg)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sidebar-active)]/40'
          )}
        >
          <Settings className="h-[16px] w-[16px] shrink-0" strokeWidth={1.8} />
          <span className="truncate">{m.settings.title}</span>
        </button>
      </div>
    </aside>
  )
}
