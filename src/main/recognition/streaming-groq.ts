import { EventEmitter } from 'events'
import { SpeakerSegment, PartialResult, SentencePair } from './streaming-soniox'
import { VADState } from './vad-utils'

export interface StreamingGroqConfig {
  apiKey?: string
  whisperModel?: 'whisper-large-v3-turbo' | 'whisper-large-v3'
  chatModel?: string // Default: 'moonshotai/kimi-k2-instruct-0905'
  language?: string
  sampleRate?: number
  /** One-way translation config */
  translation?: {
    enabled: boolean
    targetLanguage: string // e.g., 'en', 'zh', 'ja', 'fr'
  }
}

interface TranscriptionResult {
  text: string
  language?: string
  duration?: number
}

/**
 * Streaming Groq recognizer that buffers audio chunks and processes them
 * using Groq's Whisper API for transcription and Chat API for translation.
 *
 * Key differences from Soniox:
 * - REST API based (not WebSocket streaming)
 * - Requires audio buffering with endpoint detection
 * - Two-step process: transcription then translation
 * - No speaker diarization (all content assigned to speaker 0)
 * - Progressive display: transcription shown immediately, translation added after
 */
export class StreamingGroqRecognizer extends EventEmitter {
  private config: StreamingGroqConfig

  // Audio buffering
  private audioBuffer: Buffer[] = []
  private bufferStartTime = 0
  private lastSpeechTime = 0

  // VAD (Voice Activity Detection)
  private vadState: VADState

  // Endpoint detection parameters (optimized for faster response)
  private readonly MAX_CHUNK_DURATION_MS = 15000 // 15s max (reduced from 30s)
  private readonly SILENCE_THRESHOLD_MS = 600 // 0.6s silence triggers processing (reduced from 1.5s)
  private readonly MIN_CHUNK_DURATION_MS = 1000 // 1s minimum before processing (reduced from 2s)
  private readonly VAD_SILENCE_THRESHOLD = 0.01 // RMS threshold for silence detection

  // State tracking
  private isActive = false
  private processingChunk = false
  private silenceCheckInterval: NodeJS.Timeout | null = null
  private startTime = 0

  // Accumulated results
  private completedSegments: SpeakerSegment[] = []
  private accumulatedText: string[] = []
  private accumulatedTranslation: string[] = []
  private pendingTranslations: Map<string, string> = new Map() // text -> translation

  // Language name mappings for translation prompts
  private readonly LANGUAGE_NAMES: Record<string, string> = {
    en: 'English',
    zh: 'Chinese (Simplified)',
    ja: 'Japanese',
    ko: 'Korean',
    fr: 'French',
    de: 'German',
    es: 'Spanish',
    ru: 'Russian',
    pt: 'Portuguese',
    it: 'Italian'
  }

  constructor(config?: StreamingGroqConfig) {
    super()
    this.config = {
      whisperModel: 'whisper-large-v3-turbo',
      chatModel: 'moonshotai/kimi-k2-instruct-0905',
      sampleRate: 16000,
      ...config
    }
    this.vadState = new VADState(this.VAD_SILENCE_THRESHOLD, 3)
  }

  /**
   * Pre-connect is a no-op for REST-based Groq API.
   * Kept for interface compatibility with StreamingSonioxRecognizer.
   */
  async preConnect(): Promise<void> {
    console.log('[StreamingGroq] preConnect called (no-op for REST API)')
    // Validate API key exists
    if (!this.config.apiKey) {
      throw new Error('Groq API key required')
    }
  }

  /**
   * Check if pre-connected (always true for REST API if API key exists)
   */
  isPreConnected(): boolean {
    return !!this.config.apiKey
  }

  /**
   * Start a streaming session.
   */
  async startSession(): Promise<void> {
    if (!this.config.apiKey) {
      throw new Error('Groq API key required')
    }

    // Reset state for new session
    this.isActive = true
    this.audioBuffer = []
    this.bufferStartTime = 0
    this.lastSpeechTime = Date.now()
    this.startTime = Date.now()
    this.processingChunk = false
    this.completedSegments = []
    this.accumulatedText = []
    this.accumulatedTranslation = []
    this.pendingTranslations.clear()
    this.vadState.reset()

    // Start silence detection interval
    this.silenceCheckInterval = setInterval(() => {
      this.checkAndProcessBuffer()
    }, 500)

    console.log('[StreamingGroq] Session started')
  }

