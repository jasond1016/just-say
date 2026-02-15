import WebSocket from 'ws'
import { EventEmitter } from 'events'

export interface StreamingSonioxConfig {
  apiKey?: string
  model?: string
  languageHints?: string[]
  sampleRate?: number
  /** Enable speaker diarization. Each token will include a speaker number. Default: true */
  enableSpeakerDiarization?: boolean
  /** One-way translation config */
  translation?: {
    enabled: boolean
    targetLanguage: string // e.g., 'en', 'zh', 'ja', 'fr'
  }
}

interface SonioxToken {
  text: string
  is_final?: boolean
  confidence?: number
  language?: string
  /** Speaker number (when speaker diarization is enabled) */
  speaker?: number
  /** Translation status: 'none' (no translation), 'original' (transcribed text), 'translation' (translated text) */
  translation_status?: 'none' | 'original' | 'translation'
  /** Source language of the spoken text (for translation tokens) */
  source_language?: string
}

interface SonioxResponse {
  tokens?: SonioxToken[]
  finished?: boolean
  error?: string
  code?: number
  message?: string
}

// A sentence pair: original text and its translation (aligned by <end> token)
export interface SentencePair {
  original: string
  translated?: string
}

// A segment of text from a specific speaker
export interface SpeakerSegment {
  speaker: number
  text: string
  translatedText?: string // Translated text (when translation enabled)
  isFinal: boolean // Is this segment complete (speaker changed or session ended)
  /** Sentence pairs aligned by <end> tokens for interleaved display */
  sentencePairs?: SentencePair[]
}

// Partial result with speaker-aware segments
export interface PartialResult {
  /** All completed speaker segments (speaker changed, so these are finalized) */
  segments: SpeakerSegment[]
  /** Current active segment being transcribed */
  currentSegment: SpeakerSegment | null
  /** Legacy: combined text for backward compatibility */
  combined: string
  /** Current speaker number */
  currentSpeaker?: number
  /** Whether translation is enabled */
  translationEnabled?: boolean
}

/**
 * Streaming Soniox recognizer that maintains a WebSocket connection
 * and processes audio chunks in real-time.
 * Supports pre-connecting to reduce startup latency.
 */
export class StreamingSonioxRecognizer extends EventEmitter {
  private config: StreamingSonioxConfig
  private ws: WebSocket | null = null
  private isConnected = false
  private isConfigSent = false
  // Speaker-aware segments
  private completedSegments: SpeakerSegment[] = []
  private currentSegmentText: string[] = [] // Text for current speaker (final tokens)
  private currentSegmentTranslation: string[] = [] // Translation for current speaker (final tokens)
  private interimText: string[] = [] // Non-final tokens (may change)
  private interimTranslation: string[] = [] // Non-final translation tokens
  private currentSpeaker?: number
  private startTime = 0
  private preConnectTime = 0
  private readonly WS_ENDPOINT = 'wss://stt-rt.soniox.com/transcribe-websocket'

  // Sentence pairs for current segment (aligned by <end> tokens)
  private completedSentencePairs: SentencePair[] = []
  private currentSentenceText: string[] = [] // Text for current sentence (before <end>)
  private currentSentenceTranslation: string[] = [] // Translation for current sentence

  constructor(config?: StreamingSonioxConfig) {
    super()
    this.config = {
      model: 'stt-rt-v3',
      languageHints: ['zh', 'en', 'ja'],
      enableSpeakerDiarization: true, // Default enabled
      ...config
    }
  }

  /**
   * Update runtime config before startSession when reusing a pre-connected socket.
   */
  updateConfig(config?: StreamingSonioxConfig): void {
    if (!config) return
    this.config = {
      ...this.config,
      ...config
    }
    this.isConfigSent = false
  }

  /**
   * Pre-connect to WebSocket server without starting a session.
   * Call this early (e.g., when meeting window opens) to reduce latency.
   */
  async preConnect(): Promise<void> {
    if (this.isConnected) {
      console.log('[StreamingSoniox] Already connected')
      return
    }

    if (!this.config.apiKey) {
      throw new Error('Soniox API key required')
    }

    this.preConnectTime = Date.now()

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.WS_ENDPOINT)

