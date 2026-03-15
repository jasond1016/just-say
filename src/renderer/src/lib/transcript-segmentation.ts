export interface RendererSentencePair {
  original: string
  translated?: string | null
}

interface StoredSegmentLike {
  text: string
  translated_text: string | null
  sentence_pairs?: Array<{ original: string; translated: string | null }>
}

interface LiveSegmentLike {
  text: string
  stableText?: string
  unstableText?: string
  previewText?: string
  translatedText?: string
  sentencePairs?: Array<{ original: string; translated?: string }>
}

function getPreviewLiveText(segment: LiveSegmentLike): string {
  const previewText = segment.previewText || ''
  if (previewText.trim()) {
    return previewText
  }

  const unstableText = segment.unstableText || ''
  if (unstableText.trim()) {
    return unstableText
  }

  return ''
}

function getStableLiveText(segment: LiveSegmentLike): string {
  const stableText = segment.stableText || ''
  if (stableText.trim()) {
    return stableText
  }

  const fullText = segment.text || ''
  const previewText = getPreviewLiveText(segment)
  if (previewText.trim() && fullText.endsWith(previewText)) {
    return fullText.slice(0, fullText.length - previewText.length)
  }

  return fullText
}

function normalizePairs(
  pairs?: Array<{ original: string; translated?: string | null }>
): RendererSentencePair[] {
  if (!pairs || pairs.length === 0) {
    return []
  }

  return pairs
    .map((pair) => ({
      original: pair.original || '',
      translated: pair.translated ?? null
    }))
    .filter((pair) => pair.original.trim().length > 0)
}

export function toSentencePairsFromStored(segment: StoredSegmentLike): RendererSentencePair[] {
  const pairs = normalizePairs(segment.sentence_pairs)
  if (pairs.length > 0) {
    return pairs
  }

  const original = segment.text || ''
  return original.trim() ? [{ original, translated: segment.translated_text ?? null }] : []
}

export function toSentencePairsFromLive(segment: LiveSegmentLike): RendererSentencePair[] {
  const pairs = normalizePairs(segment.sentencePairs)
  if (pairs.length > 0) {
    const fullText = segment.text || ''
    const joinedOriginal = pairs.map((pair) => pair.original).join('')
    if (fullText.startsWith(joinedOriginal)) {
      const tail = fullText.slice(joinedOriginal.length)
      if (tail.trim()) {
        return [...pairs, { original: tail, translated: null }]
      }
    }
    return pairs
  }

  const original = segment.text || ''
  return original.trim() ? [{ original, translated: segment.translatedText ?? null }] : []
}

export function toSentencePairsFromCurrentLive(segment: LiveSegmentLike): RendererSentencePair[] {
  const pairs = normalizePairs(segment.sentencePairs)
  const stableOriginal = getStableLiveText(segment)
  if (pairs.length > 0) {
    const joinedOriginal = pairs.map((pair) => pair.original).join('')
    if (stableOriginal.startsWith(joinedOriginal)) {
      const tail = stableOriginal.slice(joinedOriginal.length)
      if (tail.trim()) {
        return [...pairs, { original: tail, translated: null }]
      }
      return pairs
    }

    if (stableOriginal.trim()) {
      return [{ original: stableOriginal, translated: segment.translatedText ?? null }]
    }

    return pairs
  }

  const original = stableOriginal || segment.text || ''
  return original.trim() ? [{ original, translated: segment.translatedText ?? null }] : []
}
