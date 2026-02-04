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
