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
        const shouldShowPreview = normalizedPairs.length === 1 && pairIndex === 0 && !!previewText

        return (
          <div key={pairIndex} className="space-y-1">
            <p className="whitespace-pre-wrap text-sm leading-[1.5]">
              <span>{pair.original}</span>
              {shouldShowPreview && <span className="text-muted-foreground">{previewText}</span>}
            </p>
            {translated && (
              <div className="flex items-start gap-2 rounded-md bg-emerald-50 px-3 py-2 text-emerald-600">
                <Languages className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <p className="whitespace-pre-wrap text-sm leading-[1.5]">{translated}</p>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
