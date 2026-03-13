function findTextOverlap(left: string, right: string, maxOverlap = 200): number {
  if (!left || !right) return 0

  const limit = Math.min(maxOverlap, left.length, right.length)
  for (let i = limit; i > 0; i -= 1) {
    if (left.slice(-i) === right.slice(0, i)) {
      return i
    }
  }
  return 0
}

function mergeText(left: string, right: string): string {
  if (!left) return right
  if (!right) return left

  if (/\s$/.test(left) || /^\s/.test(right)) {
    return left + right
  }

  if (shouldInsertSpace(left, right)) {
    return `${left} ${right}`
  }

  return left + right
}

function shouldInsertSpace(left: string, right: string): boolean {
  const tail = left[left.length - 1]
  const head = right[0]
  if (!tail || !head) return false
  if (isCjkChar(tail) || isCjkChar(head)) return false

  const tailWord = isWordChar(tail)
  const headWord = isWordChar(head)
  if (tailWord && headWord) return true
  if (isSentencePunct(tail) && headWord) return true

  return false
}

function isWordChar(char: string): boolean {
  return /[\p{L}\p{N}]/u.test(char)
}

function isCjkChar(char: string): boolean {
  return /[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(char)
}

function isSentencePunct(char: string): boolean {
  return /[.!?;:]/.test(char)
}

function getCommonPrefix(left: string, right: string): string {
  const leftChars = Array.from(left)
  const rightChars = Array.from(right)
  const limit = Math.min(leftChars.length, rightChars.length)
  let index = 0

  while (index < limit && leftChars[index] === rightChars[index]) {
    index += 1
  }

  return leftChars.slice(0, index).join('')
}

function getMeaningfulCharCount(text: string): number {
  return Array.from(text).filter((char) =>
    /[\p{L}\p{N}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char)
  ).length
}

function toLooseChars(text: string): Array<{ char: string; index: number }> {
  const chars: Array<{ char: string; index: number }> = []
  let index = 0

  while (index < text.length) {
    const codePoint = text.codePointAt(index)
    if (codePoint === undefined) {
      break
    }

    const char = String.fromCodePoint(codePoint)
    if (/[\p{L}\p{N}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char)) {
      chars.push({ char: char.toLowerCase(), index })
    }
    index += char.length
  }

  return chars
}

function replaceNearTailWithIncoming(previous: string, incoming: string): string | null {
  const previousChars = toLooseChars(previous)
  const incomingChars = toLooseChars(incoming)
  if (previousChars.length < 6 || incomingChars.length < 6) {
    return null
  }

  const maxSize = Math.min(24, previousChars.length, incomingChars.length)
  for (let size = maxSize; size >= 6; size -= 1) {
    const incomingPrefix = incomingChars
      .slice(0, size)
      .map((item) => item.char)
      .join('')

    const searchStart = Math.max(0, previousChars.length - size - 20)
    const searchEnd = previousChars.length - size
    for (let start = searchEnd; start >= searchStart; start -= 1) {
      const candidate = previousChars
        .slice(start, start + size)
        .map((item) => item.char)
        .join('')
      if (candidate !== incomingPrefix) {
        continue
      }

      const replaceFrom = previousChars[start].index
      return mergeText(previous.slice(0, replaceFrom).trimEnd(), incoming)
    }
  }

  return null
}

export function accumulateInterimText(previous: string, incoming: string): string {
  if (!incoming?.trim()) {
    return previous
  }
  if (!previous?.trim()) {
    return incoming
  }
  if (incoming === previous) {
    return incoming
  }
  if (incoming.startsWith(previous)) {
    return incoming
  }
  if (previous.startsWith(incoming)) {
    return previous
  }

  const commonPrefix = getCommonPrefix(previous, incoming)
  const commonMeaningfulChars = getMeaningfulCharCount(commonPrefix)
  const previousMeaningfulChars = getMeaningfulCharCount(previous)
  const incomingMeaningfulChars = getMeaningfulCharCount(incoming)
  const meaningfulFloor = Math.max(1, Math.min(previousMeaningfulChars, incomingMeaningfulChars))

  if (commonMeaningfulChars >= 12 || commonMeaningfulChars / meaningfulFloor >= 0.7) {
    return incoming
  }

  const overlap = findTextOverlap(previous, incoming)
  if (overlap > 0) {
    return mergeText(previous, incoming.slice(overlap))
  }

  const replaced = replaceNearTailWithIncoming(previous, incoming)
  if (replaced) {
    return replaced
  }

  const previousIsSentenceLike =
    /[.!?。！？]$/.test(previous.trim()) && previousMeaningfulChars >= 12
  if (previousIsSentenceLike && incomingMeaningfulChars >= 8) {
    return mergeText(previous, incoming)
  }

  return incoming
}
