import { accumulateInterimText } from './live-transcript'

export interface LiveWordTimingLike {
  text: string
  startMs: number
  endMs: number
}

export interface LiveSentencePairLike {
  original: string
  translated?: string
}

export interface LiveSpeakerSegmentLike {
  speaker: number
  text: string
  translatedText?: string
  sentencePairs?: LiveSentencePairLike[]
  stableText?: string
  unstableText?: string
  wordTimings?: LiveWordTimingLike[]
  timestamp?: number
}

const MAX_UNSTABLE_TIMING_ITEMS = 2
const UNSTABLE_TIMING_WINDOW_MS = 900

function toText(text?: string): string {
  return text || ''
}

function hasText(text?: string): boolean {
  return !!text && text.trim().length > 0
}

function splitStablePreview(prev: string, next: string): { stable: string; preview: string } {
  if (!next) {
    return { stable: '', preview: '' }
  }
  if (!prev) {
    return { stable: '', preview: next }
  }

  const max = Math.min(prev.length, next.length)
  let index = 0
  while (index < max && prev[index] === next[index]) {
    index += 1
  }

  return { stable: next.slice(0, index), preview: next.slice(index) }
}

function splitStablePreviewFromBackend(
  fullText: string,
  stableText?: string,
  unstableText?: string
): { stable: string; preview: string } | null {
  const stable = toText(stableText)
  const preview = toText(unstableText)

  if (!hasText(stable) && !hasText(preview)) {
    return null
  }

  if (hasText(stable) && hasText(preview)) {
    return { stable, preview }
  }

  if (hasText(stable)) {
    if (fullText.startsWith(stable)) {
      return { stable, preview: fullText.slice(stable.length) }
    }
    return { stable, preview: '' }
  }

  if (hasText(preview) && fullText.endsWith(preview)) {
    return { stable: fullText.slice(0, fullText.length - preview.length), preview }
  }

  return { stable: '', preview }
}

function getTailItems(items: LiveWordTimingLike[]): LiveWordTimingLike[] {
  if (items.length < 2) {
    return []
  }

  const lastEndMs = items[items.length - 1]?.endMs
  if (!Number.isFinite(lastEndMs)) {
    return []
  }

  const tail: LiveWordTimingLike[] = []
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (!item.text.trim()) {
      break
    }

    const exceedsWindow = tail.length > 0 && lastEndMs - item.startMs > UNSTABLE_TIMING_WINDOW_MS
    const exceedsCount = tail.length >= MAX_UNSTABLE_TIMING_ITEMS
    if (exceedsWindow || exceedsCount) {
      break
    }

    tail.unshift(item)
  }

  return tail
}

function splitStablePreviewFromTimings(
  fullText: string,
  wordTimings?: LiveWordTimingLike[]
): { stable: string; preview: string } | null {
  if (!wordTimings || wordTimings.length < 2) {
    return null
  }

  const tailItems = getTailItems(
    wordTimings.filter(
      (item) =>
        !!item.text.trim() && Number.isFinite(item.startMs) && Number.isFinite(item.endMs)
    )
  )
  if (tailItems.length === 0) {
    return null
  }

  const preview = tailItems.map((item) => item.text).join('')
  if (!preview || preview.length >= fullText.length || !fullText.endsWith(preview)) {
    return null
  }

  return {
    stable: fullText.slice(0, fullText.length - preview.length),
    preview
  }
}

export function buildCurrentSpeakerSegment<T extends LiveSpeakerSegmentLike>(
  previousCurrentSegment: T | null,
  incomingSegment: T,
  currentWordTimings?: LiveWordTimingLike[]
): T & {
  stableText?: string
  previewText?: string
  unstableText?: string
  wordTimings?: LiveWordTimingLike[]
} {
  const previousDisplayText =
  previousCurrentSegment?.speaker === incomingSegment.speaker ? previousCurrentSegment.text : ''
  const incomingText = toText(incomingSegment.text)
  const backendSplit = splitStablePreviewFromBackend(
    incomingText,
    incomingSegment.stableText,
    incomingSegment.unstableText
  )
  const displayText = backendSplit
    ? incomingText
    : accumulateInterimText(previousDisplayText, incomingText)
  const resolvedWordTimings =
    incomingSegment.wordTimings && incomingSegment.wordTimings.length > 0
      ? [...incomingSegment.wordTimings]
      : currentWordTimings && currentWordTimings.length > 0
        ? [...currentWordTimings]
        : undefined

  const resolvedSplit =
    backendSplit ||
    splitStablePreviewFromTimings(displayText, resolvedWordTimings) ||
    splitStablePreview(previousDisplayText, displayText)

  const stableText = toText(resolvedSplit.stable)
  const previewText = toText(resolvedSplit.preview)
  const shouldHidePreview = !stableText && previewText === displayText

  return {
    ...incomingSegment,
    text: displayText,
    stableText: stableText || displayText,
    unstableText: shouldHidePreview ? undefined : previewText || undefined,
    previewText: shouldHidePreview ? undefined : previewText || undefined,
    wordTimings: resolvedWordTimings,
    timestamp: previousCurrentSegment?.timestamp ?? incomingSegment.timestamp ?? Date.now()
  }
}

export function getStableDisplayText(segment: {
  text: string
  stableText?: string
  previewText?: string
}): string {
  const stableText = toText(segment.stableText)
  if (hasText(stableText)) {
    return stableText
  }

  const fullText = toText(segment.text)
  const previewText = toText(segment.previewText)
  if (!hasText(previewText) || !fullText.endsWith(previewText)) {
    return fullText
  }

  return fullText.slice(0, fullText.length - previewText.length)
}
