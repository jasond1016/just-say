import type { JSX } from 'react'
import { ArrowRight, Headphones, Settings } from 'lucide-react'
import { useI18n } from '@/i18n/useI18n'

interface QuickActionsProps {
  onMeetingClick: () => void
  onSettingsClick: () => void
}

function ActionRow({
  icon: Icon,
  label,
  onClick
}: {
  icon: typeof Headphones
  label: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3 py-3 text-left transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:rounded-sm"
    >
      <Icon className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" strokeWidth={1.8} />
      <span className="text-[14px] font-medium text-foreground group-hover:text-primary transition-colors">{label}</span>
      <ArrowRight className="ml-auto h-3.5 w-3.5 text-muted-foreground/50 group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
    </button>
  )
}

export function QuickActions({ onMeetingClick, onSettingsClick }: QuickActionsProps): JSX.Element {
  const { m } = useI18n()
  return (
    <section className="animate-[slideInUp_400ms_var(--ease-out-expo)_100ms] animate-fill-backwards">
      <div className="divide-y divide-border">
        <ActionRow
          icon={Headphones}
          label={m.quickActions.startMeetingTranscription}
          onClick={onMeetingClick}
        />
        <ActionRow icon={Settings} label={m.quickActions.changeHotkey} onClick={onSettingsClick} />
      </div>
    </section>
  )
}
