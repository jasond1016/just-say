import { AppConfig } from '../config'
import { OpenAICompatibleTranslator } from './openai-compatible'
import {
  MeetingTranslationRateControlConfig,
  MeetingTranslationRateLimiter,
  MeetingTranslationRateLimiterSnapshot
} from './meeting-rate-limiter'

const DEFAULT_PROVIDER = 'openai-compatible'
const DEFAULT_ENDPOINT = 'https://api.openai.com/v1'
const DEFAULT_MODEL = 'gpt-4o-mini'
const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_MEETING_TRANSLATION_RATE_CONTROL: MeetingTranslationRateControlConfig = {
  enabled: true,
  maxRequestsPerMinute: 20,
  maxTokensPerMinute: 40000,
  minRequestIntervalMs: 1200,
  maxQueueSize: 64,
  maxQueueWaitMs: 45000,
  dropPolicy: 'drop_oldest'
}

const MEETING_TRANSLATION_RATE_CONTROL_PRESETS: Record<
  'low-latency' | 'balanced' | 'throughput',
  MeetingTranslationRateControlConfig
> = {
  'low-latency': {
    enabled: true,
    maxRequestsPerMinute: 30,
    maxTokensPerMinute: 30000,
    minRequestIntervalMs: 800,
    maxQueueSize: 48,
    maxQueueWaitMs: 25000,
    dropPolicy: 'drop_newest'
  },
  balanced: {
    ...DEFAULT_MEETING_TRANSLATION_RATE_CONTROL
  },
  throughput: {
    enabled: true,
    maxRequestsPerMinute: 16,
    maxTokensPerMinute: 60000,
    minRequestIntervalMs: 1500,
    maxQueueSize: 96,
    maxQueueWaitMs: 70000,
    dropPolicy: 'drop_oldest'
  }
}

type TranslationRateControlInput = NonNullable<
  NonNullable<NonNullable<AppConfig['recognition']>['translation']>['rateControl']
>

interface TranslationRuntimeConfig {
  provider: 'openai-compatible'
  endpoint: string
  model: string
  timeoutMs: number
  pttEnabled: boolean
  pttTargetLanguage: string
  meetingRateControl: MeetingTranslationRateControlConfig
}

export interface TranslateResult {
  text: string
  translated: boolean
  fallback: boolean
  error?: string
  latencyMs: number
}

export interface MeetingTranslationMetricsSnapshot {
  rateControl: MeetingTranslationRateControlConfig
  limiter: MeetingTranslationRateLimiterSnapshot
}

export class TranslationService {
  private readonly getConfig: () => AppConfig
  private readonly getApiKey: () => string | undefined
  private cachedKey: string | null = null
  private cachedTranslator: OpenAICompatibleTranslator | null = null
  private meetingRateLimiter: MeetingTranslationRateLimiter | null = null
  private meetingRateLimiterKey: string | null = null

  constructor(getConfig: () => AppConfig, getApiKey: () => string | undefined) {
    this.getConfig = getConfig
    this.getApiKey = getApiKey
  }

  isPttEnabled(): boolean {
    return this.getRuntimeConfig().pttEnabled
  }

  getPttTargetLanguage(): string {
    return this.getRuntimeConfig().pttTargetLanguage
  }

  async translateForPtt(text: string): Promise<TranslateResult> {
    const targetLanguage = this.getPttTargetLanguage()
    return this.translate(text, targetLanguage, { context: 'ptt', fallbackToSource: true })
  }

  async translateForMeeting(text: string, targetLanguage: string): Promise<TranslateResult> {
    return this.translate(text, targetLanguage, { context: 'meeting', fallbackToSource: false })
  }

