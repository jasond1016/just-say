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
  translatedText?: string
  sentencePairs?: Array<{ original: string; translated?: string }>
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
