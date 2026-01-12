import { EventEmitter } from 'events'
import { StreamingAudioRecorder } from './audio/streaming-recorder'
import {
  StreamingSonioxRecognizer,
  StreamingSonioxConfig,
  SpeakerSegment,
  PartialResult
} from './recognition/streaming-soniox'
import { profiler } from './utils/profiler'

export interface SystemAudioSource {
  id: string
  name: string
  isDefault?: boolean
}

export interface MeetingTranscriptionOptions {
  includeMicrophone: boolean // Whether to also capture microphone input
  microphoneDevice?: string // Specific microphone device to use
  systemAudioSource?: string // Specific system audio source to use
  translationEnabled?: boolean // Enable real-time translation
  targetLanguage?: string // Target language for translation (e.g., 'en', 'zh', 'ja')
}

export interface TranscriptSegment {
  text: string
  translatedText?: string // Translated text (when translation enabled)
  timestamp: number
  isFinal: boolean
  source?: 'system' | 'microphone' | 'mixed'
  /** Current speaker number from diarization (if enabled) */
  speaker?: number
  /** All completed speaker segments (for multi-speaker display) */
  speakerSegments?: SpeakerSegment[]
  /** Current active segment being transcribed */
  currentSpeakerSegment?: SpeakerSegment | null
  /** Whether translation is enabled */
  translationEnabled?: boolean
}

export type MeetingStatus = 'idle' | 'starting' | 'transcribing' | 'stopping' | 'error'

/**
 * Manages meeting transcription by receiving system audio from renderer process
 * and sending it to the speech recognition service.
 *
 * Note: System audio capture is now done in the renderer process using desktopCapturer
 * and sent to main process via IPC. This avoids the need for ffmpeg.
 */
export class MeetingTranscriptionManager extends EventEmitter {
  private micRecorder: StreamingAudioRecorder | null = null
  private recognizer: StreamingSonioxRecognizer | null = null
  private sonioxConfig: StreamingSonioxConfig

  private status: MeetingStatus = 'idle'
  private transcriptHistory: TranscriptSegment[] = []
  private lastTextLength = 0

  // For mixing audio streams
  private mixBuffer: Buffer[] = []
  private mixInterval: NodeJS.Timeout | null = null

  // Flag to track if we're using renderer audio
  private usingRendererAudio = false

  constructor(sonioxConfig: StreamingSonioxConfig) {
    super()
    this.sonioxConfig = sonioxConfig
  }

  /**
   * Pre-connect to the recognition service to reduce startup latency.
   * Call this when the meeting window opens or before user starts transcription.
   */
  async preConnect(): Promise<void> {
    if (this.recognizer?.isPreConnected()) {
      console.log('[MeetingTranscription] Already pre-connected')
      return
    }

    console.log('[MeetingTranscription] Pre-connecting to recognition service...')
    this.recognizer = new StreamingSonioxRecognizer(this.sonioxConfig)

    // Set up error handler for pre-connection
    this.recognizer.on('error', (err: Error) => {
      console.error('[MeetingTranscription] Pre-connect error:', err)
    })

    try {
      await this.recognizer.preConnect()
      console.log('[MeetingTranscription] Pre-connected successfully')
    } catch (err) {
      console.error('[MeetingTranscription] Pre-connect failed:', err)
      this.recognizer = null
    }
  }

  /**
   * Check if pre-connected and ready
   */
  isPreConnected(): boolean {
    return this.recognizer?.isPreConnected() ?? false
  }

