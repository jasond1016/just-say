import { SpeechRecognizer, RecognitionResult } from './index'

export interface NetworkRecognizerConfig {
  endpoint?: string
  authToken?: string
  timeoutSec?: number
}

export class NetworkRecognizer implements SpeechRecognizer {
  private config: NetworkRecognizerConfig

  constructor(config?: NetworkRecognizerConfig) {
    this.config = {
      endpoint: 'http://localhost:8080/asr',
      timeoutSec: 30,
      ...config
    }
  }

  async recognize(audioBuffer: Buffer): Promise<RecognitionResult> {
    if (!this.config.endpoint) {
      throw new Error('Endpoint required')
    }

    const headers: Record<string, string> = {
      'Content-Type': 'audio/wav'
    }

    if (this.config.authToken) {
      headers['Authorization'] = `Bearer ${this.config.authToken}`
    }

    const response = await fetch(this.config.endpoint, {
      method: 'POST',
      headers,
      body: new Uint8Array(audioBuffer),
      signal: AbortSignal.timeout((this.config.timeoutSec || 30) * 1000)
    })

    if (!response.ok) {
      throw new Error(`Network error ${response.status}`)
    }

    const result = (await response.json()) as {
      text?: string
      data?: { text?: string; language?: string }
      language?: string
    }

    return {
      text: result.text || result.data?.text || '',
      language: result.language || result.data?.language,
      durationMs: 0
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await fetch(`${this.config.endpoint}/health`, {
        signal: AbortSignal.timeout(5000)
      })
      return true
    } catch {
      return false
    }
  }
}
