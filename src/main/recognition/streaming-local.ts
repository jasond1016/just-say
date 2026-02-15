import { EventEmitter } from 'events'
import { LocalRecognizer } from './local'
import { SpeakerSegment, PartialResult, SentencePair } from './streaming-soniox'
import { VADState } from './vad-utils'
import { findTextOverlap, mergeText } from './text-utils'

interface LocalTranslationConfig {
  enabled: boolean
  targetLanguage: string
  translator?: (text: string, targetLanguage: string) => Promise<string>
}

export interface StreamingLocalConfig {
  engine?: 'faster-whisper' | 'sensevoice'
  modelType?: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3'
  sensevoice?: {
    modelId?: string
    useItn?: boolean
  }
  device?: 'cpu' | 'cuda' | 'auto'
  computeType?: string
  language?: string
  serverMode?: 'local' | 'remote'
  serverHost?: string
  serverPort?: number
  sampleRate?: number
  translation?: LocalTranslationConfig
}

/**
 * Local/remote local ASR streaming adapter for meeting transcription.
 *
 * It buffers PCM chunks, performs endpointing with simple VAD + silence timing,
 * then sends finalized chunks to LocalRecognizer (HTTP server path).
 */
export class StreamingLocalRecognizer extends EventEmitter {
  private config: Required<Omit<StreamingLocalConfig, 'translation'>> & {
    translation?: LocalTranslationConfig
  }
  private recognizer: LocalRecognizer
  private preConnected = false
  private isActive = false
  private processingChunk = false
  private silenceCheckInterval: NodeJS.Timeout | null = null
  private startTime = 0

  // Endpointing state
  private pendingAudioBuffer: Buffer[] = []
  private pendingAudioBytes = 0
  private pendingNewAudioBytes = 0
  private lastSpeechTime = 0
  private bufferStartTime = 0
  private readonly vadState = new VADState(0.01, 3)

  // Output state
  private confirmedText = ''
  private confirmedTranslation = ''
  private completedSegments: SpeakerSegment[] = []
  private sentencePairs: SentencePair[] = []
  private translationQueue: Promise<void> = Promise.resolve()

  private readonly SILENCE_THRESHOLD_MS = 350
  private readonly MIN_CHUNK_DURATION_MS = 600
  private readonly MAX_CHUNK_DURATION_MS = 4500
  private readonly OVERLAP_AUDIO_MS = 200

  constructor(config?: StreamingLocalConfig) {
    super()
    this.config = {
      engine: 'faster-whisper',
      modelType: 'tiny',
      sensevoice: {
        modelId: 'FunAudioLLM/SenseVoiceSmall',
        useItn: true
      },
      device: 'auto',
      computeType: 'auto',
      language: 'auto',
      serverMode: 'local',
      serverHost: '127.0.0.1',
      serverPort: 8765,
      sampleRate: 16000,
      ...config
    }

    this.recognizer = this.createLocalRecognizer()
  }

  updateConfig(config?: StreamingLocalConfig): void {
    if (!config) return

    const nextConfig = {
      ...this.config,
      ...config,
      sensevoice: {
        ...this.config.sensevoice,
        ...(config.sensevoice || {})
      }
    }

    const recognizerRuntimeChanged =
      nextConfig.engine !== this.config.engine ||
      nextConfig.modelType !== this.config.modelType ||
      nextConfig.sensevoice.modelId !== this.config.sensevoice.modelId ||
      nextConfig.sensevoice.useItn !== this.config.sensevoice.useItn ||
      nextConfig.device !== this.config.device ||
      nextConfig.computeType !== this.config.computeType ||
      nextConfig.language !== this.config.language ||
      nextConfig.serverMode !== this.config.serverMode ||
      nextConfig.serverHost !== this.config.serverHost ||
      nextConfig.serverPort !== this.config.serverPort ||
      nextConfig.sampleRate !== this.config.sampleRate

    this.config = nextConfig

    if (recognizerRuntimeChanged) {
      this.recognizer = this.createLocalRecognizer()
      this.preConnected = false
    }
  }

  async preConnect(): Promise<void> {
    if (this.config.serverMode === 'local') {
      await this.recognizer.prewarm('meeting-preconnect')
    }
    const healthy = await this.recognizer.healthCheck()
    this.preConnected = healthy
    if (!healthy) {
      const target =
        this.config.serverMode === 'remote'
          ? `${this.config.serverHost}:${this.config.serverPort}`
          : 'local whisper runtime'
      throw new Error(`Local meeting transcription unavailable: ${target}`)
    }
    console.log('[StreamingLocal] Pre-connected successfully')
  }

