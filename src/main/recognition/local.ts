import { spawn, execSync } from 'child_process'
import { join } from 'path'
import { app } from 'electron'
import * as fs from 'fs'
import { EventEmitter } from 'events'
import { SpeechRecognizer, RecognitionResult } from './index'
import { getWhisperServer, WhisperServerClient, LocalEngine } from './whisperServer'

const DEFAULT_SENSEVOICE_MODEL_ID = 'FunAudioLLM/SenseVoiceSmall'
const SENSEVOICE_SMALL_MODEL_KEY = 'sensevoice-small'

interface LocalModelManifest {
  sensevoice?: Record<
    string,
    {
      modelId: string
      cachePath?: string
      downloadedAt: string
    }
  >
}

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
  engine?: LocalEngine
  modelType?: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3'
  sensevoice?: {
    modelId?: string
    useItn?: boolean
  }
  device?: 'cpu' | 'cuda' | 'auto'
  language?: string
  threads?: number
  computeType?: string
  useHttpServer?: boolean // Use HTTP server mode (recommended)
  serverMode?: 'local' | 'remote'
  serverHost?: string
  serverPort?: number
  sampleRate?: number
}

export class LocalRecognizer extends EventEmitter implements SpeechRecognizer {
  private config: LocalRecognizerConfig
  private pythonPath: string
  private scriptPath: string
  private static cachedGpuInfo: GpuInfo | null = null
  private static gpuDetectPromise: Promise<GpuInfo> | null = null
  private static autoComputeTypeHints = new Map<string, string>()
  private static globalPrewarmPromise: Promise<void> | null = null
  private static globalPrewarmKey: string | null = null
  private whisperServer: WhisperServerClient | null = null
  private prewarmPromise: Promise<void> | null = null
  private lastPrewarmKey: string | null = null
  private loggedFirstTranscribeWait = false

