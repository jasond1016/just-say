import { describe, expect, it } from 'vitest'

import { isWeakBoundarySuffix, shouldFlushSentenceByBoundary } from './commit-boundary'

describe('commit-boundary', () => {
  it('recognizes weak boundary suffix for Chinese/Japanese particles', () => {
    expect(isWeakBoundarySuffix('我们下周再和')).toBe(true)
    expect(isWeakBoundarySuffix('これは重要な')).toBe(false)
    expect(isWeakBoundarySuffix('これは重要なの')).toBe(true)
  })

  it('recognizes weak boundary suffix for English connectors', () => {
    expect(isWeakBoundarySuffix('we need to discuss and')).toBe(true)
    expect(isWeakBoundarySuffix('we need to discuss this topic')).toBe(false)
  })

  it('flushes on strong punctuation with enough meaningful tail', () => {
    expect(shouldFlushSentenceByBoundary('这个方案我们今天先试运行一下。', false)).toBe(true)
  })

  it('does not flush weak sentence on endpoint if suffix is weak', () => {
    expect(shouldFlushSentenceByBoundary('今天我们先和', true)).toBe(false)
  })

  it('flushes non-weak sentence on endpoint', () => {
    expect(shouldFlushSentenceByBoundary('今天我们先讨论发布方案和灰度节奏', true)).toBe(true)
  })

  it('flushes english sentence more aggressively on strong punctuation', () => {
    expect(
      shouldFlushSentenceByBoundary('Years ago, I found this blog called Rdom Ramblings.', false)
    ).toBe(true)
  })

  it('flushes english clause on soft boundary when long enough', () => {
    expect(
      shouldFlushSentenceByBoundary(
        'This guy named I Gat, who was most well known for this essay,',
        false
      )
    ).toBe(true)
  })

  it('still blocks weak english endpoint suffixes', () => {
    expect(shouldFlushSentenceByBoundary('We should talk to', true)).toBe(false)
  })
})
