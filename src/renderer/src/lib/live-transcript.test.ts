import { describe, expect, it } from 'vitest'

import { accumulateInterimText } from './live-transcript'

describe('live-transcript', () => {
  it('keeps cumulative interim text when the incoming preview is only a rolling window', () => {
    const first = accumulateInterimText('', 'Hi, Charles here. Welcome to you.')
    const second = accumulateInterimText(first, 'Welcom to You to Talk.')
    const third = accumulateInterimText(second, 'He speaks to Japanese.')

    expect(first).toBe('Hi, Charles here. Welcome to you.')
    expect(second).toBe('Hi, Charles here. Welcom to You to Talk.')
    expect(third).toBe('Hi, Charles here. Welcom to You to Talk. He speaks to Japanese.')
  })

  it('replaces the interim text when the incoming snapshot is a fuller prefix-based rewrite', () => {
    const first = accumulateInterimText('', 'Hello wor')
    const second = accumulateInterimText(first, 'Hello world')

    expect(second).toBe('Hello world')
  })

  it('preserves the previous text when the incoming snapshot regresses to a strict prefix', () => {
    const result = accumulateInterimText('Hello world again', 'Hello world')

    expect(result).toBe('Hello world again')
  })

  it('keeps the previous text when an interim packet is empty', () => {
    const result = accumulateInterimText('Hello world again', '')

    expect(result).toBe('Hello world again')
  })

  it('replaces unrelated interim text instead of blindly concatenating it', () => {
    const result = accumulateInterimText('How are you?', 'Today in Japan.')

    expect(result).toBe('Today in Japan.')
  })
})
