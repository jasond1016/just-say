import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const isHealthyMock = vi.fn<() => Promise<boolean>>()
const spawnMock = vi.fn()
const execSyncMock = vi.fn(() => 'Python 3.11.0')

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => 'D:\\mock',
    getPath: () => 'C:\\mock\\userData'
  }
}))

vi.mock('child_process', () => ({
  execSync: execSyncMock,
  spawn: spawnMock
}))

vi.mock('./whisperServer', () => ({
  getWhisperServer: vi.fn(() => ({
    isHealthy: isHealthyMock,
    detectGpu: vi.fn(),
    transcribe: vi.fn(),
    updateConfig: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    loadModel: vi.fn()
  }))
}))

describe('LocalRecognizer healthCheck', () => {
  beforeEach(() => {
    vi.resetModules()
    isHealthyMock.mockReset()
    spawnMock.mockReset()
    execSyncMock.mockClear()
  })

  it('uses HTTP server health check when useHttpServer is enabled', async () => {
    isHealthyMock.mockResolvedValue(true)
    const { LocalRecognizer } = await import('./local')
    const recognizer = new LocalRecognizer({ useHttpServer: true, serverMode: 'local' })

    const result = await recognizer.healthCheck()

    expect(result).toBe(true)
    expect(isHealthyMock).toHaveBeenCalledTimes(1)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('falls back to async python dependency check when HTTP server is disabled', async () => {
    spawnMock.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & { kill: () => void }
      proc.kill = vi.fn()
      process.nextTick(() => {
        proc.emit('close', 0)
      })
      return proc
    })

    const { LocalRecognizer } = await import('./local')
    const recognizer = new LocalRecognizer({ useHttpServer: false, serverMode: 'local' })

    const result = await recognizer.healthCheck()

    expect(result).toBe(true)
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })
})
