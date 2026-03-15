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

    expect(partials.at(-1)?.currentSegment).toMatchObject({
      text: '皆さん、お元気ですか？今日は？',
      stableText: '皆さん、お元気ですか？',
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

    expect(partials.at(-1)?.currentSegment).toMatchObject({
      text: "Hello and welcome. I'm Adam.",
      stableText: "Hello and welcome. I'm",
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

    expect(partials.at(-1)?.currentSegment).toMatchObject({
      text: "Hello and welcome. I'm Adam."
    })
    expect(partials.at(-1)?.currentSegment?.sentencePairs).toEqual([
      { original: 'Hello and welcome.' },
      { original: "I'm Adam." }
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

    expect(partials.at(-1)?.currentSegment).toMatchObject({
      text: 'Hello and welcome.',
      endpointReason: 'silence'
    })
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

    expect(partials.at(-1)?.currentSegment).toMatchObject({
      text: 'Hello and welcome.'
    })
    expect(partials.at(-1)?.currentSegment?.sentencePairs).toBeUndefined()
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

    expect(partials.at(-1)?.currentSegment).toMatchObject({
      text: "Hello and welcome. I'm Adam.",
      stableText: "Hello and welcome. I'm",
      unstableText: ' Adam.'
    })
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
