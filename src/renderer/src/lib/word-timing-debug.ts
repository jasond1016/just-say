export interface DebugWordTimingLike {
  text: string
  startMs: number
  endMs: number
}

export interface DebugWordTimingChip extends DebugWordTimingLike {
  isPreview: boolean
}

const DEFAULT_MAX_VISIBLE_WORD_TIMINGS = 8

function normalizeComparableText(text?: string): string {
  return (text || '').replace(/\s+/g, '')
}

export function buildVisibleWordTimingChips(
  wordTimings?: DebugWordTimingLike[],
  previewText?: string,
  maxItems = DEFAULT_MAX_VISIBLE_WORD_TIMINGS
): DebugWordTimingChip[] {
  const normalizedItems = Array.isArray(wordTimings)
    ? wordTimings.filter(
        (item) =>
          !!item?.text?.trim() &&
          Number.isFinite(item.startMs) &&
          Number.isFinite(item.endMs) &&
          item.endMs >= item.startMs
      )
    : []

  if (normalizedItems.length === 0) {
    return []
  }

  const previewComparable = normalizeComparableText(previewText)
  const comparableItems = normalizedItems.map((item) => normalizeComparableText(item.text))
  const comparableJoined = comparableItems.join('')

  let previewStartIndex = normalizedItems.length
  if (previewComparable && comparableJoined.endsWith(previewComparable)) {
    let remaining = previewComparable.length
    for (let index = comparableItems.length - 1; index >= 0; index -= 1) {
      const comparable = comparableItems[index]
      if (!comparable) {
        continue
      }
      remaining -= comparable.length
      previewStartIndex = index
      if (remaining <= 0) {
        break
      }
    }
  }

  const visibleCount =
    typeof maxItems === 'number' && Number.isFinite(maxItems) && maxItems > 0
      ? Math.floor(maxItems)
      : DEFAULT_MAX_VISIBLE_WORD_TIMINGS
  const sliceStart = Math.max(0, normalizedItems.length - visibleCount)

  return normalizedItems.slice(sliceStart).map((item, index) => {
    const absoluteIndex = sliceStart + index
    return {
      ...item,
      isPreview: absoluteIndex >= previewStartIndex
    }
  })
}

export function formatWordTimingRange(startMs: number, endMs: number): string {
  const startSeconds = Math.max(0, startMs) / 1000
  const endSeconds = Math.max(startSeconds, endMs / 1000)
  return `${startSeconds.toFixed(2)}-${endSeconds.toFixed(2)}s`
}
