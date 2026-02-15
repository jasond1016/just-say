import { describe, it, expect, vi, beforeEach } from 'vitest'

const { listeners, mockUiohook, mockKeys, mockPlatform } = vi.hoisted(() => {
  type HookEvent = { keycode: number }
  const listeners: Record<string, (e: HookEvent) => Promise<void> | void> = {}
  const mockUiohook = {
    on: vi.fn((event: string, listener: (e: HookEvent) => Promise<void> | void) => {
      listeners[event] = listener
      return mockUiohook
    }),
    start: vi.fn(),
    stop: vi.fn(),
    keyTap: vi.fn(),
    keyToggle: vi.fn()
  }

  const mockKeys = {
    Escape: 1,
    F13: 91,
    F14: 92,
    CtrlRight: 3613,
    AltRight: 3640
  }

  const mockPlatform = vi.fn()

  return { listeners, mockUiohook, mockKeys, mockPlatform }
})

vi.mock('uiohook-napi', () => ({
  uIOhook: mockUiohook,
  UiohookKey: mockKeys
}))

vi.mock('os', () => ({
  platform: mockPlatform
}))

import { HotkeyManager } from './hotkey'

describe('HotkeyManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(listeners)) {
      delete listeners[key]
    }
  })

  it('starts and stops uIOhook', () => {
    mockPlatform.mockReturnValue('win32')
    const manager = new HotkeyManager('RCtrl')
    manager.start()
    manager.stop()

    expect(mockUiohook.start).toHaveBeenCalledTimes(1)
    expect(mockUiohook.stop).toHaveBeenCalledTimes(1)
  })

  it('uses configured trigger key and emits start/stop', async () => {
    mockPlatform.mockReturnValue('win32')
    const manager = new HotkeyManager('F13')
    const recordStart = vi.fn()
    const recordStop = vi.fn()

    manager.on('recordStart', recordStart)
    manager.on('recordStop', recordStop)

    expect(listeners.keydown).toBeTypeOf('function')
    expect(listeners.keyup).toBeTypeOf('function')

    listeners.keydown({ keycode: mockKeys.F13 })
    await listeners.keyup({ keycode: mockKeys.F13 })

    expect(recordStart).toHaveBeenCalledTimes(1)
    expect(recordStop).toHaveBeenCalledTimes(1)
  })

  it('updates trigger key at runtime', async () => {
    mockPlatform.mockReturnValue('win32')
    const manager = new HotkeyManager('RAlt')
    const recordStart = vi.fn()

    manager.on('recordStart', recordStart)

    manager.setTriggerKey('RCtrl')
    listeners.keydown({ keycode: mockKeys.AltRight })
    listeners.keydown({ keycode: mockKeys.CtrlRight })

    expect(recordStart).toHaveBeenCalledTimes(1)
  })

  it('clears Windows Alt menu focus only when using RAlt and recording occurred', async () => {
    mockPlatform.mockReturnValue('win32')
    const manager = new HotkeyManager('RAlt')
    const recordStop = vi.fn()
    manager.on('recordStop', recordStop)

    // Press and release: should clear Alt side-effect and stop recording
    listeners.keydown({ keycode: mockKeys.AltRight })
    await listeners.keyup({ keycode: mockKeys.AltRight })

    expect(mockUiohook.keyTap).toHaveBeenCalledTimes(1)
    expect(mockUiohook.keyTap).toHaveBeenCalledWith(mockKeys.Escape)
    expect(recordStop).toHaveBeenCalledTimes(1)

    // Release again without recording: should not clear again
    await listeners.keyup({ keycode: mockKeys.AltRight })
    expect(mockUiohook.keyTap).toHaveBeenCalledTimes(1)
  })

  it('does not attempt Alt clearing on non-Windows platforms', async () => {
    mockPlatform.mockReturnValue('linux')
    const manager = new HotkeyManager('RAlt')
    manager.on('recordStop', vi.fn())

    listeners.keydown({ keycode: mockKeys.AltRight })
    await listeners.keyup({ keycode: mockKeys.AltRight })

    expect(mockUiohook.keyTap).not.toHaveBeenCalled()
  })
})
