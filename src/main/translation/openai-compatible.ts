export interface OpenAICompatibleTranslatorConfig {
  endpoint: string
  apiKey: string
  model: string
  timeoutMs: number
}

export interface OpenAICompatibleTranslateOptions {
  sourceLanguage?: string
  context?: 'ptt' | 'meeting'
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string
    }
  }>
  error?: {
    message?: string
  }
}

interface BatchTranslationJsonPayload {
  translations?: unknown
}

function resolveChatCompletionsUrl(endpoint: string): string {
  const normalized = endpoint.trim().replace(/\/+$/, '')
  if (normalized.endsWith('/chat/completions')) {
    return normalized
  }
  return `${normalized}/chat/completions`
}

export class OpenAICompatibleTranslator {
  private config: OpenAICompatibleTranslatorConfig

  constructor(config: OpenAICompatibleTranslatorConfig) {
    this.config = config
  }

  async translate(
    text: string,
    targetLanguage: string,
    options?: OpenAICompatibleTranslateOptions
  ): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)

    try {
      const response = await fetch(resolveChatCompletionsUrl(this.config.endpoint), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            {
              role: 'system',
              content: this.buildSystemPrompt()
            },
            {
              role: 'user',
              content: this.buildTranslatePrompt(
                text,
                targetLanguage,
                options?.sourceLanguage,
                options?.context
              )
            }
          ],
          temperature: 0.2
        }),
        signal: controller.signal
      })

      const payload = (await response.json()) as ChatCompletionResponse
      if (!response.ok) {
        const errorMessage = payload.error?.message || `HTTP ${response.status}`
        throw new Error(errorMessage)
      }

      const content = payload.choices?.[0]?.message?.content?.trim() || ''
      if (!content) {
        throw new Error('Empty translation response')
      }
      return content
    } finally {
      clearTimeout(timeout)
    }
  }

  async translateBatch(
    texts: string[],
    targetLanguage: string,
    options?: OpenAICompatibleTranslateOptions
  ): Promise<string[]> {
    if (texts.length === 0) {
      return []
    }
    if (texts.length === 1) {
      return [await this.translate(texts[0], targetLanguage, options)]
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)

    try {
      const response = await fetch(resolveChatCompletionsUrl(this.config.endpoint), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            {
              role: 'system',
              content: this.buildBatchSystemPrompt()
            },
            {
              role: 'user',
              content: this.buildBatchTranslatePrompt(
                texts,
                targetLanguage,
                options?.sourceLanguage,
                options?.context
              )
            }
          ],
          temperature: 0.2
        }),
        signal: controller.signal
      })

      const payload = (await response.json()) as ChatCompletionResponse
      if (!response.ok) {
        const errorMessage = payload.error?.message || `HTTP ${response.status}`
        throw new Error(errorMessage)
      }

      const content = payload.choices?.[0]?.message?.content?.trim() || ''
      if (!content) {
        throw new Error('Empty translation response')
      }

      const parsed = this.parseBatchTranslationContent(content)
      if (parsed.length !== texts.length) {
        throw new Error(
          `Batch translation size mismatch: expected ${texts.length}, got ${parsed.length}`
        )
      }
      return parsed
    } finally {
      clearTimeout(timeout)
    }
  }

  private buildTranslatePrompt(
    text: string,
    targetLanguage: string,
    sourceLanguage?: string,
    context: 'ptt' | 'meeting' = 'ptt'
  ): string {
    const sourceInfo = sourceLanguage ? ` from ${sourceLanguage}` : ''
    const contextInfo =
      context === 'meeting' ? 'Context: real-time meeting transcript.' : 'Context: push-to-talk.'

    return [
      `Task: Translate the following spoken text${sourceInfo} into ${targetLanguage}.`,
      contextInfo,
      '',
      'Apply light cleanup while translating:',
      '- Remove obvious filler words and discourse markers (for example: "um", "uh", "you know", "like", "那个", "就是").',
      '- Remove immediate repetitions and abandoned false starts that add no meaning.',
      '- Keep all meaningful content, intent, facts, numbers, negations, terminology, and proper nouns.',
      '- If unsure whether a phrase carries meaning, keep it.',
      '',
      'Output only the translated result. Do not include explanations.',
      '',
      text
    ].join('\n')
  }

  private buildSystemPrompt(): string {
    return [
      'You are a professional translator and careful spoken-text editor.',
      'Translate faithfully and naturally.',
      'Perform only light cleanup of meaningless spoken disfluencies.',
      'Do not add information or change speaker intent.',
      'Output only the translated text.'
    ].join(' ')
  }

  private buildBatchSystemPrompt(): string {
    return [
      'You are a professional translator and careful spoken-text editor.',
      'Translate each input item faithfully and naturally.',
      'Perform only light cleanup of meaningless spoken disfluencies.',
      'Do not merge, split, reorder, or omit items.',
      'Output strict JSON only.'
    ].join(' ')
  }

  private buildBatchTranslatePrompt(
    texts: string[],
    targetLanguage: string,
    sourceLanguage?: string,
    context: 'ptt' | 'meeting' = 'meeting'
  ): string {
    const sourceInfo = sourceLanguage ? ` from ${sourceLanguage}` : ''
    const contextInfo =
      context === 'meeting' ? 'Context: real-time meeting transcript.' : 'Context: push-to-talk.'
    const items = texts.map((text, index) => ({
      id: index,
      text
    }))

    return [
      `Task: Translate each text item${sourceInfo} into ${targetLanguage}.`,
      contextInfo,
      '',
      'Return strict JSON with this exact shape and no extra keys:',
      '{"translations":["...", "..."]}',
      '',
      'Rules:',
      '- The "translations" array length must equal input item count.',
      '- Preserve item order exactly by index.',
      '- Apply only light cleanup of filler words/disfluencies.',
      '- Keep all meaningful content, intent, numbers, names, and negations.',
      '',
      `Input JSON: ${JSON.stringify({ items })}`
    ].join('\n')
  }

  private parseBatchTranslationContent(content: string): string[] {
    const raw = content.trim()
    const candidates = [
      raw,
      raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim()
    ]

    for (const candidate of candidates) {
      if (!candidate) continue
      try {
        const parsed = JSON.parse(candidate) as BatchTranslationJsonPayload | string[]
        if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
          return parsed.map((item) => item.trim())
        }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const payload = parsed as BatchTranslationJsonPayload
          if (
            Array.isArray(payload.translations) &&
            payload.translations.every((item) => typeof item === 'string')
          ) {
            return payload.translations.map((item) => item.trim())
          }
        }
      } catch {
        // Continue fallback parsing.
      }
    }

    const nonEmptyLines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    if (nonEmptyLines.length > 0) {
      return nonEmptyLines
    }
    throw new Error('Invalid batch translation response format')
  }
}
