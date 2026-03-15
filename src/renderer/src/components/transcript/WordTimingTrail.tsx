import React from 'react'

import { cn } from '@/lib/utils'
import {
  buildVisibleWordTimingChips,
  formatWordTimingRange,
  type DebugWordTimingLike
} from '@/lib/word-timing-debug'

interface WordTimingTrailProps {
  wordTimings?: DebugWordTimingLike[]
  previewText?: string
  label: string
  previewLabel: string
  className?: string
}

export function WordTimingTrail({
  wordTimings,
  previewText,
  label,
  previewLabel,
  className
}: WordTimingTrailProps): React.JSX.Element | null {
  const chips = buildVisibleWordTimingChips(wordTimings, previewText)
  if (chips.length === 0) {
    return null
  }

  const hasPreview = chips.some((chip) => chip.isPreview)

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>{label}</span>
        {hasPreview && (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
            {previewLabel}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((chip, index) => (
          <span
            key={`${chip.text}-${chip.startMs}-${chip.endMs}-${index}`}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px]',
              chip.isPreview
                ? 'border-amber-300 bg-amber-50 text-amber-800'
                : 'border-border bg-muted/60 text-muted-foreground'
            )}
            title={`${chip.text} ${formatWordTimingRange(chip.startMs, chip.endMs)}`}
          >
            <span className="max-w-[10rem] truncate font-medium">{chip.text}</span>
            <span className="tabular-nums opacity-80">
              {formatWordTimingRange(chip.startMs, chip.endMs)}
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}
