import { EventEmitter } from 'events'
import { LocalRecognizer } from './local'
import { SpeakerSegment, PartialResult } from './streaming-soniox'
import { VADState } from './vad-utils'
import { findTextOverlap, mergeText } from './text-utils'

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
}

/**
 * Local/remote local ASR streaming adapter for meeting transcription.
 *
 * It buffers PCM chunks, performs endpointing with simple VAD + silence timing,
 * then sends finalized chunks to LocalRecognizer (HTTP server path).
 */
export class StreamingLocalRecognizer extends EventEmitter {
  private config: Required<StreamingLocalConfig>
  private recognizer: LocalRecognizer
  private preConnected = false
  private isActive = false
  private processingChunk = false
  private silenceCheckInterval: NodeJS.Timeout | null = null
  private startTime = 0

  // Endpointing state
  private pendingAudioBuffer: Buffer[] = []
  private pendingAudioBytes = 0
  private lastSpeechTime = 0
  private bufferStartTime = 0
  private readonly vadState = new VADState(0.01, 3)

  // Output state
  private confirmedText = ''
  private completedSegments: SpeakerSegment[] = []

  private readonly SILENCE_THRESHOLD_MS = 500
  private readonly MIN_CHUNK_DURATION_MS = 800
  private readonly MAX_CHUNK_DURATION_MS = 10000

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

    this.recognizer = new LocalRecognizer({
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

  async preConnect(): Promise<void> {
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
    this.lastSpeechTime = Date.now()
    this.bufferStartTime = 0
    this.confirmedText = ''
    this.completedSegments = []
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

    this.isActive = false

    const text = this.confirmedText.trim()
    const finalSegment: SpeakerSegment | null = text
      ? {
          speaker: 0,
          text,
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
    this.bufferStartTime = 0
    this.confirmedText = ''
  }

  private async maybeProcessFinal(force = false): Promise<void> {
    if (!this.isActive || this.processingChunk || this.pendingAudioBytes === 0) return
    if (!force && this.bufferStartTime === 0) return

    const pendingDurationMs = this.getDurationMsFromBytes(this.pendingAudioBytes)
    const silenceDurationMs = Date.now() - this.lastSpeechTime

    const shouldProcess =
      force ||
      pendingDurationMs >= this.MAX_CHUNK_DURATION_MS ||
      (pendingDurationMs >= this.MIN_CHUNK_DURATION_MS &&
        silenceDurationMs >= this.SILENCE_THRESHOLD_MS)

    if (!shouldProcess) return

    const pcmBuffer = Buffer.concat(this.pendingAudioBuffer)
    this.pendingAudioBuffer = []
    this.pendingAudioBytes = 0
    this.bufferStartTime = 0

    this.processingChunk = true

    try {
      const result = await this.recognizer.recognize(pcmBuffer)
      const chunkText = result.text?.trim()
      if (chunkText) {
        this.appendConfirmedText(chunkText)
        this.emitPartialResult()
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      console.error('[StreamingLocal] Chunk transcription failed:', err)
      this.emit('error', err)
    } finally {
      this.processingChunk = false
    }
  }

  private appendConfirmedText(nextText: string): void {
    if (!this.confirmedText) {
      this.confirmedText = nextText
      return
    }

    const overlap = findTextOverlap(this.confirmedText, nextText, 160)
    const deduped = overlap > 0 ? nextText.slice(overlap) : nextText
    const normalized = deduped.trimStart()
    if (!normalized) return

    this.confirmedText = mergeText(this.confirmedText, normalized)
  }

  private emitPartialResult(): void {
    const combined = this.confirmedText.trim()
    const currentSegment: SpeakerSegment | null = combined
      ? {
          speaker: 0,
          text: combined,
          isFinal: false
        }
      : null

    const result: PartialResult = {
      segments: [...this.completedSegments],
      currentSegment,
      combined,
      currentSpeaker: 0,
      translationEnabled: false
    }

    this.emit('partial', result)
  }

  private getDurationMsFromBytes(bytes: number): number {
    const sampleRate = this.config.sampleRate || 16000
    const samples = bytes / 2 // 16-bit PCM mono
    return (samples / sampleRate) * 1000
  }
}
