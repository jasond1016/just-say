import { describe, expect, it } from 'vitest'

import { toSentencePairsFromLive, toSentencePairsFromStored } from './transcript-segmentation'

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
})
