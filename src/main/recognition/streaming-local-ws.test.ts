import { describe, expect, it, vi } from 'vitest'

vi.mock('./whisperServer', () => ({
  getWhisperServer: vi.fn(() => ({
    getCapabilities: vi.fn(),
    getStreamWsUrl: vi.fn()
  }))
}))

describe('StreamingLocalWsRecognizer', () => {
  it('emits a full visible interim after a committed final chunk', async () => {
    const { StreamingLocalWsRecognizer } = await import('./streaming-local-ws')
    const recognizer = new StreamingLocalWsRecognizer()
    const partials: any[] = []

    recognizer.on('partial', (result) => {
      partials.push(result)
    })
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'final_chunk',
        text: '皆さん、お元気ですか？'
      })
    )
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'endpoint',
        reason: 'silence'
      })
    )
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'interim',
        text: '今日は？',
        stableText: '',
        unstableText: '今日は？'
      })
    )

    expect(partials.at(-1)?.segments).toMatchObject([
      {
        text: '皆さん、お元気ですか？',
        isFinal: true
      }
    ])
    expect(partials.at(-1)?.currentSegment).toMatchObject({
      text: '今日は？',
      unstableText: '今日は？'
    })
  })

  it('treats final_chunk as committed immediately without waiting for endpoint', async () => {
    const { StreamingLocalWsRecognizer } = await import('./streaming-local-ws')
    const recognizer = new StreamingLocalWsRecognizer()
    const partials: any[] = []

    recognizer.on('partial', (result) => {
      partials.push(result)
    })
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'final_chunk',
        text: 'Hello and welcome.'
      })
    )
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'interim',
        text: "I'm Adam.",
        stableText: "I'm",
        unstableText: ' Adam.'
      })
    )

    expect(partials.at(-1)?.segments).toMatchObject([
      {
        text: 'Hello and welcome.',
        isFinal: true
      }
    ])
    expect(partials.at(-1)?.currentSegment).toMatchObject({
      text: "I'm Adam.",
      stableText: "I'm",
      unstableText: ' Adam.'
    })
  })

  it('uses sentence events from the backend to finalize sentence pairs', async () => {
    const { StreamingLocalWsRecognizer } = await import('./streaming-local-ws')
    const recognizer = new StreamingLocalWsRecognizer()
    const partials: any[] = []

    recognizer.on('partial', (result) => {
      partials.push(result)
    })
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'final_chunk',
        text: 'Hello and welcome.'
      })
    )
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'sentence',
        text: 'Hello and welcome.'
      })
    )
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'interim',
        text: "I'm Adam.",
        stableText: "I'm",
        unstableText: ' Adam.'
      })
    )

    expect(partials.at(-1)?.segments).toMatchObject([
      {
        text: 'Hello and welcome.',
        sentencePairs: [{ original: 'Hello and welcome.' }],
        isFinal: true
      }
    ])
    expect(partials.at(-1)?.currentSegment).toMatchObject({
      text: "I'm Adam.",
      stableText: "I'm",
      unstableText: ' Adam.'
    })
  })

  it('moves finalized sentence pairs into completed segments for display', async () => {
    const { StreamingLocalWsRecognizer } = await import('./streaming-local-ws')
    const recognizer = new StreamingLocalWsRecognizer()
    const partials: any[] = []

    recognizer.on('partial', (result) => {
      partials.push(result)
    })
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'final_chunk',
        text: 'Hello and welcome.'
      })
    )
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'sentence',
        text: 'Hello and welcome.'
      })
    )
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'interim',
        text: "I'm Adam.",
        stableText: "I'm",
        unstableText: ' Adam.'
      })
    )

    expect(partials.at(-1)?.segments).toMatchObject([
      {
        text: 'Hello and welcome.',
        sentencePairs: [{ original: 'Hello and welcome.' }],
        isFinal: true
      }
    ])
    expect(partials.at(-1)?.currentSegment).toMatchObject({
      text: "I'm Adam.",
      stableText: "I'm",
      unstableText: ' Adam.'
    })
  })

  it('keeps committed chunks as separate history segments even after a multi-chunk sentence event', async () => {
    const { StreamingLocalWsRecognizer } = await import('./streaming-local-ws')
    const recognizer = new StreamingLocalWsRecognizer()
    const partials: any[] = []

    recognizer.on('partial', (result) => {
      partials.push(result)
    })
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'final_chunk',
        text: '今日は日本の夏に'
      })
    )
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'final_chunk',
        text: 'よく食べるものをご紹介します。'
      })
    )

    expect(partials.at(-1)?.segments).toMatchObject([
      { text: '今日は日本の夏に', isFinal: true },
      { text: 'よく食べるものをご紹介します。', isFinal: true }
    ])

    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'sentence',
        text: '今日は日本の夏によく食べるものをご紹介します。'
      })
    )

    expect(partials.at(-1)?.segments).toMatchObject([
      { text: '今日は日本の夏に', isFinal: true },
      { text: 'よく食べるものをご紹介します。', isFinal: true }
    ])
  })

  it('does not synthesize sentence pairs locally on final without a sentence event', async () => {
    const { StreamingLocalWsRecognizer } = await import('./streaming-local-ws')
    const recognizer = new StreamingLocalWsRecognizer()
    const partials: any[] = []

    recognizer.on('partial', (result) => {
      partials.push(result)
    })
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'final_chunk',
        text: 'Hello and welcome.'
      })
    )
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'final',
        text: 'Hello and welcome.'
      })
    )

    expect(partials.at(-1)?.currentSegment).toBeNull()
    expect(partials.at(-1)?.segments).toMatchObject([
      {
        text: 'Hello and welcome.',
        sentencePairs: undefined,
        isFinal: true
      }
    ])
  })

  it('uses server interim fields directly without local protocol aliases', async () => {
    const { StreamingLocalWsRecognizer } = await import('./streaming-local-ws')
    const recognizer = new StreamingLocalWsRecognizer()
    const partials: any[] = []

    recognizer.on('partial', (result) => {
      partials.push(result)
    })
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'final_chunk',
        text: 'Hello and welcome.'
      })
    )
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'endpoint',
        reason: 'silence'
      })
    )
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'interim',
        text: "I'm Adam.",
        stableText: "I'm",
        unstableText: ' Adam.'
      })
    )

    expect(partials.at(-1)?.segments).toMatchObject([
      {
        text: 'Hello and welcome.',
        isFinal: true
      }
    ])
    expect(partials.at(-1)?.currentSegment).toMatchObject({
      text: "I'm Adam.",
      stableText: "I'm",
      unstableText: ' Adam.'
    })
  })

  it('surfaces completed sentence pairs with translations in committed segments', async () => {
    const { StreamingLocalWsRecognizer } = await import('./streaming-local-ws')
    const recognizer = new StreamingLocalWsRecognizer({
      translation: {
        enabled: true,
        targetLanguage: 'zh',
        translator: async () => '你好。'
      }
    })
    ;(recognizer as any).isActive = true
    const partials: any[] = []

    recognizer.on('partial', (result) => {
      partials.push(result)
    })
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'final_chunk',
        text: 'Hello and welcome.'
      })
    )
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'sentence',
        text: 'Hello and welcome.'
      })
    )

    await Promise.resolve()
    await Promise.resolve()

    expect(partials.at(-1)?.segments).toMatchObject([
      {
        translatedText: '你好。',
        sentencePairs: [{ original: 'Hello and welcome.', translated: '你好。' }]
      }
    ])
  })

  it('surfaces endpoint reason on the current live segment', async () => {
    const { StreamingLocalWsRecognizer } = await import('./streaming-local-ws')
    const recognizer = new StreamingLocalWsRecognizer()
    const partials: any[] = []

    recognizer.on('partial', (result) => {
      partials.push(result)
    })
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'final_chunk',
        text: 'Hello and welcome.'
      })
    )
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'endpoint',
        reason: 'silence'
      })
    )

    expect(partials.at(-1)?.currentSegment).toBeNull()
    expect(partials.at(-1)?.segments).toMatchObject([
      {
        text: 'Hello and welcome.',
        isFinal: true
      }
    ])
  })

  it('preserves english spacing in unstable preview text', async () => {
    const { StreamingLocalWsRecognizer } = await import('./streaming-local-ws')
    const recognizer = new StreamingLocalWsRecognizer()
    const partials: any[] = []

    recognizer.on('partial', (result) => {
      partials.push(result)
    })
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'interim',
        text: 'Hello world',
        stableText: 'Hello',
        unstableText: ' world'
      })
    )
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'interim',
        text: 'Hello wonderful world',
        stableText: 'Hello wonderful',
        unstableText: ' world'
      })
    )

    expect(partials.at(-1)?.currentSegment).toMatchObject({
      text: 'Hello wonderful world',
      stableText: 'Hello wonderful',
      unstableText: ' world'
    })
  })
})