  constructor(config?: LocalRecognizerConfig) {
    super()
    this.config = {
      engine: 'faster-whisper',
      modelType: 'tiny',
      sensevoice: {
        modelId: DEFAULT_SENSEVOICE_MODEL_ID,
        useItn: true
      },
      device: 'auto',
      language: 'auto',
      threads: 4,
      computeType: 'auto',
      useHttpServer: true, // Default to HTTP server mode
      serverMode: 'local',
      serverHost: '127.0.0.1',
      serverPort: 8765,
      sampleRate: 16000,
      ...config
    } as LocalRecognizerConfig

    if (this.config.serverMode === 'remote') {
      this.config.useHttpServer = true
    }

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
      const serverMode = this.config.serverMode || 'local'
      const serverHost =
        serverMode === 'remote' ? this.config.serverHost || '127.0.0.1' : '127.0.0.1'
      const serverPort = this.config.serverPort || 8765

      this.whisperServer = getWhisperServer({
        mode: serverMode,
        host: serverHost,
        port: serverPort,
        engine: this.config.engine,
        modelType: this.config.modelType,
        sensevoiceModelId: this.getSenseVoiceModelId(),
        sensevoiceUseItn: this.shouldUseSenseVoiceItn(),
        device: this.resolveInitialDevice(),
        computeType: this.resolveInitialComputeType(),
        autoStart: serverMode === 'local'
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

  private createWavBuffer(pcmBuffer: Buffer, sampleRate?: number): Buffer {
    const resolvedSampleRate =
      typeof sampleRate === 'number' && Number.isFinite(sampleRate)
        ? sampleRate
        : this.config.sampleRate || 16000
    const numChannels = 1
    const bitsPerSample = 16
    const byteRate = (resolvedSampleRate * numChannels * bitsPerSample) / 8
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
    header.writeUInt32LE(resolvedSampleRate, 24)
    header.writeUInt32LE(byteRate, 28)
    header.writeUInt16LE(blockAlign, 32)
    header.writeUInt16LE(bitsPerSample, 34)
    header.write('data', 36)
    header.writeUInt32LE(dataSize, 40)

    return Buffer.concat([header, pcmBuffer])
  }

  async recognize(audioBuffer: Buffer): Promise<RecognitionResult> {
    if (this.isRemoteMode() && (!this.config.useHttpServer || !this.whisperServer)) {
      throw new Error('Remote server mode requires HTTP server')
    }

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
    const wavBuffer = this.createWavBuffer(audioBuffer)

    if (this.isRemoteMode()) {
      console.log('[LocalRecognizer] Recognizing via remote HTTP server (server-controlled params)')
      const requestOptions = {
        engine: this.config.engine,
        sensevoiceModelId: this.getSenseVoiceModelId(),
        sensevoiceUseItn: this.shouldUseSenseVoiceItn(),
        language: this.config.language
      }

      let remoteResult
      try {
        remoteResult = await this.whisperServer!.transcribe(wavBuffer, {
          ...requestOptions,
          skipHealthCheck: true
        })
      } catch (error) {
        // Remote fast path failed: run one checked retry for recovery.
        remoteResult = await this.whisperServer!.transcribe(wavBuffer, requestOptions)
        console.warn(
          '[LocalRecognizer] Remote fast transcribe failed, recovered via checked retry:',
          error instanceof Error ? error.message : String(error)
        )
      }
      if (!remoteResult.success) {
        throw new Error(remoteResult.error || 'Transcription failed')
      }
      return {
        text: remoteResult.text || '',
        language: remoteResult.language,
        confidence: remoteResult.language_probability,
        durationMs: (remoteResult.processing_time || 0) * 1000
      }
    }

    const { device, computeType } = await this.resolveAutoSettings()
    const autoComputeType =
      !this.config.computeType ||
      this.config.computeType === 'auto' ||
      this.config.computeType === 'default'

    console.log('[LocalRecognizer] Recognizing via HTTP server')
    const prewarmStart = Date.now()
    const runtime = {
      engine: this.getEngine(),
      modelType: this.config.modelType || 'tiny',
      sensevoiceModelId: this.getSenseVoiceModelId(),
      sensevoiceUseItn: this.shouldUseSenseVoiceItn(),
      device,
      computeType
    }
    await this.prewarmWithRuntime(runtime, 'recognize')
    if (!this.loggedFirstTranscribeWait) {
      this.loggedFirstTranscribeWait = true
      console.log(
        '[LocalRecognizer] First transcribe wait:',
        JSON.stringify({
          first_transcribe_wait_ms: Date.now() - prewarmStart,
          engine: this.getEngine()
        })
      )
    }

    const requestOptions = {
      engine: this.config.engine,
      modelType: this.config.modelType,
      sensevoiceModelId: this.getSenseVoiceModelId(),
      sensevoiceUseItn: this.shouldUseSenseVoiceItn(),
      device,
      computeType,
      language: this.config.language
    }
    const prewarmKey = this.getPrewarmKey(runtime)

    let result
    try {
      result = await this.whisperServer!.transcribe(wavBuffer, {
        ...requestOptions,
        skipHealthCheck: true
      })
    } catch (error) {
      // Fast path failed (server restarted / transient network error):
      // invalidate prewarm cache and retry once via full readiness check.
      this.invalidatePrewarmKey(prewarmKey)
      await this.prewarmWithRuntime(runtime, 'recover-transcribe')
      result = await this.whisperServer!.transcribe(wavBuffer, requestOptions)
      console.warn(
        '[LocalRecognizer] Fast transcribe failed, recovered via re-prewarm:',
        error instanceof Error ? error.message : String(error)
      )
    }

    if (!result.success) {
      const errMessage = result.error || 'Transcription failed'
      if (
        this.getEngine() === 'faster-whisper' &&
        autoComputeType &&
        device === 'cuda' &&
        computeType === 'float16' &&
        errMessage.includes('CUBLAS_STATUS_INVALID_VALUE')
      ) {
        console.warn('[LocalRecognizer] CUDA float16 failed, retrying with int8_float16')
        const retry = await this.whisperServer!.transcribe(wavBuffer, {
          engine: this.config.engine,
          modelType: this.config.modelType,
          sensevoiceModelId: this.getSenseVoiceModelId(),
          sensevoiceUseItn: this.shouldUseSenseVoiceItn(),
          device,
          computeType: 'int8_float16',
          language: this.config.language
        })
        if (retry.success) {
          this.rememberAutoComputeTypeHint(device, 'int8_float16')
          return {
            text: retry.text || '',
            language: retry.language,
            confidence: retry.language_probability,
            durationMs: (retry.processing_time || 0) * 1000
          }
        }
        throw new Error(retry.error || errMessage)
      }

      throw new Error(errMessage)
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
        '--engine',
        this.config.engine || 'faster-whisper',
        '--device',
        device,
        '--compute-type',
        computeType,
        '--download-root',
        modelsPath
      ]

      if ((this.config.engine || 'faster-whisper') === 'faster-whisper') {
        args.push('--model', this.config.modelType || 'tiny')
      } else {
        args.push('--sensevoice-model-id', this.getSenseVoiceModelId())
        args.push('--sensevoice-use-itn', this.shouldUseSenseVoiceItn() ? 'true' : 'false')
      }

      if (this.config.language && this.config.language !== 'auto') {
        args.push('--language', this.config.language)
      }

      console.log('[LocalRecognizer] Running:', this.pythonPath, args.join(' '))

      const proc = spawn(this.pythonPath, args, {
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          HF_HOME: modelsPath,
          MODELSCOPE_CACHE: modelsPath
        }
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
    if (this.isRemoteMode()) {
      if (!this.whisperServer) {
        return false
      }
      return this.whisperServer.isHealthy()
    }

    try {
      const checkScript =
        this.getEngine() === 'sensevoice'
          ? "import funasr; print('OK')"
          : "import faster_whisper; print('OK')"
      execSync(`${this.pythonPath} -c "${checkScript}"`, {
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

    if (LocalRecognizer.gpuDetectPromise) {
      return LocalRecognizer.gpuDetectPromise
    }

    LocalRecognizer.gpuDetectPromise = (async () => {
      if (this.isRemoteMode()) {
        if (!this.whisperServer) {
          throw new Error('Remote server not configured')
        }
        const info = await this.whisperServer.detectGpu()
        LocalRecognizer.cachedGpuInfo = info
        return info
      }

      return new Promise<GpuInfo>((resolve) => {
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
          LocalRecognizer.cachedGpuInfo = fallback
          resolve(fallback)
        })
      })
    })().finally(() => {
      LocalRecognizer.gpuDetectPromise = null
    })

    return LocalRecognizer.gpuDetectPromise
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
    if (this.isAutoComputeTypeConfigured()) {
      const hintKey = this.getAutoComputeHintKey(device)
      const hintedComputeType = LocalRecognizer.autoComputeTypeHints.get(hintKey)
      if (hintedComputeType) {
        return { device, computeType: hintedComputeType }
      }

      const fallbackComputeType = device === 'cuda' ? 'float16' : 'int8'
      computeType =
        device === gpuInfo.recommended_device
          ? gpuInfo.recommended_compute_type || fallbackComputeType
          : fallbackComputeType

      LocalRecognizer.autoComputeTypeHints.set(hintKey, computeType)
    } else {
      computeType = this.config.computeType as string
    }

    return { device, computeType }
  }

  async prewarm(reason = 'manual'): Promise<void> {
    if (!this.config.useHttpServer || !this.whisperServer || this.isRemoteMode()) {
      return
    }

    const { device, computeType } = await this.resolveAutoSettings()
    return this.prewarmWithRuntime(
      {
        engine: this.getEngine(),
        modelType: this.config.modelType || 'tiny',
        sensevoiceModelId: this.getSenseVoiceModelId(),
        sensevoiceUseItn: this.shouldUseSenseVoiceItn(),
        device,
        computeType
      },
      reason
    )
  }

  async downloadModel(modelType: string): Promise<void> {
    if (this.isRemoteMode()) {
      throw new Error('Remote mode does not support local model management')
    }

    const modelsPath = join(app.getPath('userData'), 'models')
    if (!fs.existsSync(modelsPath)) {
      fs.mkdirSync(modelsPath, { recursive: true })
    }

    return new Promise((resolve, reject) => {
      const args = [
        this.scriptPath,
        '--engine',
        this.getEngine(),
        '--sensevoice-model-id',
        this.getSenseVoiceModelId(),
        '--sensevoice-use-itn',
        this.shouldUseSenseVoiceItn() ? 'true' : 'false',
        '--model',
        modelType,
        '--download-root',
        modelsPath,
        '--download-only'
      ]

      console.log('[LocalRecognizer] Downloading model:', modelType)
      const proc = spawn(this.pythonPath, args, {
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          HF_HOME: modelsPath,
          MODELSCOPE_CACHE: modelsPath
        }
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
          if (this.getEngine() === 'sensevoice') {
            const manifest = this.readModelManifest()
            const key = this.resolveSenseVoiceModelKey(modelType)
            const cachePath = this.findSenseVoiceCachePath(modelsPath)
            manifest.sensevoice = {
              ...(manifest.sensevoice || {}),
              [key]: {
                modelId: this.getSenseVoiceModelId(),
                cachePath,
                downloadedAt: new Date().toISOString()
              }
            }
            this.writeModelManifest(manifest)
          }
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
    if (this.isRemoteMode()) {
      throw new Error('Remote mode does not support local model management')
    }

    const modelsPath = join(app.getPath('userData'), 'models')
    if (!fs.existsSync(modelsPath)) {
      return []
    }

    try {
      if (this.getEngine() === 'sensevoice') {
        const manifest = this.readModelManifest()
        return Object.keys(manifest.sensevoice || {})
      }

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
    if (this.isRemoteMode()) {
      throw new Error('Remote mode does not support local model management')
    }

    const modelsPath = join(app.getPath('userData'), 'models')

    if (this.getEngine() === 'sensevoice') {
      const key = this.resolveSenseVoiceModelKey(modelType)
      const manifest = this.readModelManifest()
      const entry = manifest.sensevoice?.[key]

      if (!entry) {
        throw new Error(`Model ${modelType} not found`)
      }

      if (entry.cachePath && fs.existsSync(entry.cachePath)) {
        fs.rmSync(entry.cachePath, { recursive: true, force: true })
      } else {
        const fallbackPaths = this.getSenseVoiceCacheCandidates(modelsPath)
        let removed = false
        for (const path of fallbackPaths) {
          if (fs.existsSync(path)) {
            fs.rmSync(path, { recursive: true, force: true })
            removed = true
          }
        }
        if (!removed) {
          throw new Error(
            'SenseVoice cache path not tracked. Please clean cache directory manually.'
          )
        }
      }

      const nextManifest: LocalModelManifest = {
        ...manifest,
        sensevoice: { ...(manifest.sensevoice || {}) }
      }
      delete nextManifest.sensevoice?.[key]
      this.writeModelManifest(nextManifest)
      console.log(`[LocalRecognizer] Deleted model: ${modelType}`)
      return
    }

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
    if (this.isRemoteMode()) {
      throw new Error('Remote mode does not support starting local server')
    }
    await this.prewarm('manual-start')
  }

  private isRemoteMode(): boolean {
    return this.config.serverMode === 'remote'
  }

  private getEngine(): LocalEngine {
    return this.config.engine || 'faster-whisper'
  }

  private getSenseVoiceModelId(): string {
    return this.config.sensevoice?.modelId || DEFAULT_SENSEVOICE_MODEL_ID
  }

  private shouldUseSenseVoiceItn(): boolean {
    return this.config.sensevoice?.useItn !== false
  }

  private resolveInitialDevice(): 'cpu' | 'cuda' {
    if (this.config.device === 'cuda' || this.config.device === 'cpu') {
      return this.config.device
    }
    return 'cpu'
  }

  private resolveInitialComputeType(): string {
    if (
      this.config.computeType &&
      this.config.computeType !== 'auto' &&
      this.config.computeType !== 'default'
    ) {
      return this.config.computeType
    }
    return this.resolveInitialDevice() === 'cuda' ? 'float16' : 'int8'
  }

  private isAutoComputeTypeConfigured(): boolean {
    return (
      !this.config.computeType ||
      this.config.computeType === 'auto' ||
      this.config.computeType === 'default'
    )
  }

  private getAutoComputeHintKey(device: 'cpu' | 'cuda'): string {
    const modelIdentity =
      this.getEngine() === 'sensevoice'
        ? this.getSenseVoiceModelId()
        : this.config.modelType || 'tiny'
    return `${this.getEngine()}|${modelIdentity}|${device}`
  }

  private rememberAutoComputeTypeHint(device: 'cpu' | 'cuda', computeType: string): void {
    if (!this.isAutoComputeTypeConfigured()) {
      return
    }
    LocalRecognizer.autoComputeTypeHints.set(this.getAutoComputeHintKey(device), computeType)
  }

  private getPrewarmKey(runtime: {
    engine: LocalEngine
    modelType: string
    sensevoiceModelId: string
    sensevoiceUseItn: boolean
    device: 'cpu' | 'cuda'
    computeType: string
  }): string {
    return JSON.stringify({
      mode: this.config.serverMode || 'local',
      host: this.config.serverHost || '127.0.0.1',
      port: this.config.serverPort || 8765,
      runtime
    })
  }

  private async ensureServerReadyAndPrewarmed(
    runtime: {
      engine: LocalEngine
      modelType: string
      sensevoiceModelId: string
      sensevoiceUseItn: boolean
      device: 'cpu' | 'cuda'
      computeType: string
    },
    reason: string
  ): Promise<void> {
    if (!this.whisperServer) {
      throw new Error('Whisper server client is not initialized')
    }

    const key = this.getPrewarmKey(runtime)
    if (this.lastPrewarmKey === key || LocalRecognizer.globalPrewarmKey === key) {
      return
    }

    await this.whisperServer.updateConfig({
      engine: runtime.engine,
      modelType: runtime.modelType as LocalRecognizerConfig['modelType'],
      sensevoiceModelId: runtime.sensevoiceModelId,
      sensevoiceUseItn: runtime.sensevoiceUseItn,
      device: runtime.device,
      computeType: runtime.computeType
    })

    let serverStartMs = 0
    if (!(await this.whisperServer.isHealthy())) {
      const serverStartAt = Date.now()
      await this.whisperServer.start()
      serverStartMs = Date.now() - serverStartAt
    }

    const loadStartAt = Date.now()
    await this.whisperServer.loadModel(runtime.modelType, runtime.device, runtime.computeType, {
      engine: runtime.engine,
      sensevoiceModelId: runtime.sensevoiceModelId,
      sensevoiceUseItn: runtime.sensevoiceUseItn
    })
    const prewarmMs = Date.now() - loadStartAt
    this.lastPrewarmKey = key
    LocalRecognizer.globalPrewarmKey = key
    console.log(
      '[LocalRecognizer] Prewarm complete:',
      JSON.stringify({
        reason,
        engine: runtime.engine,
        device: runtime.device,
        compute_type: runtime.computeType,
        server_start_ms: serverStartMs,
        prewarm_ms: prewarmMs
      })
    )
  }

  private async prewarmWithRuntime(
    runtime: {
      engine: LocalEngine
      modelType: string
      sensevoiceModelId: string
      sensevoiceUseItn: boolean
      device: 'cpu' | 'cuda'
      computeType: string
    },
    reason: string
  ): Promise<void> {
    if (this.prewarmPromise) {
      return this.prewarmPromise
    }

    this.prewarmPromise = (async () => {
      const key = this.getPrewarmKey(runtime)

      if (LocalRecognizer.globalPrewarmPromise) {
        await LocalRecognizer.globalPrewarmPromise
        if (LocalRecognizer.globalPrewarmKey === key) {
          this.lastPrewarmKey = key
          return
        }
      }

      const sharedPrewarm = this.ensureServerReadyAndPrewarmed(runtime, reason)
      LocalRecognizer.globalPrewarmPromise = sharedPrewarm
      try {
        await sharedPrewarm
      } finally {
        if (LocalRecognizer.globalPrewarmPromise === sharedPrewarm) {
          LocalRecognizer.globalPrewarmPromise = null
        }
      }
    })().finally(() => {
      this.prewarmPromise = null
    })

    return this.prewarmPromise
  }

  private invalidatePrewarmKey(key: string): void {
    if (this.lastPrewarmKey === key) {
      this.lastPrewarmKey = null
    }
    if (LocalRecognizer.globalPrewarmKey === key) {
      LocalRecognizer.globalPrewarmKey = null
    }
  }

  private resolveSenseVoiceModelKey(modelType: string): string {
    return modelType === SENSEVOICE_SMALL_MODEL_KEY ? modelType : SENSEVOICE_SMALL_MODEL_KEY
  }

  private getModelManifestPath(modelsPath: string): string {
    return join(modelsPath, 'justsay-models.json')
  }

  private readModelManifest(): LocalModelManifest {
    const modelsPath = join(app.getPath('userData'), 'models')
    if (!fs.existsSync(modelsPath)) {
      return {}
    }
    const manifestPath = this.getModelManifestPath(modelsPath)
    if (!fs.existsSync(manifestPath)) {
      return {}
    }
    try {
      const raw = fs.readFileSync(manifestPath, 'utf8')
      return JSON.parse(raw) as LocalModelManifest
    } catch (error) {
      console.error('[LocalRecognizer] Failed to read model manifest:', error)
      return {}
    }
  }

  private writeModelManifest(manifest: LocalModelManifest): void {
    const modelsPath = join(app.getPath('userData'), 'models')
    if (!fs.existsSync(modelsPath)) {
      fs.mkdirSync(modelsPath, { recursive: true })
    }
    const manifestPath = this.getModelManifestPath(modelsPath)
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  }

  private getSenseVoiceCacheCandidates(modelsPath: string): string[] {
    return [
      join(modelsPath, 'hub', 'models--FunAudioLLM--SenseVoiceSmall'),
      join(modelsPath, 'models--FunAudioLLM--SenseVoiceSmall'),
      join(modelsPath, 'FunAudioLLM', 'SenseVoiceSmall')
    ]
  }

  private findSenseVoiceCachePath(modelsPath: string): string | undefined {
    for (const path of this.getSenseVoiceCacheCandidates(modelsPath)) {
      if (fs.existsSync(path)) {
        return path
      }
    }
    return undefined
  }
}