  isPreConnected(): boolean {
    return this.preConnected
  }

  async startSession(): Promise<void> {
    if (!this.preConnected) {
      await this.preConnect()
    }

    this.isActive = true
    this.processingChunk = false
    this.startTime = Date.now()
    this.pendingAudioBuffer = []
    this.pendingAudioBytes = 0
    this.pendingNewAudioBytes = 0
    this.lastSpeechTime = Date.now()
    this.bufferStartTime = 0
    this.confirmedText = ''
    this.confirmedTranslation = ''
    this.completedSegments = []
    this.sentencePairs = []
    this.translationQueue = Promise.resolve()
    this.vadState.reset()

    if (this.silenceCheckInterval) {
      clearInterval(this.silenceCheckInterval)
    }
    this.silenceCheckInterval = setInterval(() => {
      void this.maybeProcessFinal()
    }, 400)

    console.log('[StreamingLocal] Session started')
  }

  sendAudioChunk(chunk: Buffer): void {
    if (!this.isActive || chunk.length === 0) return

    this.pendingAudioBuffer.push(chunk)
    this.pendingAudioBytes += chunk.length
    this.pendingNewAudioBytes += chunk.length
    if (this.bufferStartTime === 0) {
      this.bufferStartTime = Date.now()
    }

    const hasSpeech = this.vadState.processChunk(chunk)
    if (hasSpeech) {
      this.lastSpeechTime = Date.now()
    }

    void this.maybeProcessFinal()
  }

  async endSession(): Promise<{
    text: string
    durationMs: number
    segments: SpeakerSegment[]
    currentSegment: SpeakerSegment | null
  }> {
    if (this.silenceCheckInterval) {
      clearInterval(this.silenceCheckInterval)
      this.silenceCheckInterval = null
    }

    if (this.pendingAudioBytes > 0) {
      await this.maybeProcessFinal(true)
    }
    await this.translationQueue

    this.isActive = false

    const text = this.confirmedText.trim()
    const translatedText = this.confirmedTranslation.trim()
    const finalSegment: SpeakerSegment | null = text
      ? {
          speaker: 0,
          text,
          translatedText: translatedText || undefined,
          sentencePairs: this.sentencePairs.length > 0 ? [...this.sentencePairs] : undefined,
          isFinal: true
        }
      : null

    return {
      text,
      durationMs: Date.now() - this.startTime,
      segments: [...this.completedSegments],
      currentSegment: finalSegment
    }
  }

  isSessionActive(): boolean {
    return this.isActive
  }

  close(): void {
    if (this.silenceCheckInterval) {
      clearInterval(this.silenceCheckInterval)
      this.silenceCheckInterval = null
    }
    this.isActive = false
    this.processingChunk = false
    this.pendingAudioBuffer = []
    this.pendingAudioBytes = 0
    this.pendingNewAudioBytes = 0
    this.bufferStartTime = 0
    this.confirmedText = ''
    this.confirmedTranslation = ''
    this.sentencePairs = []
    this.translationQueue = Promise.resolve()
  }

  private createLocalRecognizer(): LocalRecognizer {
    return new LocalRecognizer({
      engine: this.config.engine,
      modelType: this.config.modelType,
      sensevoice: this.config.sensevoice,
      device: this.config.device,
      computeType: this.config.computeType,
      language: this.config.language,
      serverMode: this.config.serverMode,
      serverHost: this.config.serverHost,
      serverPort: this.config.serverPort,
      sampleRate: this.config.sampleRate,
      useHttpServer: true
    })
  }

