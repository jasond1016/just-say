import WebSocket from 'ws'
import { EventEmitter } from 'events'

export interface StreamingSonioxConfig {
  apiKey?: string
  model?: string
  languageHints?: string[]
}

interface SonioxToken {
  text: string
  is_final?: boolean
  confidence?: number
  language?: string
}

interface SonioxResponse {
  tokens?: SonioxToken[]
  finished?: boolean
  error?: string
  code?: number
  message?: string
}

/**
 * Streaming Soniox recognizer that maintains a WebSocket connection
 * and processes audio chunks in real-time.
 */
export class StreamingSonioxRecognizer extends EventEmitter {
  private config: StreamingSonioxConfig
  private ws: WebSocket | null = null
  private isConnected = false
  private finalText: string[] = []
  private startTime = 0
  private readonly WS_ENDPOINT = 'wss://stt-rt.soniox.com/transcribe-websocket'

  constructor(config?: StreamingSonioxConfig) {
    super()
    this.config = {
      model: 'stt-rt-v3',
      languageHints: ['zh', 'en'],
      ...config
    }
  }

  /**
   * Start a streaming session. Call this when recording starts.
   */
  async startSession(): Promise<void> {
    if (!this.config.apiKey) {
      throw new Error('Soniox API key required')
    }

    this.finalText = []
    this.startTime = Date.now()

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.WS_ENDPOINT)

      const timeout = setTimeout(() => {
        this.ws?.close()
        reject(new Error('Soniox connection timeout'))
      }, 10000)

      this.ws.on('open', () => {
        clearTimeout(timeout)
        this.isConnected = true
        console.log(`[StreamingSoniox] Connected in ${Date.now() - this.startTime}ms`)

        // Send configuration
        const config = {
          api_key: this.config.apiKey,
          model: this.config.model,
          audio_format: 'pcm_s16le',
          sample_rate: 16000,
          num_channels: 1,
          language_hints: this.config.languageHints
        }
        this.ws!.send(JSON.stringify(config))
        console.log('[StreamingSoniox] Config sent')
        resolve()
      })

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data)
      })

      this.ws.on('error', (err) => {
        clearTimeout(timeout)
        console.error('[StreamingSoniox] Error:', err)
        this.emit('error', err)
        reject(err)
      })

      this.ws.on('close', (code, reason) => {
        this.isConnected = false
        console.log('[StreamingSoniox] Closed:', code, reason.toString())
      })
    })
  }

  /**
   * Send an audio chunk to the server.
   */
  sendAudioChunk(chunk: Buffer): void {
    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(chunk)
    }
  }

  /**
   * End the streaming session and get final result.
   */
  async endSession(): Promise<{ text: string; durationMs: number }> {
    return new Promise((resolve) => {
      if (!this.isConnected || !this.ws) {
        resolve({ text: this.finalText.join('').trim(), durationMs: Date.now() - this.startTime })
        return
      }

      const timeout = setTimeout(() => {
        this.ws?.close()
        resolve({ text: this.finalText.join('').trim(), durationMs: Date.now() - this.startTime })
      }, 5000)

      // Listen for finished signal
      const finishHandler = () => {
        clearTimeout(timeout)
        resolve({ text: this.finalText.join('').trim(), durationMs: Date.now() - this.startTime })
      }
      this.once('finished', finishHandler)

      // Send empty frame to signal end
      console.log('[StreamingSoniox] Sending end signal')
      this.ws.send('')
    })
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(data: Buffer): void {
    try {
      const response: SonioxResponse = JSON.parse(data.toString())

      // Check for error
      if (response.error || response.code) {
        console.error('[StreamingSoniox] Server error:', response.message || response.error)
        this.emit('error', new Error(response.message || response.error))
        return
      }

      // Process tokens
      if (response.tokens) {
        for (const token of response.tokens) {
          if (token.is_final) {
            this.finalText.push(token.text)
          }
        }

        // Emit partial result for real-time display
        const currentText = this.finalText.join('')
        this.emit('partial', currentText)
      }

      // Check if finished
      if (response.finished) {
        console.log(`[StreamingSoniox] Finished, total time: ${Date.now() - this.startTime}ms`)
        this.emit('finished')
        this.ws?.close()
      }
    } catch (err) {
      console.error('[StreamingSoniox] Parse error:', err)
    }
  }

  /**
   * Check if connected
   */
  isSessionActive(): boolean {
    return this.isConnected
  }

  /**
   * Force close the connection
   */
  close(): void {
    this.ws?.close()
    this.isConnected = false
  }
}
