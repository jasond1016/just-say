import type { JSX } from 'react'
import { ArrowRight, Square } from 'lucide-react'
import { useI18n } from '@/i18n/useI18n'

interface MeetingStatusBarProps {
  seconds: number
  onReturn: () => void
  onStop: () => void
}

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export function MeetingStatusBar({
  seconds,
  onReturn,
  onStop
}: MeetingStatusBarProps): JSX.Element {
  const { m } = useI18n()

  return (
    <div className="flex items-center justify-between bg-[var(--color-recording-bg)] px-8 py-2 animate-[slideInUp_200ms_var(--ease-out-expo)]">
      <div className="flex items-center gap-3">
        <span className="h-2 w-2 rounded-full bg-[var(--color-recording)] animate-[pulseRecord_1.5s_ease-in-out_infinite]" />
        <span className="text-[13px] font-medium text-[var(--color-recording)]">
          {m.meetingBar.recording}
        </span>
        <span className="font-mono tabular-nums text-[13px] text-[var(--color-recording)]">
          {formatClock(seconds)}
        </span>
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onStop}
          className="press-scale inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] font-medium text-[var(--color-recording)] hover:bg-[var(--color-recording)]/10 transition-colors rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-recording)]/30"
        >
          <Square className="h-3 w-3" />
          {m.meetingBar.stop}
        </button>
        <button
          type="button"
          onClick={onReturn}
          className="press-scale inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] font-medium text-[var(--color-recording)] hover:bg-[var(--color-recording)]/10 transition-colors rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-recording)]/30"
        >
          {m.meetingBar.returnToMeeting}
          <ArrowRight className="h-3 w-3" />
        </button>
      </div>
    </div>
  )
}
