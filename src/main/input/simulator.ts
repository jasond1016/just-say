import { exec } from 'child_process'
import { clipboard } from 'electron'
import * as os from 'os'

export class InputSimulator {
  private platform: string
  private lastChar: string = ''

  constructor() {
    this.platform = os.platform()
  }

  async typeText(
    text: string,
    options?: {
      method?: 'simulate_input' | 'clipboard' | 'popup'
      autoSpace?: boolean
      capitalize?: boolean
    }
  ): Promise<string | null> {
    if (!text?.trim()) {
      console.log('[InputSimulator] No text to type')
      return null
    }

    let finalText = text
    const method = options?.method || 'simulate_input'

    // 1. Handle Capitalize
    if (options?.capitalize && finalText.length > 0) {
      finalText = finalText.charAt(0).toUpperCase() + finalText.slice(1)
    }

    // 2. Handle AutoSpace
    if (options?.autoSpace) {
      const isAlphaNum = (char: string): boolean => /^[a-zA-Z0-9]$/.test(char)

      // If last char was alphaNum AND current first char is alphaNum -> add space
      if (
        this.lastChar &&
        finalText.length > 0 &&
        isAlphaNum(this.lastChar) &&
        isAlphaNum(finalText.charAt(0))
      ) {
        finalText = ' ' + finalText
      }
    }

    console.log(
      '[InputSimulator] Typing:',
      finalText.substring(0, 50) + (finalText.length > 50 ? '...' : '')
    )

    if (method === 'clipboard' || method === 'popup') {
      clipboard.writeText(finalText)
      console.log('[InputSimulator] Copied to clipboard')
    } else {
      try {
        // Use clipboard + paste method for all platforms
        await this.pasteViaClipboard(finalText)
      } catch (error) {
        console.error('[InputSimulator] Auto-paste error:', error)
        // Fallback: just copy to clipboard
        clipboard.writeText(finalText)
        console.log('[InputSimulator] Fallback: copied to clipboard, please paste manually')
      }
    }

    // 3. Update state
    if (finalText.length > 0) {
      this.lastChar = finalText.charAt(finalText.length - 1)
    }

    return finalText
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
