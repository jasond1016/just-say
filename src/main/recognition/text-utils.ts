export const findTextOverlap = (left: string, right: string, maxOverlap = 200): number => {
  if (!left || !right) return 0

  const limit = Math.min(maxOverlap, left.length, right.length)
  for (let i = limit; i > 0; i--) {
    if (left.slice(-i) === right.slice(0, i)) {
      return i
    }
  }
  return 0
}

export const mergeText = (left: string, right: string): string => {
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

export const mergeStreamingChunkText = (left: string, right: string): string => {
  if (!left) return right
  if (!right) return left

  const exactOverlap = findTextOverlap(left, right, 200)
  if (exactOverlap > 0) {
    return mergeText(left, right.slice(exactOverlap))
  }

  const replacement = replaceWeakTailWithContinuation(left, right)
  if (replacement) {
    return replacement
  }

  return mergeText(left, right)
}

const shouldInsertSpace = (left: string, right: string): boolean => {
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

const isWordChar = (char: string): boolean => /[\p{L}\p{N}]/u.test(char)

const isCjkChar = (char: string): boolean =>
  /[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(char)

const isSentencePunct = (char: string): boolean => /[.!?;:]/.test(char)

const normalizeLooseText = (text: string): string =>
  Array.from(text)
    .filter((char) => /[\p{L}\p{N}\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff]/u.test(char))
    .join('')
    .toLowerCase()

const replaceWeakTailWithContinuation = (left: string, right: string): string | null => {
  const trimmedLeft = left.replace(/[\s,，、。！？!?;；:：]+$/gu, '')
  if (!trimmedLeft) return null

  const normalizedRight = normalizeLooseText(right)
  for (let size = Math.min(8, trimmedLeft.length); size >= 2; size -= 1) {
    const tail = trimmedLeft.slice(-size)
    if (!Array.from(tail).every(isLooseWordChar)) {
      continue
    }

    const normalizedTail = normalizeLooseText(tail)
    if (
      normalizedTail.length < 2 ||
      !normalizedRight.startsWith(normalizedTail) ||
      normalizedRight.length <= normalizedTail.length
    ) {
      continue
    }

    return mergeText(trimmedLeft.slice(0, -size), right)
  }

  return null
}

const isLooseWordChar = (char: string): boolean =>
  /[\p{L}\p{N}\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff]/u.test(char)
