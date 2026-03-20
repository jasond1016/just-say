import { SentencePair, SpeakerSegment } from './streaming-soniox'

export interface LocalTranslationConfig {
  enabled: boolean
  targetLanguage: string
  translator?: (text: string, targetLanguage: string) => Promise<string>
  batchTranslator?: (texts: string[], targetLanguage: string) => Promise<string[]>
  batchWindowMs?: number
  maxBatchItems?: number
}

interface LocalTranslationCoordinatorDeps {
  getConfig: () => LocalTranslationConfig | undefined
  isActive: () => boolean
  getSentencePairs: () => SentencePair[]
  applyTranslation: (pairIndex: number, originalText: string, translated: string) => boolean
  emitPartialResult: () => void
  emitTranslationError: (error: Error) => void
  logPrefix: string
}

export class LocalTranslationCoordinator {
  private translationQueue: Promise<void> = Promise.resolve()
  private pendingTranslationPairIndices: number[] = []
  private translationBatchTimer: NodeJS.Timeout | null = null

  private readonly DEFAULT_TRANSLATION_BATCH_WINDOW_MS = 450
  private readonly DEFAULT_TRANSLATION_MAX_BATCH_ITEMS = 6

  constructor(private readonly deps: LocalTranslationCoordinatorDeps) {}

  reset(): void {
    this.pendingTranslationPairIndices = []
    this.clearTranslationBatchTimer()
    this.translationQueue = Promise.resolve()
  }

  waitForIdle(): Promise<void> {
    return this.translationQueue
  }

  translatePairAsync(pairIndex: number): void {
    const config = this.deps.getConfig()
    if (!config?.enabled || !config.targetLanguage) {
      return
    }

    const originalText = this.deps.getSentencePairs()[pairIndex]?.original?.trim()
    if (!originalText || !hasTranslatableContent(originalText)) {
      return
    }

    if (config.batchTranslator) {
      this.pendingTranslationPairIndices.push(pairIndex)
      if (this.pendingTranslationPairIndices.length >= this.getTranslationMaxBatchItems(config)) {
        this.flushPendingBatch()
      } else {
        this.scheduleTranslationBatchFlush(config)
      }
      return
    }

    const translator = config.translator
    if (!translator) {
      return
    }

    this.translationQueue = this.translationQueue
      .then(async () => {
        const translated = (await translator(originalText, config.targetLanguage))?.trim()
        if (!this.deps.isActive() || !translated) {
          return
        }
        if (this.deps.getSentencePairs()[pairIndex]?.original !== originalText) {
          return
        }
        const changed = this.deps.applyTranslation(pairIndex, originalText, translated)
        if (changed) {
          this.deps.emitPartialResult()
        }
      })
      .catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error))
        console.warn(`[${this.deps.logPrefix}] Translation failed:`, err.message)
        this.deps.emitTranslationError(err)
      })
  }

  flushPendingBatch(): void {
    this.clearTranslationBatchTimer()
    const config = this.deps.getConfig()
    if (!config?.enabled || !config.targetLanguage) {
      this.pendingTranslationPairIndices = []
      return
    }

    const batchTranslator = config.batchTranslator
    if (!batchTranslator || this.pendingTranslationPairIndices.length === 0) {
      return
    }

    const indices = [...this.pendingTranslationPairIndices]
    this.pendingTranslationPairIndices = []
    const items = indices
      .map((index) => ({
        index,
        original: this.deps.getSentencePairs()[index]?.original?.trim() || ''
      }))
      .filter((item) => item.original && hasTranslatableContent(item.original))

    if (items.length === 0) {
      return
    }

    this.translationQueue = this.translationQueue
      .then(async () => {
        const translatedBatch = await batchTranslator(
          items.map((item) => item.original),
          config.targetLanguage
        )
        if (!this.deps.isActive() || translatedBatch.length === 0) {
          return
        }

        let changed = false
        for (let i = 0; i < items.length; i += 1) {
          const translated = (translatedBatch[i] || '').trim()
          if (!translated) continue
          const item = items[i]
          if (this.deps.getSentencePairs()[item.index]?.original !== item.original) {
            continue
          }
          changed = this.deps.applyTranslation(item.index, item.original, translated) || changed
        }
        if (changed) {
          this.deps.emitPartialResult()
        }
      })
      .catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error))
        console.warn(`[${this.deps.logPrefix}] Batch translation failed:`, err.message)
        this.deps.emitTranslationError(err)
      })
  }

  private getTranslationBatchWindowMs(config: LocalTranslationConfig): number {
    const configured = config.batchWindowMs
    if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
      return Math.floor(configured)
    }
    return this.DEFAULT_TRANSLATION_BATCH_WINDOW_MS
  }

  private getTranslationMaxBatchItems(config: LocalTranslationConfig): number {
    const configured = config.maxBatchItems
    if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
      return Math.floor(configured)
    }
    return this.DEFAULT_TRANSLATION_MAX_BATCH_ITEMS
  }

  private scheduleTranslationBatchFlush(config: LocalTranslationConfig): void {
    if (this.translationBatchTimer || this.pendingTranslationPairIndices.length === 0) {
      return
    }
    this.translationBatchTimer = setTimeout(() => {
      this.translationBatchTimer = null
      this.flushPendingBatch()
    }, this.getTranslationBatchWindowMs(config))
  }

  private clearTranslationBatchTimer(): void {
    if (this.translationBatchTimer) {
      clearTimeout(this.translationBatchTimer)
      this.translationBatchTimer = null
    }
  }
}

export function cloneSpeakerSegment(segment: SpeakerSegment): SpeakerSegment {
  return {
    ...segment,
    sentencePairs: segment.sentencePairs ? [...segment.sentencePairs] : undefined,
    wordTimings: segment.wordTimings ? [...segment.wordTimings] : undefined
  }
}

export function hasTranslatableContent(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) {
    return false
  }

  return Array.from(normalized).some((ch) =>
    /[\p{L}\p{N}\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff]/u.test(ch)
  )
}