  /**
   * Send an audio chunk to be buffered.
   */
  sendAudioChunk(chunk: Buffer): void {
    if (!this.isActive) return

    this.audioBuffer.push(chunk)

    // Use VAD to detect speech activity
    const isSpeech = this.vadState.processChunk(chunk)
    if (isSpeech) {
      this.lastSpeechTime = Date.now() // Only update when speech is detected
    }

    // Start buffer timer if this is first chunk
    if (this.audioBuffer.length === 1) {
      this.bufferStartTime = Date.now()
    }

    // Check if we should process buffered audio
    this.checkAndProcessBuffer()
  }

  /**
   * Check if buffer should be processed based on silence or max duration.
   */
  private checkAndProcessBuffer(): void {
    if (this.processingChunk || this.audioBuffer.length === 0) return

    const bufferDuration = Date.now() - this.bufferStartTime
    const silenceDuration = Date.now() - this.lastSpeechTime // Based on actual VAD detection

    const shouldProcess =
      (bufferDuration >= this.MIN_CHUNK_DURATION_MS &&
        silenceDuration >= this.SILENCE_THRESHOLD_MS) ||
      bufferDuration >= this.MAX_CHUNK_DURATION_MS

    if (shouldProcess) {
      this.processBufferedAudio()
    }
  }

  /**
   * Process buffered audio: transcribe and optionally translate.
   */
  private async processBufferedAudio(): Promise<void> {
    if (this.audioBuffer.length === 0) return

    this.processingChunk = true
    const audioToProcess = Buffer.concat(this.audioBuffer)
    this.audioBuffer = [] // Clear buffer immediately
    this.bufferStartTime = Date.now()

    try {
      // Step 1: Convert PCM to WAV
      const wavBuffer = this.createWavBuffer(audioToProcess)

      // Step 2: Call Groq Whisper API
      const transcription = await this.transcribeAudio(wavBuffer)

      if (!transcription.text.trim()) {
        this.processingChunk = false
        return
      }

      // Accumulate transcription result
      this.accumulatedText.push(transcription.text)

      // Step 3: Emit partial result immediately with transcription (don't wait for translation)
      this.emitPartialResult(transcription.text, undefined)

      // Step 4: Optionally translate (async, non-blocking)
      if (this.config.translation?.enabled && this.config.translation.targetLanguage) {
        const targetLang = this.config.translation.targetLanguage
        this.translateText(transcription.text, targetLang)
          .then((translatedText) => {
            if (translatedText) {
              this.accumulatedTranslation.push(translatedText)
              this.pendingTranslations.set(transcription.text, translatedText)
              // Re-emit with translation
              this.emitPartialResult(transcription.text, translatedText, true)
            }
          })
          .catch((err) => {
            console.warn('[StreamingGroq] Translation failed:', err)
            this.emit('translationError', err)
            // Translation failure doesn't affect transcription
          })
      }
    } catch (error) {
      console.error('[StreamingGroq] Processing error:', error)
      this.emit('error', error)
    } finally {
      this.processingChunk = false
    }
  }

