import WebSocket from 'ws'
import { EventEmitter } from 'events'

import { getWhisperServer, LocalEngine } from './whisperServer'
import { SpeakerSegment, PartialResult, SentencePair } from './streaming-soniox'
import { findTextOverlap, mergeText } from './text-utils'
import { isWeakBoundarySuffix, shouldFlushSentenceByBoundary } from './commit-boundary'

interface LocalTranslationConfig {
  enabled: boolean
  targetLanguage: string
  translator?: (text: string, targetLanguage: string) => Promise<string>
  batchTranslator?: (texts: string[], targetLanguage: string) => Promise<string[]>
  batchWindowMs?: number
  maxBatchItems?: number
}

interface StreamingSegmentationConfig {
  previewIntervalMs?: number
  previewMinAudioMs?: number
  previewMinNewAudioMs?: number
  previewWindowMs?: number
  minChunkMs?: number
  silenceMs?: number
  maxChunkMs?: number
  overlapMs?: number
  holdMs?: number
}

export interface StreamingLocalWsConfig {
  engine?: LocalEngine
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
  segmentation?: StreamingSegmentationConfig
  translation?: LocalTranslationConfig
}

export class StreamingLocalWsRecognizer extends EventEmitter {
  private config: Required<
    Omit<StreamingLocalWsConfig, 'translation' | 'segmentation' | 'sensevoice'>
  > & {
    sensevoice: {
      modelId: string
      useItn: boolean
    }
    translation?: LocalTranslationConfig
    segmentation?: StreamingSegmentationConfig
  }

  private ws: WebSocket | null = null
  private preConnected = false
  private wsPort: number | undefined
  private isActive = false
  private startTime = 0
  private translationQueue: Promise<void> = Promise.resolve()

  private confirmedText = ''
  private previewText = ''
  private pendingSentenceOriginal = ''
  private sentencePairs: SentencePair[] = []
  private confirmedTranslation = ''
  private boundaryHoldTimer: NodeJS.Timeout | null = null
  private pendingTranslationPairIndices: number[] = []
  private translationBatchTimer: NodeJS.Timeout | null = null

  private readonly SENTENCE_MIN_FLUSH_CHARS = 14
  private readonly SENTENCE_SOFT_FLUSH_CHARS = 28
  private readonly SENTENCE_FORCE_FLUSH_CHARS = 48
  private readonly STRONG_PUNCTUATION_MIN_TAIL_CHARS = 3
  private readonly DEFAULT_HOLD_MS = 260
  private readonly DEFAULT_TRANSLATION_BATCH_WINDOW_MS = 450
  private readonly DEFAULT_TRANSLATION_MAX_BATCH_ITEMS = 6

  constructor(config?: StreamingLocalWsConfig) {
    super()
    const defaults = {
      engine: 'sensevoice',
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
      sampleRate: 16000
    } as const
    this.config = {
      ...defaults,
      ...config,
      sensevoice: {
        modelId: config?.sensevoice?.modelId || defaults.sensevoice.modelId,
        useItn: config?.sensevoice?.useItn ?? defaults.sensevoice.useItn
      }
    }
  }

  updateConfig(config?: StreamingLocalWsConfig): void {
    if (!config) return
    this.config = {
      ...this.config,
      ...config,
      sensevoice: {
        modelId: config.sensevoice?.modelId || this.config.sensevoice.modelId,
        useItn: config.sensevoice?.useItn ?? this.config.sensevoice.useItn
      }
    }
    this.clearBoundaryHoldTimer()
    this.pendingTranslationPairIndices = []
    this.clearTranslationBatchTimer()
    this.preConnected = false
  }

  private getServerClient(): ReturnType<typeof getWhisperServer> {
    const serverMode = this.config.serverMode || 'local'
    const host = serverMode === 'remote' ? this.config.serverHost || '127.0.0.1' : '127.0.0.1'
    const port = this.config.serverPort || 8765
    const device =
      this.config.device === 'cuda' || this.config.device === 'cpu' ? this.config.device : 'cpu'
    const computeType =
      this.config.computeType && this.config.computeType !== 'auto'
        ? this.config.computeType
        : device === 'cuda'
          ? 'float16'
          : 'int8'

    return getWhisperServer({
      mode: serverMode,
      host,
      port,
      engine: this.config.engine,
      modelType: this.config.modelType,
      sensevoiceModelId: this.config.sensevoice.modelId,
      sensevoiceUseItn: this.config.sensevoice.useItn,
      device,
      computeType,
      autoStart: serverMode === 'local'
    })
  }

