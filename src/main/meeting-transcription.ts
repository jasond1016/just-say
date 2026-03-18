import { EventEmitter } from 'events'
import type {
  MeetingTranscriptEvent,
  PartialResult,
  SpeakerSegment,
  TranscriptSource
} from '../shared/transcription-types'
import { StreamingSonioxRecognizer, StreamingSonioxConfig } from './recognition/streaming-soniox'
import { StreamingGroqRecognizer, StreamingGroqConfig } from './recognition/streaming-groq'
import { StreamingLocalRecognizer, StreamingLocalConfig } from './recognition/streaming-local'
import {
  StreamingLocalWsRecognizer,
  StreamingLocalWsConfig
} from './recognition/streaming-local-ws'
import type { MeetingTranslationMetricsSnapshot } from './translation/service'
import { profiler } from './utils/profiler'

export type MeetingBackend = 'local' | 'soniox' | 'groq'

type Recognizer =
  | StreamingSonioxRecognizer
  | StreamingGroqRecognizer
  | StreamingLocalRecognizer
  | StreamingLocalWsRecognizer

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

export interface TranscriptSegment extends MeetingTranscriptEvent {
  source?: TranscriptSource
}

export type MeetingStatus = 'idle' | 'starting' | 'transcribing' | 'stopping' | 'error'

export type ExternalTranslator = (text: string, targetLanguage: string) => Promise<string>
export type ExternalBatchTranslator = (texts: string[], targetLanguage: string) => Promise<string[]>
export type ExternalTranslationMetricsProvider = (options?: {
  reset?: boolean
}) => MeetingTranslationMetricsSnapshot | null

interface LocalTranslationBatchConfig {
  batchWindowMs?: number
  maxBatchItems?: number
}

/**
 * Manages meeting transcription by receiving system audio from renderer process
 * and sending it to the speech recognition service.
 *
 * Note: Both system audio and microphone capture are now done in the renderer process
 * using Web APIs (desktopCapturer and getUserMedia) and sent to main process via IPC.
 * This avoids the need for ffmpeg.
 */
export class MeetingTranscriptionManager extends EventEmitter {
  private static readonly PRECONNECT_WAIT_TIMEOUT_MS = 2500

  private pendingPartialDispatchBySource: Partial<
    Record<
      TranscriptSource,
      {
        recognizer: Recognizer
        result: PartialResult
      }
    >
  > = {}
  private partialDispatchScheduled = false
  private preConnectAttemptId = 0

  private preconnectedRecognizer: Recognizer | null = null
  private recognizers: Partial<Record<TranscriptSource, Recognizer>> = {}
  private partialStateBySource: Partial<Record<TranscriptSource, PartialResult>> = {}
  private currentSegmentTimestampBySource: Partial<Record<TranscriptSource, number | null>> = {}
  private segmentTimestampCache = new Map<string, number>()
  private backend: MeetingBackend
  private sonioxConfig?: StreamingSonioxConfig
  private groqConfig?: StreamingGroqConfig
  private localConfig?: StreamingLocalConfig
  private externalTranslator?: ExternalTranslator
  private externalBatchTranslator?: ExternalBatchTranslator
  private localTranslationBatchConfig?: LocalTranslationBatchConfig
  private translationMetricsProvider?: ExternalTranslationMetricsProvider

  private status: MeetingStatus = 'idle'
  private preConnectPromise: Promise<void> | null = null
  private transcriptHistory: TranscriptSegment[] = []
  private lastTextLength = 0
  private lastTranslatedTextLength = 0
  private maxSentencePairsSeen = 0
  private maxTranslatedSentencePairsSeen = 0

  // Flag to track if we're using renderer audio
  private usingRendererAudio = false

  // Flag to track if we're using microphone from renderer
  private usingMicrophone = false

  constructor(
    backend: MeetingBackend,
    sonioxConfig?: StreamingSonioxConfig,
    groqConfig?: StreamingGroqConfig,
    localConfig?: StreamingLocalConfig,
    externalTranslator?: ExternalTranslator,
    externalBatchTranslator?: ExternalBatchTranslator,
    localTranslationBatchConfig?: LocalTranslationBatchConfig,
    translationMetricsProvider?: ExternalTranslationMetricsProvider
  ) {
    super()
    this.backend = backend
    this.sonioxConfig = sonioxConfig
    this.groqConfig = groqConfig
    this.localConfig = localConfig
    this.externalTranslator = externalTranslator
    this.externalBatchTranslator = externalBatchTranslator
    this.localTranslationBatchConfig = localTranslationBatchConfig
    this.translationMetricsProvider = translationMetricsProvider
  }

