import { spawn, execSync } from 'child_process'
import { join } from 'path'
import { app } from 'electron'
import * as fs from 'fs'
import { EventEmitter } from 'events'
import { SpeechRecognizer, RecognitionResult } from './index'
import { getWhisperServer, WhisperServerClient } from './whisperServer'

export interface DownloadProgress {
  model: string
  percent: number
  status: string
}

export interface GpuInfo {
  cuda_available: boolean
  device_name: string | null
  recommended_device: 'cpu' | 'cuda'
  recommended_compute_type: string
}

export interface LocalRecognizerConfig {
  modelPath?: string
  modelType?: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3'
  device?: 'cpu' | 'cuda' | 'auto'
  language?: string
  threads?: number
  computeType?: string
  useHttpServer?: boolean // Use HTTP server mode (recommended)
}

export class LocalRecognizer extends EventEmitter implements SpeechRecognizer {
  private config: LocalRecognizerConfig
  private pythonPath: string
  private scriptPath: string
  private static cachedGpuInfo: GpuInfo | null = null
  private whisperServer: WhisperServerClient | null = null

  constructor(config?: LocalRecognizerConfig) {
    super()
    this.config = {
      modelType: 'tiny',
      device: 'auto',
      language: 'auto',
      threads: 4,
      computeType: 'auto',
      useHttpServer: true, // Default to HTTP server mode
      ...config
    } as LocalRecognizerConfig

    // Script is in project root/python folder
    let projectRoot: string
    if (app.isPackaged) {
      projectRoot = process.resourcesPath
    } else {
      projectRoot = app.getAppPath()
    }
    this.scriptPath = join(projectRoot, 'python', 'whisper_service.py')

    // Find python - prefer venv
    this.pythonPath = this.findPython(projectRoot)

    // Initialize HTTP server client if enabled
    if (this.config.useHttpServer) {
      this.whisperServer = getWhisperServer({
        modelType: this.config.modelType,
        device: this.config.device === 'auto' ? 'cpu' : this.config.device,
        computeType: this.config.computeType === 'auto' ? 'int8' : this.config.computeType,
        autoStart: true
      })
    }
  }

  private findPython(projectRoot: string): string {
    const platform = process.platform
    const venvPath =
      platform === 'win32'
        ? join(projectRoot, 'python', '.venv', 'Scripts', 'python.exe')
        : join(projectRoot, 'python', '.venv', 'bin', 'python')

    if (fs.existsSync(venvPath)) {
      console.log('[LocalRecognizer] Using venv python:', venvPath)
      return venvPath
    }

    const pythonCmds = ['python', 'python3']
    for (const cmd of pythonCmds) {
      try {
        execSync(`${cmd} --version`, { encoding: 'utf8', stdio: 'pipe' })
        return cmd
      } catch {
        continue
      }
    }
    return 'python'
  }

  private createWavBuffer(pcmBuffer: Buffer, sampleRate: number = 16000): Buffer {
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
    // Use HTTP server mode if enabled (faster, model stays in memory)
    if (this.config.useHttpServer && this.whisperServer) {
      return this.recognizeViaServer(audioBuffer)
    }

    // Fallback to legacy spawn mode
    return this.recognizeViaSpawn(audioBuffer)
  }

  /**
   * Recognize via HTTP server (fast path - model stays in memory)
   */
  private async recognizeViaServer(audioBuffer: Buffer): Promise<RecognitionResult> {
    const { device, computeType } = await this.resolveAutoSettings()
    const wavBuffer = this.createWavBuffer(audioBuffer)

    console.log('[LocalRecognizer] Recognizing via HTTP server')

    const result = await this.whisperServer!.transcribe(wavBuffer, {
      modelType: this.config.modelType,
      device,
      computeType,
      language: this.config.language
    })

    if (!result.success) {
      throw new Error(result.error || 'Transcription failed')
    }

    return {
      text: result.text || '',
      language: result.language,
      confidence: result.language_probability,
      durationMs: (result.processing_time || 0) * 1000
    }
  }

