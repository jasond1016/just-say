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
      // Use clipboard + paste method for all platforms
      await this.pasteViaClipboard(text)
    } catch (error) {
      console.error('[InputSimulator] Error:', error)
      // Fallback: just copy to clipboard
      clipboard.writeText(text)
      console.log('[InputSimulator] Fallback: copied to clipboard, please paste manually')
    }
  }

  private async pasteViaClipboard(text: string): Promise<void> {
    // Save original clipboard content
    const originalClipboard = clipboard.readText()

    // Write new text to clipboard
    clipboard.writeText(text)

    // Small delay to ensure clipboard is updated
    await this.sleep(50)

    try {
      // Simulate Ctrl+V / Cmd+V
      await this.simulatePaste()

      // Wait a bit for paste to complete
      await this.sleep(100)
    } finally {
      // Restore original clipboard content
      setTimeout(() => {
        clipboard.writeText(originalClipboard)
      }, 200)
    }
  }

  private simulatePaste(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.platform === 'win32') {
        // Windows: Use PowerShell to simulate Ctrl+V
        const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')`
        exec(`powershell -Command "${script.replace(/"/g, '\\"')}"`, (error) => {
          if (error) reject(error)
          else resolve()
        })
      } else if (this.platform === 'darwin') {
        // macOS: Use osascript to simulate Cmd+V
        exec(
          `osascript -e 'tell application "System Events" to keystroke "v" using command down'`,
          (error) => {
            if (error) reject(error)
            else resolve()
          }
        )
      } else {
        // Linux: Try xdotool first, then xclip with xdotool key
        exec('xdotool key --clearmodifiers ctrl+v', (error) => {
          if (error) {
            // Fallback: try ydotool for Wayland
            exec('ydotool key 29:1 47:1 47:0 29:0', (err2) => {
              if (err2) reject(err2)
              else resolve()
            })
          } else {
            resolve()
          }
        })
      }
    })
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