  /**
   * Pre-connect to the recognition service to reduce startup latency.
   * Call this when the meeting window opens or before user starts transcription.
   */
  async preConnect(): Promise<void> {
    if (this.preconnectedRecognizer?.isPreConnected()) {
      console.log('[MeetingTranscription] Already pre-connected')
      return
    }
    if (this.preConnectPromise) {
      await this.preConnectPromise
      return
    }

    const attemptId = ++this.preConnectAttemptId
    const promise = this.doPreConnect(attemptId).finally(() => {
      if (this.preConnectPromise === promise) {
        this.preConnectPromise = null
      }
    })
    this.preConnectPromise = promise
    await promise
  }

  private async createLocalRecognizerWithFallback(
    localConfig: StreamingLocalConfig | undefined,
    wsConfig: StreamingLocalWsConfig
  ): Promise<{
    recognizer: StreamingLocalWsRecognizer | StreamingLocalRecognizer
    preConnected: boolean
  }> {
    const mode = localConfig?.mode || 'auto'
    if (mode !== 'http_chunk') {
      const wsRecognizer = new StreamingLocalWsRecognizer(wsConfig)
      try {
        await wsRecognizer.preConnect()
        return { recognizer: wsRecognizer, preConnected: true }
      } catch (error) {
        if (mode === 'streaming') {
          throw error
        }
        console.warn(
          '[MeetingTranscription] WS pre-connect unavailable, fallback to HTTP chunk mode:',
          error
        )
      }
    }
    return { recognizer: new StreamingLocalRecognizer(localConfig), preConnected: false }
  }

  private async doPreConnect(attemptId: number): Promise<void> {
    if (this.preconnectedRecognizer?.isPreConnected()) {
      return
    }

    console.log(`[MeetingTranscription] Pre-connecting to ${this.backend} recognition service...`)

    // Create appropriate recognizer based on backend
    let recognizer: Recognizer
    let alreadyPreConnected = false
    if (this.backend === 'groq') {
      recognizer = new StreamingGroqRecognizer(this.groqConfig)
    } else if (this.backend === 'local') {
      const result = await this.createLocalRecognizerWithFallback(this.localConfig, {
        ...this.localConfig
      })
      recognizer = result.recognizer
      alreadyPreConnected = result.preConnected
    } else {
      recognizer = new StreamingSonioxRecognizer(this.sonioxConfig)
    }

    // Set up error handler for pre-connection
    recognizer.on('error', (err: Error) => {
      console.error('[MeetingTranscription] Pre-connect error:', err)
    })

    try {
      if (!alreadyPreConnected) {
        await recognizer.preConnect()
      }
      const canAdoptRecognizer =
        attemptId === this.preConnectAttemptId &&
        this.status === 'idle' &&
        (!this.preconnectedRecognizer || !this.preconnectedRecognizer.isSessionActive())

      if (canAdoptRecognizer) {
        this.preconnectedRecognizer?.close()
        this.preconnectedRecognizer = recognizer
        console.log('[MeetingTranscription] Pre-connected successfully')
      } else {
        recognizer.close()
        console.log('[MeetingTranscription] Pre-connect finished for stale recognizer')
      }
    } catch (err) {
      console.error('[MeetingTranscription] Pre-connect failed:', err)
      recognizer.close()
      throw err
    }
  }