  /**
   * Get available system audio sources
   * Note: This is now handled in the renderer process via desktopCapturer
   */
  async getSystemAudioSources(): Promise<SystemAudioSource[]> {
    // Sources are now provided by renderer process
    return []
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
    this.lastTextLength = 0

    try {
      // Start profiling session
      profiler.startSession()

      // Use pre-connected recognizer or create new one
      // Merge translation options if provided
      const recognizerConfig = {
        ...this.sonioxConfig,
        translation:
          options.translationEnabled && options.targetLanguage
            ? { enabled: true, targetLanguage: options.targetLanguage }
            : undefined
      }
      if (!this.recognizer?.isPreConnected()) {
        this.recognizer = new StreamingSonioxRecognizer(recognizerConfig)
      } else {
        // Update config for pre-connected recognizer
        this.recognizer = new StreamingSonioxRecognizer(recognizerConfig)
      }

      // Set up recognizer events (clear any from pre-connect first)
      this.recognizer.removeAllListeners('partial')
      this.recognizer.removeAllListeners('error')

      this.recognizer.on('partial', (result: PartialResult) => {
        // Track response for profiling (use combined length for latency tracking)
        profiler.markResponseReceived(result.combined.length, this.lastTextLength)
        this.lastTextLength = result.combined.length

        const segment: TranscriptSegment = {
          text: result.combined, // Legacy: combined text for backward compatibility
          translatedText: result.currentSegment?.translatedText,
          timestamp: Date.now(),
          isFinal: false,
          source: 'mixed',
          speaker: result.currentSpeaker,
          speakerSegments: result.segments,
          currentSpeakerSegment: result.currentSegment,
          translationEnabled: result.translationEnabled
        }
        this.emit('transcript', segment)
      })

      this.recognizer.on('error', (err: Error) => {
        console.error('[MeetingTranscription] Recognizer error:', err)
        this.emit('error', err)
      })

      // Start WebSocket connection (instant if pre-connected)
      profiler.markConnectionStart()
      await this.recognizer.startSession()
      profiler.markConnectionEstablished()
      console.log('[MeetingTranscription] Recognizer session started')

      // System audio is now captured in renderer process and sent via IPC
      // Set flag to indicate we're ready to receive audio from renderer
      this.usingRendererAudio = true

      // Set up audio data handlers
      if (options.includeMicrophone) {
        // Mixed mode: capture microphone in main process, system audio from renderer
        this.micRecorder = new StreamingAudioRecorder()

        this.micRecorder.on('data', (chunk: Buffer) => {
          this.mixBuffer.push(chunk)
        })

        // Send mixed audio periodically
        this.mixInterval = setInterval(() => {
          this.sendMixedAudio()
        }, 50) // Send every 50ms for lower latency

        // Start microphone recorder
        await this.micRecorder.startRecording()
        console.log('[MeetingTranscription] Microphone recorder started (mixed mode)')
      }
      // For system audio only mode, audio will be received via handleRendererAudioChunk

      this.setStatus('transcribing')
      console.log('[MeetingTranscription] Ready to receive audio from renderer')
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

      // Mark that we're no longer receiving renderer audio
      this.usingRendererAudio = false

      // Stop microphone recorder if active
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

      // Print profiling report
      profiler.printReport()
      profiler.endSession()

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
    const combined = Buffer.concat(this.mixBuffer)
    const bytesSent = combined.length
    this.mixBuffer = []

    profiler.markAudioSent(bytesSent)
    this.recognizer?.sendAudioChunk(combined)
  }

  /**
   * Handle audio chunk from renderer process (system audio via desktopCapturer)
   */
  handleRendererAudioChunk(chunk: Buffer): void {
    if (!this.usingRendererAudio || this.status !== 'transcribing') {
      return
    }

    if (this.mixInterval) {
      // Mixed mode: add to mix buffer
      this.mixBuffer.push(chunk)
    } else {
      // Direct mode: send to recognizer
      profiler.markAudioSent(chunk.length)
      this.recognizer?.sendAudioChunk(chunk)
    }
  }

  private async cleanup(): Promise<void> {
    if (this.mixInterval) {
      clearInterval(this.mixInterval)
      this.mixInterval = null
    }

    this.usingRendererAudio = false

    if (this.micRecorder) {
      try {
        this.micRecorder.stopRecording()
        this.micRecorder.removeAllListeners('data')
      } catch {
        // Ignore cleanup errors
      }
      this.micRecorder = null
    }

    if (this.recognizer) {
      try {
        this.recognizer.close()
      } catch {
        // Ignore cleanup errors
      }
      this.recognizer = null
    }

    this.mixBuffer = []
  }
}
