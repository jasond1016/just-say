import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'
import { app } from 'electron'
import * as fs from 'fs'
import * as os from 'os'

export class AudioRecorder {
  private process: ChildProcess | null = null
  private isRecording = false
  private tempFilePath: string

  constructor() {
    const tempDir = join(app.getPath('temp'), 'justsay')
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true })
    }
    this.tempFilePath = join(tempDir, 'recording.wav')
  }

  async startRecording(): Promise<void> {
    if (this.isRecording) {
      console.warn('[AudioRecorder] Already recording')
      return
    }

    this.isRecording = true

    // Delete old recording if exists
    if (fs.existsSync(this.tempFilePath)) {
      fs.unlinkSync(this.tempFilePath)
    }

    const ffmpegPath = this.getFfmpegPath()
    const args = this.buildFfmpegArgs()

    console.log('[AudioRecorder] Starting:', ffmpegPath, args.join(' '))

    this.process = spawn(ffmpegPath, args)

    this.process.stderr?.on('data', (data: Buffer) => {
      // ffmpeg logs to stderr - only log errors
      const msg = data.toString()
      if (msg.includes('error') || msg.includes('Error')) {
        console.error('[AudioRecorder]', msg)
      }
    })

    this.process.on('error', (err) => {
      console.error('[AudioRecorder] Error:', err)
    })
  }

  async stopRecording(): Promise<Buffer> {
    if (!this.isRecording || !this.process) {
      console.warn('[AudioRecorder] Not recording')
      return Buffer.alloc(0)
    }

    this.isRecording = false

    return new Promise((resolve, reject) => {
      // Send 'q' to ffmpeg to stop gracefully
      if (this.process?.stdin?.writable) {
        this.process.stdin.write('q')
      }

      setTimeout(() => {
        try {
          if (this.process && !this.process.killed) {
            this.process.kill('SIGTERM')
          }
          this.process = null

          if (fs.existsSync(this.tempFilePath)) {
            const audioBuffer = fs.readFileSync(this.tempFilePath)
            console.log('[AudioRecorder] Recorded:', audioBuffer.length, 'bytes')
            resolve(audioBuffer)
          } else {
            console.warn('[AudioRecorder] No audio file found')
            resolve(Buffer.alloc(0))
          }
        } catch (error) {
          reject(error)
        }
      }, 500)
    })
  }

  private getFfmpegPath(): string {
    // Try system ffmpeg
    return os.platform() === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  }

  private buildFfmpegArgs(): string[] {
    const platform = os.platform()

    if (platform === 'win32') {
      // Get default audio device on Windows
      const device = this.getWindowsAudioDevice()
      return [
        '-y',
        '-f',
        'dshow',
        '-i',
        `audio=${device}`,
        '-ar',
        '16000',
        '-ac',
        '1',
        '-acodec',
        'pcm_s16le',
        this.tempFilePath
      ]
    } else if (platform === 'darwin') {
      return [
        '-y',
        '-f',
        'avfoundation',
        '-i',
        ':0',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-acodec',
        'pcm_s16le',
        this.tempFilePath
      ]
    } else {
      return [
        '-y',
        '-f',
        'pulse',
        '-i',
        'default',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-acodec',
        'pcm_s16le',
        this.tempFilePath
      ]
    }
  }

  private getWindowsAudioDevice(): string {
    try {
      // Use spawnSync to properly capture ffmpeg stderr
      const { spawnSync } = require('child_process')
      const result = spawnSync('ffmpeg', ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
        encoding: 'utf8',
        timeout: 5000,
        shell: true
      })

      // ffmpeg outputs device list to stderr
      const output = result.stderr || ''
      const lines = output.split('\n')

      let inAudioSection = false
      for (const line of lines) {
        // Check if we're in the audio device section
        if (line.includes('DirectShow audio devices')) {
          inAudioSection = true
          continue
        }
        // Exit if we hit video section
        if (line.includes('DirectShow video devices')) {
          inAudioSection = false
        }

        if (inAudioSection && line.includes('"')) {
          // Extract device name between quotes
          const match = line.match(/"([^"]+)"/)
          if (match && !match[1].includes('@device')) {
            console.log('[AudioRecorder] Found device:', match[1])
            return match[1]
          }
        }
      }
    } catch (err) {
      console.error('[AudioRecorder] Device detection error:', err)
    }

    // Try common device name patterns
    const commonNames = [
      'Microphone Array',
      'Microphone (Realtek',
      'Microphone (High Definition Audio',
      'Microphone (USB',
      'Microphone'
    ]

    console.log('[AudioRecorder] Using fallback device search')
    return commonNames[0] // Will iterate if needed
  }

  getRecordingPath(): string {
    return this.tempFilePath
  }
}
