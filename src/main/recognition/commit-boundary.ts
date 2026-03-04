const WEAK_CJK_SUFFIX_CHARS = new Set([
  '的',
  '了',
  '和',
  '与',
  '及',
  '并',
  '而',
  '但',
  '就',
  '还',
  '呢',
  '吗',
  '吧',
  '啊',
  'は',
  'が',
  'を',
  'に',
  'で',
  'と',
  'へ',
  'も',
  'の'
])

const WEAK_ENGLISH_SUFFIX = /\b(?:and|or|to|of|for|with|the|a|an|but|so|if|that)$/i

export interface SentenceFlushConfig {
  sentenceMinFlushChars?: number
  sentenceSoftFlushChars?: number
  sentenceForceFlushChars?: number
  strongPunctuationMinTailChars?: number
}

export function isWeakBoundarySuffix(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) {
    return false
  }

  const trimmed = normalized.replace(/[。！？!?，、,;；:：\s]+$/u, '').trim()
  if (!trimmed) {
    return true
  }

  const lower = trimmed.toLowerCase()
  if (WEAK_ENGLISH_SUFFIX.test(lower)) {
    return true
  }

  const chars = Array.from(trimmed)
  const tail = chars[chars.length - 1]
  return WEAK_CJK_SUFFIX_CHARS.has(tail)
}

export function shouldFlushSentenceByBoundary(
  sentence: string,
  endpointTriggered: boolean,
  config?: SentenceFlushConfig
): boolean {
  const normalized = sentence.trim()
  if (!normalized) {
    return false
  }

  const sentenceMinFlushChars = config?.sentenceMinFlushChars ?? 14
  const sentenceSoftFlushChars = config?.sentenceSoftFlushChars ?? 28
  const sentenceForceFlushChars = config?.sentenceForceFlushChars ?? 48
  const strongPunctuationMinTailChars = config?.strongPunctuationMinTailChars ?? 3

  const meaningfulChars = getMeaningfulCharCount(normalized)
  if (meaningfulChars >= sentenceForceFlushChars) {
    return true
  }

  const endsWithStrongPunctuation = /[。！？!?]$/.test(normalized)
  if (
    endsWithStrongPunctuation &&
    meaningfulChars >= sentenceMinFlushChars &&
    hasEnoughTailForStrongPunctuationCommit(normalized, strongPunctuationMinTailChars)
  ) {
    return true
  }

  const hasSoftBoundary = /[，、,;；:：]$/.test(normalized)
  if (hasSoftBoundary && meaningfulChars >= sentenceSoftFlushChars) {
    return true
  }

  if (
    endpointTriggered &&
    meaningfulChars >= sentenceMinFlushChars &&
    !isWeakBoundarySuffix(normalized)
  ) {
    return true
  }

  return false
}

function getMeaningfulCharCount(text: string): number {
  let count = 0
  for (const ch of Array.from(text)) {
    if (/[\p{L}\p{N}\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff]/u.test(ch)) {
      count += 1
    }
  }
  return count
}

function hasEnoughTailForStrongPunctuationCommit(text: string, minTailChars: number): boolean {
  const withoutStrongPunctuation = text.replace(/[。！？!?]+$/u, '')
  if (!withoutStrongPunctuation) {
    return false
  }
  const tail = getTailAfterLastBoundary(withoutStrongPunctuation)
  return getMeaningfulCharCount(tail) >= minTailChars
}

function getTailAfterLastBoundary(text: string): string {
  const chars = Array.from(text)
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    if (/[\s,，、。！？!?;；:：]/u.test(chars[i])) {
      return chars.slice(i + 1).join('')
    }
  }
  return text
}
