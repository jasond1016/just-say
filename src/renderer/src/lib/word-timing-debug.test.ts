import { describe, expect, it } from 'vitest'

import { buildVisibleWordTimingChips, formatWordTimingRange } from './word-timing-debug'

describe('buildVisibleWordTimingChips', () => {
  it('marks preview tail tokens even when preview spacing differs', () => {
    const chips = buildVisibleWordTimingChips(
      [
        { text: 'Hello', startMs: 0, endMs: 120 },
        { text: 'and', startMs: 120, endMs: 240 },
        { text: 'welcome', startMs: 240, endMs: 480 },
        { text: 'to', startMs: 480, endMs: 620 },
        { text: 'Adam', startMs: 620, endMs: 880 }
      ],
      ' to Adam'
    )

    expect(chips.map((chip) => ({ text: chip.text, isPreview: chip.isPreview }))).toEqual([
      { text: 'Hello', isPreview: false },
      { text: 'and', isPreview: false },
      { text: 'welcome', isPreview: false },
      { text: 'to', isPreview: true },
      { text: 'Adam', isPreview: true }
    ])
  })

  it('keeps only the most recent timing chips', () => {
    const chips = buildVisibleWordTimingChips(
      [
        { text: 'w1', startMs: 0, endMs: 50 },
        { text: 'w2', startMs: 50, endMs: 100 },
        { text: 'w3', startMs: 100, endMs: 150 },
        { text: 'w4', startMs: 150, endMs: 200 }
      ],
      'w4',
      2
    )

    expect(chips.map((chip) => chip.text)).toEqual(['w3', 'w4'])
    expect(chips.map((chip) => chip.isPreview)).toEqual([false, true])
  })
})

describe('formatWordTimingRange', () => {
  it('formats milliseconds into second ranges', () => {
    expect(formatWordTimingRange(120, 980)).toBe('0.12-0.98s')
  })
})
