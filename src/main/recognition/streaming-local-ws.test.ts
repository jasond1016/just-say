import { describe, expect, it, vi } from 'vitest'

vi.mock('./whisperServer', () => ({
  getWhisperServer: vi.fn(() => ({
    getCapabilities: vi.fn(),
    getStreamWsUrl: vi.fn()
  }))
}))

describe('StreamingLocalWsRecognizer', () => {
  it('keeps the stable preview monotonic when the backend regresses it', async () => {
    const { StreamingLocalWsRecognizer } = await import('./streaming-local-ws')
    const recognizer = new StreamingLocalWsRecognizer()
    const partials: any[] = []

    recognizer.on('partial', (result) => {
      partials.push(result)
    })

    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'interim',
        text: '今日は日本の夏によく食べるものをご紹介しま。',
        stableText: '今日は日本の夏によ',
        unstableText: 'く食べるものをご紹介しま。'
      })
    )
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'interim',
        text: '今日は日本の夏によく食べるものをご紹介します。',
        stableText: '今日は日本の夏によく食べ',
        unstableText: 'るものをご紹介します。'
      })
    )
    ;(recognizer as any).handleMessage(
      JSON.stringify({
        type: 'interim',
        text: '今日は日本の夏によく食べるものをご紹介します。',
        stableText: '今',
        unstableText: '日は日本の夏によく食べるものをご紹介します。'
      })
    )

    expect(partials.at(-1)?.currentSegment).toMatchObject({
      text: '今日は日本の夏によく食べるものをご紹介します。',
      stableText: '今日は日本の夏によく食べ',
      unstableText: 'るものをご紹介します。'
    })
  })

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
