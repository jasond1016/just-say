import { SpeechRecognizer, RecognitionResult } from './index'
import WebSocket from 'ws'

export interface SonioxConfig {
  apiKey?: string
  model?: string
  languageHints?: string[]
  audioFormat?: string
}

interface SonioxToken {
  text: string
  start_ms?: number
  end_ms?: number
  confidence?: number
  is_final?: boolean
  speaker?: string
  language?: string
}

interface SonioxResponse {
  tokens?: SonioxToken[]
  final_audio_proc_ms?: number
  total_audio_proc_ms?: number
  finished?: boolean
  error?: string
  code?: number
  message?: string
}

export class SonioxRecognizer implements SpeechRecognizer {
  private config: SonioxConfig
  private readonly WS_ENDPOINT = 'wss://stt-rt.soniox.com/transcribe-websocket'

  constructor(config?: SonioxConfig) {
    this.config = {
      model: 'stt-rt-v3',
      audioFormat: 'auto',
      languageHints: ['zh', 'en'],
      ...config
    }
  }

  async recognize(audioBuffer: Buffer): Promise<RecognitionResult> {
    if (!this.config.apiKey) {
      throw new Error('Soniox API key required')
    }

    return new Promise((resolve, reject) => {
      const startTime = Date.now()
      const finalTokens: string[] = []
      let detectedLanguage: string | undefined

      // Create WebSocket connection
      const ws = new WebSocket(this.WS_ENDPOINT)

      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error('Soniox connection timeout'))
      }, 60000) // 60 second timeout

      ws.on('open', () => {
        console.log('[Soniox] Connected')

        // Send configuration
        const config = {
          api_key: this.config.apiKey,
          model: this.config.model,
          audio_format: this.config.audioFormat,
          language_hints: this.config.languageHints
        }
        console.log('[Soniox] Sending config:', JSON.stringify({ ...config, api_key: '***' }))
        ws.send(JSON.stringify(config))

        // Send audio data
        console.log('[Soniox] Sending audio:', audioBuffer.length, 'bytes')
        ws.send(audioBuffer)

        // Send empty text frame to signal end of audio
        console.log('[Soniox] Sending end signal')
        ws.send('')
      })

      ws.on('message', (data: Buffer) => {
        try {
          const response: SonioxResponse = JSON.parse(data.toString())

          // Check for error
          if (response.error || response.code) {
            clearTimeout(timeout)
            ws.close()
            reject(new Error(response.message || response.error || 'Soniox error'))
            return
          }

          // Collect final tokens
          if (response.tokens) {
            for (const token of response.tokens) {
              if (token.is_final) {
                finalTokens.push(token.text)
                if (token.language && !detectedLanguage) {
                  detectedLanguage = token.language
                }
              }
            }
          }

          // Check if finished
          if (response.finished) {
            clearTimeout(timeout)
            ws.close()

            const text = finalTokens.join('').trim()
            resolve({
              text,
              language: detectedLanguage,
              durationMs: Date.now() - startTime
            })
          }
        } catch (err) {
          console.error('[Soniox] Parse error:', err)
        }
      })

      ws.on('error', (err) => {
        clearTimeout(timeout)
        console.error('[Soniox] WebSocket error:', err)
        reject(new Error(`Soniox connection error: ${err.message}`))
      })

      ws.on('close', (code, reason) => {
        clearTimeout(timeout)
        if (code !== 1000 && finalTokens.length === 0) {
          reject(new Error(`Soniox connection closed: ${code} ${reason}`))
        }
      })
    })
  }

  async healthCheck(): Promise<boolean> {
    return !!this.config.apiKey
  }
}
