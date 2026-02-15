import type { ComponentType, JSX } from 'react'
import { ArrowRight, Headphones, Settings } from 'lucide-react'

interface QuickActionsProps {
  onMeetingClick: () => void
  onSettingsClick: () => void
}

function ActionRow({
  icon: Icon,
  label,
  onClick
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg border bg-background px-4 py-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7C3AED]/35"
    >
      <Icon className="h-[18px] w-[18px] text-[#7C3AED]" />
      <span className="text-[13px] font-medium">{label}</span>
      <ArrowRight className="text-muted-foreground ml-auto h-4 w-4" />
    </button>
  )
}

export function QuickActions({ onMeetingClick, onSettingsClick }: QuickActionsProps): JSX.Element {
  return (
    <section className="flex w-full flex-col gap-3">
      <ActionRow icon={Headphones} label="Start Meeting Transcription" onClick={onMeetingClick} />
      <ActionRow icon={Settings} label="Change Hotkey" onClick={onSettingsClick} />
    </section>
  )
}
