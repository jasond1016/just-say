import { describe, expect, it } from 'vitest'

import { buildCurrentSpeakerSegment, getStableDisplayText } from './live-segment'

describe('live-segment', () => {
  it('prefers backend stable and unstable text when available', () => {
    const segment = buildCurrentSpeakerSegment(
      null,
      {
        speaker: 0,
        text: '皆さん、お元気ですか今日は',
        stableText: '皆さん、お元気ですか',
        unstableText: '今日は'
      },
      [
        { text: '皆さん、', startMs: 0, endMs: 300 },
        { text: 'お元気ですか', startMs: 300, endMs: 900 },
        { text: '今日は', startMs: 900, endMs: 1200 }
      ]
    )

    expect(segment.text).toBe('皆さん、お元気ですか今日は')
    expect(segment.stableText).toBe('皆さん、お元気ですか')
    expect(segment.previewText).toBe('今日は')
    expect(segment.unstableText).toBe('今日は')
    expect(segment.wordTimings).toHaveLength(3)
  })

  it('falls back to trailing word timings when backend stable split is unavailable', () => {
    const segment = buildCurrentSpeakerSegment(
      {
        speaker: 0,
        text: 'かき氷は'
      },
      {
        speaker: 0,
        text: 'かき氷はイチゴ味です'
      },
      [
        { text: 'かき氷は', startMs: 0, endMs: 600 },
        { text: 'イチゴ', startMs: 600, endMs: 900 },
        { text: '味です', startMs: 900, endMs: 1200 }
      ]
    )

    expect(segment.text).toBe('かき氷はイチゴ味です')
    expect(segment.stableText).toBe('かき氷は')
    expect(segment.previewText).toBe('イチゴ味です')
  })

  it('falls back to text overlap heuristics when timings are not usable', () => {
    const segment = buildCurrentSpeakerSegment(
      {
        speaker: 0,
        text: 'Hello wor'
      },
      {
        speaker: 0,
        text: 'Hello world'
      }
    )

    expect(segment.text).toBe('Hello world')
    expect(segment.stableText).toBe('Hello wor')
    expect(segment.previewText).toBe('ld')
  })

  it('extracts stable display text by removing preview suffix when needed', () => {
    expect(
      getStableDisplayText({
        text: 'かき氷はイチゴ味です',
        previewText: '味です'
      })
    ).toBe('かき氷はイチゴ')
  })

  it('preserves english whitespace between stable and unstable text', () => {
    const segment = buildCurrentSpeakerSegment(null, {
      speaker: 0,
      text: 'Hello wonderful world',
      stableText: 'Hello wonderful',
      unstableText: ' world'
    })

    expect(segment.stableText).toBe('Hello wonderful')
    expect(segment.previewText).toBe(' world')
    expect(getStableDisplayText(segment)).toBe('Hello wonderful')
  })
})
