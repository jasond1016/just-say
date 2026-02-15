export interface OpenAICompatibleTranslatorConfig {
  endpoint: string
  apiKey: string
  model: string
  timeoutMs: number
}

export interface OpenAICompatibleTranslateOptions {
  sourceLanguage?: string
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
              content:
                'You are a professional translator. Translate faithfully and naturally. Output only the translated text.'
            },
            {
              role: 'user',
              content: this.buildTranslatePrompt(text, targetLanguage, options?.sourceLanguage)
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

  private buildTranslatePrompt(
    text: string,
    targetLanguage: string,
    sourceLanguage?: string
  ): string {
    const sourceInfo = sourceLanguage ? ` from ${sourceLanguage}` : ''
    return [
      `Translate the following text${sourceInfo} into ${targetLanguage}.`,
      'Preserve meaning, tone, and terminology.',
      'Output only the translated result.',
      '',
      text
    ].join('\n')
  }
}
