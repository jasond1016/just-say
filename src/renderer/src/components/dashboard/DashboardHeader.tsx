import type { JSX } from 'react'
import { Home, Settings } from 'lucide-react'
import { useI18n } from '@/i18n/useI18n'

interface DashboardHeaderProps {
  onOpenSettings: () => void
}

export function DashboardHeader({ onOpenSettings }: DashboardHeaderProps): JSX.Element {
  const { m } = useI18n()
  return (
    <header className="flex h-[53px] w-full items-center justify-between border-b px-6">
      <div className="flex items-center gap-3">
        <Home className="h-5 w-5 text-[#7C3AED]" />
        <h1 className="text-[18px] leading-none font-semibold">{m.header.homeTitle}</h1>
      </div>

      <p className="text-muted-foreground text-[13px]">{m.header.readyHint}</p>

      <button
        type="button"
        onClick={onOpenSettings}
        className="text-muted-foreground hover:bg-accent inline-flex h-[30px] w-[30px] items-center justify-center rounded-[4px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7C3AED]/40"
        aria-label={m.header.openSettingsAria}
      >
        <Settings className="h-[18px] w-[18px]" />
      </button>
    </header>
  )
}
