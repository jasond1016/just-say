import { describe, it, expect } from 'vitest'
import { findTextOverlap, mergeText } from './text-utils'

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
})