      const timeout = setTimeout(() => {
        this.ws?.close()
        reject(new Error('Soniox pre-connect timeout'))
      }, 10000)

      this.ws.on('open', () => {
        clearTimeout(timeout)
        this.isConnected = true
        console.log(`[StreamingSoniox] Pre-connected in ${Date.now() - this.preConnectTime}ms`)
        resolve()
      })

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data)
      })

      this.ws.on('error', (err) => {
        clearTimeout(timeout)
        console.error('[StreamingSoniox] Pre-connect error:', err)
        this.emit('error', err)
        reject(err)
      })

      this.ws.on('close', (code, reason) => {
        this.isConnected = false
        this.isConfigSent = false
        console.log('[StreamingSoniox] Closed:', code, reason.toString())
      })
    })
  }

  /**
   * Check if pre-connected and ready
   */
  isPreConnected(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocket.OPEN
  }

  /**
   * Start a streaming session. If pre-connected, this is instant.
   */
  async startSession(): Promise<void> {
    if (!this.config.apiKey) {
      throw new Error('Soniox API key required')
    }

    // Reset state for new session
    this.completedSegments = []
    this.currentSegmentText = []
    this.currentSegmentTranslation = []
    this.interimText = []
    this.interimTranslation = []
    this.currentSpeaker = undefined
    this.startTime = Date.now()

    // If already pre-connected, just send config
    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      if (!this.isConfigSent) {
        this.sendConfig()
      }
      console.log(`[StreamingSoniox] Session started instantly (pre-connected)`)
      return
    }

    // Otherwise, connect now
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.WS_ENDPOINT)

      const timeout = setTimeout(() => {
        this.ws?.close()
        reject(new Error('Soniox connection timeout'))
      }, 10000)

      this.ws.on('open', () => {
        clearTimeout(timeout)
        this.isConnected = true
        console.log(`[StreamingSoniox] Connected in ${Date.now() - this.startTime}ms`)
        this.sendConfig()
        resolve()
      })

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data)
      })

      this.ws.on('error', (err) => {
        clearTimeout(timeout)
        console.error('[StreamingSoniox] Error:', err)
        this.emit('error', err)
        reject(err)
      })

      this.ws.on('close', (code, reason) => {
        this.isConnected = false
        this.isConfigSent = false
        console.log('[StreamingSoniox] Closed:', code, reason.toString())
      })
    })
  }

  /**
   * Send configuration to server
   */
  private sendConfig(): void {
    if (!this.ws || this.isConfigSent) return

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config: Record<string, any> = {
      api_key: this.config.apiKey,
      model: this.config.model,
      audio_format: 'pcm_s16le',
      sample_rate:
        typeof this.config.sampleRate === 'number' && Number.isFinite(this.config.sampleRate)
          ? this.config.sampleRate
          : 16000,
      num_channels: 1,
      language_hints: this.config.languageHints,
      // Enable endpoint detection for faster finalization
      enable_endpoint_detection: true,
      // Enable speaker diarization
      enable_speaker_diarization: this.config.enableSpeakerDiarization
    }

    // Add translation config if enabled
    if (this.config.translation?.enabled && this.config.translation.targetLanguage) {
      config.translation = {
        type: 'one_way',
        target_language: this.config.translation.targetLanguage
      }
    }

    this.ws.send(JSON.stringify(config))
    this.isConfigSent = true
    const translationInfo = this.config.translation?.enabled
      ? `, translation: ${this.config.translation.targetLanguage}`
      : ''
    console.log(
      `[StreamingSoniox] Config sent (endpoint detection: on, speaker diarization: ${this.config.enableSpeakerDiarization}${translationInfo})`
    )
  }

  /**
   * Send an audio chunk to the server.
   */
  sendAudioChunk(chunk: Buffer): void {
    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(chunk)
    }
  }

  /**
   * End the streaming session and get final result.
   */
  async endSession(): Promise<{
    text: string
    durationMs: number
    segments: SpeakerSegment[]
    currentSegment: SpeakerSegment | null
  }> {
    const getFinalResult = (): {
      text: string
      segments: SpeakerSegment[]
      currentSegment: SpeakerSegment | null
    } => {
      const currentText = this.currentSegmentText.join('')
      const interim = this.interimText.join('')
      const currentTranslation = this.currentSegmentTranslation.join('')
      const interimTranslation = this.interimTranslation.join('')

      // Finalize any remaining sentence
      const finalSentencePairs = [...this.completedSentencePairs]
      const remainingSentence = this.currentSentenceText.join('') + interim
      const remainingTranslation = this.currentSentenceTranslation.join('') + interimTranslation
      if (remainingSentence.trim()) {
        finalSentencePairs.push({
          original: remainingSentence,
          translated: remainingTranslation || undefined
        })
      }

      // Build current segment with all remaining text (including interim)
      const currentSegment: SpeakerSegment | null =
        this.currentSpeaker !== undefined && (currentText || interim)
          ? {
              speaker: this.currentSpeaker,
              text: currentText + interim,
              translatedText: currentTranslation + interimTranslation || undefined,
              isFinal: true,
              sentencePairs: finalSentencePairs.length > 0 ? finalSentencePairs : undefined
            }
          : null

      const segmentTexts = this.completedSegments.map((s) => s.text)
      const fullText = [...segmentTexts, currentSegment?.text || ''].join('').trim()

      return {
        text: fullText,
        segments: [...this.completedSegments],
        currentSegment
      }
    }

    return new Promise((resolve) => {
      const buildResult = (): {
        text: string
        durationMs: number
        segments: SpeakerSegment[]
        currentSegment: SpeakerSegment | null
      } => {
        const result = getFinalResult()
        return { ...result, durationMs: Date.now() - this.startTime }
      }

      if (!this.isConnected || !this.ws) {
        resolve(buildResult())
        return
      }

      const timeout = setTimeout(() => {
        this.ws?.close()
        resolve(buildResult())
      }, 5000)

      // Listen for finished signal
      const finishHandler = (): void => {
        clearTimeout(timeout)
        resolve(buildResult())
      }
      this.once('finished', finishHandler)

      // Send empty frame to signal end
      console.log('[StreamingSoniox] Sending end signal')
      this.ws.send('')
    })
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(data: Buffer): void {
    try {
      const response: SonioxResponse = JSON.parse(data.toString())

      // Check for error
      if (response.error || response.code) {
        console.error('[StreamingSoniox] Server error:', response.message || response.error)
        this.emit('error', new Error(response.message || response.error))
        return
      }

      // Process tokens
      if (response.tokens) {
        // Reset interim for each response
        this.interimText = []
        this.interimTranslation = []

        for (const token of response.tokens) {
          // If token has no speaker, keep the current speaker (don't default to 0)
          // This handles special tokens like <end> that may not have speaker info
          const tokenSpeaker = token.speaker ?? this.currentSpeaker ?? 0

          // Check if speaker changed (only if both are defined and different)
          // Note: translation tokens follow their original tokens, so we use the speaker from original tokens
          const isTranslation = token.translation_status === 'translation'

          if (
            !isTranslation &&
            this.currentSpeaker !== undefined &&
            token.speaker !== undefined &&
            tokenSpeaker !== this.currentSpeaker
          ) {
            // Finalize current sentence if any
            const sentenceText = this.currentSentenceText.join('')
            const sentenceTranslation = this.currentSentenceTranslation.join('')
            if (sentenceText.trim()) {
              this.completedSentencePairs.push({
                original: sentenceText,
                translated: sentenceTranslation || undefined
              })
            }

            // Finalize current segment before switching
            const segmentText = this.currentSegmentText.join('')
            const segmentTranslation = this.currentSegmentTranslation.join('')
            if (segmentText.trim()) {
              this.completedSegments.push({
                speaker: this.currentSpeaker,
                text: segmentText,
                translatedText: segmentTranslation || undefined,
                isFinal: true,
                sentencePairs:
                  this.completedSentencePairs.length > 0
                    ? [...this.completedSentencePairs]
                    : undefined
              })
            }
            // Start new segment
            this.currentSegmentText = []
            this.currentSegmentTranslation = []
            this.completedSentencePairs = []
            this.currentSentenceText = []
            this.currentSentenceTranslation = []
          }

          // Only update current speaker from non-translation tokens
          if (!isTranslation) {
            this.currentSpeaker = tokenSpeaker
          }

          // Check for <end> token (endpoint detection marker)
          const isEndToken = token.text === '<end>' && token.is_final

          if (isEndToken && !isTranslation) {
            // Finalize current sentence pair when we see <end>
            const sentenceText = this.currentSentenceText.join('')
            const sentenceTranslation = this.currentSentenceTranslation.join('')
            if (sentenceText.trim()) {
              this.completedSentencePairs.push({
                original: sentenceText,
                translated: sentenceTranslation || undefined
              })
            }
            // Reset for next sentence
            this.currentSentenceText = []
            this.currentSentenceTranslation = []
            // Don't add <end> to visible text
            continue
          }

          // Handle translation tokens separately from original tokens
          if (isTranslation) {
            // This is a translation token
            if (token.is_final) {
              this.currentSegmentTranslation.push(token.text)
              this.currentSentenceTranslation.push(token.text)
            } else {
              this.interimTranslation.push(token.text)
            }
          } else {
            // This is an original transcription token (translation_status: 'none' or 'original')
            if (token.is_final) {
              this.currentSegmentText.push(token.text)
              this.currentSentenceText.push(token.text)
            } else {
              // Non-final tokens - show immediately but may change
              this.interimText.push(token.text)
            }
          }
        }

        // Build current sentence pair (incomplete, still being transcribed)
        const currentSentence: SentencePair | null =
          this.currentSentenceText.length > 0 || this.interimText.length > 0
            ? {
                original: this.currentSentenceText.join('') + this.interimText.join(''),
                translated:
                  this.currentSentenceTranslation.join('') + this.interimTranslation.join('') ||
                  undefined
              }
            : null

        // Build current segment for display with sentence pairs
        const allSentencePairs = [
          ...this.completedSentencePairs,
          ...(currentSentence && currentSentence.original.trim() ? [currentSentence] : [])
        ]

        const currentSegment: SpeakerSegment | null =
          this.currentSpeaker !== undefined
            ? {
                speaker: this.currentSpeaker,
                text: this.currentSegmentText.join('') + this.interimText.join(''),
                translatedText:
                  this.currentSegmentTranslation.join('') + this.interimTranslation.join('') ||
                  undefined,
                isFinal: false,
                sentencePairs: allSentencePairs.length > 0 ? allSentencePairs : undefined
              }
            : null

        // Compute combined text for backward compatibility
        const allTexts = [
          ...this.completedSegments.map((s) => s.text),
          this.currentSegmentText.join(''),
          this.interimText.join('')
        ]

        // Emit partial result with speaker segments
        const result: PartialResult = {
          segments: [...this.completedSegments],
          currentSegment,
          combined: allTexts.join(''),
          currentSpeaker: this.currentSpeaker,
          translationEnabled: this.config.translation?.enabled
        }
        this.emit('partial', result)
      }

      // Check if finished
      if (response.finished) {
        console.log(`[StreamingSoniox] Finished, total time: ${Date.now() - this.startTime}ms`)
        this.emit('finished')
        this.ws?.close()
      }
    } catch (err) {
      console.error('[StreamingSoniox] Parse error:', err)
    }
  }

  /**
   * Check if connected
   */
  isSessionActive(): boolean {
    return this.isConnected
  }

  /**
   * Force close the connection
   */
  close(): void {
    this.ws?.close()
    this.isConnected = false
    this.isConfigSent = false
  }
}
