import { EventEmitter } from 'events'
import { AppConfig } from '../config'
import { getApiKey } from '../secureStore'
import { LocalRecognizer, DownloadProgress } from './local'
import { ApiRecognizer } from './api'
import { NetworkRecognizer } from './network'
import { SonioxRecognizer } from './soniox'
import { GroqRecognizer } from './groq'

export type { DownloadProgress } from './local'

export interface RecognitionResult {
  text: string
  language?: string
  confidence?: number
  durationMs: number
}

export interface SpeechRecognizer {
  recognize(audioBuffer: Buffer): Promise<RecognitionResult>
  healthCheck(): Promise<boolean>
}

export class RecognitionController extends EventEmitter {
  private recognizer: SpeechRecognizer
  private config: AppConfig

  constructor(config: AppConfig) {
    super()
    this.config = config
    this.recognizer = this.createRecognizer()
  }

  private createRecognizer(): SpeechRecognizer {
    const backend = this.config.recognition?.backend || 'local'
    console.log(`[Recognition] Using ${backend} backend`)

    switch (backend) {
      case 'api':
        return new ApiRecognizer(this.config.recognition?.api)
      case 'soniox': {
        const sonioxApiKey = getApiKey('soniox')
        return new SonioxRecognizer({
          ...this.config.recognition?.soniox,
          apiKey: sonioxApiKey
        })
      }
      case 'network':
        return new NetworkRecognizer(this.config.recognition?.network)
      case 'groq': {
        const groqApiKey = getApiKey('groq')
        return new GroqRecognizer({
          ...this.config.recognition?.groq,
          apiKey: groqApiKey
        })
      }
      default:
        return new LocalRecognizer(this.config.recognition?.local)
    }
  }

  async recognize(audioBuffer: Buffer): Promise<RecognitionResult | null> {
    const startTime = Date.now()

    try {
      console.log('[Recognition] Starting...')
      const result = await this.recognizer.recognize(audioBuffer)
      result.durationMs = Date.now() - startTime
      console.log(`[Recognition] Done in ${result.durationMs}ms: "${result.text}"`)
      return result
    } catch (error) {
      console.error('[Recognition] Error:', error)
      return null
    }
  }

  async healthCheck(): Promise<boolean> {
    return this.recognizer.healthCheck()
  }

  async getLocalModels(): Promise<string[]> {
    if (this.recognizer instanceof LocalRecognizer) {
      return this.recognizer.getModels()
    }
    return []
  }

  async downloadModel(modelType: string): Promise<void> {
    if (this.recognizer instanceof LocalRecognizer) {
      // Forward progress events
      const onProgress = (progress: DownloadProgress): void => {
        this.emit('download-progress', progress)
      }
      this.recognizer.on('download-progress', onProgress)

      try {
        await this.recognizer.downloadModel(modelType)
      } finally {
        this.recognizer.off('download-progress', onProgress)
      }
      return
    }
    throw new Error('Current backend does not support model downloading')
  }

  async deleteModel(modelType: string): Promise<void> {
    if (this.recognizer instanceof LocalRecognizer) {
      return this.recognizer.deleteModel(modelType)
    }
    throw new Error('Current backend does not support model deletion')
  }
}
