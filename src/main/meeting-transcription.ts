import { EventEmitter } from 'events'
import {
  StreamingSonioxRecognizer,
  StreamingSonioxConfig,
  SpeakerSegment,
  PartialResult
} from './recognition/streaming-soniox'
import { StreamingGroqRecognizer, StreamingGroqConfig } from './recognition/streaming-groq'
import { StreamingLocalRecognizer, StreamingLocalConfig } from './recognition/streaming-local'
import { profiler } from './utils/profiler'

export type MeetingBackend = 'local' | 'soniox' | 'groq'

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

export type ExternalTranslator = (text: string, targetLanguage: string) => Promise<string>

/**
 * Manages meeting transcription by receiving system audio from renderer process
 * and sending it to the speech recognition service.
 *
 * Note: Both system audio and microphone capture are now done in the renderer process
 * using Web APIs (desktopCapturer and getUserMedia) and sent to main process via IPC.
 * This avoids the need for ffmpeg.
 */
export class MeetingTranscriptionManager extends EventEmitter {
  private recognizer:
    | StreamingSonioxRecognizer
    | StreamingGroqRecognizer
    | StreamingLocalRecognizer
    | null = null
  private backend: MeetingBackend
  private sonioxConfig?: StreamingSonioxConfig
  private groqConfig?: StreamingGroqConfig
  private localConfig?: StreamingLocalConfig
  private externalTranslator?: ExternalTranslator

  private status: MeetingStatus = 'idle'
  private transcriptHistory: TranscriptSegment[] = []
  private lastTextLength = 0

  // For mixing audio streams
  private mixBuffer: Buffer[] = []
  private mixInterval: NodeJS.Timeout | null = null

  // Flag to track if we're using renderer audio
  private usingRendererAudio = false

  // Flag to track if we're using microphone from renderer
  private usingMicrophone = false

  constructor(
    backend: MeetingBackend,
    sonioxConfig?: StreamingSonioxConfig,
    groqConfig?: StreamingGroqConfig,
    localConfig?: StreamingLocalConfig,
    externalTranslator?: ExternalTranslator
  ) {
    super()
    this.backend = backend
    this.sonioxConfig = sonioxConfig
    this.groqConfig = groqConfig
    this.localConfig = localConfig
    this.externalTranslator = externalTranslator
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

    console.log(`[MeetingTranscription] Pre-connecting to ${this.backend} recognition service...`)

    // Create appropriate recognizer based on backend
    if (this.backend === 'groq') {
      this.recognizer = new StreamingGroqRecognizer(this.groqConfig)
    } else if (this.backend === 'local') {
      this.recognizer = new StreamingLocalRecognizer(this.localConfig)
    } else {
      this.recognizer = new StreamingSonioxRecognizer(this.sonioxConfig)
    }

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
      const useExternalTranslation =
        this.backend !== 'soniox' &&
        !!options.translationEnabled &&
        !!options.targetLanguage &&
        !!this.externalTranslator

      if (
        this.backend !== 'soniox' &&
        options.translationEnabled &&
        options.targetLanguage &&
        !this.externalTranslator
      ) {
        console.warn(
          '[MeetingTranscription] Translation requested but external translator is unavailable'
        )
      }

      if (this.backend === 'groq') {
        const recognizerConfig: StreamingGroqConfig = {
          ...this.groqConfig,
          translation:
            useExternalTranslation
              ? { enabled: true, targetLanguage: options.targetLanguage! }
              : undefined,
          externalTranslator: useExternalTranslation ? this.externalTranslator : undefined
        }
        this.recognizer = new StreamingGroqRecognizer(recognizerConfig)
      } else if (this.backend === 'local') {
        const recognizerConfig: StreamingLocalConfig = {
          ...this.localConfig,
          translation:
            useExternalTranslation
              ? {
                  enabled: true,
                  targetLanguage: options.targetLanguage!,
                  translator: useExternalTranslation ? this.externalTranslator : undefined
                }
              : undefined
        }
        this.recognizer = new StreamingLocalRecognizer(recognizerConfig)
      } else {
        const recognizerConfig: StreamingSonioxConfig = {
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

      // Both system audio and microphone are now captured in renderer process and sent via IPC
      // Set flags to indicate we're ready to receive audio from renderer
      this.usingRendererAudio = true
      this.usingMicrophone = options.includeMicrophone

      if (options.includeMicrophone) {
        // Mixed mode: both system audio and microphone from renderer
        // Send mixed audio periodically
        this.mixInterval = setInterval(() => {
          this.sendMixedAudio()
        }, 50) // Send every 50ms for lower latency
        console.log('[MeetingTranscription] Mixed mode enabled (microphone + system audio)')
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
      this.usingMicrophone = false

      // End recognizer session and get final result
      if (this.recognizer) {
        const result = await this.recognizer.endSession()
        if (result.text) {
          const finalSegment: TranscriptSegment = {
            text: result.text,
            timestamp: Date.now(),
            isFinal: true,
            source: 'mixed',
            speakerSegments: result.segments,
            currentSpeakerSegment: result.currentSegment
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

  /**
   * Handle microphone audio chunk from renderer process (via getUserMedia)
   */
  handleMicrophoneAudioChunk(chunk: Buffer): void {
    if (!this.usingMicrophone || this.status !== 'transcribing') {
      return
    }

    // Microphone audio goes into the mix buffer (along with system audio)
    this.mixBuffer.push(chunk)
  }

  private async cleanup(): Promise<void> {
    if (this.mixInterval) {
      clearInterval(this.mixInterval)
      this.mixInterval = null
    }

    this.usingRendererAudio = false
    this.usingMicrophone = false

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
