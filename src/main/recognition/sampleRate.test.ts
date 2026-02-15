import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => 'D:\\mock',
    getPath: (name: string) => `C:\\mock\\${name}`
  }
}))

vi.mock('child_process', () => ({
  execSync: vi.fn(() => 'Python 3.11'),
  spawn: vi.fn()
}))

const readSampleRate = (wavBuffer: Buffer): number => wavBuffer.readUInt32LE(24)

interface WavFactory {
  createWavBuffer: (buffer: Buffer) => Buffer
}

interface StreamingSonioxHarness {
  ws: { send: (payload: string) => void }
  isConfigSent: boolean
  sendConfig: () => void
}

describe('recognition sample rate handling', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  it('uses configured sample rate in LocalRecognizer WAV header', async () => {
    const { LocalRecognizer } = await import('./local')
    const recognizer = new LocalRecognizer({ sampleRate: 44100, useHttpServer: false })
    const wav = (recognizer as unknown as WavFactory).createWavBuffer(Buffer.alloc(8))

    expect(readSampleRate(wav)).toBe(44100)
  })

  it('falls back to 16000 Hz in LocalRecognizer when unset', async () => {
    const { LocalRecognizer } = await import('./local')
    const recognizer = new LocalRecognizer({ useHttpServer: false })
    const wav = (recognizer as unknown as WavFactory).createWavBuffer(Buffer.alloc(8))

    expect(readSampleRate(wav)).toBe(16000)
  })

  it('uses configured sample rate in GroqRecognizer WAV header', async () => {
    const { GroqRecognizer } = await import('./groq')
    const recognizer = new GroqRecognizer({ sampleRate: 22050 })
    const wav = (recognizer as unknown as WavFactory).createWavBuffer(Buffer.alloc(8))

    expect(readSampleRate(wav)).toBe(22050)
  })

  it('falls back to 16000 Hz in GroqRecognizer when unset', async () => {
    const { GroqRecognizer } = await import('./groq')
    const recognizer = new GroqRecognizer()
    const wav = (recognizer as unknown as WavFactory).createWavBuffer(Buffer.alloc(8))

    expect(readSampleRate(wav)).toBe(16000)
  })

  it('sends configured sample rate in StreamingSonioxRecognizer config', async () => {
    const { StreamingSonioxRecognizer } = await import('./streaming-soniox')
    const recognizer = new StreamingSonioxRecognizer({ apiKey: 'test', sampleRate: 48000 })
    const send = vi.fn()
    const harness = recognizer as unknown as StreamingSonioxHarness
    harness.ws = { send }
    harness.isConfigSent = false
    harness.sendConfig()

    const payload = JSON.parse(send.mock.calls[0][0] as string) as { sample_rate: number }
    expect(payload.sample_rate).toBe(48000)
  })

  it('falls back to 16000 Hz in StreamingSonioxRecognizer config', async () => {
    const { StreamingSonioxRecognizer } = await import('./streaming-soniox')
    const recognizer = new StreamingSonioxRecognizer({ apiKey: 'test' })
    const send = vi.fn()
    const harness = recognizer as unknown as StreamingSonioxHarness
    harness.ws = { send }
    harness.isConfigSent = false
    harness.sendConfig()

    const payload = JSON.parse(send.mock.calls[0][0] as string) as { sample_rate: number }
    expect(payload.sample_rate).toBe(16000)
  })
})