  /**
   * Convert raw PCM buffer to WAV format.
   */
  private createWavBuffer(pcmBuffer: Buffer): Buffer {
    const sampleRate =
      typeof this.config.sampleRate === 'number' && Number.isFinite(this.config.sampleRate)
        ? this.config.sampleRate
        : 16000
    const numChannels = 1
    const bitsPerSample = 16
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8
    const blockAlign = (numChannels * bitsPerSample) / 8
    const dataSize = pcmBuffer.length
    const headerSize = 44
    const fileSize = headerSize + dataSize - 8

    const header = Buffer.alloc(headerSize)
    header.write('RIFF', 0)
    header.writeUInt32LE(fileSize, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16) // fmt chunk size
    header.writeUInt16LE(1, 20) // PCM format
    header.writeUInt16LE(numChannels, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(byteRate, 28)
    header.writeUInt16LE(blockAlign, 32)
    header.writeUInt16LE(bitsPerSample, 34)
    header.write('data', 36)
    header.writeUInt32LE(dataSize, 40)

    return Buffer.concat([header, pcmBuffer])
  }

  /**
   * Call Groq Whisper API to transcribe audio.
   */
  private async transcribeAudio(wavBuffer: Buffer): Promise<TranscriptionResult> {
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2)
    const parts: Buffer[] = []

    // File part
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`
      )
    )
    parts.push(wavBuffer)
    parts.push(Buffer.from('\r\n'))

    // Model part
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${this.config.whisperModel}\r\n`
      )
    )

    // Language part (optional, improves accuracy and latency)
    if (this.config.language && this.config.language !== 'auto') {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${this.config.language}\r\n`
        )
      )
    }

    // Response format for verbose output with metadata
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n`
      )
    )

    // End boundary
    parts.push(Buffer.from(`--${boundary}--\r\n`))

    const body = Buffer.concat(parts)

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Groq Whisper API error ${response.status}: ${error}`)
    }

    const result = (await response.json()) as {
      text?: string
      language?: string
      duration?: number
    }

    return {
      text: result.text || '',
      language: result.language,
      duration: result.duration
    }
  }

  /**
   * Call Groq Chat API to translate text.
   */
  private async translateText(text: string, targetLanguage: string): Promise<string> {
    const model = this.config.chatModel || 'llama-3.3-70b-versatile'
    const targetLangName = this.LANGUAGE_NAMES[targetLanguage] || targetLanguage

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: 'system',
            content:
              'You are a professional translator. Translate the given text accurately while preserving tone and meaning. Only output the translation, no explanations or additional text.'
          },
          {
            role: 'user',
            content: `Translate this meeting transcript to ${targetLangName}. Preserve the tone, technical terms, and speaker intent. Only output the translation:\n\n${text}`
          }
        ],
        temperature: 0.3, // Low temperature for consistent translations
        max_tokens: 2000
      })
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Groq Chat API error ${response.status}: ${error}`)
    }

    const result = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string
        }
      }>
    }

    return result.choices?.[0]?.message?.content?.trim() || ''
  }

  /**
   * Emit partial result in Soniox-compatible format.
   */
  private emitPartialResult(
    _text: string,
    _translatedText: string | undefined,
    isTranslationUpdate = false
  ): void {
    // Build current segment (speaker 0 since Groq doesn't provide diarization)
    const currentSegment: SpeakerSegment = {
      speaker: 0,
      text: this.accumulatedText.join(' '),
      translatedText: this.accumulatedTranslation.join(' ') || undefined,
      isFinal: false,
      sentencePairs: this.buildSentencePairs()
    }

    const result: PartialResult = {
      segments: [...this.completedSegments],
      currentSegment: currentSegment,
      combined: this.accumulatedText.join(' '),
      currentSpeaker: 0,
      translationEnabled: this.config.translation?.enabled
    }

    this.emit('partial', result)

    if (isTranslationUpdate) {
      console.log(`[StreamingGroq] Translation update emitted for chunk`)
    }
  }

  /**
   * Build sentence pairs from accumulated text and translations.
   */
  private buildSentencePairs(): SentencePair[] {
    const pairs: SentencePair[] = []
    for (const text of this.accumulatedText) {
      pairs.push({
        original: text,
        translated: this.pendingTranslations.get(text)
      })
    }
    return pairs
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
    // Stop silence check interval
    if (this.silenceCheckInterval) {
      clearInterval(this.silenceCheckInterval)
      this.silenceCheckInterval = null
    }

    // Process any remaining buffered audio
    if (this.audioBuffer.length > 0) {
      await this.processBufferedAudio()
      // Wait a bit for any pending translations
      await this.sleep(500)
    }

    this.isActive = false

    // Build final result
    const fullText = this.accumulatedText.join(' ').trim()
    const fullTranslation = this.accumulatedTranslation.join(' ').trim()

    const finalSegment: SpeakerSegment | null =
      fullText.length > 0
        ? {
            speaker: 0,
            text: fullText,
            translatedText: fullTranslation || undefined,
            isFinal: true,
            sentencePairs: this.buildSentencePairs()
          }
        : null

    console.log(`[StreamingGroq] Session ended, total time: ${Date.now() - this.startTime}ms`)
    this.emit('finished')

    return {
      text: fullText,
      durationMs: Date.now() - this.startTime,
      segments: [...this.completedSegments],
      currentSegment: finalSegment
    }
  }

  /**
   * Check if session is active.
   */
  isSessionActive(): boolean {
    return this.isActive
  }

  /**
   * Force close the session.
   */
  close(): void {
    if (this.silenceCheckInterval) {
      clearInterval(this.silenceCheckInterval)
      this.silenceCheckInterval = null
    }
    this.isActive = false
    this.audioBuffer = []
  }

  /**
   * Helper: sleep for a given duration.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
