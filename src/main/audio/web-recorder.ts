import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

/**
 * Web-based audio recorder using a hidden BrowserWindow.
 * Replaces ffmpeg-based AudioRecorder for non-streaming mode.
 * Accumulates audio chunks and returns a single Buffer on stop.
 */
export class WebAudioRecorder {
  private window: BrowserWindow | null = null
  private isRecording = false
  private isReady = false
  private audioChunks: Buffer[] = []
  private resolveStop: ((buffer: Buffer) => void) | null = null

  constructor() {
    this.setupIpcHandlers()
  }

  private setupIpcHandlers(): void {
    ipcMain.on('recording-audio-chunk', (_event, chunk: ArrayBuffer) => {
      if (this.isRecording) {
        this.audioChunks.push(Buffer.from(chunk))
      }
    })

    ipcMain.on('recording-started', () => {
      console.log('[WebAudioRecorder] Capture started in hidden window')
    })

    ipcMain.on('recording-stopped', () => {
      console.log('[WebAudioRecorder] Capture stopped in hidden window')
      const buffer = Buffer.concat(this.audioChunks)
      this.audioChunks = []
      if (this.resolveStop) {
        this.resolveStop(buffer)
        this.resolveStop = null
      }
    })

    ipcMain.on('recording-error', (_event, message: string) => {
      console.error('[WebAudioRecorder] Error:', message)
      this.audioChunks = []
      if (this.resolveStop) {
        this.resolveStop(Buffer.alloc(0))
        this.resolveStop = null
      }
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
    console.log('[WebAudioRecorder] Hidden window initialized')
  }

  async startRecording(): Promise<void> {
    if (this.isRecording) {
      console.warn('[WebAudioRecorder] Already recording')
      return
    }

    if (!this.isReady) {
      await this.initialize()
    }

    this.audioChunks = []
    this.isRecording = true
    this.window?.webContents.send('start-recording')
    console.log('[WebAudioRecorder] Start recording command sent')
  }

  async stopRecording(): Promise<Buffer> {
    if (!this.isRecording) {
      console.warn('[WebAudioRecorder] Not recording')
      return Buffer.alloc(0)
    }

    this.isRecording = false

    return new Promise((resolve) => {
      this.resolveStop = resolve
      this.window?.webContents.send('stop-recording')
      console.log('[WebAudioRecorder] Stop recording command sent')

      // Timeout fallback
      setTimeout(() => {
        if (this.resolveStop) {
          console.warn('[WebAudioRecorder] Stop timeout, returning accumulated data')
          const buffer = Buffer.concat(this.audioChunks)
          this.audioChunks = []
          this.resolveStop(buffer)
          this.resolveStop = null
        }
      }, 1000)
    })
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
    this.audioChunks = []
    ipcMain.removeAllListeners('recording-audio-chunk')
    ipcMain.removeAllListeners('recording-started')
    ipcMain.removeAllListeners('recording-stopped')
    ipcMain.removeAllListeners('recording-error')
  }
}
