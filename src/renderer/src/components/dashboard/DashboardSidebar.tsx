import type { ComponentType, JSX } from 'react'
import { Clock3, Headphones, Hexagon, Home } from 'lucide-react'

import { cn } from '@/lib/utils'

export type DashboardView = 'ptt' | 'meeting' | 'history'

interface DashboardSidebarProps {
  activeView: DashboardView
  onNavigate: (view: DashboardView) => void
  meetingSessionLocked?: boolean
}

const navItems: Array<{
  id: DashboardView
  label: string
  icon: ComponentType<{ className?: string }>
}> = [
  { id: 'ptt', label: 'Home', icon: Home },
  { id: 'meeting', label: 'Meeting', icon: Headphones },
  { id: 'history', label: 'History', icon: Clock3 }
]

export function DashboardSidebar({
  activeView,
  onNavigate,
  meetingSessionLocked = false
}: DashboardSidebarProps): JSX.Element {
  if (meetingSessionLocked) {
    return (
      <aside className="flex h-full w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-2">
        <div className="flex items-center gap-2 rounded-md p-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-[8px] bg-[#7C3AED] text-white">
            <Hexagon className="h-4 w-4" />
          </div>
          <span className="text-sidebar-foreground text-sm font-semibold">JustSay</span>
        </div>

        <div className="mt-4 px-2">
          <span className="text-muted-foreground text-xs font-medium tracking-wide">SESSION</span>
        </div>

        <nav className="mt-2 flex flex-col gap-0.5">
          <div className="text-sidebar-foreground bg-sidebar-accent flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium">
            <Headphones className="h-4 w-4" />
            <span>Meeting In Progress</span>
          </div>
          <p className="text-muted-foreground px-2 pt-2 text-xs leading-5">
            Home and History are locked while Meeting transcription is active.
          </p>
        </nav>
      </aside>
    )
  }

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-2">
      <div className="flex items-center gap-2 rounded-md p-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-[8px] bg-[#7C3AED] text-white">
          <Hexagon className="h-4 w-4" />
        </div>
        <span className="text-sidebar-foreground text-sm font-semibold">JustSay</span>
      </div>

      <div className="mt-4 px-2">
        <span className="text-muted-foreground text-xs font-medium tracking-wide">NAVIGATION</span>
      </div>

      <nav className="mt-2 flex flex-col gap-0.5">
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = activeView === item.id

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              className={cn(
                'text-sidebar-foreground flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-normal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7C3AED]/35',
                isActive ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60'
              )}
            >
              <Icon className="h-4 w-4" />
              <span>{item.label}</span>
            </button>
          )
        })}
      </nav>
    </aside>
  )
}
