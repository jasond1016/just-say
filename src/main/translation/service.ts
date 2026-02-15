import { AppConfig } from '../config'
import { OpenAICompatibleTranslator } from './openai-compatible'

const DEFAULT_PROVIDER = 'openai-compatible'
const DEFAULT_ENDPOINT = 'https://api.openai.com/v1'
const DEFAULT_MODEL = 'gpt-4o-mini'
const DEFAULT_TIMEOUT_MS = 15000

interface TranslationRuntimeConfig {
  provider: 'openai-compatible'
  endpoint: string
  model: string
  timeoutMs: number
  pttEnabled: boolean
  pttTargetLanguage: string
}

export interface TranslateResult {
  text: string
  translated: boolean
  fallback: boolean
  error?: string
  latencyMs: number
}

export class TranslationService {
  private readonly getConfig: () => AppConfig
  private readonly getApiKey: () => string | undefined
  private cachedKey: string | null = null
  private cachedTranslator: OpenAICompatibleTranslator | null = null

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
      const translated = await translator.translate(sourceText, targetLanguage, {
        sourceLanguage: options.sourceLanguage
      })
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
      pttTargetLanguage: translation?.targetLanguage || 'en'
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
}
