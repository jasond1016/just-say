import { EventEmitter } from 'events'
import { LocalRecognizer } from './local'
import { SpeakerSegment, PartialResult, SentencePair } from './streaming-soniox'
import { VADState } from './vad-utils'
import { findTextOverlap, mergeText } from './text-utils'
import { TextCorrectionConfig } from './text-corrections'
import { shouldFlushSentenceByBoundary } from './commit-boundary'

interface LocalTranslationConfig {
  enabled: boolean
  targetLanguage: string
  translator?: (text: string, targetLanguage: string) => Promise<string>
  batchTranslator?: (texts: string[], targetLanguage: string) => Promise<string[]>
  batchWindowMs?: number
  maxBatchItems?: number
}

export interface StreamingLocalConfig {
  mode?: 'auto' | 'streaming' | 'http_chunk'
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
  textCorrections?: TextCorrectionConfig
  segmentation?: {
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
  translation?: LocalTranslationConfig
}

/**
 * Local/remote local ASR streaming adapter for meeting transcription.
 *
 * It buffers PCM chunks, performs endpointing with simple VAD + silence timing,
 * then sends finalized chunks to LocalRecognizer (HTTP server path).
 */
export class StreamingLocalRecognizer extends EventEmitter {
  private config: Required<Omit<StreamingLocalConfig, 'translation' | 'textCorrections'>> & {
    textCorrections?: TextCorrectionConfig
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
  private pendingTranslationPairIndices: number[] = []
  private translationBatchTimer: NodeJS.Timeout | null = null
  private liveSentenceTail = ''
  private previewText = ''
  private pendingHypothesis = ''
  private lastHypothesisUpdateAt = 0

  private readonly SILENCE_THRESHOLD_MS = 700
  private readonly MIN_CHUNK_DURATION_MS = 1200
  private readonly MAX_CHUNK_DURATION_MS = 6000
  private readonly OVERLAP_AUDIO_MS = 360
  private readonly STABILITY_FORCE_COMMIT_CHARS = 20
  private readonly STABILITY_MIN_BOUNDARY_CHARS = 6
  private readonly STABILITY_REPLACE_COMMIT_MIN_COMMON_CHARS = 2
  private readonly HYPOTHESIS_FINALIZE_SILENCE_MS = 1200
  private readonly HYPOTHESIS_FINALIZE_IDLE_MS = 220
  private readonly DEFAULT_TRANSLATION_BATCH_WINDOW_MS = 450
  private readonly DEFAULT_TRANSLATION_MAX_BATCH_ITEMS = 6
  private readonly JAPANESE_CONTINUATION_PARTICLES = new Set([
    'は',
    'が',
    'を',
    'に',
    'で',
    'と',
    'へ',
    'も',
    'の'
  ])

  constructor(config?: StreamingLocalConfig) {
    super()
    this.config = {
      mode: 'auto',
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
      segmentation: {},
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
      },
      segmentation: {
        ...(this.config.segmentation || {}),
        ...(config.segmentation || {})
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
      nextConfig.sampleRate !== this.config.sampleRate ||
      JSON.stringify(nextConfig.textCorrections || null) !==
        JSON.stringify(this.config.textCorrections || null)

    this.config = nextConfig

    if (recognizerRuntimeChanged) {
      this.recognizer = this.createLocalRecognizer()
      this.preConnected = false
    }
    this.pendingTranslationPairIndices = []
    this.clearTranslationBatchTimer()
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
    this.liveSentenceTail = ''
    this.previewText = ''
    this.pendingHypothesis = ''
    this.lastHypothesisUpdateAt = 0
    this.translationQueue = Promise.resolve()
    this.pendingTranslationPairIndices = []
    this.clearTranslationBatchTimer()
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
    const forcedPairIndex = this.commitPendingHypothesis(true)
    if (forcedPairIndex !== null) {
      this.translatePairAsync(forcedPairIndex)
    }
    const finalPairIndex = this.flushPendingSentencePair()
    if (finalPairIndex !== null) {
      this.translatePairAsync(finalPairIndex)
    }
    this.flushPendingTranslationBatch()
    await this.translationQueue

    this.isActive = false

    const text = this.normalizeJapaneseSpacing(
      mergeText(this.confirmedText, this.previewText)
    ).trim()
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
    this.liveSentenceTail = ''
    this.previewText = ''
    this.pendingHypothesis = ''
    this.lastHypothesisUpdateAt = 0
    this.pendingTranslationPairIndices = []
    this.clearTranslationBatchTimer()
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
      textCorrections: this.config.textCorrections,
      useHttpServer: true
    })
  }

