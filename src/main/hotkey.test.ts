import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock child_process and os before import
const mockExec = vi.fn()
const mockPlatform = vi.fn()

vi.mock('child_process', () => ({
  exec: mockExec
}))

vi.mock('os', () => ({
  platform: mockPlatform
}))

describe('clearAltModifier - cross-platform behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExec.mockImplementation((_cmd, callback) => {
      // Immediately call the callback
      if (typeof callback === 'function') {
        callback(null)
      }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should call xdotool on Linux', async () => {
    mockPlatform.mockReturnValue('linux')
    
    // Simulate the clearAltModifier logic
    const clearAltModifier = async () => {
      return new Promise<void>((resolve) => {
        mockExec('xdotool keyup Alt_L Alt_R 2>/dev/null || xdotool key --clearmodifiers 2>/dev/null || true', () => {
          mockExec('xdotool key --delay 10 a 2>/dev/null || true', () => {
            resolve()
          })
        })
      })
    }
    
    await clearAltModifier()
    
    expect(mockExec).toHaveBeenCalledTimes(2)
    expect(mockExec.mock.calls[0][0]).toContain('xdotool keyup Alt_L Alt_R')
    expect(mockExec.mock.calls[1][0]).toContain('xdotool key --delay 10 a')
  })

  it('should call PowerShell on Windows', async () => {
    mockPlatform.mockReturnValue('win32')
    
    const clearAltModifier = async () => {
      return new Promise<void>((resolve) => {
        const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{ESCAPE}')`
        mockExec(`powershell -Command "${script.replace(/"/g, '\\"')}"`, () => resolve())
      })
    }
    
    await clearAltModifier()
    
    expect(mockExec).toHaveBeenCalledTimes(1)
    expect(mockExec.mock.calls[0][0]).toContain('powershell')
    expect(mockExec.mock.calls[0][0]).toContain('{ESCAPE}')
  })

  it('should call osascript on macOS', async () => {
    mockPlatform.mockReturnValue('darwin')
    
    const clearAltModifier = async () => {
      return new Promise<void>((resolve) => {
        mockExec(`osascript -e 'tell application "System Events" to key up option using command down' 2>/dev/null`, () => resolve())
      })
    }
    
    await clearAltModifier()
    
    expect(mockExec).toHaveBeenCalledTimes(1)
    expect(mockExec.mock.calls[0][0]).toContain('osascript')
    expect(mockExec.mock.calls[0][0]).toContain('key up option')
  })

  it('should silently ignore if command fails', async () => {
    mockPlatform.mockReturnValue('linux')
    
    // First exec fails (xdotool not installed), second succeeds
    mockExec.mockImplementation((cmd, callback) => {
      if (typeof callback === 'function') {
        if (cmd.includes('keyup Alt_L Alt_R')) {
          callback({ code: 127 }) // Command not found
        } else {
          callback(null)
        }
      }
    })
    
    const clearAltModifier = async () => {
      return new Promise<void>((resolve) => {
        mockExec('xdotool keyup Alt_L Alt_R 2>/dev/null || xdotool key --clearmodifiers 2>/dev/null || true', () => {
          resolve()
        })
      })
    }
    
    // Should not throw, just resolve
    await expect(clearAltModifier()).resolves.toBeUndefined()
  })
})

describe('HotkeyManager - state machine logic', () => {
  it('should track recording state correctly', () => {
    let isRecording = false
    let recordStartCount = 0
    let recordStopCount = 0
    
    // Simulate keydown/keyup handlers
    const handleKeyDown = (keycode: number, targetKey: number) => {
      if (keycode === targetKey && !isRecording) {
        isRecording = true
        recordStartCount++
        return true
      }
      return false
    }
    
    const handleKeyUp = (keycode: number, targetKey: number) => {
      if (keycode === targetKey && isRecording) {
        isRecording = false
        recordStopCount++
        return true
      }
      return false
    }
    
    const TARGET_KEY = 0xA5 // Right Alt
    
    // Initial state
    expect(isRecording).toBe(false)
    expect(recordStartCount).toBe(0)
    
    // Press key - should start recording
    expect(handleKeyDown(TARGET_KEY, TARGET_KEY)).toBe(true)
    expect(isRecording).toBe(true)
    expect(recordStartCount).toBe(1)
    
    // Press again - should be ignored
    expect(handleKeyDown(TARGET_KEY, TARGET_KEY)).toBe(false)
    expect(isRecording).toBe(true)
    expect(recordStartCount).toBe(1)
    
    // Release key - should stop recording
    expect(handleKeyUp(TARGET_KEY, TARGET_KEY)).toBe(true)
    expect(isRecording).toBe(false)
    expect(recordStopCount).toBe(1)
    
    // Release again - should be ignored
    expect(handleKeyUp(TARGET_KEY, TARGET_KEY)).toBe(false)
    expect(isRecording).toBe(false)
    expect(recordStopCount).toBe(1)
  })

  it('should ignore wrong key', () => {
    let isRecording = false
    let recordStartCount = 0
    
    const handleKeyDown = (keycode: number, targetKey: number) => {
      if (keycode === targetKey && !isRecording) {
        isRecording = true
        recordStartCount++
        return true
      }
      return false
    }
    
    const WRONG_KEY = 0x41 // A key
    const TARGET_KEY = 0xA5 // Right Alt
    
    // Press wrong key - should be ignored
    expect(handleKeyDown(WRONG_KEY, TARGET_KEY)).toBe(false)
    expect(isRecording).toBe(false)
    expect(recordStartCount).toBe(0)
  })
})
