import { spawn, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import * as os from 'os'

/**
 * Streaming audio recorder that emits audio chunks in real-time
 * instead of writing to a file.
 */
export class StreamingAudioRecorder extends EventEmitter {
  private process: ChildProcess | null = null
  private isRecording = false

  async startRecording(): Promise<void> {
    if (this.isRecording) {
      console.warn('[StreamingRecorder] Already recording')
      return
    }

    this.isRecording = true

    const ffmpegPath = this.getFfmpegPath()
    const args = this.buildFfmpegArgs()

    console.log('[StreamingRecorder] Starting:', ffmpegPath, args.join(' '))

    this.process = spawn(ffmpegPath, args)

    // Emit audio data chunks as they come
    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.emit('data', chunk)
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString()
      if (msg.includes('error') || msg.includes('Error')) {
        console.error('[StreamingRecorder]', msg)
      }
    })

    this.process.on('error', (err) => {
      console.error('[StreamingRecorder] Error:', err)
      this.emit('error', err)
    })

    this.process.on('close', (code) => {
      this.isRecording = false
      this.emit('end', code)
    })
  }

  stopRecording(): void {
    if (!this.isRecording || !this.process) {
      console.warn('[StreamingRecorder] Not recording')
      return
    }

    this.isRecording = false

    // Send 'q' to ffmpeg to stop gracefully
    if (this.process.stdin?.writable) {
      this.process.stdin.write('q')
    }

    // Force kill after a short delay if not stopped
    setTimeout(() => {
      if (this.process && !this.process.killed) {
        this.process.kill('SIGTERM')
      }
      this.process = null
    }, 100)
  }

  private getFfmpegPath(): string {
    return os.platform() === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  }

  private buildFfmpegArgs(): string[] {
    const platform = os.platform()

    // Low-latency parameters to reduce capture delay
    const lowLatencyArgs = [
      '-probesize', '32',
      '-analyzeduration', '0',
      '-fflags', 'nobuffer+flush_packets',
      '-flags', 'low_delay'
    ]

    // Common output args: output to stdout as raw PCM
    const outputArgs = [
      '-ar', '16000',      // 16kHz sample rate
      '-ac', '1',          // mono
      '-f', 's16le',       // raw PCM signed 16-bit little-endian
      '-'                  // output to stdout
    ]

    if (platform === 'win32') {
      return [
        ...lowLatencyArgs,
        '-f', 'dshow',
        '-i', 'audio=@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{default}',
        ...outputArgs
      ]
    } else if (platform === 'darwin') {
      return [
        ...lowLatencyArgs,
        '-f', 'avfoundation',
        '-i', ':0',
        ...outputArgs
      ]
    } else {
      // Linux with PulseAudio
      return [
        ...lowLatencyArgs,
        '-f', 'pulse',
        '-i', 'default',
        ...outputArgs
      ]
    }
  }

  isCurrentlyRecording(): boolean {
    return this.isRecording
  }
}
