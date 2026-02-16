import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const startSessionMock = vi.fn(async () => {})
const isPreConnectedMock = vi.fn(() => false)
const updateConfigMock = vi.fn()

vi.mock('./recognition/streaming-local', () => {
  class MockStreamingLocalRecognizer {
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>()

    constructor(_config?: unknown) {
      void _config
    }

    async preConnect(): Promise<void> {
      await Promise.resolve()
    }

    isPreConnected(): boolean {
      return isPreConnectedMock()
    }

    updateConfig(_config?: unknown): void {
      updateConfigMock(_config)
    }

    async startSession(): Promise<void> {
      await startSessionMock()
    }

    sendAudioChunk(_chunk: Buffer): void {
      void _chunk
    }

    async endSession(): Promise<{
      text: string
      durationMs: number
      segments: []
      currentSegment: null
    }> {
      return { text: '', durationMs: 0, segments: [], currentSegment: null }
    }

    close(): void {
      this.listeners.clear()
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
      const handlers = this.listeners.get(event) || []
      handlers.push(listener)
      this.listeners.set(event, handlers)
      return this
    }

    removeAllListeners(event?: string): this {
      if (event) {
        this.listeners.delete(event)
      } else {
        this.listeners.clear()
      }
      return this
    }
  }

  return { StreamingLocalRecognizer: MockStreamingLocalRecognizer }
})

vi.mock('./utils/profiler', () => ({
  profiler: {
    startSession: vi.fn(),
    markConnectionStart: vi.fn(),
    markConnectionEstablished: vi.fn(),
    markResponseReceived: vi.fn(),
    markAudioSent: vi.fn(),
    printReport: vi.fn(),
    endSession: vi.fn()
  }
}))

describe('MeetingTranscriptionManager pre-connect fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    startSessionMock.mockClear()
    isPreConnectedMock.mockReset()
    isPreConnectedMock.mockReturnValue(false)
    updateConfigMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('continues with cold start after pre-connect wait timeout', async () => {
    const { MeetingTranscriptionManager } = await import('./meeting-transcription')
    const manager = new MeetingTranscriptionManager('local')
    ;(manager as unknown as { preConnectPromise: Promise<void> | null }).preConnectPromise =
      new Promise(() => {})

    const startPromise = manager.startTranscription({
      includeMicrophone: false,
      translationEnabled: false
    })

    await vi.advanceTimersByTimeAsync(2499)
    expect(startSessionMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await startPromise

    expect(startSessionMock).toHaveBeenCalledTimes(1)
    expect(manager.getStatus()).toBe('transcribing')
  })

  it('continues with cold start when in-flight pre-connect fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { MeetingTranscriptionManager } = await import('./meeting-transcription')
    const manager = new MeetingTranscriptionManager('local')
    const failedPreConnect = Promise.reject(new Error('pre-connect failed'))
    void failedPreConnect.catch(() => {})
    ;(manager as unknown as { preConnectPromise: Promise<void> | null }).preConnectPromise =
      failedPreConnect

    await manager.startTranscription({
      includeMicrophone: false,
      translationEnabled: false
    })

    expect(startSessionMock).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      '[MeetingTranscription] In-flight pre-connect failed, fallback to cold start:',
      expect.any(Error)
    )
    warnSpy.mockRestore()
  })
})
