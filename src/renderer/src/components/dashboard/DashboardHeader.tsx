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
    <header className="flex items-baseline gap-3 px-8 py-3">
      {title && (
        <h1 className="font-display text-2xl text-foreground">{title}</h1>
      )}
      {subtitle && (
        <span className="text-[13px] text-muted-foreground">{subtitle}</span>
      )}
    </header>
  )
}
