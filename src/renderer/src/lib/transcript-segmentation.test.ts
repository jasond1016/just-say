import { describe, expect, it } from 'vitest'

import {
  toSentencePairsFromCurrentLive,
  toSentencePairsFromLive,
  toSentencePairsFromStored
} from './transcript-segmentation'

describe('transcript-segmentation', () => {
  it('uses sentence_pairs for stored segments when available', () => {
    const pairs = toSentencePairsFromStored({
      text: 'ignored',
      translated_text: 'ignored',
      sentence_pairs: [
        { original: 'Hello.', translated: '你好。' },
        { original: 'World.', translated: '世界。' }
      ]
    })

    expect(pairs).toEqual([
      { original: 'Hello.', translated: '你好。' },
      { original: 'World.', translated: '世界。' }
    ])
  })

  it('falls back to full text for stored segments without sentence_pairs', () => {
    const pairs = toSentencePairsFromStored({
      text: 'Hello world.',
      translated_text: '你好，世界。'
    })

    expect(pairs).toEqual([{ original: 'Hello world.', translated: '你好，世界。' }])
  })

  it('uses sentencePairs for live segments', () => {
    const pairs = toSentencePairsFromLive({
      text: 'Hello.World.',
      sentencePairs: [
        { original: 'Hello.', translated: '你好。' },
        { original: 'World.', translated: '世界。' }
      ]
    })

    expect(pairs).toEqual([
      { original: 'Hello.', translated: '你好。' },
      { original: 'World.', translated: '世界。' }
    ])
  })

  it('appends untranslated live tail when text extends beyond sentencePairs', () => {
    const pairs = toSentencePairsFromLive({
      text: 'Hello.World.Pending',
      sentencePairs: [
        { original: 'Hello.', translated: '你好。' },
        { original: 'World.', translated: '世界。' }
      ]
    })

    expect(pairs).toEqual([
      { original: 'Hello.', translated: '你好。' },
      { original: 'World.', translated: '世界。' },
      { original: 'Pending', translated: null }
    ])
  })

  it('falls back to full text for live segments without sentencePairs', () => {
    const pairs = toSentencePairsFromLive({
      text: 'Hello world.',
      translatedText: '你好，世界。'
    })

    expect(pairs).toEqual([{ original: 'Hello world.', translated: '你好，世界。' }])
  })

  it('falls back to full text for current live segment when sentencePairs no longer align', () => {
    const pairs = toSentencePairsFromCurrentLive({
      text: 'Hello world again.',
      translatedText: '你好，世界，再次问好。',
      sentencePairs: [{ original: 'world again.', translated: '世界，再次问好。' }]
    })

    expect(pairs).toEqual([
      { original: 'Hello world again.', translated: '你好，世界，再次问好。' }
    ])
  })

  it('uses stableText for current live segment instead of unstable preview tail', () => {
    const pairs = toSentencePairsFromCurrentLive({
      text: 'かき氷はイチゴ味です',
      stableText: 'かき氷は',
      previewText: 'イチゴ味です',
      sentencePairs: [{ original: 'かき氷は', translated: 'Shaved ice is' }]
    })

    expect(pairs).toEqual([{ original: 'かき氷は', translated: 'Shaved ice is' }])
  })

  it('appends only stable tail beyond translated sentencePairs for current live segment', () => {
    const pairs = toSentencePairsFromCurrentLive({
      text: 'かき氷はイチゴ味です',
      stableText: 'かき氷はイチゴ',
      previewText: '味です',
      sentencePairs: [{ original: 'かき氷は', translated: 'Shaved ice is' }]
    })

    expect(pairs).toEqual([
      { original: 'かき氷は', translated: 'Shaved ice is' },
      { original: 'イチゴ', translated: null }
    ])
  })
})
