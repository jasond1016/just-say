import { EventEmitter } from 'events'
import { platform } from 'os'
import { uIOhook, UiohookKey } from 'uiohook-napi'
import { getTriggerKeyLabel, normalizeTriggerKey, type TriggerKey } from '../shared/hotkey'

const TRIGGER_KEY_TO_UIOHOOK_KEY: Record<TriggerKey, number> = {
  RAlt: UiohookKey.AltRight,
  RCtrl: UiohookKey.CtrlRight,
  F13: UiohookKey.F13,
  F14: UiohookKey.F14
}

export class HotkeyManager extends EventEmitter {
  private isRecording = false
  private triggerKey: TriggerKey = normalizeTriggerKey(undefined)
  private targetKey = TRIGGER_KEY_TO_UIOHOOK_KEY[this.triggerKey]
  private triggerKeyLabel = getTriggerKeyLabel(this.triggerKey)

  constructor(triggerKey?: unknown) {
    super()
    this.setTriggerKey(triggerKey)
    this.setupListeners()
  }

  setTriggerKey(triggerKey?: unknown): void {
    const normalized = normalizeTriggerKey(triggerKey)
    this.triggerKey = normalized
    this.targetKey = TRIGGER_KEY_TO_UIOHOOK_KEY[normalized]
    this.triggerKeyLabel = getTriggerKeyLabel(normalized)
  }

  getTriggerKeyLabel(): string {
    return this.triggerKeyLabel
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

        if (wasRecording && this.targetKey === UiohookKey.AltRight) {
          // Prevent Right Alt from triggering the Windows menu focus after release
          await this.clearAltModifier()
        }

        if (wasRecording) {
          this.emit('recordStop')
        }
      }
    })
  }

  private async clearAltModifier(): Promise<void> {
    if (platform() !== 'win32') return
    try {
      uIOhook.keyTap(UiohookKey.Escape)
    } catch {
      // Best-effort only
    }
  }

  start(): void {
    uIOhook.start()
    console.log(`[Hotkey] Started listening for ${this.triggerKeyLabel}`)
  }

  stop(): void {
    uIOhook.stop()
    console.log('[Hotkey] Stopped listening')
  }

  isCurrentlyRecording(): boolean {
    return this.isRecording
  }
}