  /**
   * Recognize via spawning Python process (legacy mode)
   */
  private async recognizeViaSpawn(audioBuffer: Buffer): Promise<RecognitionResult> {
    // Resolve auto settings before running
    const { device, computeType } = await this.resolveAutoSettings()

    return new Promise((resolve, reject) => {
      // Write audio to temp file with proper WAV header
      const tempDir = join(app.getPath('temp'), 'justsay')
      const audioPath = join(tempDir, `input_${Date.now()}.wav`)

      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true })
      }

      const wavBuffer = this.createWavBuffer(audioBuffer)
      fs.writeFileSync(audioPath, wavBuffer)

      // Build args
      const modelsPath = join(app.getPath('userData'), 'models')
      if (!fs.existsSync(modelsPath)) {
        fs.mkdirSync(modelsPath, { recursive: true })
      }

      const args = [
        this.scriptPath,
        '--audio',
        audioPath,
        '--model',
        this.config.modelType || 'tiny',
        '--device',
        device,
        '--compute-type',
        computeType,
        '--download-root',
        modelsPath
      ]

      if (this.config.language && this.config.language !== 'auto') {
        args.push('--language', this.config.language)
      }

      console.log('[LocalRecognizer] Running:', this.pythonPath, args.join(' '))

      const proc = spawn(this.pythonPath, args, {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      })
      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString('utf8')
      })

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString('utf8')
      })

      proc.on('close', (code) => {
        // Cleanup temp file
        try {
          fs.unlinkSync(audioPath)
        } catch {
          /* ignore */
        }

        // Try to parse result first - CUDA may crash on cleanup but still produce valid output
        try {
          const result = JSON.parse(stdout.trim())
          if (result.success) {
            resolve({
              text: result.text || '',
              language: result.language,
              confidence: result.language_probability,
              durationMs: 0
            })
            return
          } else if (result.error) {
            reject(new Error(result.error))
            return
          }
        } catch {
          // Not valid JSON, check exit code
        }

        if (code === 0) {
          resolve({ text: stdout.trim(), durationMs: 0 })
        } else {
          reject(new Error(`Failed (code ${code}): ${stderr || stdout}`))
        }
      })

      proc.on('error', (err) => {
        reject(new Error(`Python error: ${err.message}`))
      })
    })
  }

  async healthCheck(): Promise<boolean> {
    try {
      execSync(`${this.pythonPath} -c "import faster_whisper; print('OK')"`, {
        encoding: 'utf8',
        timeout: 10000,
        stdio: 'pipe'
      })
      return true
    } catch {
      return false
    }
  }

  async detectGpu(): Promise<GpuInfo> {
    if (LocalRecognizer.cachedGpuInfo) {
      return LocalRecognizer.cachedGpuInfo
    }

    return new Promise((resolve) => {
      const args = [this.scriptPath, '--detect-gpu']
      const proc = spawn(this.pythonPath, args, {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      })
      let stdout = ''

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString('utf8')
      })

      proc.on('close', (code) => {
        if (code === 0) {
          try {
            const info = JSON.parse(stdout.trim()) as GpuInfo
            LocalRecognizer.cachedGpuInfo = info
            console.log('[LocalRecognizer] GPU detection:', info)
            resolve(info)
            return
          } catch {
            // Parse error, fall through
          }
        }
        // Default fallback
        const fallback: GpuInfo = {
          cuda_available: false,
          device_name: null,
          recommended_device: 'cpu',
          recommended_compute_type: 'int8'
        }
        LocalRecognizer.cachedGpuInfo = fallback
        resolve(fallback)
      })

      proc.on('error', () => {
        const fallback: GpuInfo = {
          cuda_available: false,
          device_name: null,
          recommended_device: 'cpu',
          recommended_compute_type: 'int8'
        }
        resolve(fallback)
      })
    })
  }

  private async resolveAutoSettings(): Promise<{ device: 'cpu' | 'cuda'; computeType: string }> {
    const gpuInfo = await this.detectGpu()

    // Determine device: auto-detect, or validate user choice
    let device: 'cpu' | 'cuda'
    if (!this.config.device || this.config.device === 'auto') {
      device = gpuInfo.recommended_device
    } else if (this.config.device === 'cuda' && !gpuInfo.cuda_available) {
      console.log('[LocalRecognizer] CUDA requested but not available, falling back to CPU')
      device = 'cpu'
    } else {
      device = this.config.device as 'cpu' | 'cuda'
    }

    // Determine compute type based on device
    let computeType: string
    if (!this.config.computeType || this.config.computeType === 'auto' || this.config.computeType === 'default') {
      computeType = device === 'cuda' ? 'float16' : 'int8'
    } else {
      computeType = this.config.computeType
    }

    return { device, computeType }
  }
  async downloadModel(modelType: string): Promise<void> {
    const modelsPath = join(app.getPath('userData'), 'models')
    if (!fs.existsSync(modelsPath)) {
      fs.mkdirSync(modelsPath, { recursive: true })
    }

    return new Promise((resolve, reject) => {
      const args = [
        this.scriptPath,
        '--model',
        modelType,
        '--download-root',
        modelsPath,
        '--download-only'
      ]

      console.log('[LocalRecognizer] Downloading model:', modelType)
      const proc = spawn(this.pythonPath, args, {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      })

      let stderrBuffer = ''

      proc.stderr.on('data', (data: Buffer) => {
        stderrBuffer += data.toString('utf8')

        // Parse progress JSON lines from stderr
        const lines = stderrBuffer.split('\n')
        stderrBuffer = lines.pop() || '' // Keep incomplete line

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line)
            if (msg.type === 'progress') {
              this.emit('download-progress', {
                model: modelType,
                percent: msg.percent,
                status: msg.status
              } as DownloadProgress)
            }
          } catch {
            // Not JSON, log as regular output
            console.log('[Download]', line.trim())
          }
        }
      })

      proc.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`Download failed: ${stderrBuffer}`))
        }
      })

      proc.on('error', (err) => {
        reject(new Error(`Process error: ${err.message}`))
      })
    })
  }

  async getModels(): Promise<string[]> {
    const modelsPath = join(app.getPath('userData'), 'models')
    if (!fs.existsSync(modelsPath)) {
      return []
    }

    try {
      const files = fs.readdirSync(modelsPath)
      // Filter for huggingface cache folders
      // Format: models--Systran--faster-whisper-{type}
      const models = files
        .filter((f) => f.toLowerCase().startsWith('models--systran--faster-whisper-'))
        .map((f) => f.substring('models--Systran--faster-whisper-'.length))

      return models
    } catch (error) {
      console.error('Error listing models:', error)
      return []
    }
  }

  async deleteModel(modelType: string): Promise<void> {
    const modelsPath = join(app.getPath('userData'), 'models')
    const modelDir = join(modelsPath, `models--Systran--faster-whisper-${modelType}`)

    if (!fs.existsSync(modelDir)) {
      throw new Error(`Model ${modelType} not found`)
    }

    try {
      fs.rmSync(modelDir, { recursive: true, force: true })
      console.log(`[LocalRecognizer] Deleted model: ${modelType}`)
    } catch (error) {
      throw new Error(`Failed to delete model: ${error}`)
    }
  }

  /**
   * Stop the HTTP server (call on app quit)
   */
  async stopServer(): Promise<void> {
    if (this.whisperServer) {
      await this.whisperServer.stop()
    }
  }

  /**
   * Check if HTTP server is running
   */
  async isServerRunning(): Promise<boolean> {
    if (!this.whisperServer) {
      return false
    }
    return this.whisperServer.isHealthy()
  }

  /**
   * Start the HTTP server manually
   */
  async startServer(): Promise<void> {
    if (this.whisperServer) {
      await this.whisperServer.start()
    }
  }
}
