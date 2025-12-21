import { exec } from 'child_process'
import { clipboard } from 'electron'
import * as os from 'os'

export class InputSimulator {
  private platform: string

  constructor() {
    this.platform = os.platform()
  }

  async typeText(text: string): Promise<void> {
    if (!text?.trim()) {
      console.log('[InputSimulator] No text to type')
      return
    }

    console.log('[InputSimulator] Typing:', text.substring(0, 50) + (text.length > 50 ? '...' : ''))

    try {
      if (this.platform === 'win32') {
        await this.typeWindows(text)
      } else if (this.platform === 'darwin') {
        await this.typeMac(text)
      } else {
        await this.typeLinux(text)
      }
    } catch (error) {
      console.error('[InputSimulator] Error, using clipboard:', error)
      this.copyToClipboard(text)
    }
  }

  private typeWindows(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Escape for PowerShell
      const escaped = text.replace(/'/g, "''").replace(/\n/g, '{ENTER}').replace(/\t/g, '{TAB}')

      const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`

      exec(`powershell -Command "${script.replace(/"/g, '\\"')}"`, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  private typeMac(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const escaped = text.replace(/"/g, '\\"').replace(/'/g, "'\\''")
      exec(`osascript -e 'tell application "System Events" to keystroke "${escaped}"'`, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  private typeLinux(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const escaped = text.replace(/"/g, '\\"')
      exec(`xdotool type --clearmodifiers "${escaped}"`, (error) => {
        if (error) {
          exec(`ydotool type "${escaped}"`, (err2) => {
            if (err2) reject(err2)
            else resolve()
          })
        } else {
          resolve()
        }
      })
    })
  }

  private copyToClipboard(text: string): void {
    clipboard.writeText(text)
    console.log('[InputSimulator] Copied to clipboard')
  }
}
