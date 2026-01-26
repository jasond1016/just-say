import { EventEmitter } from 'events'
import { uIOhook, UiohookKey } from 'uiohook-napi'

export class HotkeyManager extends EventEmitter {
  private isRecording = false
  private targetKey = UiohookKey.AltRight

  constructor() {
    super()
    this.setupListeners()
  }

  private setupListeners(): void {
    uIOhook.on('keydown', (e) => {
      if (e.keycode === this.targetKey && !this.isRecording) {
        this.isRecording = true
        this.emit('recordStart')
      }
    })

    uIOhook.on('keyup', async (e) => {
      if (e.keycode === this.targetKey) {
        const wasRecording = this.isRecording
        this.isRecording = false
        
        // Prevent Alt from triggering system menu by clearing modifier state
        await this.clearAltModifier()
        
        if (wasRecording) {
          this.emit('recordStop')
        }
      }
    })
  }

  private async clearAltModifier(): Promise<void> {
    const { exec } = await import('child_process')
    const { platform } = await import('os')
    
    return new Promise((resolve) => {
      if (platform() === 'win32') {
        // Windows: Use PowerShell to release Alt modifier (pre-installed on Windows 7+)
        const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{ESCAPE}')`
        exec(`powershell -Command "${script.replace(/"/g, '\\"')}"`, () => resolve())
      } else if (platform() === 'darwin') {
        // macOS: Use osascript (built-in to macOS)
        exec(`osascript -e 'tell application "System Events" to key up option using command down' 2>/dev/null`, () => resolve())
      } else {
        // Linux: Release Alt modifier with xdotool (may not be installed, silently fail if missing)
        exec('xdotool keyup Alt_L Alt_R 2>/dev/null || xdotool key --clearmodifiers 2>/dev/null || true', () => {
          exec('xdotool key --delay 10 a 2>/dev/null || true', () => resolve())
        })
      }
    })
  }
  }
  }

  start(): void {
    uIOhook.start()
    console.log('[Hotkey] Started listening for Right Alt key')
  }

  stop(): void {
    uIOhook.stop()
    console.log('[Hotkey] Stopped listening')
  }

  isCurrentlyRecording(): boolean {
    return this.isRecording
  }
}
