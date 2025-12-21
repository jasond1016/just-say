import { SpeechRecognizer, RecognitionResult } from './index'

export interface ApiRecognizerConfig {
  provider?: string
  endpoint?: string
  apiKey?: string
  model?: string
}

export class ApiRecognizer implements SpeechRecognizer {
  private config: ApiRecognizerConfig

  constructor(config?: ApiRecognizerConfig) {
    this.config = {
      endpoint: 'https://api.openai.com/v1/audio/transcriptions',
      model: 'whisper-1',
      ...config
    }
  }

  async recognize(audioBuffer: Buffer): Promise<RecognitionResult> {
    if (!this.config.apiKey) {
      throw new Error('API key required')
    }

    // Create multipart form data manually
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2)
    const parts: Buffer[] = []

    // File part
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`
      )
    )
    parts.push(audioBuffer)
    parts.push(Buffer.from('\r\n'))

    // Model part
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${this.config.model}\r\n`
      )
    )

    // End boundary
    parts.push(Buffer.from(`--${boundary}--\r\n`))

    const body = Buffer.concat(parts)

    const response = await fetch(this.config.endpoint!, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`API error ${response.status}: ${error}`)
    }

    const result = (await response.json()) as { text?: string; language?: string }
    return {
      text: result.text || '',
      language: result.language,
      durationMs: 0
    }
  }

  async healthCheck(): Promise<boolean> {
    return !!this.config.apiKey
  }
}
