import WebSocket from 'ws'
import { EventEmitter } from 'events'

import {
  getWhisperServer,
  getWhisperStreamWsPort,
  LocalEngine,
  supportsWhisperStreamEvent,
  WhisperStreamEvent,
  WhisperStreamWordTimingPayload
} from './whisperServer'
import { SpeakerSegment, PartialResult, SentencePair, WordTiming } from './streaming-soniox'
import {
  cleanupJapaneseAsrText,
  findTextOverlap,
  mergeText,
  normalizeJapaneseSpacing
} from './text-utils'
import { TextCorrectionConfig } from './text-corrections'

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
  transcriptionProfile?: 'single_shot' | 'offline_segmented'
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
  includeWordTimings?: boolean
  textCorrections?: TextCorrectionConfig
  segmentation?: StreamingSegmentationConfig
  translation?: LocalTranslationConfig
}

export class StreamingLocalWsRecognizer extends EventEmitter {
  private static readonly DEBUG_STREAM = true

  private config: Required<
    Omit<StreamingLocalWsConfig, 'translation' | 'segmentation' | 'sensevoice' | 'textCorrections'>
  > & {
    sensevoice: {
      modelId: string
      useItn: boolean
    }
    textCorrections?: TextCorrectionConfig
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
  private previewStableText = ''
  private previewUnstableText = ''
  private currentWordTimings: WordTiming[] = []
  private completedSegments: SpeakerSegment[] = []
  private liveSentenceTail = ''
  private endpointReason = ''
  private sentencePairs: SentencePair[] = []
  private sentencePairSegmentIndices: number[] = []
  private pendingSentenceStartIndex = 0
  private pendingTranslationPairIndices: number[] = []
  private translationBatchTimer: NodeJS.Timeout | null = null

  private readonly DEFAULT_TRANSLATION_BATCH_WINDOW_MS = 450
  private readonly DEFAULT_TRANSLATION_MAX_BATCH_ITEMS = 6

  constructor(config?: StreamingLocalWsConfig) {
    super()
    const defaults = {
      engine: 'sensevoice',
      transcriptionProfile: 'single_shot',
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
      includeWordTimings: true
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
    this.wsPort = getWhisperStreamWsPort(capabilities, (this.config.serverPort || 8765) + 1)
    if (!supportsWhisperStreamEvent(capabilities, 'sentence')) {
      console.warn('[StreamingLocalWs] Server does not advertise sentence events')
    }
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
    this.previewStableText = ''
    this.previewUnstableText = ''
    this.currentWordTimings = []
    this.completedSegments = []
    this.liveSentenceTail = ''
    this.endpointReason = ''
    this.sentencePairs = []
    this.sentencePairSegmentIndices = []
    this.pendingSentenceStartIndex = 0
    this.pendingTranslationPairIndices = []
    this.clearTranslationBatchTimer()

    const server = this.getServerClient()
    const wsUrl = server.getStreamWsUrl({
      wsPort: this.wsPort,
      sampleRate: this.config.sampleRate,
      language: this.config.language,
      returnWordTimings: this.config.engine === 'sensevoice' && this.config.includeWordTimings,
      textCorrections: this.config.textCorrections,
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
    this.previewStableText = ''
    this.previewUnstableText = ''
    this.currentWordTimings = []
    this.liveSentenceTail = ''
    this.endpointReason = ''
    this.flushPendingTranslationBatch()
    await this.translationQueue
    this.isActive = false

    const finalText = this.confirmedText.trim()
    const finalSegment = this.buildCurrentLiveSegment()

    return {
      text: finalText,
      durationMs: Date.now() - this.startTime,
      segments: this.buildCommittedSegments(),
      currentSegment: finalSegment ? { ...finalSegment, isFinal: true } : null
    }
  }

  isSessionActive(): boolean {
    return this.isActive
  }

  close(): void {
    this.isActive = false
    this.previewText = ''
    this.previewStableText = ''
    this.previewUnstableText = ''
    this.currentWordTimings = []
    this.completedSegments = []
    this.liveSentenceTail = ''
    this.endpointReason = ''
    this.pendingTranslationPairIndices = []
    this.sentencePairSegmentIndices = []
    this.pendingSentenceStartIndex = 0
    this.clearTranslationBatchTimer()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.translationQueue = Promise.resolve()
  }

  private handleMessage(raw: string): void {
    const data = this.parseStreamEvent(raw)
    if (!data) {
      return
    }

    switch (data.type) {
      case 'interim': {
        this.endpointReason = ''
        this.previewText = this.normalizePreviewText(data.text || '')
        const stablePreview = this.normalizePreviewText(data.stableText || '')
        const unstablePreview = this.normalizeUnstablePreviewText(data.unstableText || '')
        this.applyPreviewStateFromServer(stablePreview, unstablePreview)
        this.currentWordTimings = this.normalizeWordTimings(data.wordTimings)
        this.debugStreamState('interim')
        this.emitPartialResult()
        return
      }
      case 'final_chunk':
        this.endpointReason = ''
        this.appendCommittedChunk(data.text || '')
        this.previewText = ''
        this.previewStableText = ''
        this.previewUnstableText = ''
        this.currentWordTimings = this.normalizeWordTimings(data.wordTimings)
        this.debugStreamState('final_chunk')
        this.emitPartialResult()
        return
      case 'sentence':
        this.applyFinalizedSentenceFromServer(data.text || '')
        this.debugStreamState('sentence')
        this.emitPartialResult()
        return
      case 'endpoint':
        this.endpointReason = typeof data.reason === 'string' ? data.reason.trim() : ''
        this.debugStreamState(`endpoint:${this.endpointReason || 'unknown'}`)
        this.emitPartialResult()
        return
      case 'final':
        this.previewText = ''
        this.previewStableText = ''
        this.previewUnstableText = ''
        this.currentWordTimings = this.normalizeWordTimings(data.wordTimings)
        this.liveSentenceTail = ''
        this.endpointReason = ''
        this.debugStreamState('final')
        this.emitPartialResult()
        return
      case 'error':
        this.emit('error', new Error(data.message || 'streaming_local_ws_error'))
        return
      default:
        return
    }
  }

  private parseStreamEvent(raw: string): WhisperStreamEvent | null {
    try {
      const parsed = JSON.parse(raw) as Partial<WhisperStreamEvent>
      if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
        return null
      }
      return parsed as WhisperStreamEvent
    } catch {
      return null
    }
  }

  private normalizeText(text: string): string {
    return cleanupJapaneseAsrText(text).trim()
  }

  private normalizePreviewText(text: string): string {
    return cleanupJapaneseAsrText(text)
  }

  private normalizeUnstablePreviewText(text: string): string {
    return normalizeJapaneseSpacing(text)
  }

  private normalizeWordTimings(items: WhisperStreamWordTimingPayload[] | undefined): WordTiming[] {
    if (!Array.isArray(items) || items.length === 0) {
      return []
    }

    return items
      .map((item) => {
        const text = this.normalizeText(item.text || '')
        const startMs = Number(item.startMs)
        const endMs = Number(item.endMs)
        if (!text || !Number.isFinite(startMs) || !Number.isFinite(endMs)) {
          return null
        }
        return {
          text,
          startMs: Math.max(0, Math.floor(startMs)),
          endMs: Math.max(0, Math.floor(endMs))
        }
      })
      .filter((item): item is WordTiming => item !== null)
  }

  private applyPreviewStateFromServer(stablePreview: string, unstablePreview: string): void {
    if (!this.previewText.trim()) {
      this.previewStableText = ''
      this.previewUnstableText = ''
      return
    }

    this.previewStableText = stablePreview
    this.previewUnstableText = unstablePreview
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

  private appendCommittedChunk(text: string): string {
    const committed = this.appendConfirmed(text)
    if (committed) {
      this.completedSegments.push({
        speaker: 0,
        text: committed,
        isFinal: true,
        timestamp: Date.now()
      })
      this.liveSentenceTail = mergeText(this.liveSentenceTail, committed)
    }
    return committed
  }

  private getVisibleBaseText(): string {
    return this.confirmedText.trim()
  }

  private applyFinalizedSentenceFromServer(text: string): number | null {
    const normalized = this.normalizeText(text)
    if (!normalized) {
      return null
    }

    if (this.liveSentenceTail.startsWith(normalized)) {
      this.liveSentenceTail = this.liveSentenceTail.slice(normalized.length).trimStart()
    } else if (this.liveSentenceTail === normalized) {
      this.liveSentenceTail = ''
    } else {
      const overlap = findTextOverlap(normalized, this.liveSentenceTail, 200)
      if (overlap > 0 && overlap === normalized.length) {
        this.liveSentenceTail = this.liveSentenceTail.slice(overlap).trimStart()
      } else {
        this.liveSentenceTail = ''
      }
    }

    const pairIndex = this.sentencePairs.push({ original: normalized }) - 1
    const segmentIndex = this.finalizePendingSentenceSegments(normalized)
    if (segmentIndex !== null) {
      this.sentencePairSegmentIndices[pairIndex] = segmentIndex
    }
    this.translatePairAsync(pairIndex)
    return pairIndex
  }

  private finalizePendingSentenceSegments(sentenceText: string): number | null {
    const normalized = this.normalizeText(sentenceText)
    if (!normalized) {
      return null
    }

    const startIndex = Math.max(
      0,
      Math.min(this.pendingSentenceStartIndex, this.completedSegments.length)
    )
    const endIndex = this.completedSegments.length
    this.pendingSentenceStartIndex = endIndex

    if (startIndex >= endIndex) {
      return null
    }

    if (endIndex - startIndex !== 1) {
      return null
    }

    this.completedSegments[startIndex] = {
      ...this.completedSegments[startIndex],
      sentencePairs: [{ original: normalized }]
    }
    return startIndex
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
        const segmentIndex = this.sentencePairSegmentIndices[pairIndex]
        if (typeof segmentIndex === 'number' && this.completedSegments[segmentIndex]) {
          this.completedSegments[segmentIndex] = {
            ...this.completedSegments[segmentIndex],
            translatedText: translated,
            sentencePairs: [{ original: originalText, translated }]
          }
        }
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
          const segmentIndex = this.sentencePairSegmentIndices[item.index]
          if (typeof segmentIndex === 'number' && this.completedSegments[segmentIndex]) {
            this.completedSegments[segmentIndex] = {
              ...this.completedSegments[segmentIndex],
              translatedText: translated,
              sentencePairs: [{ original: item.original, translated }]
            }
          }
          changed = true
        }
        if (changed) {
          this.emitPartialResult()
        }
      })
      .catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error))
        console.warn('[StreamingLocalWs] Batch translation failed:', err.message)
        this.emit('translationError', err)
      })
  }

  private shouldTranslateText(text: string): boolean {
    const normalized = text.trim()
    if (!normalized) return false
    return Array.from(normalized).some((ch) => /[\p{L}\p{N}]/u.test(ch))
  }

  private debugStreamState(eventType: string): void {
    if (!StreamingLocalWsRecognizer.DEBUG_STREAM) {
      return
    }

    const committedTail = this.completedSegments
      .slice(-3)
      .map((segment) => segment.text)
      .join(' | ')
    console.log(
      '[StreamingLocalWs][Debug]',
      JSON.stringify({
        eventType,
        completedSegments: this.completedSegments.length,
        sentencePairs: this.sentencePairs.length,
        previewText: this.previewText,
        previewStableText: this.previewStableText,
        previewUnstableText: this.previewUnstableText,
        endpointReason: this.endpointReason,
        committedTail
      })
    )
  }

  private emitPartialResult(): void {
    const visibleBase = this.getVisibleBaseText()
    const combined = mergeText(visibleBase, this.previewText).trim()
    const currentSegment = this.buildCurrentLiveSegment()
    const segments = this.buildCommittedSegments()

    const result: PartialResult = {
      segments,
      currentSegment,
      currentWordTimings:
        this.currentWordTimings.length > 0 ? [...this.currentWordTimings] : undefined,
      combined,
      currentSpeaker: 0,
      translationEnabled: this.config.translation?.enabled === true
    }

    this.emit('partial', result)
  }

  private buildCommittedSegments(): SpeakerSegment[] {
    return this.completedSegments.map((segment) => ({
      ...segment,
      sentencePairs: segment.sentencePairs ? [...segment.sentencePairs] : undefined,
      wordTimings: segment.wordTimings ? [...segment.wordTimings] : undefined
    }))
  }

  private buildCurrentLiveSegment(): SpeakerSegment | null {
    const liveText = this.previewText.trim()
    if (!liveText) {
      return null
    }

    const liveStableText = this.previewStableText.trim()
    return {
      speaker: 0,
      text: liveText,
      stableText: liveStableText || undefined,
      unstableText: this.previewUnstableText || undefined,
      previewText: this.previewUnstableText || undefined,
      endpointReason: this.endpointReason || undefined,
      wordTimings: this.currentWordTimings.length > 0 ? [...this.currentWordTimings] : undefined,
      isFinal: false
    }
  }
}
