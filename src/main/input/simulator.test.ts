import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockClipboard = {
  readText: vi.fn(() => ''),
  writeText: vi.fn(() => undefined)
}

const mockExec = vi.fn()

vi.mock('electron', () => ({
  clipboard: mockClipboard
}))

vi.mock('child_process', () => ({
  exec: mockExec
}))

vi.mock('os', () => ({
  platform: vi.fn()
}))

describe('InputSimulator', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockClipboard.readText.mockReturnValue('ORIGINAL')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('capitalizes and auto-adds space between alphanumerics', async () => {
    const os = await import('os')
    ;(os.platform as unknown as ReturnType<typeof vi.fn>).mockReturnValue('win32')

    const { InputSimulator } = await import('./simulator')
    const sim = new InputSimulator()

    const r1 = await sim.typeText('hello', { method: 'clipboard', capitalize: true, autoSpace: true })
    const r2 = await sim.typeText('world', { method: 'clipboard', capitalize: true, autoSpace: true })

    expect(r1).toBe('Hello')
    expect(r2).toBe(' World')
    expect(mockClipboard.writeText).toHaveBeenCalledWith('Hello')
    expect(mockClipboard.writeText).toHaveBeenCalledWith(' World')
  })

  it('clipboard mode only writes to clipboard (no auto-paste)', async () => {
    const os = await import('os')
    ;(os.platform as unknown as ReturnType<typeof vi.fn>).mockReturnValue('win32')

    const { InputSimulator } = await import('./simulator')
    const sim = new InputSimulator()

    const result = await sim.typeText('test', { method: 'clipboard' })
    expect(result).toBe('test')
    expect(mockClipboard.writeText).toHaveBeenCalledTimes(1)
    expect(mockClipboard.writeText).toHaveBeenCalledWith('test')
    expect(mockClipboard.readText).not.toHaveBeenCalled()
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('popup mode writes to clipboard (no auto-paste) and returns final text', async () => {
    const os = await import('os')
    ;(os.platform as unknown as ReturnType<typeof vi.fn>).mockReturnValue('win32')

    const { InputSimulator } = await import('./simulator')
    const sim = new InputSimulator()

    const result = await sim.typeText('popup', { method: 'popup' })
    expect(result).toBe('popup')
    expect(mockClipboard.writeText).toHaveBeenCalledTimes(1)
    expect(mockClipboard.writeText).toHaveBeenCalledWith('popup')
    expect(mockClipboard.readText).not.toHaveBeenCalled()
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('simulate_input mode pastes via clipboard and restores original clipboard', async () => {
    vi.useFakeTimers()

    const os = await import('os')
    ;(os.platform as unknown as ReturnType<typeof vi.fn>).mockReturnValue('win32')

    mockExec.mockImplementation((_cmd: string, cb: (err?: Error | null) => void) => cb(null))

    const { InputSimulator } = await import('./simulator')
    const sim = new InputSimulator()

    const p = sim.typeText('hello', { method: 'simulate_input', capitalize: true })
    await vi.runAllTimersAsync()
    const result = await p

    expect(result).toBe('Hello')
    expect(mockClipboard.readText).toHaveBeenCalledTimes(1)
    // Write new content + restore original
    expect(mockClipboard.writeText).toHaveBeenCalledWith('Hello')
    expect(mockClipboard.writeText).toHaveBeenCalledWith('ORIGINAL')
    expect(mockExec).toHaveBeenCalledTimes(1)
  })
})
