import { SpeechRecognizer, RecognitionResult } from './index'

export interface GroqRecognizerConfig {
  apiKey?: string
  model?: 'whisper-large-v3-turbo' | 'whisper-large-v3'
  language?: string
}

export class GroqRecognizer implements SpeechRecognizer {
  private config: GroqRecognizerConfig

  constructor(config?: GroqRecognizerConfig) {
    this.config = {
      model: 'whisper-large-v3-turbo',
      ...config
    }
  }

  private createWavBuffer(pcmBuffer: Buffer): Buffer {
    const sampleRate = 16000
    const numChannels = 1
    const bitsPerSample = 16
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8
    const blockAlign = (numChannels * bitsPerSample) / 8
    const dataSize = pcmBuffer.length
    const headerSize = 44
    const fileSize = headerSize + dataSize - 8

    const header = Buffer.alloc(headerSize)
    header.write('RIFF', 0)
    header.writeUInt32LE(fileSize, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16) // fmt chunk size
    header.writeUInt16LE(1, 20) // PCM format
    header.writeUInt16LE(numChannels, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(byteRate, 28)
    header.writeUInt16LE(blockAlign, 32)
    header.writeUInt16LE(bitsPerSample, 34)
    header.write('data', 36)
    header.writeUInt32LE(dataSize, 40)

    return Buffer.concat([header, pcmBuffer])
  }

  async recognize(audioBuffer: Buffer): Promise<RecognitionResult> {
    if (!this.config.apiKey) {
      throw new Error('Groq API key required')
    }

    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2)
    const parts: Buffer[] = []

    // Convert raw PCM to WAV format
    const wavBuffer = this.createWavBuffer(audioBuffer)

    // File part
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`
      )
    )
    parts.push(wavBuffer)
    parts.push(Buffer.from('\r\n'))

    // Model part
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${this.config.model}\r\n`
      )
    )

    // Language part (optional, improves accuracy and latency)
    if (this.config.language && this.config.language !== 'auto') {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${this.config.language}\r\n`
        )
      )
    }

    // Response format for verbose output with metadata
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n`
      )
    )

    // End boundary
    parts.push(Buffer.from(`--${boundary}--\r\n`))

    const body = Buffer.concat(parts)

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Groq API error ${response.status}: ${error}`)
    }

    const result = (await response.json()) as {
      text?: string
      language?: string
      duration?: number
    }

    return {
      text: result.text || '',
      language: result.language,
      durationMs: result.duration ? result.duration * 1000 : 0
    }
  }

  async healthCheck(): Promise<boolean> {
    return !!this.config.apiKey
  }
}
