import { BrowserWindow, ipcMain } from 'electron'
import { EventEmitter } from 'events'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

/**
 * Web-based streaming audio recorder using a hidden BrowserWindow.
 * Replaces ffmpeg-based StreamingAudioRecorder for push-to-talk.
 */
export class WebStreamingAudioRecorder extends EventEmitter {
  private window: BrowserWindow | null = null
  private isRecording = false
  private isReady = false

  constructor() {
    super()
    this.setupIpcHandlers()
  }

  private setupIpcHandlers(): void {
    ipcMain.on('ptt-audio-chunk', (_event, chunk: ArrayBuffer) => {
      this.emit('data', Buffer.from(chunk))
    })

    ipcMain.on('ptt-started', () => {
      console.log('[WebStreamingRecorder] Capture started in hidden window')
    })

    ipcMain.on('ptt-stopped', () => {
      console.log('[WebStreamingRecorder] Capture stopped in hidden window')
      this.emit('end', 0)
    })

    ipcMain.on('ptt-error', (_event, message: string) => {
      console.error('[WebStreamingRecorder] Error:', message)
      this.emit('error', new Error(message))
    })
  }

  async initialize(): Promise<void> {
    if (this.window) {
      return
    }

    this.window = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true
      }
    })

    const url = is.dev
      ? `${process.env['ELECTRON_RENDERER_URL']}/audio-capture.html`
      : `file://${join(__dirname, '../renderer/audio-capture.html')}`

    await this.window.loadURL(url)
    this.isReady = true
    console.log('[WebStreamingRecorder] Hidden window initialized')
  }

  async startRecording(): Promise<void> {
    if (this.isRecording) {
      console.warn('[WebStreamingRecorder] Already recording')
      return
    }

    if (!this.isReady) {
      await this.initialize()
    }

    this.isRecording = true
    this.window?.webContents.send('start-ptt-capture')
    console.log('[WebStreamingRecorder] Start recording command sent')
  }

  stopRecording(): void {
    if (!this.isRecording) {
      console.warn('[WebStreamingRecorder] Not recording')
      return
    }

    this.isRecording = false
    this.window?.webContents.send('stop-ptt-capture')
    console.log('[WebStreamingRecorder] Stop recording command sent')
  }

  isCurrentlyRecording(): boolean {
    return this.isRecording
  }

  destroy(): void {
    if (this.window) {
      this.window.close()
      this.window = null
    }
    this.isReady = false
    this.isRecording = false
    ipcMain.removeAllListeners('ptt-audio-chunk')
    ipcMain.removeAllListeners('ptt-started')
    ipcMain.removeAllListeners('ptt-stopped')
    ipcMain.removeAllListeners('ptt-error')
  }
}
