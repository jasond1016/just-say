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

    uIOhook.on('keyup', (e) => {
      if (e.keycode === this.targetKey && this.isRecording) {
        this.isRecording = false
        this.emit('recordStop')
      }
    })
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
