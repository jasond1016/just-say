import type { JSX } from 'react'

interface DashboardHeaderProps {
  title?: string
  subtitle?: string
}

export function DashboardHeader({
  title,
  subtitle
}: DashboardHeaderProps): JSX.Element {
  return (
    <header
      className="flex items-end px-8 pb-2"
      style={{ WebkitAppRegion: 'drag', minHeight: 52 } as React.CSSProperties}
    >
      <div
        className="flex items-baseline gap-3"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {title && (
          <h1 className="font-display text-2xl text-foreground italic">{title}</h1>
        )}
        {subtitle && (
          <span className="text-[13px] text-muted-foreground">{subtitle}</span>
        )}
      </div>
    </header>
  )
}