  async translateBatchForMeeting(texts: string[], targetLanguage: string): Promise<string[]> {
    const normalizedItems = texts.map((text) => text.trim())
    const hasMeaningfulText = normalizedItems.some((text) => text.length > 0)
    if (!hasMeaningfulText) {
      return normalizedItems.map(() => '')
    }

    try {
      const translator = this.getTranslator()
      const translated = await this.translateBatchWithRateControl(
        translator,
        normalizedItems,
        targetLanguage
      )
      if (translated.length !== normalizedItems.length) {
        throw new Error(
          `Batch translation size mismatch: expected ${normalizedItems.length}, got ${translated.length}`
        )
      }
      return translated.map((text) => text.trim())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(
        '[Translation] Batch translate failed:',
        JSON.stringify({
          context: 'meeting',
          target_language: targetLanguage,
          size: normalizedItems.length,
          error: message
        })
      )
      return normalizedItems.map(() => '')
    }
  }

  getMeetingTranslationMetricsSnapshot(options?: {
    reset?: boolean
  }): MeetingTranslationMetricsSnapshot | null {
    const runtime = this.getRuntimeConfig()
    if (!runtime.meetingRateControl.enabled) {
      return null
    }

    const limiter = this.getMeetingRateLimiter(runtime.meetingRateControl)
    return {
      rateControl: runtime.meetingRateControl,
      limiter: options?.reset ? limiter.getSnapshotAndReset() : limiter.getSnapshot()
    }
  }

  async translate(
    text: string,
    targetLanguage: string,
    options: {
      context: 'ptt' | 'meeting'
      fallbackToSource: boolean
      sourceLanguage?: string
    }
  ): Promise<TranslateResult> {
    const startAt = Date.now()
    const sourceText = text?.trim()
    if (!sourceText) {
      return {
        text: '',
        translated: false,
        fallback: false,
        latencyMs: 0
      }
    }

    try {
      const translator = this.getTranslator()
      const translated = await this.translateWithRateControl(
        translator,
        sourceText,
        targetLanguage,
        options.context,
        options.sourceLanguage
      )
      return {
        text: translated,
        translated: true,
        fallback: false,
        latencyMs: Date.now() - startAt
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(
        '[Translation] Translate failed:',
        JSON.stringify({
          context: options.context,
          target_language: targetLanguage,
          error: message
        })
      )
      return {
        text: options.fallbackToSource ? sourceText : '',
        translated: false,
        fallback: true,
        error: message,
        latencyMs: Date.now() - startAt
      }
    }
  }

  private getRuntimeConfig(): TranslationRuntimeConfig {
    const config = this.getConfig()
    const translation = config.recognition?.translation

    return {
      provider: (translation?.provider || DEFAULT_PROVIDER) as 'openai-compatible',
      endpoint: (translation?.endpoint || DEFAULT_ENDPOINT).trim(),
      model: (translation?.model || DEFAULT_MODEL).trim(),
      timeoutMs:
        typeof translation?.timeoutMs === 'number' && translation.timeoutMs > 0
          ? translation.timeoutMs
          : DEFAULT_TIMEOUT_MS,
      pttEnabled: translation?.enabledForPtt === true,
      pttTargetLanguage: translation?.targetLanguage || 'en',
      meetingRateControl: this.resolveMeetingRateControl(translation?.rateControl)
    }
  }

  private getTranslator(): OpenAICompatibleTranslator {
    const runtime = this.getRuntimeConfig()
    if (runtime.provider !== 'openai-compatible') {
      throw new Error(`Unsupported translation provider: ${runtime.provider}`)
    }

    const apiKey = this.getApiKey()
    if (!apiKey) {
      throw new Error('Missing OpenAI-compatible API key')
    }
    if (!runtime.endpoint) {
      throw new Error('Missing translation endpoint')
    }
    if (!runtime.model) {
      throw new Error('Missing translation model')
    }

    const cacheKey = JSON.stringify({
      endpoint: runtime.endpoint,
      model: runtime.model,
      timeoutMs: runtime.timeoutMs,
      apiKey
    })

    if (!this.cachedTranslator || this.cachedKey !== cacheKey) {
      this.cachedTranslator = new OpenAICompatibleTranslator({
        endpoint: runtime.endpoint,
        apiKey,
        model: runtime.model,
        timeoutMs: runtime.timeoutMs
      })
      this.cachedKey = cacheKey
    }

    return this.cachedTranslator
  }

  private resolveMeetingRateControl(
    config?: TranslationRateControlInput
  ): MeetingTranslationRateControlConfig {
    const presetName =
      config?.preset === 'low-latency' || config?.preset === 'throughput'
        ? config.preset
        : 'balanced'
    const defaults = MEETING_TRANSLATION_RATE_CONTROL_PRESETS[presetName]
    const raw = config || {}
    return {
      enabled: raw.enabled !== false,
      maxRequestsPerMinute: this.normalizeMinValue(
        raw.maxRequestsPerMinute,
        defaults.maxRequestsPerMinute,
        1
      ),
      maxTokensPerMinute: this.normalizeMinValue(
        raw.maxTokensPerMinute,
        defaults.maxTokensPerMinute,
        500
      ),
      minRequestIntervalMs: this.normalizeMinValue(
        raw.minRequestIntervalMs,
        defaults.minRequestIntervalMs,
        0
      ),
      maxQueueSize: this.normalizeMinValue(raw.maxQueueSize, defaults.maxQueueSize, 1),
      maxQueueWaitMs: this.normalizeMinValue(raw.maxQueueWaitMs, defaults.maxQueueWaitMs, 1000),
      dropPolicy: raw.dropPolicy === 'drop_newest' ? 'drop_newest' : 'drop_oldest'
    }
  }

  private normalizeMinValue(value: unknown, defaultValue: number, minValue: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return defaultValue
    }
    return Math.max(minValue, Math.floor(value))
  }

