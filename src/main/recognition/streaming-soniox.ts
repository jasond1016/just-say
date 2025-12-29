import WebSocket from 'ws'
import { EventEmitter } from 'events'

export interface StreamingSonioxConfig {
  apiKey?: string
  model?: string
  languageHints?: string[]
  /** Enable speaker diarization. Each token will include a speaker number. Default: true */
  enableSpeakerDiarization?: boolean
}

interface SonioxToken {
  text: string
  is_final?: boolean
  confidence?: number
  language?: string
  /** Speaker number (when speaker diarization is enabled) */
  speaker?: number
}

interface SonioxResponse {
  tokens?: SonioxToken[]
  finished?: boolean
  error?: string
  code?: number
  message?: string
}

// Partial result includes both final and interim text
export interface PartialResult {
  finalText: string    // Confirmed text that won't change
  interimText: string  // Provisional text that may change
  combined: string     // finalText + interimText for display
  /** Current speaker number (if speaker diarization is enabled) */
  currentSpeaker?: number
}

/**
 * Streaming Soniox recognizer that maintains a WebSocket connection
 * and processes audio chunks in real-time.
 * Supports pre-connecting to reduce startup latency.
 */
export class StreamingSonioxRecognizer extends EventEmitter {
  private config: StreamingSonioxConfig
  private ws: WebSocket | null = null
  private isConnected = false
  private isConfigSent = false
  private finalText: string[] = []
  private interimText: string[] = [] // Track non-final tokens
  private currentSpeaker?: number
  private startTime = 0
  private preConnectTime = 0
  private readonly WS_ENDPOINT = 'wss://stt-rt.soniox.com/transcribe-websocket'

  constructor(config?: StreamingSonioxConfig) {
    super()
    this.config = {
      model: 'stt-rt-v3',
      languageHints: ['zh', 'en', 'ja'],
      enableSpeakerDiarization: true, // Default enabled
      ...config
    }
  }

  /**
   * Pre-connect to WebSocket server without starting a session.
   * Call this early (e.g., when meeting window opens) to reduce latency.
   */
  async preConnect(): Promise<void> {
    if (this.isConnected) {
      console.log('[StreamingSoniox] Already connected')
      return
    }

    if (!this.config.apiKey) {
      throw new Error('Soniox API key required')
    }

    this.preConnectTime = Date.now()

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.WS_ENDPOINT)

      const timeout = setTimeout(() => {
        this.ws?.close()
        reject(new Error('Soniox pre-connect timeout'))
      }, 10000)

      this.ws.on('open', () => {
        clearTimeout(timeout)
        this.isConnected = true
        console.log(`[StreamingSoniox] Pre-connected in ${Date.now() - this.preConnectTime}ms`)
        resolve()
      })

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data)
      })

      this.ws.on('error', (err) => {
        clearTimeout(timeout)
        console.error('[StreamingSoniox] Pre-connect error:', err)
        this.emit('error', err)
        reject(err)
      })

      this.ws.on('close', (code, reason) => {
        this.isConnected = false
        this.isConfigSent = false
        console.log('[StreamingSoniox] Closed:', code, reason.toString())
      })
    })
  }

  /**
   * Check if pre-connected and ready
   */
  isPreConnected(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocket.OPEN
  }

  /**
   * Start a streaming session. If pre-connected, this is instant.
   */
  async startSession(): Promise<void> {
    if (!this.config.apiKey) {
      throw new Error('Soniox API key required')
    }

    this.finalText = []
    this.startTime = Date.now()

    // If already pre-connected, just send config
    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      if (!this.isConfigSent) {
        this.sendConfig()
      }
      console.log(`[StreamingSoniox] Session started instantly (pre-connected)`)
      return
    }

    // Otherwise, connect now
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
        this.sendConfig()
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
        this.isConfigSent = false
        console.log('[StreamingSoniox] Closed:', code, reason.toString())
      })
    })
  }

  /**
   * Send configuration to server
   */
  private sendConfig(): void {
    if (!this.ws || this.isConfigSent) return

    const config = {
      api_key: this.config.apiKey,
      model: this.config.model,
      audio_format: 'pcm_s16le',
      sample_rate: 16000,
      num_channels: 1,
      language_hints: this.config.languageHints,
      // Enable endpoint detection for faster finalization
      enable_endpoint_detection: true,
      // Enable speaker diarization
      enable_speaker_diarization: this.config.enableSpeakerDiarization
    }
    this.ws.send(JSON.stringify(config))
    this.isConfigSent = true
    console.log(
      `[StreamingSoniox] Config sent (endpoint detection: on, speaker diarization: ${this.config.enableSpeakerDiarization})`
    )
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
      const finishHandler = (): void => {
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
        // Collect final and interim tokens separately
        this.interimText = [] // Reset interim for each response

        for (const token of response.tokens) {
          // Track speaker changes
          if (token.speaker !== undefined && token.speaker !== this.currentSpeaker) {
            this.currentSpeaker = token.speaker
          }

          if (token.is_final) {
            this.finalText.push(token.text)
          } else {
            // Non-final tokens - show immediately but may change
            this.interimText.push(token.text)
          }
        }

        // Emit partial result with both final and interim text
        const result: PartialResult = {
          finalText: this.finalText.join(''),
          interimText: this.interimText.join(''),
          combined: this.finalText.join('') + this.interimText.join(''),
          currentSpeaker: this.currentSpeaker
        }
        this.emit('partial', result)
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
    this.isConfigSent = false
  }
}
