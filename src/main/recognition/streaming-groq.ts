import { EventEmitter } from 'events'
import { SpeakerSegment, PartialResult, SentencePair } from './streaming-soniox'
import { VADState } from './vad-utils'
import { findTextOverlap, mergeText } from './text-utils'

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
  /** Preview window for non-final text (ms). */
  previewWindowMs?: number
  /** Minimum new audio before triggering preview (ms). */
  previewMinNewAudioMs?: number
  /** Preview trigger interval (ms). */
  previewIntervalMs?: number
  /** Minimum audio length required for preview (ms). */
  previewMinAudioMs?: number
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
  private bufferStartTime = 0
  private lastSpeechTime = 0

  // VAD (Voice Activity Detection)
  private vadState: VADState

  // === Preview processing (Non-final) ===
  private readonly previewIntervalMs: number
  private readonly previewMinAudioMs: number
  private readonly previewWindowMs: number
  private readonly previewMinNewAudioMs: number

  // === Final processing - optimized parameters ===
  private readonly MAX_CHUNK_DURATION_MS = 10000 // 10s max (reduced from 15s)
  private readonly SILENCE_THRESHOLD_MS = 400 // 0.4s silence triggers processing (reduced from 0.6s)
  private readonly MIN_CHUNK_DURATION_MS = 800 // 0.8s minimum before processing (reduced from 1s)
  private readonly VAD_SILENCE_THRESHOLD = 0.01 // RMS threshold for silence detection

  // === Chunk boundary handling ===
  private readonly OVERLAP_AUDIO_MS = 200 // Audio overlap to prevent word cutoff

  // State tracking
  private isActive = false
  private processingChunk = false
  private silenceCheckInterval: NodeJS.Timeout | null = null
  private startTime = 0

  // === Non-final state (preview, may change) ===
  private nonFinalText = '' // Current preview text
  private lastPreviewTime = 0 // Last preview time
  private isPreviewProcessing = false // Preview in progress
  private lastPreviewAudioBytes = 0 // Preview audio size at last request

  // === Final state (confirmed, never changes) ===
  private finalText: string[] = [] // Confirmed text segments
  private finalTranslation: string[] = [] // Confirmed translations
  private finalRevision = 0 // Increments on each final update

  // === Dual buffering ===
  private previewAudioBuffer: Buffer[] = [] // Recent audio for preview (trimmed window)
  private pendingAudioBuffer: Buffer[] = [] // Audio pending finalization (includes overlap)
  private previewAudioBytes = 0
  private pendingAudioBytes = 0
  private pendingNewAudioBytes = 0

  // Completed segments and mappings
  private completedSegments: SpeakerSegment[] = []

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
    this.previewIntervalMs = this.normalizeMs(this.config.previewIntervalMs, 400)
    this.previewMinAudioMs = this.normalizeMs(this.config.previewMinAudioMs, 300)
    this.previewWindowMs = this.normalizeMs(this.config.previewWindowMs, 2500)
    this.previewMinNewAudioMs = this.normalizeMs(this.config.previewMinNewAudioMs, 200)
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
    this.previewAudioBuffer = []
    this.pendingAudioBuffer = []
    this.previewAudioBytes = 0
    this.pendingAudioBytes = 0
    this.pendingNewAudioBytes = 0
    this.bufferStartTime = 0
    this.lastSpeechTime = Date.now()
    this.startTime = Date.now()
    this.processingChunk = false
    this.isPreviewProcessing = false
    this.lastPreviewTime = 0
    this.lastPreviewAudioBytes = 0
    this.completedSegments = []
    this.finalText = []
    this.finalTranslation = []
    this.nonFinalText = ''
    this.finalRevision = 0
    this.vadState.reset()

    // Start silence detection interval
    this.silenceCheckInterval = setInterval(() => {
      void this.maybeProcessFinal()
    }, 500)

    console.log('[StreamingGroq] Session started with non-final/final token support')
  }

  /**
   * Send an audio chunk to be buffered.
   */
  sendAudioChunk(chunk: Buffer): void {
    if (!this.isActive) return

    // Add to both buffers (dual buffering)
    this.pendingAudioBuffer.push(chunk)
    this.pendingAudioBytes += chunk.length
    this.pendingNewAudioBytes += chunk.length
    this.previewAudioBuffer.push(chunk)
    this.previewAudioBytes += chunk.length
    this.trimPreviewBuffer()

    // Use VAD to detect speech activity
    const isSpeech = this.vadState.processChunk(chunk)
    if (isSpeech) {
      this.lastSpeechTime = Date.now() // Only update when speech is detected
    }

    // Start buffer timer when first new audio arrives after final
    if (this.pendingNewAudioBytes === chunk.length) {
      this.bufferStartTime = Date.now()
    }

    // Check if we should process preview (Non-final)
    void this.maybeProcessPreview()

    // Check if we should process final
    void this.maybeProcessFinal()
  }

  /**
   * Check if preview should be processed (Non-final).
   */
  private async maybeProcessPreview(): Promise<void> {
    if (!this.isActive || this.isPreviewProcessing || this.processingChunk) return

    const now = Date.now()
    const timeSinceLastPreview = now - this.lastPreviewTime
    if (timeSinceLastPreview < this.previewIntervalMs) return

    const audioLengthMs = this.getDurationMsFromBytes(this.previewAudioBytes)
    if (audioLengthMs < this.previewMinAudioMs) return

    const newAudioMs = this.getDurationMsFromBytes(this.previewAudioBytes - this.lastPreviewAudioBytes)
    if (newAudioMs < this.previewMinNewAudioMs) return

    const previewRevision = this.finalRevision
    this.isPreviewProcessing = true
    this.lastPreviewTime = now
    this.lastPreviewAudioBytes = this.previewAudioBytes

    try {
      const audioToPreview = this.getPreviewWindowBuffer()
      if (audioToPreview.length === 0) return

      const wavBuffer = this.createWavBuffer(audioToPreview)
      const result = await this.transcribeAudio(wavBuffer)
      const previewText = result.text.trim()

      if (!previewText || !this.isActive || previewRevision !== this.finalRevision) {
        return
      }

      this.nonFinalText = this.deduplicateFromFinal(previewText)
      this.emitPartialResult()
    } catch (error) {
      console.warn('[GroqPreview] Preview failed:', error)
    } finally {
      this.isPreviewProcessing = false
    }
  }

  /**
   * Check if buffer should be processed based on silence or max duration.
   */
  private async maybeProcessFinal(): Promise<void> {
    if (this.processingChunk || this.pendingNewAudioBytes === 0) return
    if (this.bufferStartTime === 0) return

    const bufferDuration = Date.now() - this.bufferStartTime
    const silenceDuration = Date.now() - this.lastSpeechTime // Based on actual VAD detection

    const shouldProcess =
      (bufferDuration >= this.MIN_CHUNK_DURATION_MS &&
        silenceDuration >= this.SILENCE_THRESHOLD_MS) ||
      bufferDuration >= this.MAX_CHUNK_DURATION_MS

    if (shouldProcess) {
      await this.processFinalAudio()
    }
  }

  /**
   * Process buffered audio: transcribe and optionally translate (Final).
   */
  private async processFinalAudio(): Promise<void> {
    if (this.pendingAudioBuffer.length === 0) return
    if (this.pendingNewAudioBytes === 0) return

    this.processingChunk = true
    const audioToProcess = this.getAudioWithOverlap()
    this.retainPendingOverlap(audioToProcess)

    try {
      const wavBuffer = this.createWavBuffer(audioToProcess)
      const transcription = await this.transcribeAudio(wavBuffer)
      const finalText = transcription.text.trim()

      if (!finalText) {
        return
      }

      const deduped = this.deduplicateChunkBoundary(this.getFinalText(), finalText)
      this.finalRevision += 1
      this.previewAudioBuffer = [...this.pendingAudioBuffer]
      this.previewAudioBytes = this.pendingAudioBytes
      const overlapBytes = this.getBytesForMs(this.OVERLAP_AUDIO_MS)
      this.lastPreviewAudioBytes = Math.min(this.previewAudioBytes, overlapBytes)
      this.trimPreviewBuffer()

      this.nonFinalText = ''
      if (!deduped.trim()) {
        this.emitPartialResult()
        return
      }

      this.finalText.push(deduped)
      const finalIndex = this.finalText.length - 1
      this.emitPartialResult()

      this.translateFinalAsync(deduped, finalIndex)
    } catch (error) {
      console.error('[GroqFinal] Processing error:', error)
      this.emit('error', error)
    } finally {
      this.processingChunk = false
    }
  }

  private translateFinalAsync(text: string, index: number): void {
    if (!this.config.translation?.enabled || !this.config.translation.targetLanguage) {
      return
    }

    const targetLang = this.config.translation.targetLanguage
    this.translateText(text, targetLang)
      .then((translatedText) => {
        if (!translatedText || !this.isActive || this.finalText[index] !== text) {
          return
        }

        this.finalTranslation[index] = translatedText
        this.emitPartialResult(true)
      })
      .catch((err) => {
        console.warn('[StreamingGroq] Translation failed:', err)
        this.emit('translationError', err)
      })
  }

  private getPreviewWindowBuffer(): Buffer {
    const maxBytes = this.getBytesForMs(this.previewWindowMs)
    if (maxBytes <= 0 || this.previewAudioBuffer.length === 0) {
      return Buffer.alloc(0)
    }

    if (this.previewAudioBytes <= maxBytes) {
      return Buffer.concat(this.previewAudioBuffer)
    }

    return this.getTailBuffer(this.previewAudioBuffer, maxBytes)
  }

  private getTailBuffer(buffers: Buffer[], maxBytes: number): Buffer {
    if (maxBytes <= 0 || buffers.length === 0) {
      return Buffer.alloc(0)
    }

    let bytes = 0
    const slices: Buffer[] = []

    for (let i = buffers.length - 1; i >= 0; i--) {
      const buf = buffers[i]
      if (bytes + buf.length >= maxBytes) {
        const sliceStart = buf.length - (maxBytes - bytes)
        slices.unshift(buf.slice(Math.max(0, sliceStart)))
        break
      }
      bytes += buf.length
      slices.unshift(buf)
    }

    return Buffer.concat(slices)
  }

  private trimPreviewBuffer(): void {
    const maxBytes = this.getBytesForMs(this.previewWindowMs)
    if (maxBytes <= 0 || this.previewAudioBytes <= maxBytes) {
      return
    }

    let bytesToDrop = this.previewAudioBytes - maxBytes
    while (bytesToDrop > 0 && this.previewAudioBuffer.length > 0) {
      const head = this.previewAudioBuffer[0]
      if (head.length <= bytesToDrop) {
        bytesToDrop -= head.length
        this.previewAudioBytes -= head.length
        this.previewAudioBuffer.shift()
      } else {
        this.previewAudioBuffer[0] = head.slice(bytesToDrop)
        this.previewAudioBytes -= bytesToDrop
        bytesToDrop = 0
      }
    }

    if (this.lastPreviewAudioBytes > this.previewAudioBytes) {
      this.lastPreviewAudioBytes = this.previewAudioBytes
    }
  }

  private getAudioWithOverlap(): Buffer {
    return Buffer.concat(this.pendingAudioBuffer)
  }

  private retainPendingOverlap(processedAudio: Buffer): void {
    const overlapBytes = this.getBytesForMs(this.OVERLAP_AUDIO_MS)
    if (overlapBytes <= 0 || processedAudio.length === 0) {
      this.pendingAudioBuffer = []
      this.pendingAudioBytes = 0
    } else if (processedAudio.length > overlapBytes) {
      const overlap = processedAudio.slice(processedAudio.length - overlapBytes)
      this.pendingAudioBuffer = [overlap]
      this.pendingAudioBytes = overlap.length
    } else {
      this.pendingAudioBuffer = [processedAudio]
      this.pendingAudioBytes = processedAudio.length
    }

    this.pendingNewAudioBytes = 0
    this.bufferStartTime = 0
  }

  private deduplicateChunkBoundary(prevFinal: string, newText: string): string {
    if (!prevFinal) return newText

    const overlap = findTextOverlap(prevFinal, newText)
    return overlap > 0 ? newText.slice(overlap) : newText
  }

  private deduplicateFromFinal(previewText: string): string {
    const finalJoined = this.getFinalText()
    if (!finalJoined) return previewText

    const overlap = findTextOverlap(finalJoined, previewText)
    return overlap > 0 ? previewText.slice(overlap) : previewText
  }

  private getFinalText(): string {
    return this.finalText.reduce((acc, part) => mergeText(acc, part), '')
  }

  private getFinalTranslationText(): string {
    return this.finalTranslation.reduce((acc, part) => mergeText(acc, part), '')
  }

  private getDurationMsFromBytes(bytes: number): number {
    if (bytes <= 0) return 0
    return bytes / this.getBytesPerMs()
  }

  private getBytesForMs(ms: number): number {
    if (ms <= 0) return 0
    return Math.floor(ms * this.getBytesPerMs())
  }

  private getBytesPerMs(): number {
    return (this.getSampleRate() * 2) / 1000
  }

  private getSampleRate(): number {
    return typeof this.config.sampleRate === 'number' && Number.isFinite(this.config.sampleRate)
      ? this.config.sampleRate
      : 16000
  }

  private normalizeMs(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return fallback
    }
    return Math.floor(value)
  }

  /**
   * Convert raw PCM buffer to WAV format.
   */
  private createWavBuffer(pcmBuffer: Buffer): Buffer {
    const sampleRate = this.getSampleRate()
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
  private emitPartialResult(isTranslationUpdate = false): void {
    const finalJoined = this.getFinalText()
    const translationJoined = this.getFinalTranslationText()
    const combinedText = mergeText(finalJoined, this.nonFinalText)

    // Build current segment (speaker 0 since Groq doesn't provide diarization)
    const currentSegment: SpeakerSegment = {
      speaker: 0,
      text: combinedText,
      translatedText: translationJoined || undefined,
      isFinal: false,
      sentencePairs: this.buildSentencePairs()
    }

    const result: PartialResult = {
      segments: [...this.completedSegments],
      currentSegment: currentSegment,
      combined: combinedText,
      currentSpeaker: 0,
      translationEnabled: this.config.translation?.enabled
    }

    this.emit('partial', result)

    if (isTranslationUpdate) {
      console.log(`[StreamingGroq] Translation update emitted for chunk`)
    }
  }

  /**
   * Build sentence pairs from confirmed text and translations.
   */
  private buildSentencePairs(): SentencePair[] {
    const pairs: SentencePair[] = []
    for (let i = 0; i < this.finalText.length; i++) {
      const text = this.finalText[i]
      pairs.push({
        original: text,
        translated: this.finalTranslation[i] || undefined
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
    if (this.pendingNewAudioBytes > 0) {
      await this.processFinalAudio()
      // Wait a bit for any pending translations
      await this.sleep(500)
    }

    this.isActive = false

    // Build final result
    const finalJoined = this.getFinalText()
    const fullText = mergeText(finalJoined, this.nonFinalText).trim()
    const fullTranslation = this.getFinalTranslationText().trim()

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
    this.previewAudioBuffer = []
    this.pendingAudioBuffer = []
    this.previewAudioBytes = 0
    this.pendingAudioBytes = 0
    this.pendingNewAudioBytes = 0
    this.nonFinalText = ''
    this.processingChunk = false
    this.isPreviewProcessing = false
  }

  /**
   * Helper: sleep for a given duration.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
