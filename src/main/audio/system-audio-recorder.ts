import { spawn, ChildProcess, spawnSync } from 'child_process'
import { EventEmitter } from 'events'
import * as os from 'os'

export interface SystemAudioSource {
  id: string
  name: string
  isDefault?: boolean
}

/**
 * System audio recorder that captures desktop/system audio output.
 * Uses platform-specific methods:
 * - Linux: PulseAudio monitor sources
 * - Windows: WASAPI loopback
 * - macOS: Requires virtual audio driver (BlackHole/Soundflower)
 */
export class SystemAudioRecorder extends EventEmitter {
  private process: ChildProcess | null = null
  private isRecording = false
  private selectedSource: string | null = null

  /**
   * Get available system audio sources for capture.
   */
  async getAvailableSources(): Promise<SystemAudioSource[]> {
    const platform = os.platform()

    if (platform === 'linux') {
      return this.getLinuxSources()
    } else if (platform === 'win32') {
      return this.getWindowsSources()
    } else if (platform === 'darwin') {
      return this.getMacOSSources()
    }

    return []
  }

  /**
   * Set the audio source to capture from.
   */
  setSource(sourceId: string): void {
    this.selectedSource = sourceId
  }

  /**
   * Start capturing system audio. Emits 'data' events with audio chunks.
   */
  async startRecording(): Promise<void> {
    if (this.isRecording) {
      console.warn('[SystemAudioRecorder] Already recording')
      return
    }

    // Auto-detect source if not set
    if (!this.selectedSource) {
      const sources = await this.getAvailableSources()
      const defaultSource = sources.find((s) => s.isDefault) || sources[0]
      if (!defaultSource) {
        throw new Error('No system audio source available')
      }
      this.selectedSource = defaultSource.id
      console.log('[SystemAudioRecorder] Auto-selected source:', defaultSource.name)
    }

    this.isRecording = true

    const ffmpegPath = this.getFfmpegPath()
    const args = this.buildFfmpegArgs()

    console.log('[SystemAudioRecorder] Starting:', ffmpegPath, args.join(' '))

    this.process = spawn(ffmpegPath, args)

    // Emit audio data chunks as they come
    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.emit('data', chunk)
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString()
      if (msg.includes('error') || msg.includes('Error')) {
        console.error('[SystemAudioRecorder]', msg)
      }
    })

    this.process.on('error', (err) => {
      console.error('[SystemAudioRecorder] Error:', err)
      this.emit('error', err)
    })

    this.process.on('close', (code) => {
      this.isRecording = false
      this.emit('end', code)
    })
  }

  /**
   * Stop capturing system audio.
   */
  stopRecording(): void {
    if (!this.isRecording || !this.process) {
      console.warn('[SystemAudioRecorder] Not recording')
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

  isCurrentlyRecording(): boolean {
    return this.isRecording
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
    const outputArgs = ['-ar', '16000', '-ac', '1', '-f', 's16le', '-']

    if (platform === 'win32') {
      // Windows: WASAPI loopback
      return [...lowLatencyArgs, '-f', 'dshow', '-i', `audio=${this.selectedSource}`, ...outputArgs]
    } else if (platform === 'darwin') {
      // macOS: AVFoundation with virtual audio device
      return [...lowLatencyArgs, '-f', 'avfoundation', '-i', `:${this.selectedSource}`, ...outputArgs]
    } else {
      // Linux: PulseAudio monitor source
      return [...lowLatencyArgs, '-f', 'pulse', '-i', this.selectedSource!, ...outputArgs]
    }
  }

  /**
   * Get Linux PulseAudio monitor sources
   */
  private getLinuxSources(): SystemAudioSource[] {
    const sources: SystemAudioSource[] = []

    try {
      const result = spawnSync('pactl', ['list', 'short', 'sources'], {
        encoding: 'utf8',
        timeout: 5000
      })

      if (result.stdout) {
        const lines = result.stdout.split('\n')
        for (const line of lines) {
          // Format: INDEX NAME MODULE SAMPLE_SPEC STATE
          const parts = line.split('\t')
          if (parts.length >= 2) {
            const name = parts[1]
            // Monitor sources end with .monitor
            if (name.includes('.monitor')) {
              sources.push({
                id: name,
                name: this.formatLinuxSourceName(name),
                isDefault: name.includes('alsa_output') && name.includes('analog-stereo')
              })
            }
          }
        }
      }
    } catch (err) {
      console.error('[SystemAudioRecorder] Failed to list Linux sources:', err)
    }

    return sources
  }

  /**
   * Get Windows audio output devices (for loopback)
   */
  private getWindowsSources(): SystemAudioSource[] {
    const sources: SystemAudioSource[] = []

    try {
      const result = spawnSync('ffmpeg', ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
        encoding: 'utf8',
        timeout: 5000,
        shell: true
      })

      const output = result.stderr || ''
      const lines = output.split('\n')

      let inAudioSection = false
      for (const line of lines) {
        if (line.includes('DirectShow audio devices')) {
          inAudioSection = true
          continue
        }
        if (line.includes('DirectShow video devices')) {
          inAudioSection = false
        }

        if (inAudioSection && line.includes('"')) {
          const match = line.match(/"([^"]+)"/)
          if (match && !match[1].includes('@device')) {
            // Look for stereo mix or loopback devices
            const name = match[1]
            const isLoopback =
              name.toLowerCase().includes('stereo mix') ||
              name.toLowerCase().includes('loopback') ||
              name.toLowerCase().includes('what u hear')

            sources.push({
              id: name,
              name: name,
              isDefault: isLoopback
            })
          }
        }
      }
    } catch (err) {
      console.error('[SystemAudioRecorder] Failed to list Windows sources:', err)
    }

    return sources
  }

  /**
   * Get macOS audio devices (need virtual audio driver)
   */
  private getMacOSSources(): SystemAudioSource[] {
    const sources: SystemAudioSource[] = []

    try {
      const result = spawnSync('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', '""'], {
        encoding: 'utf8',
        timeout: 5000,
        shell: true
      })

      const output = result.stderr || ''
      const lines = output.split('\n')

      let inAudioSection = false
      for (const line of lines) {
        if (line.includes('AVFoundation audio devices:')) {
          inAudioSection = true
          continue
        }
        if (line.includes('AVFoundation video devices:')) {
          inAudioSection = false
        }

        if (inAudioSection) {
          // Format: [AVFoundation indev @ 0x...] [0] DeviceName
          const match = line.match(/\[(\d+)\]\s+(.+)/)
          if (match) {
            const id = match[1]
            const name = match[2].trim()

            // Check for virtual audio devices
            const isVirtual =
              name.toLowerCase().includes('blackhole') ||
              name.toLowerCase().includes('soundflower') ||
              name.toLowerCase().includes('loopback')

            sources.push({
              id: id,
              name: name,
              isDefault: isVirtual
            })
          }
        }
      }
    } catch (err) {
      console.error('[SystemAudioRecorder] Failed to list macOS sources:', err)
    }

    return sources
  }

  /**
   * Format Linux source name for display
   */
  private formatLinuxSourceName(sourceName: string): string {
    // Convert: alsa_output.pci-0000_00_1f.3.analog-stereo.monitor
    // To: Analog Stereo Output (Monitor)
    if (sourceName.includes('analog-stereo')) {
      return 'Analog Stereo Output (Monitor)'
    } else if (sourceName.includes('hdmi')) {
      return 'HDMI Output (Monitor)'
    } else if (sourceName.includes('usb')) {
      return 'USB Audio Output (Monitor)'
    }
    return sourceName.replace('.monitor', ' (Monitor)')
  }
}
