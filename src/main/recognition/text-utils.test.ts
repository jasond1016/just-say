import { describe, it, expect } from 'vitest'
import {
  cleanupJapaneseAsrText,
  findTextOverlap,
  mergeStreamingChunkText,
  mergeText
} from './text-utils'

describe('text utils', () => {
  describe('findTextOverlap', () => {
    it('returns longest suffix/prefix overlap', () => {
      expect(findTextOverlap('hello world', 'worldwide')).toBe(5)
      expect(findTextOverlap('你好世界', '世界你好')).toBe(2)
    })

    it('returns zero when no overlap', () => {
      expect(findTextOverlap('abc', 'xyz')).toBe(0)
    })

    it('respects maxOverlap limit', () => {
      expect(findTextOverlap('12345', '34567', 3)).toBe(3)
    })
  })

  describe('mergeText', () => {
    it('inserts space between Latin words', () => {
      expect(mergeText('hello', 'world')).toBe('hello world')
    })

    it('preserves existing whitespace boundaries', () => {
      expect(mergeText('hello ', 'world')).toBe('hello world')
      expect(mergeText('hello', ' world')).toBe('hello world')
    })

    it('adds space after sentence punctuation', () => {
      expect(mergeText('Hello.', 'World')).toBe('Hello. World')
    })

    it('avoids inserting space between CJK characters', () => {
      expect(mergeText('你好', '世界')).toBe('你好世界')
    })
  })

  describe('mergeStreamingChunkText', () => {
    it('replaces a weak trailing fragment when the next chunk continues it', () => {
      expect(
        mergeStreamingChunkText(
          'まず1つ目はそうめんですそうめんは細い小麦。',
          '小麦粉 の 麺です茹で 時間 は12分で。'
        )
      ).toBe('まず1つ目はそうめんですそうめんは細い小麦粉 の 麺です茹で 時間 は12分で。')
    })

    it('falls back to regular merge when the next chunk does not continue the tail', () => {
      expect(mergeStreamingChunkText('につけて食べます。', '入れると 美味しいです。')).toBe(
        'につけて食べます。入れると 美味しいです。'
      )
    })
  })

  describe('cleanupJapaneseAsrText', () => {
    it('removes decorative symbols and normalizes Japanese spacing', () => {
      expect(
        cleanupJapaneseAsrText(
          '🎼 そうめん は 細い 小麦粉 の 麺 です。'
        )
      ).toBe('そうめんは細い小麦粉の麺です。')
    })

    it('collapses repeated trailing sentences', () => {
      expect(
        cleanupJapaneseAsrText('流しそうめんもあります。流しそうめんもあります。')
      ).toBe('流しそうめんもあります。')
    })
  })
})