  async preConnect(): Promise<void> {
    const server = this.getServerClient()
    const capabilities = await server.getCapabilities()
    if (!capabilities.streaming_asr) {
      throw new Error('Local server does not support websocket streaming ASR')
    }
    this.wsPort =
      typeof capabilities.ws_port === 'number' && Number.isFinite(capabilities.ws_port)
        ? Math.floor(capabilities.ws_port)
        : undefined
    this.preConnected = true
    console.log('[StreamingLocalWs] Pre-connected successfully')
  }

  isPreConnected(): boolean {
    return this.preConnected
  }

  async startSession(): Promise<void> {
    if (!this.preConnected) {
      await this.preConnect()
    }

    this.isActive = true
    this.startTime = Date.now()
    this.translationQueue = Promise.resolve()
    this.confirmedText = ''
    this.previewText = ''
    this.pendingSentenceOriginal = ''
    this.sentencePairs = []
    this.confirmedTranslation = ''
    this.pendingTranslationPairIndices = []
    this.clearBoundaryHoldTimer()
    this.clearTranslationBatchTimer()

    const server = this.getServerClient()
    const wsUrl = server.getStreamWsUrl({
      wsPort: this.wsPort,
      sampleRate: this.config.sampleRate,
      language: this.config.language,
      previewIntervalMs: this.config.segmentation?.previewIntervalMs,
      previewMinAudioMs: this.config.segmentation?.previewMinAudioMs,
      previewMinNewAudioMs: this.config.segmentation?.previewMinNewAudioMs,
      previewWindowMs: this.config.segmentation?.previewWindowMs,
      minChunkMs: this.config.segmentation?.minChunkMs,
      silenceMs: this.config.segmentation?.silenceMs,
      maxChunkMs: this.config.segmentation?.maxChunkMs,
      overlapMs: this.config.segmentation?.overlapMs
    })

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      let settled = false
      const finish = (err?: Error): void => {
        if (settled) return
        settled = true
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      }

      const timeout = setTimeout(() => {
        ws.close()
        finish(new Error('Streaming websocket connection timeout'))
      }, 5000)

      ws.once('open', () => {
        clearTimeout(timeout)
        this.ws = ws
        finish()
      })

      ws.on('message', (payload, isBinary) => {
        if (isBinary) return
        this.handleMessage(payload.toString('utf-8'))
      })

      ws.on('error', (err) => {
        clearTimeout(timeout)
        if (!settled) {
          finish(err instanceof Error ? err : new Error(String(err)))
          return
        }
        this.emit('error', err)
      })

      ws.on('close', () => {
        this.ws = null
      })
    })

    console.log('[StreamingLocalWs] Session started')
  }

  sendAudioChunk(chunk: Buffer): void {
    if (!this.isActive || !this.ws || this.ws.readyState !== WebSocket.OPEN || chunk.length === 0) {
      return
    }
    this.ws.send(chunk, { binary: true })
  }

  async endSession(): Promise<{
    text: string
    durationMs: number
    segments: SpeakerSegment[]
    currentSegment: SpeakerSegment | null
  }> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'flush' }))
      } catch {
        // Ignore flush errors.
      }
      await new Promise((resolve) => setTimeout(resolve, 600))
      try {
        this.ws.send(JSON.stringify({ type: 'close' }))
      } catch {
        // Ignore close errors.
      }
      this.ws.close()
      this.ws = null
    }

    this.previewText = ''
    this.clearBoundaryHoldTimer()
    this.flushPendingSentencePair(true, true)
    this.flushPendingTranslationBatch()
    await this.translationQueue
    this.isActive = false

    const finalText = this.confirmedText.trim()
    const finalTranslation = this.confirmedTranslation.trim()
    const finalSegment: SpeakerSegment | null = finalText
      ? {
          speaker: 0,
          text: finalText,
          translatedText: finalTranslation || undefined,
          sentencePairs: this.sentencePairs.length > 0 ? [...this.sentencePairs] : undefined,
          isFinal: true
        }
      : null

    return {
      text: finalText,
      durationMs: Date.now() - this.startTime,
      segments: [],
      currentSegment: finalSegment
    }
  }

  isSessionActive(): boolean {
    return this.isActive
  }

  close(): void {
    this.isActive = false
    this.previewText = ''
    this.clearBoundaryHoldTimer()
    this.pendingTranslationPairIndices = []
    this.clearTranslationBatchTimer()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.translationQueue = Promise.resolve()
  }

  private handleMessage(raw: string): void {
    let data: { type?: string; text?: string; message?: string; reason?: string }
    try {
      data = JSON.parse(raw) as { type?: string; text?: string; message?: string; reason?: string }
    } catch {
      return
    }

    if (data.type === 'interim') {
      const preview = this.normalizeText(data.text || '')
      this.previewText = this.deduplicateFromConfirmed(preview)
      this.emitPartialResult()
      return
    }

    if (data.type === 'final_chunk') {
      this.clearBoundaryHoldTimer()
      const committed = this.appendConfirmed(data.text || '')
      this.previewText = ''
      if (committed) {
        this.pendingSentenceOriginal = mergeText(this.pendingSentenceOriginal, committed)
        this.flushPendingSentencePair(false, false)
      }
      this.emitPartialResult()
      return
    }

    if (data.type === 'endpoint') {
      if (this.pendingSentenceOriginal.trim()) {
        if (isWeakBoundarySuffix(this.pendingSentenceOriginal)) {
          this.scheduleBoundaryHoldFlush(data.reason || 'endpoint')
        } else {
          this.flushPendingSentencePair(false, true)
        }
      }
      this.emitPartialResult()
      return
    }

    if (data.type === 'final') {
      this.previewText = ''
      this.flushPendingSentencePair(true, true)
      this.emitPartialResult()
      return
    }

    if (data.type === 'error') {
      this.emit('error', new Error(data.message || 'streaming_local_ws_error'))
    }
  }

  private normalizeText(text: string): string {
    return text.trim()
  }

  private deduplicateFromConfirmed(text: string): string {
    if (!text || !this.confirmedText) return text
    const overlap = findTextOverlap(this.confirmedText, text, 200)
    return overlap > 0 ? text.slice(overlap) : text
  }

  private appendConfirmed(text: string): string {
    const normalized = this.normalizeText(text)
    if (!normalized) return ''
    if (!this.confirmedText) {
      this.confirmedText = normalized
      return normalized
    }
    const overlap = findTextOverlap(this.confirmedText, normalized, 200)
    const deduped = overlap > 0 ? normalized.slice(overlap) : normalized
    if (!deduped.trim()) {
      return ''
    }
    this.confirmedText = mergeText(this.confirmedText, deduped)
    return deduped
  }

  private getHoldMs(): number {
    const holdMs = this.config.segmentation?.holdMs
    if (typeof holdMs === 'number' && Number.isFinite(holdMs) && holdMs > 0) {
      return Math.floor(holdMs)
    }
    return this.DEFAULT_HOLD_MS
  }

  private scheduleBoundaryHoldFlush(reason: string): void {
    this.clearBoundaryHoldTimer()
    const holdMs = this.getHoldMs()
    this.boundaryHoldTimer = setTimeout(() => {
      this.boundaryHoldTimer = null
      if (!this.isActive) {
        return
      }
      this.flushPendingSentencePair(false, true)
      this.emitPartialResult()
      if (reason) {
        console.log(`[StreamingLocalWs] Hold flush executed after weak boundary: ${reason}`)
      }
    }, holdMs)
  }

  private clearBoundaryHoldTimer(): void {
    if (this.boundaryHoldTimer) {
      clearTimeout(this.boundaryHoldTimer)
      this.boundaryHoldTimer = null
    }
  }

  private flushPendingSentencePair(force: boolean, endpointTriggered: boolean): number | null {
    const normalized = this.pendingSentenceOriginal.trim()
    if (!normalized) {
      this.pendingSentenceOriginal = ''
      return null
    }

    if (
      !force &&
      !shouldFlushSentenceByBoundary(normalized, endpointTriggered, {
        sentenceMinFlushChars: this.SENTENCE_MIN_FLUSH_CHARS,
        sentenceSoftFlushChars: this.SENTENCE_SOFT_FLUSH_CHARS,
        sentenceForceFlushChars: this.SENTENCE_FORCE_FLUSH_CHARS,
        strongPunctuationMinTailChars: this.STRONG_PUNCTUATION_MIN_TAIL_CHARS
      })
    ) {
      return null
    }

    this.pendingSentenceOriginal = ''
    const pairIndex = this.sentencePairs.push({ original: normalized }) - 1
    this.translatePairAsync(pairIndex)
    return pairIndex
  }

  private translatePairAsync(pairIndex: number): void {
    if (!this.config.translation?.enabled || !this.config.translation.targetLanguage) {
      return
    }

    const originalText = this.sentencePairs[pairIndex]?.original?.trim()
    if (!originalText || !this.shouldTranslateText(originalText)) {
      return
    }

    if (this.config.translation.batchTranslator) {
      this.pendingTranslationPairIndices.push(pairIndex)
      if (this.pendingTranslationPairIndices.length >= this.getTranslationMaxBatchItems()) {
        this.flushPendingTranslationBatch()
      } else {
        this.scheduleTranslationBatchFlush()
      }
      return
    }

    const translator = this.config.translation.translator
    if (!translator) {
      return
    }

    this.translationQueue = this.translationQueue
      .then(async () => {
        const translated = (
          await translator(originalText, this.config.translation!.targetLanguage)
        )?.trim()
        if (!translated || !this.isActive) {
          return
        }
        if (this.sentencePairs[pairIndex]?.original !== originalText) {
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
        console.warn('[StreamingLocalWs] Translation failed:', err.message)
        this.emit('translationError', err)
      })
  }

  private getTranslationBatchWindowMs(): number {
    const configured = this.config.translation?.batchWindowMs
    if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
      return Math.floor(configured)
    }
    return this.DEFAULT_TRANSLATION_BATCH_WINDOW_MS
  }

  private getTranslationMaxBatchItems(): number {
    const configured = this.config.translation?.maxBatchItems
    if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
      return Math.floor(configured)
    }
    return this.DEFAULT_TRANSLATION_MAX_BATCH_ITEMS
  }

  private scheduleTranslationBatchFlush(): void {
    if (this.translationBatchTimer || this.pendingTranslationPairIndices.length === 0) {
      return
    }
    this.translationBatchTimer = setTimeout(() => {
      this.translationBatchTimer = null
      this.flushPendingTranslationBatch()
    }, this.getTranslationBatchWindowMs())
  }

  private clearTranslationBatchTimer(): void {
    if (this.translationBatchTimer) {
      clearTimeout(this.translationBatchTimer)
      this.translationBatchTimer = null
    }
  }

  private flushPendingTranslationBatch(): void {
    this.clearTranslationBatchTimer()
    if (!this.config.translation?.enabled || !this.config.translation.targetLanguage) {
      this.pendingTranslationPairIndices = []
      return
    }
    const batchTranslator = this.config.translation.batchTranslator
    if (!batchTranslator || this.pendingTranslationPairIndices.length === 0) {
      return
    }

    const indices = [...this.pendingTranslationPairIndices]
    this.pendingTranslationPairIndices = []
    const items = indices
      .map((index) => ({
        index,
        original: this.sentencePairs[index]?.original?.trim() || ''
      }))
      .filter((item) => item.original && this.shouldTranslateText(item.original))

    if (items.length === 0) {
      return
    }

    this.translationQueue = this.translationQueue
      .then(async () => {
        const translatedBatch = await batchTranslator(
          items.map((item) => item.original),
          this.config.translation!.targetLanguage
        )
        if (!this.isActive || translatedBatch.length === 0) {
          return
        }
        let changed = false
        for (let i = 0; i < items.length; i += 1) {
          const translated = (translatedBatch[i] || '').trim()
          if (!translated) continue
          const item = items[i]
          if (this.sentencePairs[item.index]?.original !== item.original) {
            continue
          }
          this.sentencePairs[item.index] = {
            ...this.sentencePairs[item.index],
            translated
          }
          changed = true
        }
        if (changed) {
          this.rebuildConfirmedTranslation()
          this.emitPartialResult()
        }
      })
      .catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error))
        console.warn('[StreamingLocalWs] Batch translation failed:', err.message)
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

  private shouldTranslateText(text: string): boolean {
    const normalized = text.trim()
    if (!normalized) return false
    return Array.from(normalized).some((ch) => /[\p{L}\p{N}]/u.test(ch))
  }

  private emitPartialResult(): void {
    const combined = mergeText(this.confirmedText, this.previewText).trim()
    const translated = this.confirmedTranslation.trim()

    const pairs: SentencePair[] = [...this.sentencePairs]
    const pendingPairText = mergeText(this.pendingSentenceOriginal, this.previewText).trim()
    if (pendingPairText) {
      pairs.push({ original: pendingPairText })
    }

    const currentSegment: SpeakerSegment | null = combined
      ? {
          speaker: 0,
          text: combined,
          translatedText: translated || undefined,
          sentencePairs: pairs.length > 0 ? pairs : undefined,
          isFinal: false
        }
      : null

    const result: PartialResult = {
      segments: [],
      currentSegment,
      combined,
      currentSpeaker: 0,
      translationEnabled: this.config.translation?.enabled === true
    }

    this.emit('partial', result)
  }
}