  private async maybeProcessFinal(force = false): Promise<void> {
    if (!this.isActive || this.processingChunk || this.pendingAudioBytes === 0) return
    if (!force && this.pendingNewAudioBytes === 0) return
    if (!force && this.bufferStartTime === 0) return

    const pendingDurationMs = this.getDurationMsFromBytes(this.pendingNewAudioBytes)
    const silenceDurationMs = Date.now() - this.lastSpeechTime

    const shouldProcess =
      force ||
      pendingDurationMs >= this.MAX_CHUNK_DURATION_MS ||
      (pendingDurationMs >= this.MIN_CHUNK_DURATION_MS &&
        silenceDurationMs >= this.SILENCE_THRESHOLD_MS)

    if (!shouldProcess) return

    const snapshotBuffers = this.pendingAudioBuffer
    const snapshotBytes = this.pendingAudioBytes
    const snapshotNewBytes = this.pendingNewAudioBytes
    const pcmBuffer = Buffer.concat(snapshotBuffers)
    this.pendingAudioBuffer = []
    this.pendingAudioBytes = 0
    this.pendingNewAudioBytes = 0
    this.bufferStartTime = 0

    this.processingChunk = true

    try {
      const result = await this.recognizer.recognize(pcmBuffer)
      this.retainOverlap(pcmBuffer)
      const chunkText = result.text?.trim()
      if (chunkText) {
        const appended = this.appendConfirmedText(chunkText)
        if (!appended) {
          return
        }
        const pairIndex = this.sentencePairs.push({ original: appended }) - 1
        this.emitPartialResult()
        this.translateChunkAsync(appended, pairIndex)
      }
    } catch (error) {
      // Requeue audio when ASR fails, so we don't drop speech content.
      this.pendingAudioBuffer = [...snapshotBuffers, ...this.pendingAudioBuffer]
      this.pendingAudioBytes += snapshotBytes
      this.pendingNewAudioBytes += snapshotNewBytes
      this.bufferStartTime = Date.now() - this.getDurationMsFromBytes(this.pendingAudioBytes)
      const err = error instanceof Error ? error : new Error(String(error))
      console.error('[StreamingLocal] Chunk transcription failed:', err)
      this.emit('error', err)
    } finally {
      this.processingChunk = false
    }
  }

  private appendConfirmedText(nextText: string): string {
    if (!this.confirmedText) {
      this.confirmedText = nextText
      return nextText
    }

    const overlap = findTextOverlap(this.confirmedText, nextText, 160)
    const deduped = overlap > 0 ? nextText.slice(overlap) : nextText
    const normalized = deduped.trimStart()
    if (!normalized) return ''

    this.confirmedText = mergeText(this.confirmedText, normalized)
    return normalized
  }

  private translateChunkAsync(chunkText: string, pairIndex: number): void {
    if (!this.config.translation?.enabled || !this.config.translation.targetLanguage) {
      return
    }

    const translator = this.config.translation.translator
    if (!translator) {
      return
    }

    this.translationQueue = this.translationQueue
      .then(async () => {
        const translated = (await translator(
          chunkText,
          this.config.translation!.targetLanguage
        ))?.trim()
        if (!this.isActive || !translated) {
          return
        }
        if (this.sentencePairs[pairIndex]?.original !== chunkText) {
          return
        }
        this.sentencePairs[pairIndex] = {
          ...this.sentencePairs[pairIndex],
          translated
        }
        this.rebuildConfirmedTranslation()
        this.emitPartialResult()
      })
      .catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error))
        console.warn('[StreamingLocal] Chunk translation failed:', err.message)
        this.emit('translationError', err)
      })
  }

  private rebuildConfirmedTranslation(): void {
    let merged = ''
    for (const pair of this.sentencePairs) {
      if (!pair.translated) continue
      merged = mergeText(merged, pair.translated)
    }
    this.confirmedTranslation = merged
  }

  private emitPartialResult(): void {
    const combined = this.confirmedText.trim()
    const translated = this.confirmedTranslation.trim()
    const currentSegment: SpeakerSegment | null = combined
      ? {
          speaker: 0,
          text: combined,
          translatedText: translated || undefined,
          sentencePairs: this.sentencePairs.length > 0 ? [...this.sentencePairs] : undefined,
          isFinal: false
        }
      : null

    const result: PartialResult = {
      segments: [...this.completedSegments],
      currentSegment,
      combined,
      currentSpeaker: 0,
      translationEnabled: this.config.translation?.enabled === true
    }

    this.emit('partial', result)
  }

  private getDurationMsFromBytes(bytes: number): number {
    const sampleRate = this.config.sampleRate || 16000
    const samples = bytes / 2 // 16-bit PCM mono
    return (samples / sampleRate) * 1000
  }

  private retainOverlap(processedBuffer: Buffer): void {
    const overlapBytes = this.getBytesForMs(this.OVERLAP_AUDIO_MS)
    if (overlapBytes <= 0 || processedBuffer.length === 0) {
      return
    }

    const overlap =
      processedBuffer.length > overlapBytes
        ? processedBuffer.slice(processedBuffer.length - overlapBytes)
        : processedBuffer
    this.pendingAudioBuffer = [overlap, ...this.pendingAudioBuffer]
    this.pendingAudioBytes += overlap.length
    this.bufferStartTime = Date.now() - this.getDurationMsFromBytes(this.pendingAudioBytes)
  }

  private getBytesForMs(ms: number): number {
    if (ms <= 0) return 0
    const sampleRate = this.config.sampleRate || 16000
    return Math.floor((sampleRate * 2 * ms) / 1000)
  }
}
