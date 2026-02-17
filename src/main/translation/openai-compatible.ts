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
}