  private async waitForInFlightPreconnect(): Promise<void> {
    if (!this.preConnectPromise) {
      return
    }

    const preConnectPromise = this.preConnectPromise
    let timedOut = false
    let failed = false
    const waitStartAt = Date.now()
    let timeout: NodeJS.Timeout | null = null

    try {
      await Promise.race([
        preConnectPromise,
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            timedOut = true
            resolve()
          }, MeetingTranscriptionManager.PRECONNECT_WAIT_TIMEOUT_MS)
        })
      ])
    } catch (err) {
      failed = true
      console.warn(
        '[MeetingTranscription] In-flight pre-connect failed, fallback to cold start:',
        err
      )
    } finally {
      if (timeout) {
        clearTimeout(timeout)
      }
    }

    const preconnectWaitMs = Date.now() - waitStartAt
    console.log(
      '[MeetingTranscription] Pre-connect wait:',
      JSON.stringify({
        preconnectWaitMs,
        preconnectTimedOut: timedOut,
        continuedWithColdStart: timedOut || failed
      })
    )

    if (timedOut) {
      void preConnectPromise.catch((err) => {
        console.warn('[MeetingTranscription] Background pre-connect failed after timeout:', err)
      })
    }
  }

  /**
   * Check if pre-connected and ready
   */
  isPreConnected(): boolean {
    return this.preconnectedRecognizer?.isPreConnected() ?? false
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

  private getRequestedSources(includeMicrophone: boolean): TranscriptSource[] {
    return includeMicrophone ? ['system', 'microphone'] : ['system']
  }

  private async createRecognizerForSource(
    source: TranscriptSource,
    options: MeetingTranscriptionOptions,
    useExternalTranslation: boolean
  ): Promise<Recognizer> {
    if (this.backend === 'groq') {
      const recognizerConfig: StreamingGroqConfig = {
        ...this.groqConfig,
        translation: useExternalTranslation
          ? { enabled: true, targetLanguage: options.targetLanguage! }
          : undefined,
        externalTranslator: useExternalTranslation ? this.externalTranslator : undefined
      }
      return new StreamingGroqRecognizer(recognizerConfig)
    }

    if (this.backend === 'local') {
      const recognizerConfig: StreamingLocalConfig = {
        ...this.localConfig,
        translation: useExternalTranslation
          ? {
              enabled: true,
              targetLanguage: options.targetLanguage!,
              translator: this.externalTranslator,
              batchTranslator: this.externalBatchTranslator,
              batchWindowMs: this.localTranslationBatchConfig?.batchWindowMs,
              maxBatchItems: this.localTranslationBatchConfig?.maxBatchItems
            }
          : undefined
      }
      const wsConfig: StreamingLocalWsConfig = {
        ...recognizerConfig,
        translation: recognizerConfig.translation
      }
      if (source === 'system') {
        if (
          this.preconnectedRecognizer instanceof StreamingLocalWsRecognizer &&
          this.preconnectedRecognizer.isPreConnected()
        ) {
          this.preconnectedRecognizer.updateConfig(wsConfig)
          return this.preconnectedRecognizer
        }
        if (
          recognizerConfig.mode === 'http_chunk' &&
          this.preconnectedRecognizer instanceof StreamingLocalRecognizer &&
          this.preconnectedRecognizer.isPreConnected()
        ) {
          this.preconnectedRecognizer.updateConfig(recognizerConfig)
          return this.preconnectedRecognizer
        }
      }
      const result = await this.createLocalRecognizerWithFallback(recognizerConfig, wsConfig)
      return result.recognizer
    }

    const recognizerConfig: StreamingSonioxConfig = {
      ...this.sonioxConfig,
      translation:
        options.translationEnabled && options.targetLanguage
          ? { enabled: true, targetLanguage: options.targetLanguage }
          : undefined
    }
    if (
      source === 'system' &&
      this.preconnectedRecognizer instanceof StreamingSonioxRecognizer &&
      this.preconnectedRecognizer.isPreConnected()
    ) {
      this.preconnectedRecognizer.updateConfig(recognizerConfig)
      return this.preconnectedRecognizer
    }
    return new StreamingSonioxRecognizer(recognizerConfig)
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
    this.pendingPartialDispatchBySource = {}
    this.partialDispatchScheduled = false
    this.partialStateBySource = {}
    this.currentSegmentTimestampBySource = {}
    this.segmentTimestampCache.clear()
    this.recognizers = {}
    this.lastTextLength = 0
    this.lastTranslatedTextLength = 0
    this.maxSentencePairsSeen = 0
    this.maxTranslatedSentencePairsSeen = 0
    this.translationMetricsProvider?.({ reset: true })

    try {
      // If pre-connect is currently in flight, wait briefly then continue with cold start.
      await this.waitForInFlightPreconnect()

      // Start profiling session
      profiler.startSession(this.backend)

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

      const sources = this.getRequestedSources(options.includeMicrophone)
      for (const source of sources) {
        this.recognizers[source] = await this.createRecognizerForSource(
          source,
          options,
          useExternalTranslation
        )
      }

      for (const source of sources) {
        const recognizer = this.recognizers[source]
        if (!recognizer) {
          throw new Error(`Recognizer initialization failed for ${source}`)
        }

        recognizer.removeAllListeners('partial')
        recognizer.removeAllListeners('error')

        recognizer.on('partial', (result: PartialResult) => {
          this.queuePartialDispatch(source, recognizer, result)
        })

        recognizer.on('error', (err: Error) => {
          console.error(`[MeetingTranscription] Recognizer error (${source}):`, err)
          this.emit('error', err)
        })
      }

      profiler.markConnectionStart()
      await Promise.all(
        sources.map(async (source) => {
          const recognizer = this.recognizers[source]
          if (!recognizer) {
            throw new Error(`Recognizer missing for ${source}`)
          }
          await recognizer.startSession()
        })
      )
      profiler.markConnectionEstablished()
      console.log('[MeetingTranscription] Recognizer sessions started')

      this.usingRendererAudio = true
      this.usingMicrophone = options.includeMicrophone

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
      this.usingRendererAudio = false
      this.usingMicrophone = false

      const activeSources = (Object.keys(this.recognizers) as TranscriptSource[]).filter(
        (source) => this.recognizers[source]
      )
      const resultEntries = await Promise.all(
        activeSources.map(async (source) => {
          const recognizer = this.recognizers[source]
          if (!recognizer) {
            return null
          }
          const result = await recognizer.endSession()
          return { source, recognizer, result }
        })
      )

      const finalSegments = resultEntries
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .flatMap((entry) => this.buildSegmentsFromRecognizerResult(entry.source, entry.result))

      if (finalSegments.length > 0) {
        const orderedFinalSegments = this.sortSegments(finalSegments)
        const finalSegment: TranscriptSegment = {
          text: orderedFinalSegments
            .map((segment) => segment.text)
            .join('')
            .trim(),
          translatedText:
            orderedFinalSegments
              .map((segment) => segment.translatedText || '')
              .join('')
              .trim() || undefined,
          timestamp: Date.now(),
          isFinal: true,
          source: undefined,
          speakerSegments: orderedFinalSegments,
          currentSpeakerSegment: null,
          translationEnabled: orderedFinalSegments.some((segment) => !!segment.translatedText)
        }
        this.transcriptHistory = [finalSegment]
        this.emit('transcript', finalSegment)
      }

      const systemRecognizer = this.recognizers.system || null
      const keepWarmRecognizer =
        systemRecognizer instanceof StreamingLocalRecognizer ||
        systemRecognizer instanceof StreamingLocalWsRecognizer ||
        systemRecognizer instanceof StreamingGroqRecognizer
      if (keepWarmRecognizer) {
        this.preconnectedRecognizer = systemRecognizer
      } else {
        this.preconnectedRecognizer = null
      }

      for (const source of activeSources) {
        const recognizer = this.recognizers[source]
        if (!recognizer || recognizer === this.preconnectedRecognizer) {
          continue
        }
        recognizer.close()
      }
      this.recognizers = {}
      this.partialStateBySource = {}
      this.currentSegmentTimestampBySource = {}

      profiler.markSentencePairMetrics({
        sentencePairs: this.maxSentencePairsSeen,
        translatedSentencePairs: this.maxTranslatedSentencePairsSeen
      })
      const translationMetrics = this.translationMetricsProvider?.({ reset: true })
      if (translationMetrics) {
        profiler.markMeetingTranslationMetrics(translationMetrics)
      }

      // Print profiling report
      profiler.printReport()
      profiler.endSession()

      console.log('[MeetingTranscription] Stopped successfully')
    } catch (err) {
      console.error('[MeetingTranscription] Stop error:', err)
    } finally {
      this.setStatus('idle')
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

  private buildSegmentTimestampCacheKey(
    source: TranscriptSource,
    segment: SpeakerSegment,
    occurrenceIndex: number
  ): string {
    return `${source}|${occurrenceIndex}|${segment.speaker}|${segment.text}|${segment.timestamp ?? 'na'}`
  }

  private withSource(
    source: TranscriptSource,
    segment: SpeakerSegment,
    fallbackTimestamp: number,
    occurrenceIndex: number
  ): SpeakerSegment {
    const cacheKey = this.buildSegmentTimestampCacheKey(source, segment, occurrenceIndex)
    const timestamp =
      segment.timestamp ?? this.segmentTimestampCache.get(cacheKey) ?? fallbackTimestamp
    this.segmentTimestampCache.set(cacheKey, timestamp)
    return {
      ...segment,
      source,
      timestamp
    }
  }

  private tagSegments(
    source: TranscriptSource,
    segments: SpeakerSegment[],
    currentSegment?: SpeakerSegment | null
  ): SpeakerSegment[] {
    const baseTimestamp = Date.now()
    const taggedFinalSegments = segments.map((segment, index) =>
      this.withSource(source, segment, baseTimestamp + index, index)
    )
    if (currentSegment?.text?.trim()) {
      const nextTimestamp = this.currentSegmentTimestampBySource[source] ?? Date.now()
      this.currentSegmentTimestampBySource[source] = nextTimestamp
      return [
        ...taggedFinalSegments,
        {
          ...currentSegment,
          source,
          timestamp: currentSegment.timestamp ?? nextTimestamp
        }
      ]
    }
    if (currentSegment === null) {
      this.currentSegmentTimestampBySource[source] = null
    }
    return taggedFinalSegments
  }

  private buildSegmentsFromRecognizerResult(
    source: TranscriptSource,
    result: {
      segments: SpeakerSegment[]
      currentSegment: SpeakerSegment | null
    }
  ): SpeakerSegment[] {
    return this.tagSegments(source, result.segments, result.currentSegment)
  }

  private sortSegments(segments: SpeakerSegment[]): SpeakerSegment[] {
    return [...segments].sort((left, right) => {
      const leftTimestamp = left.timestamp ?? 0
      const rightTimestamp = right.timestamp ?? 0
      if (leftTimestamp !== rightTimestamp) {
        return leftTimestamp - rightTimestamp
      }
      if ((left.source || '') !== (right.source || '')) {
        return (left.source || '').localeCompare(right.source || '')
      }
      return left.speaker - right.speaker
    })
  }

  private buildMergedCurrentSegment(): SpeakerSegment | null {
    const currentSegments: SpeakerSegment[] = []
    for (const [source, result] of Object.entries(this.partialStateBySource) as Array<
      [TranscriptSource, PartialResult | undefined]
    >) {
      if (!result?.currentSegment?.text?.trim()) {
        this.currentSegmentTimestampBySource[source] = null
        continue
      }
      const nextTimestamp = this.currentSegmentTimestampBySource[source] ?? Date.now()
      this.currentSegmentTimestampBySource[source] = nextTimestamp
      currentSegments.push({
        ...result.currentSegment,
        source,
        timestamp: result.currentSegment.timestamp ?? nextTimestamp
      })
    }

    if (currentSegments.length === 0) {
      return null
    }

    return this.sortSegments(currentSegments)[currentSegments.length - 1]
  }

  private buildMergedCommittedSegments(): SpeakerSegment[] {
    const merged = (
      Object.entries(this.partialStateBySource) as Array<
        [TranscriptSource, PartialResult | undefined]
      >
    ).flatMap(([source, result]) => this.tagSegments(source, result?.segments || []))
    return this.sortSegments(merged)
  }

  private updateMetrics(result: PartialResult): void {
    const translatedLength = result.currentSegment?.translatedText?.length || 0
    const responseType =
      result.combined.length > this.lastTextLength
        ? 'asr'
        : translatedLength > this.lastTranslatedTextLength
          ? 'translation'
          : 'other'
    profiler.markResponseReceived(result.combined.length, this.lastTextLength, responseType)
    this.lastTextLength = result.combined.length
    this.lastTranslatedTextLength = translatedLength

    const sentencePairs = result.currentSegment?.sentencePairs || []
    if (sentencePairs.length > this.maxSentencePairsSeen) {
      this.maxSentencePairsSeen = sentencePairs.length
    }
    const translatedSentencePairs = sentencePairs.filter((pair) => !!pair.translated).length
    if (translatedSentencePairs > this.maxTranslatedSentencePairsSeen) {
      this.maxTranslatedSentencePairsSeen = translatedSentencePairs
    }
  }

  private emitMergedPartialTranscript(): void {
    const speakerSegments = this.buildMergedCommittedSegments()
    const currentSpeakerSegment = this.buildMergedCurrentSegment()
    const orderedVisibleSegments = this.sortSegments(
      currentSpeakerSegment ? [...speakerSegments, currentSpeakerSegment] : speakerSegments
    )
    const segment: TranscriptSegment = {
      text: orderedVisibleSegments
        .map((item) => item.text)
        .join('')
        .trim(),
      translatedText:
        orderedVisibleSegments
          .map((item) => item.translatedText || '')
          .join('')
          .trim() || undefined,
      timestamp: Date.now(),
      isFinal: false,
      source: currentSpeakerSegment?.source,
      speaker: currentSpeakerSegment?.speaker,
      speakerSegments,
      currentSpeakerSegment,
      currentWordTimings: currentSpeakerSegment?.wordTimings,
      translationEnabled: orderedVisibleSegments.some((item) => !!item.translatedText)
    }

    if (this.recognizers.system instanceof StreamingLocalWsRecognizer) {
      console.log(
        '[MeetingTranscription][Debug]',
        JSON.stringify({
          segments: speakerSegments.length,
          segmentTexts: speakerSegments.map((item) => `${item.source}:${item.text}`),
          currentText: currentSpeakerSegment?.text || '',
          currentSource: currentSpeakerSegment?.source || null,
          combined: segment.text
        })
      )
    }

    this.emit('transcript', segment)
  }

  /**
   * Handle audio chunk from renderer process (system audio via desktopCapturer)
   */
  handleRendererAudioChunk(chunk: Buffer): void {
    if (!this.usingRendererAudio || this.status !== 'transcribing') {
      return
    }

    const recognizer = this.recognizers.system
    if (!recognizer) {
      return
    }
    profiler.markAudioSent(chunk.length)
    recognizer.sendAudioChunk(chunk)
  }

  /**
   * Handle microphone audio chunk from renderer process (via getUserMedia)
   */
  handleMicrophoneAudioChunk(chunk: Buffer): void {
    if (!this.usingMicrophone || this.status !== 'transcribing') {
      return
    }

    const recognizer = this.recognizers.microphone
    if (!recognizer) {
      return
    }
    profiler.markAudioSent(chunk.length)
    recognizer.sendAudioChunk(chunk)
  }

  private async cleanup(): Promise<void> {
    this.usingRendererAudio = false
    this.usingMicrophone = false

    for (const source of Object.keys(this.recognizers) as TranscriptSource[]) {
      const recognizer = this.recognizers[source]
      if (!recognizer) {
        continue
      }
      try {
        recognizer.close()
      } catch {
        // Ignore cleanup errors
      }
    }
    this.recognizers = {}
    this.partialStateBySource = {}
    this.pendingPartialDispatchBySource = {}
    this.currentSegmentTimestampBySource = {}
    this.preconnectedRecognizer = null
  }

  private queuePartialDispatch(
    source: TranscriptSource,
    recognizer:
      | StreamingSonioxRecognizer
      | StreamingGroqRecognizer
      | StreamingLocalRecognizer
      | StreamingLocalWsRecognizer,
    result: PartialResult
  ): void {
    this.pendingPartialDispatchBySource[source] = { recognizer, result }
    if (this.partialDispatchScheduled) {
      return
    }

    this.partialDispatchScheduled = true
    queueMicrotask(() => {
      this.partialDispatchScheduled = false
      const pendingEntries = Object.entries(this.pendingPartialDispatchBySource) as Array<
        [TranscriptSource, { recognizer: Recognizer; result: PartialResult }]
      >
      this.pendingPartialDispatchBySource = {}
      let updated = false
      for (const [pendingSource, pending] of pendingEntries) {
        if (!pending || pending.recognizer !== this.recognizers[pendingSource]) {
          continue
        }
        this.partialStateBySource[pendingSource] = pending.result
        this.updateMetrics(pending.result)
        updated = true
      }
      if (updated) {
        this.emitMergedPartialTranscript()
      }
    })
  }
}
