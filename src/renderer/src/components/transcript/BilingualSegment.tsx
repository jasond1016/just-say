import React from 'react'
import { Languages } from 'lucide-react'

import { cn } from '@/lib/utils'

export interface BilingualSentencePair {
  original: string
  translated?: string | null
}

interface BilingualSegmentProps {
  pairs?: BilingualSentencePair[]
  originalText?: string
  translatedText?: string | null
  previewText?: string
  className?: string
}

export function BilingualSegment({
  pairs,
  originalText,
  translatedText,
  previewText,
  className
}: BilingualSegmentProps): React.JSX.Element {
  const normalizedPairs: BilingualSentencePair[] =
    pairs && pairs.length > 0
      ? pairs
      : [
          {
            original: originalText || '',
            translated: translatedText || undefined
          }
        ]

  return (
    <div className={cn('space-y-1', className)}>
      {normalizedPairs.map((pair, pairIndex) => {
        const translated = pair.translated?.trim()
        const shouldShowPreview = pairIndex === normalizedPairs.length - 1 && !!previewText

        return (
          <div key={pairIndex} className="space-y-1">
            <p className="whitespace-pre-wrap text-[14px] leading-[1.65] text-foreground">
              <span>{pair.original}</span>
              {shouldShowPreview && (
                <span className="text-muted-foreground/60">{previewText}</span>
              )}
            </p>
            {translated && (
              <div className="flex items-start gap-2 border-l-2 border-[var(--color-success)]/40 pl-3 py-1">
                <Languages className="mt-0.5 h-3 w-3 shrink-0 text-[var(--color-success)]" />
                <p className="whitespace-pre-wrap text-[13px] leading-[1.65] text-[var(--color-success)]">
                  {translated}
                </p>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