  private getMeetingRateLimiter(
    config: MeetingTranslationRateControlConfig
  ): MeetingTranslationRateLimiter {
    const key = JSON.stringify(config)
    if (!this.meetingRateLimiter || this.meetingRateLimiterKey !== key) {
      this.meetingRateLimiter = new MeetingTranslationRateLimiter(config)
      this.meetingRateLimiterKey = key
      return this.meetingRateLimiter
    }
    this.meetingRateLimiter.updateConfig(config)
    return this.meetingRateLimiter
  }

  private estimateMeetingTranslationTokens(text: string, targetLanguage: string): number {
    const inputTokens = Math.ceil(Array.from(text).length / 3)
    const targetHintTokens = Math.ceil(Array.from(targetLanguage || '').length / 2)
    // Reserve prompt + output headroom to reduce TPM burst risk.
    return Math.max(64, Math.floor(inputTokens * 1.8) + targetHintTokens + 120)
  }

  private estimateMeetingBatchTranslationTokens(texts: string[], targetLanguage: string): number {
    const base = texts.reduce(
      (sum, text) => sum + this.estimateMeetingTranslationTokens(text, targetLanguage),
      0
    )
    // Batch prompt/output framing overhead.
    return base + 60 + texts.length * 12
  }

  private async translateWithRateControl(
    translator: OpenAICompatibleTranslator,
    sourceText: string,
    targetLanguage: string,
    context: 'ptt' | 'meeting',
    sourceLanguage?: string
  ): Promise<string> {
    const execute = async (): Promise<string> =>
      translator.translate(sourceText, targetLanguage, {
        sourceLanguage,
        context
      })

    if (context !== 'meeting') {
      return execute()
    }

    const runtime = this.getRuntimeConfig()
    if (!runtime.meetingRateControl.enabled) {
      return execute()
    }

    const limiter = this.getMeetingRateLimiter(runtime.meetingRateControl)
    const estimatedTokens = this.estimateMeetingTranslationTokens(sourceText, targetLanguage)
    return limiter.enqueue(estimatedTokens, execute)
  }

  private async translateBatchWithRateControl(
    translator: OpenAICompatibleTranslator,
    sourceTexts: string[],
    targetLanguage: string
  ): Promise<string[]> {
    const execute = async (): Promise<string[]> =>
      translator.translateBatch(sourceTexts, targetLanguage, {
        context: 'meeting'
      })

    const runtime = this.getRuntimeConfig()
    if (!runtime.meetingRateControl.enabled) {
      return execute()
    }

    const limiter = this.getMeetingRateLimiter(runtime.meetingRateControl)
    const estimatedTokens = this.estimateMeetingBatchTranslationTokens(sourceTexts, targetLanguage)
    return limiter.enqueue(estimatedTokens, execute)
  }
}
