import type { JSX } from 'react'
import { Settings } from 'lucide-react'
import { useI18n } from '@/i18n/useI18n'

interface DashboardHeaderProps {
  title?: string
  subtitle?: string
  onOpenSettings: () => void
}

export function DashboardHeader({
  title,
  subtitle,
  onOpenSettings
}: DashboardHeaderProps): JSX.Element {
  const { m } = useI18n()

  return (
    <header className="flex h-14 items-center justify-between px-8">
      <div className="flex items-baseline gap-3">
        {title && (
          <h1 className="font-display text-2xl text-foreground italic">{title}</h1>
        )}
        {subtitle && (
          <span className="text-[13px] text-muted-foreground">{subtitle}</span>
        )}
      </div>

      <button
        type="button"
        onClick={onOpenSettings}
        className="inline-flex h-8 w-8 items-center justify-center text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        aria-label={m.header.openSettingsAria}
      >
        <Settings className="h-[18px] w-[18px]" strokeWidth={1.8} />
      </button>
    </header>
  )
}