  private async maybeProcessFinal(force = false): Promise<void> {
    if (!this.isActive || this.processingChunk) return

    if (this.pendingAudioBytes === 0) {
      const pairIndex = this.commitPendingHypothesis(force)
      if (pairIndex !== null) {
        this.emitPartialResult()
        this.translatePairAsync(pairIndex)
      }
      return
    }

    if (!force && this.pendingNewAudioBytes === 0) {
      const pairIndex = this.commitPendingHypothesis(false)
      if (pairIndex !== null) {
        this.emitPartialResult()
        this.translatePairAsync(pairIndex)
      }
      return
    }
    if (!force && this.bufferStartTime === 0) return

    const pendingDurationMs = this.getDurationMsFromBytes(this.pendingNewAudioBytes)
    const silenceDurationMs = Date.now() - this.lastSpeechTime
    const inSilence = this.vadState.isInSilence()

    const shouldProcess =
      force ||
      pendingDurationMs >= this.MAX_CHUNK_DURATION_MS ||
      (pendingDurationMs >= this.MIN_CHUNK_DURATION_MS &&
        inSilence &&
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
      let pairIndex: number | null = null
      if (chunkText) {
        const hypothesisTail = this.buildHypothesisTail(chunkText)
        const committedText = this.updateHypothesis(hypothesisTail, force)
        if (committedText) {
          pairIndex = this.commitRecognizedText(committedText)
        }
      } else if (force) {
        pairIndex = this.commitPendingHypothesis(true)
      } else {
        pairIndex = this.commitPendingHypothesis(false)
      }

      if (!chunkText && force && pairIndex === null) {
        this.previewText = ''
        this.pendingHypothesis = ''
      }

      if (chunkText || pairIndex !== null) {
        this.emitPartialResult()
        if (pairIndex !== null) {
          this.translatePairAsync(pairIndex)
        }
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

  private buildHypothesisTail(nextText: string): string {
    const normalizedInput = this.normalizeJapaneseSpacing(nextText).trim()
    if (!normalizedInput) {
      return ''
    }

    if (!this.confirmedText) {
      return normalizedInput
    }

    const overlap = findTextOverlap(this.confirmedText, normalizedInput, 160)
    let deduped = overlap > 0 ? normalizedInput.slice(overlap) : normalizedInput
    if (overlap === 0) {
      deduped = this.trimLoosePrefixDuplicate(this.confirmedText, deduped)
    }

    let normalized = deduped.trimStart()
    normalized = this.dropLeadingPunctuationAfterBoundary(this.confirmedText, normalized)
    return this.normalizeJapaneseSpacing(normalized)
  }

  private updateHypothesis(nextHypothesis: string, forceCommit = false): string {
    const normalizedNext = this.normalizeJapaneseSpacing(nextHypothesis).trimStart()
    this.lastHypothesisUpdateAt = Date.now()

    if (forceCommit) {
      const forced = normalizedNext || this.pendingHypothesis
      this.pendingHypothesis = ''
      this.previewText = ''
      return forced
    }

    if (!normalizedNext) {
      return ''
    }

    if (!this.pendingHypothesis) {
      this.pendingHypothesis = normalizedNext
      this.previewText = normalizedNext
      return ''
    }

    const stablePrefix = this.getCommonPrefix(this.pendingHypothesis, normalizedNext)
    const commitCandidate = this.trimToStableCommitBoundary(stablePrefix)
    if (!commitCandidate) {
      const stableCommonChars = this.getMeaningfulCharCount(stablePrefix)
      if (stableCommonChars < this.STABILITY_REPLACE_COMMIT_MIN_COMMON_CHARS) {
        const commitBeforeReplace =
          this.trimToStableCommitBoundary(this.pendingHypothesis) || this.pendingHypothesis
        this.pendingHypothesis = normalizedNext
        this.previewText = normalizedNext
        return commitBeforeReplace
      }
      this.pendingHypothesis = normalizedNext
      this.previewText = normalizedNext
      return ''
    }

    const committedChars = this.getCharLength(commitCandidate)
    this.pendingHypothesis = this.normalizeJapaneseSpacing(
      this.dropByCharCount(normalizedNext, committedChars).trimStart()
    )
    this.previewText = this.pendingHypothesis
    return commitCandidate
  }

  private commitPendingHypothesis(forceCommit: boolean): number | null {
    if (!this.pendingHypothesis.trim()) {
      return null
    }

    if (!forceCommit) {
      const silenceDurationMs = Date.now() - this.lastSpeechTime
      const idleDurationMs = Date.now() - this.lastHypothesisUpdateAt
      if (
        silenceDurationMs < this.HYPOTHESIS_FINALIZE_SILENCE_MS ||
        idleDurationMs < this.HYPOTHESIS_FINALIZE_IDLE_MS
      ) {
        return null
      }
    }

    const pending = this.pendingHypothesis
    this.pendingHypothesis = ''
    this.previewText = ''
    return this.commitRecognizedText(pending)
  }

  private commitRecognizedText(text: string): number | null {
    const appended = this.appendCommittedText(text)
    if (!appended) {
      return null
    }

    this.liveSentenceTail = this.normalizeJapaneseSpacing(
      mergeText(this.liveSentenceTail, appended)
    )
    if (this.shouldFlushSentence(this.liveSentenceTail)) {
      return this.flushPendingSentencePair()
    }
    return null
  }

  private appendCommittedText(nextText: string): string {
    const normalizedInput = this.normalizeJapaneseSpacing(nextText).trim()
    if (!normalizedInput) {
      return ''
    }

    if (!this.confirmedText) {
      const first = normalizedInput
      this.confirmedText = first
      return first
    }

    let normalized = normalizedInput.trimStart()
    normalized = this.dropLeadingPunctuationAfterBoundary(this.confirmedText, normalized)
    if (!normalized) {
      return ''
    }

    const overlap = findTextOverlap(this.confirmedText, normalized, 160)
    let deduped = overlap > 0 ? normalized.slice(overlap) : normalized
    if (overlap === 0) {
      deduped = this.trimLoosePrefixDuplicate(this.confirmedText, deduped)
    }
    const committed = this.normalizeJapaneseSpacing(deduped)
    if (!committed) return ''

    this.confirmedText = this.normalizeJapaneseSpacing(mergeText(this.confirmedText, committed))
    return committed
  }

  private getCommonPrefix(left: string, right: string): string {
    if (!left || !right) {
      return ''
    }

    const leftChars = Array.from(left)
    const rightChars = Array.from(right)
    const limit = Math.min(leftChars.length, rightChars.length)
    let index = 0
    while (index < limit && leftChars[index] === rightChars[index]) {
      index += 1
    }
    if (index <= 0) {
      return ''
    }
    return leftChars.slice(0, index).join('')
  }

  private trimToStableCommitBoundary(text: string): string {
    const normalized = this.normalizeJapaneseSpacing(text).trimEnd()
    if (!normalized) {
      return ''
    }

    const meaningfulChars = this.getMeaningfulCharCount(normalized)
    if (meaningfulChars === 0) {
      return ''
    }

    if (/[。！？!?]$/.test(normalized) && meaningfulChars >= 2) {
      return normalized
    }

    const boundaryChars = this.findLastBoundaryCharCount(normalized)
    if (boundaryChars > 0) {
      const boundaryCommitted = this.takeByCharCount(normalized, boundaryChars).trimEnd()
      if (this.getMeaningfulCharCount(boundaryCommitted) >= this.STABILITY_MIN_BOUNDARY_CHARS) {
        return boundaryCommitted
      }
    }

    if (meaningfulChars >= this.STABILITY_FORCE_COMMIT_CHARS) {
      return normalized
    }

    return ''
  }

  private findLastBoundaryCharCount(text: string): number {
    let lastBoundary = 0
    const chars = Array.from(text)
    for (let i = 0; i < chars.length; i += 1) {
      if (/[\s,，、。！？!?;；:：]/u.test(chars[i])) {
        lastBoundary = i + 1
      }
    }
    return lastBoundary
  }

  private getCharLength(text: string): number {
    return Array.from(text).length
  }

  private takeByCharCount(text: string, count: number): string {
    if (count <= 0) {
      return ''
    }
    const chars = Array.from(text)
    if (count >= chars.length) {
      return text
    }
    return chars.slice(0, count).join('')
  }

  private dropByCharCount(text: string, count: number): string {
    if (count <= 0) {
      return text
    }
    const chars = Array.from(text)
    if (count >= chars.length) {
      return ''
    }
    return chars.slice(count).join('')
  }

  private normalizeJapaneseSpacing(text: string): string {
    if (!text) {
      return text
    }

    return text
      .replace(
        /([\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])[ \t\u3000]+([\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/gu,
        '$1$2'
      )
      .replace(
        /([\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])[ \t\u3000]+([。、「」『』（）！？、])/gu,
        '$1$2'
      )
      .replace(
        /([。、「」『』（）！？、])[ \t\u3000]+([\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/gu,
        '$1$2'
      )
  }

  private trimLoosePrefixDuplicate(left: string, right: string): string {
    if (!left || !right) {
      return right
    }

    const maxMeaningfulChars = Math.min(
      20,
      this.getMeaningfulCharCount(left),
      this.getMeaningfulCharCount(right)
    )
    for (let size = maxMeaningfulChars; size >= 2; size--) {
      const tail = this.getMeaningfulTail(left, size)
      if (tail.length !== size) {
        continue
      }
      const prefix = this.getMeaningfulPrefix(right, size)
      if (!prefix || prefix.value !== tail) {
        continue
      }
      return right.slice(prefix.endIndex)
    }

    return right
  }

  private getMeaningfulTail(text: string, size: number): string {
    if (!text || size <= 0) {
      return ''
    }

    const chars = Array.from(text)
    const matched: string[] = []
    for (let i = chars.length - 1; i >= 0; i--) {
      const ch = chars[i]
      if (!this.isMeaningfulChar(ch)) {
        continue
      }
      matched.push(ch)
      if (matched.length >= size) {
        break
      }
    }

    return matched.reverse().join('')
  }

  private getMeaningfulPrefix(
    text: string,
    size: number
  ): {
    value: string
    endIndex: number
  } | null {
    if (!text || size <= 0) {
      return null
    }

    let index = 0
    let value = ''
    while (index < text.length && value.length < size) {
      const codePoint = text.codePointAt(index)
      if (codePoint === undefined) {
        break
      }
      const ch = String.fromCodePoint(codePoint)
      index += ch.length
      if (this.isMeaningfulChar(ch)) {
        value += ch
      }
    }

    if (value.length < size) {
      return null
    }
    return {
      value,
      endIndex: index
    }
  }

  private dropLeadingPunctuationAfterBoundary(left: string, right: string): string {
    if (!left || !right) {
      return right
    }
    if (!/[\p{P}\p{S}]$/u.test(left)) {
      return right
    }
    return right.replace(/^[\p{P}\p{S}\s]+/u, '')
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
        if (!this.isActive || !translated) {
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
        console.warn('[StreamingLocal] Chunk translation failed:', err.message)
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
        console.warn('[StreamingLocal] Batch translation failed:', err.message)
        this.emit('translationError', err)
      })
  }

  private shouldFlushSentence(sentence: string): boolean {
    return shouldFlushSentenceByBoundary(sentence, false)
  }

  private flushPendingSentencePair(): number | null {
    const finalized = this.normalizeJapaneseSpacing(this.liveSentenceTail).trim()
    this.liveSentenceTail = ''
    if (!finalized) {
      return null
    }

    const mergedPairIndex = this.mergeSuspiciousBoundaryWithPreviousPair(finalized)
    if (mergedPairIndex !== null) {
      return mergedPairIndex
    }

    return this.sentencePairs.push({ original: finalized }) - 1
  }

  private shouldTranslateText(text: string): boolean {
    const normalized = text.trim()
    if (!normalized) {
      return false
    }

    // Skip chunks that are just punctuation/symbols to avoid noisy translations.
    return Array.from(normalized).some((ch) => this.isMeaningfulChar(ch))
  }

  private getMeaningfulCharCount(text: string): number {
    let count = 0
    for (const ch of Array.from(text)) {
      if (this.isMeaningfulChar(ch)) {
        count += 1
      }
    }
    return count
  }

  private isMeaningfulChar(ch: string): boolean {
    return /[\p{L}\p{N}\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff]/u.test(ch)
  }

  private isHanChar(ch: string): boolean {
    return /\p{Script=Han}/u.test(ch)
  }

  private getTailAfterLastBoundary(text: string): string {
    const chars = Array.from(text)
    for (let i = chars.length - 1; i >= 0; i -= 1) {
      if (/[\s,，、。！？!?;；:：]/u.test(chars[i])) {
        return chars.slice(i + 1).join('')
      }
    }
    return text
  }

  private getLeadingMeaningfulChar(text: string): string | null {
    for (const ch of Array.from(text.trimStart())) {
      if (this.isMeaningfulChar(ch)) {
        return ch
      }
    }
    return null
  }

  private getTrailingMeaningfulChar(text: string): string | null {
    const chars = Array.from(text.trimEnd())
    for (let i = chars.length - 1; i >= 0; i -= 1) {
      if (this.isMeaningfulChar(chars[i])) {
        return chars[i]
      }
    }
    return null
  }

  private removeTrailingStrongPunctuation(text: string): string {
    return text.replace(/[。！？!?]+$/u, '').trimEnd()
  }

  private mergeSuspiciousBoundaryWithPreviousPair(nextOriginal: string): number | null {
    if (this.sentencePairs.length === 0) {
      return null
    }

    const prevIndex = this.sentencePairs.length - 1
    const prevPair = this.sentencePairs[prevIndex]
    const prevOriginal = prevPair.original.trim()
    const nextTrimmed = nextOriginal.trim()
    if (!prevOriginal || !nextTrimmed || !/[。！？!?]$/u.test(prevOriginal)) {
      return null
    }

    const prevWithoutPunctuation = this.removeTrailingStrongPunctuation(prevOriginal)
    if (!prevWithoutPunctuation) {
      return null
    }

    const prevTail = this.getTailAfterLastBoundary(prevWithoutPunctuation)
    const prevTailMeaningful = this.getMeaningfulCharCount(prevTail)
    const prevLastMeaningful = this.getTrailingMeaningfulChar(prevWithoutPunctuation)
    const nextFirstMeaningful = this.getLeadingMeaningfulChar(nextTrimmed)
    if (!prevLastMeaningful || !nextFirstMeaningful) {
      return null
    }

    const looksLikeHanCompoundBreak =
      prevTailMeaningful <= 2 &&
      this.isHanChar(prevLastMeaningful) &&
      this.isHanChar(nextFirstMeaningful)
    const looksLikeParticleContinuation =
      this.JAPANESE_CONTINUATION_PARTICLES.has(nextFirstMeaningful)
    if (!looksLikeHanCompoundBreak && !looksLikeParticleContinuation) {
      return null
    }

    const mergedOriginal = this.normalizeJapaneseSpacing(
      mergeText(prevWithoutPunctuation, nextTrimmed)
    ).trim()
    if (!mergedOriginal) {
      return null
    }

    this.sentencePairs[prevIndex] = {
      ...prevPair,
      original: mergedOriginal,
      translated: undefined
    }
    this.rebuildConfirmedTranslation()
    return prevIndex
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
    const combined = this.normalizeJapaneseSpacing(
      mergeText(this.confirmedText, this.previewText)
    ).trim()
    const translated = this.confirmedTranslation.trim()
    const currentSegment: SpeakerSegment | null = combined
      ? {
          speaker: 0,
          text: combined,
          translatedText: translated || undefined,
          sentencePairs: this.buildLiveSentencePairs(),
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

  private buildLiveSentencePairs(): SentencePair[] | undefined {
    const pairs: SentencePair[] = [...this.sentencePairs]
    const livePairText = mergeText(this.liveSentenceTail, this.previewText).trim()
    if (livePairText) {
      pairs.push({ original: livePairText })
    }
    return pairs.length > 0 ? pairs : undefined
  }
}
