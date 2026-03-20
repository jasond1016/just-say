import { beforeEach, describe, expect, it, vi } from 'vitest'

const execSyncMock = vi.fn(() => 'Python 3.11.0')
const transcribeMock = vi.fn()

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => 'D:\\mock',
    getPath: () => 'C:\\mock\\userData'
  }
}))

vi.mock('child_process', () => ({
  execSync: execSyncMock,
  spawn: vi.fn()
}))

vi.mock('./whisperServer', () => ({
  getWhisperServer: vi.fn(() => ({
    isHealthy: vi.fn(),
    detectGpu: vi.fn(),
    transcribe: transcribeMock,
    updateConfig: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    loadModel: vi.fn()
  }))
}))

describe('LocalRecognizer transcription profile', () => {
  beforeEach(() => {
    vi.resetModules()
    execSyncMock.mockClear()
    transcribeMock.mockReset()
    transcribeMock.mockResolvedValue({
      success: true,
      text: 'hello world',
      language: 'en',
      processing_time: 0.12
    })
  })

  it('passes offline-segmented profile to whisper server transcribe', async () => {
    const { LocalRecognizer } = await import('./local')
    const recognizer = new LocalRecognizer({
      useHttpServer: true,
      serverMode: 'remote',
      transcriptionProfile: 'offline_segmented',
      language: 'en'
    })

    await recognizer.recognize(Buffer.from([0, 1, 2, 3]))

    expect(transcribeMock).toHaveBeenCalledTimes(1)
    expect(transcribeMock.mock.calls[0]?.[1]).toMatchObject({
      transcriptionProfile: 'offline_segmented',
      language: 'en',
      skipHealthCheck: true
    })
  })
})
