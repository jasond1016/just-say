import { EventEmitter } from 'events'
import { SystemAudioRecorder, SystemAudioSource } from './audio/system-audio-recorder'
import { StreamingAudioRecorder } from './audio/streaming-recorder'
import { StreamingSonioxRecognizer, StreamingSonioxConfig } from './recognition/streaming-soniox'

export interface MeetingTranscriptionOptions {
  includeMicrophone: boolean // Whether to also capture microphone input
  microphoneDevice?: string // Specific microphone device to use
  systemAudioSource?: string // Specific system audio source to use
}

export interface TranscriptSegment {
  text: string
  timestamp: number
  isFinal: boolean
  source?: 'system' | 'microphone' | 'mixed'
}

export type MeetingStatus = 'idle' | 'starting' | 'transcribing' | 'stopping' | 'error'

/**
 * Manages meeting transcription by capturing system audio (and optionally microphone)
 * and sending it to the speech recognition service.
 */
export class MeetingTranscriptionManager extends EventEmitter {
  private systemRecorder: SystemAudioRecorder
  private micRecorder: StreamingAudioRecorder | null = null
  private recognizer: StreamingSonioxRecognizer | null = null
  private sonioxConfig: StreamingSonioxConfig

  private status: MeetingStatus = 'idle'
  private transcriptHistory: TranscriptSegment[] = []

  // For mixing audio streams
  private mixBuffer: Buffer[] = []
  private mixInterval: NodeJS.Timeout | null = null

  constructor(sonioxConfig: StreamingSonioxConfig) {
    super()
    this.sonioxConfig = sonioxConfig
    this.systemRecorder = new SystemAudioRecorder()
  }

  /**
   * Get available system audio sources
   */
  async getSystemAudioSources(): Promise<SystemAudioSource[]> {
    return this.systemRecorder.getAvailableSources()
  }

  /**
   * Get current status
   */
  getStatus(): MeetingStatus {
    return this.status
  }

  /**
   * Get transcript history
   */
  getTranscriptHistory(): TranscriptSegment[] {
    return [...this.transcriptHistory]
  }

  /**
   * Start meeting transcription
   */
  async startTranscription(options: MeetingTranscriptionOptions): Promise<void> {
    if (this.status !== 'idle') {
      throw new Error(`Cannot start transcription in status: ${this.status}`)
    }

    this.setStatus('starting')
    this.transcriptHistory = []

    try {
      // Initialize recognizer
      this.recognizer = new StreamingSonioxRecognizer(this.sonioxConfig)

      // Set up recognizer events
      this.recognizer.on('partial', (text: string) => {
        const segment: TranscriptSegment = {
          text,
          timestamp: Date.now(),
          isFinal: false,
          source: 'mixed'
        }
        this.emit('transcript', segment)
      })

      this.recognizer.on('error', (err: Error) => {
        console.error('[MeetingTranscription] Recognizer error:', err)
        this.emit('error', err)
      })

      // Start WebSocket connection
      await this.recognizer.startSession()
      console.log('[MeetingTranscription] Recognizer session started')

      // Set up system audio source
      if (options.systemAudioSource) {
        this.systemRecorder.setSource(options.systemAudioSource)
      }

      // Set up audio data handlers
      if (options.includeMicrophone) {
        // Mixed mode: capture both system audio and microphone
        this.micRecorder = new StreamingAudioRecorder()

        // Collect chunks for mixing
        this.systemRecorder.on('data', (chunk: Buffer) => {
          this.mixBuffer.push(chunk)
        })

        this.micRecorder.on('data', (chunk: Buffer) => {
          this.mixBuffer.push(chunk)
        })

        // Send mixed audio periodically
        this.mixInterval = setInterval(() => {
          this.sendMixedAudio()
        }, 100) // Send every 100ms

        // Start both recorders
        await Promise.all([this.systemRecorder.startRecording(), this.micRecorder.startRecording()])

        console.log('[MeetingTranscription] Both recorders started (mixed mode)')
      } else {
        // System audio only mode
        this.systemRecorder.on('data', (chunk: Buffer) => {
          this.recognizer?.sendAudioChunk(chunk)
        })

        await this.systemRecorder.startRecording()
        console.log('[MeetingTranscription] System audio recorder started')
      }

      this.setStatus('transcribing')
    } catch (err) {
      console.error('[MeetingTranscription] Start error:', err)
      this.setStatus('error')
      await this.cleanup()
      throw err
    }
  }

  /**
   * Stop meeting transcription
   */
  async stopTranscription(): Promise<TranscriptSegment[]> {
    if (this.status !== 'transcribing') {
      console.warn('[MeetingTranscription] Not currently transcribing')
      return this.transcriptHistory
    }

    this.setStatus('stopping')

    try {
      // Stop mixing interval
      if (this.mixInterval) {
        clearInterval(this.mixInterval)
        this.mixInterval = null
      }

      // Stop recorders
      this.systemRecorder.stopRecording()
      this.systemRecorder.removeAllListeners('data')

      if (this.micRecorder) {
        this.micRecorder.stopRecording()
        this.micRecorder.removeAllListeners('data')
        this.micRecorder = null
      }

      // End recognizer session and get final result
      if (this.recognizer) {
        const result = await this.recognizer.endSession()
        if (result.text) {
          const finalSegment: TranscriptSegment = {
            text: result.text,
            timestamp: Date.now(),
            isFinal: true,
            source: 'mixed'
          }
          this.transcriptHistory.push(finalSegment)
          this.emit('transcript', finalSegment)
        }
        this.recognizer = null
      }

      console.log('[MeetingTranscription] Stopped successfully')
    } catch (err) {
      console.error('[MeetingTranscription] Stop error:', err)
    } finally {
      this.setStatus('idle')
      this.mixBuffer = []
    }

    return this.transcriptHistory
  }

  /**
   * Clear transcript history
   */
  clearHistory(): void {
    this.transcriptHistory = []
    this.emit('historyCleared')
  }

  private setStatus(status: MeetingStatus): void {
    this.status = status
    this.emit('status', status)
  }

  /**
   * Mix audio buffers and send to recognizer
   */
  private sendMixedAudio(): void {
    if (this.mixBuffer.length === 0) return

    // Simple mixing: just concatenate buffers
    // For better mixing, we could add the PCM samples together
    const combined = Buffer.concat(this.mixBuffer)
    this.mixBuffer = []

    this.recognizer?.sendAudioChunk(combined)
  }

  private async cleanup(): Promise<void> {
    if (this.mixInterval) {
      clearInterval(this.mixInterval)
      this.mixInterval = null
    }

    try {
      this.systemRecorder.stopRecording()
      this.systemRecorder.removeAllListeners('data')
    } catch {}

    if (this.micRecorder) {
      try {
        this.micRecorder.stopRecording()
        this.micRecorder.removeAllListeners('data')
      } catch {}
      this.micRecorder = null
    }

    if (this.recognizer) {
      try {
        this.recognizer.close()
      } catch {}
      this.recognizer = null
    }

    this.mixBuffer = []
  }
}
