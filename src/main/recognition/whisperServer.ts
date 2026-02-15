/**
 * Whisper HTTP Server 客户端
 *
 * 管理本地 Whisper 服务器进程，提供 HTTP API 调用。
 * 模型常驻内存，首次请求后延迟降至 200-500ms。
 */

import { spawn, ChildProcess, execSync } from 'child_process'
import { join } from 'path'
import { app } from 'electron'
import * as fs from 'fs'
import * as http from 'http'

export type LocalEngine = 'faster-whisper' | 'sensevoice'

export interface WhisperServerConfig {
  host?: string
  port?: number
  modelType?: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3'
  engine?: LocalEngine
  sensevoiceModelId?: string
  sensevoiceUseItn?: boolean
  device?: 'cpu' | 'cuda'
  computeType?: string
  autoStart?: boolean
  mode?: 'local' | 'remote'
  downloadRoot?: string
}

export interface TranscribeResult {
  success: boolean
  text: string
  language?: string
  language_probability?: number
  duration?: number
  processing_time?: number
  device?: string
  compute_type?: string
  model_reused?: boolean
  reload_reason?: string
  error?: string
}

export interface GpuInfo {
  cuda_available: boolean
  device_name: string | null
  recommended_device: 'cpu' | 'cuda'
  recommended_compute_type: string
}

type WhisperServerRuntimeConfig = {
  host: string
  port: number
  modelType: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3'
  engine: LocalEngine
  sensevoiceModelId: string
  sensevoiceUseItn: boolean
  device: 'cpu' | 'cuda'
  computeType: string
  autoStart: boolean
  mode: 'local' | 'remote'
  downloadRoot?: string
}

class WhisperServerClient {
  private config: WhisperServerRuntimeConfig
  private serverProcess: ChildProcess | null = null
  private pythonPath: string
  private scriptPath: string
  private isStarting = false
  private startPromise: Promise<void> | null = null
  private lastLoadedModelSignature: string | null = null

  constructor(config?: WhisperServerConfig) {
    this.config = {
      host: '127.0.0.1',
      port: 8765,
      modelType: 'tiny',
      engine: 'faster-whisper',
      sensevoiceModelId: 'FunAudioLLM/SenseVoiceSmall',
      sensevoiceUseItn: true,
      device: 'cpu',
      computeType: 'int8',
      autoStart: true,
      mode: 'local',
      ...config
    }

    const projectRoot = app.isPackaged ? process.resourcesPath : app.getAppPath()
    this.scriptPath = join(projectRoot, 'python', 'whisper_server.py')
    this.pythonPath = this.findPython(projectRoot)
  }

  private findPython(projectRoot: string): string {
    const platform = process.platform
    const venvPath =
      platform === 'win32'
        ? join(projectRoot, 'python', '.venv', 'Scripts', 'python.exe')
        : join(projectRoot, 'python', '.venv', 'bin', 'python')

    if (fs.existsSync(venvPath)) {
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

  private get baseUrl(): string {
    return `http://${this.config.host}:${this.config.port}`
  }

  private get modelsPath(): string | undefined {
    if (this.config.mode !== 'local') {
      return undefined
    }

    const path = this.config.downloadRoot || join(app.getPath('userData'), 'models')
    if (!fs.existsSync(path)) {
      fs.mkdirSync(path, { recursive: true })
    }
    return path
  }

  /**
   * Start the whisper server process
   */
  async start(): Promise<void> {
    if (this.config.mode === 'remote') {
      throw new Error('Remote mode does not start local server')
    }

    if (this.serverProcess) {
      return // Already running
    }

    if (this.isStarting && this.startPromise) {
      return this.startPromise
    }

    this.isStarting = true
    this.startPromise = this.doStart()

    try {
      await this.startPromise
    } finally {
      this.isStarting = false
      this.startPromise = null
    }
  }

  private async doStart(): Promise<void> {
    // Check if server is already running (maybe from previous session)
    if (await this.isHealthy()) {
      console.log('[WhisperServer] Server already running')
      return
    }

    const downloadRoot = this.modelsPath
    if (!downloadRoot) {
      throw new Error('Local models path is not available')
    }

    const args = [
      this.scriptPath,
      '--host',
      this.config.host,
      '--port',
      this.config.port.toString(),
      '--engine',
      this.config.engine,
      '--device',
      this.config.device,
      '--compute-type',
      this.config.computeType,
      '--sensevoice-model-id',
      this.config.sensevoiceModelId,
      '--sensevoice-use-itn',
      this.config.sensevoiceUseItn ? 'true' : 'false'
    ]

    args.push('--download-root', downloadRoot)

    // Pre-load model on startup
    if (this.config.engine === 'faster-whisper' && this.config.modelType) {
      args.push('--preload-model', this.config.modelType)
    }

    console.log('[WhisperServer] Starting server:', this.pythonPath, args.join(' '))

    this.serverProcess = spawn(this.pythonPath, args, {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    this.serverProcess.stdout?.on('data', (data: Buffer) => {
      console.log('[WhisperServer]', data.toString().trim())
    })

    this.serverProcess.stderr?.on('data', (data: Buffer) => {
      console.error('[WhisperServer]', data.toString().trim())
    })

    this.serverProcess.on('close', (code) => {
      console.log(`[WhisperServer] Process exited with code ${code}`)
      this.serverProcess = null
      this.lastLoadedModelSignature = null
    })

    this.serverProcess.on('error', (err) => {
      console.error('[WhisperServer] Process error:', err)
      this.serverProcess = null
      this.lastLoadedModelSignature = null
    })

    // Wait for server to be ready
    await this.waitForReady(30000)
  }

  private async waitForReady(timeoutMs: number): Promise<void> {
    const startTime = Date.now()
    const pollInterval = 200

    while (Date.now() - startTime < timeoutMs) {
      if (await this.isHealthy()) {
        console.log('[WhisperServer] Server is ready')
        return
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval))
    }

    throw new Error('Server failed to start within timeout')
  }

  /**
   * Stop the server process
   */
  async stop(): Promise<void> {
    if (this.config.mode === 'remote') {
      return
    }

    if (!this.serverProcess) {
      return
    }

    console.log('[WhisperServer] Stopping server')
    this.serverProcess.kill('SIGTERM')

    // Wait for graceful shutdown
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.serverProcess) {
          this.serverProcess.kill('SIGKILL')
        }
        resolve()
      }, 5000)

      this.serverProcess?.on('close', () => {
        clearTimeout(timeout)
        resolve()
      })
    })

    this.serverProcess = null
    this.lastLoadedModelSignature = null
  }

  /**
   * Check if server is healthy
   */
  async isHealthy(): Promise<boolean> {
    try {
      const result = await this.httpGet<{ status: string }>('/health')
      return result.status === 'ok'
    } catch {
      return false
    }
  }

  /**
   * Detect GPU capabilities
   */
  async detectGpu(): Promise<GpuInfo> {
    await this.ensureRunning()
    return this.httpGet<GpuInfo>('/gpu')
  }

  /**
   * Pre-load a model
   */
  async loadModel(
    modelType: string,
    device: 'cpu' | 'cuda' = 'cpu',
    computeType: string = 'int8',
    options?: {
      engine?: LocalEngine
      sensevoiceModelId?: string
      sensevoiceUseItn?: boolean
    }
  ): Promise<void> {
    await this.ensureRunning()
    const engine = options?.engine || this.config.engine
    const signature = this.getModelLoadSignature(modelType, device, computeType, options)
    if (this.lastLoadedModelSignature === signature) {
      console.log('[WhisperServer] Skipping duplicate model load request')
      return
    }

    const payload: Record<string, unknown> = {
      engine,
      device,
      compute_type: computeType
    }
    if (engine === 'faster-whisper') {
      payload.model = modelType
    } else {
      payload.sensevoice_model_id = options?.sensevoiceModelId || this.config.sensevoiceModelId
      payload.sensevoice_use_itn =
        options?.sensevoiceUseItn !== undefined
          ? options.sensevoiceUseItn
          : this.config.sensevoiceUseItn
    }
    const downloadRoot = this.modelsPath
    if (downloadRoot) {
      payload.download_root = downloadRoot
    }
    await this.httpPost('/model/load', payload)
    this.lastLoadedModelSignature = signature
  }

  /**
   * Unload current model to free memory
   */
  async unloadModel(): Promise<void> {
    await this.ensureRunning()
    await this.httpPost('/model/unload', {})
    this.lastLoadedModelSignature = null
  }

  /**
   * Transcribe audio
   */
  async transcribe(
    audioBuffer: Buffer,
    options?: {
      modelType?: string
      engine?: LocalEngine
      sensevoiceModelId?: string
      sensevoiceUseItn?: boolean
      device?: 'cpu' | 'cuda'
      computeType?: string
      language?: string
      skipHealthCheck?: boolean
    }
  ): Promise<TranscribeResult> {
    if (!options?.skipHealthCheck) {
      await this.ensureRunning()
    }

    const params = new URLSearchParams()

    const engine = options?.engine || this.config.engine
    params.set('engine', engine)

    if (engine === 'faster-whisper') {
      params.set('model', options?.modelType || this.config.modelType)
    } else {
      params.set(
        'sensevoice_model_id',
        options?.sensevoiceModelId || this.config.sensevoiceModelId
      )
      params.set(
        'sensevoice_use_itn',
        (options?.sensevoiceUseItn !== undefined
          ? options.sensevoiceUseItn
          : this.config.sensevoiceUseItn
        )
          ? 'true'
          : 'false'
      )
    }
    if (options?.device) {
      params.set('device', options.device)
    }
    if (options?.computeType) {
      params.set('compute_type', options.computeType)
    }

    if (options?.language && options.language !== 'auto') {
      params.set('language', options.language)
    }

    const downloadRoot = this.modelsPath
    if (downloadRoot) {
      params.set('download_root', downloadRoot)
    }

    const query = params.toString()
    const endpoint = query ? `/transcribe?${query}` : '/transcribe'
    return this.httpPostBinary(endpoint, audioBuffer)
  }

  private async ensureRunning(): Promise<void> {
    if (this.config.mode === 'remote') {
      const healthy = await this.isHealthy()
      if (!healthy) {
        throw new Error('Remote server not available')
      }
      return
    }

    if (this.config.autoStart && !(await this.isHealthy())) {
      await this.start()
    }
  }

  private getModelLoadSignature(
    modelType: string,
    device: 'cpu' | 'cuda',
    computeType: string,
    options?: {
      engine?: LocalEngine
      sensevoiceModelId?: string
      sensevoiceUseItn?: boolean
    }
  ): string {
    const engine = options?.engine || this.config.engine
    const signature: Record<string, unknown> = {
      engine,
      device,
      computeType,
      downloadRoot: this.modelsPath || null
    }

    if (engine === 'faster-whisper') {
      signature.modelType = modelType
    } else {
      signature.sensevoiceModelId = options?.sensevoiceModelId || this.config.sensevoiceModelId
      signature.sensevoiceUseItn =
        options?.sensevoiceUseItn !== undefined
          ? options.sensevoiceUseItn
          : this.config.sensevoiceUseItn
    }

    return JSON.stringify(signature)
  }

  private httpGet<T>(path: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = http.get(`${this.baseUrl}${path}`, (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch {
            reject(new Error(`Invalid JSON response: ${data}`))
          }
        })
      })

      req.on('error', reject)
      req.setTimeout(10000, () => {
        req.destroy()
        reject(new Error('Request timeout'))
      })
    })
  }

  private httpPost<T>(path: string, body: object): Promise<T> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body)

      const req = http.request(
        `${this.baseUrl}${path}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
          }
        },
        (res) => {
          let responseData = ''
          res.on('data', (chunk) => (responseData += chunk))
          res.on('end', () => {
            try {
              resolve(JSON.parse(responseData))
            } catch {
              reject(new Error(`Invalid JSON response: ${responseData}`))
            }
          })
        }
      )

      req.on('error', reject)
      req.setTimeout(60000, () => {
        req.destroy()
        reject(new Error('Request timeout'))
      })

      req.write(data)
      req.end()
    })
  }

  private httpPostBinary<T>(path: string, buffer: Buffer): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${this.baseUrl}${path}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'audio/wav',
            'Content-Length': buffer.length
          }
        },
        (res) => {
          let data = ''
          res.on('data', (chunk) => (data += chunk))
          res.on('end', () => {
            try {
              resolve(JSON.parse(data))
            } catch {
              reject(new Error(`Invalid JSON response: ${data}`))
            }
          })
        }
      )

      req.on('error', reject)
      req.setTimeout(120000, () => {
        req.destroy()
        reject(new Error('Request timeout'))
      })

      req.write(buffer)
      req.end()
    })
  }

  /**
   * Update configuration (will restart server if needed)
   */
  async updateConfig(config: Partial<WhisperServerConfig>): Promise<void> {
    const prev = { ...this.config }
    const next: WhisperServerRuntimeConfig = { ...this.config, ...config }
    const needsRestart =
      prev.host !== next.host ||
      prev.port !== next.port ||
      prev.mode !== next.mode
    const needsReload =
      prev.modelType !== next.modelType ||
      prev.engine !== next.engine ||
      prev.sensevoiceModelId !== next.sensevoiceModelId ||
      prev.sensevoiceUseItn !== next.sensevoiceUseItn ||
      prev.device !== next.device ||
      prev.computeType !== next.computeType ||
      prev.downloadRoot !== next.downloadRoot

    this.config = next

    if (needsRestart && this.serverProcess) {
      await this.stop()
      if (this.config.mode === 'local') {
        await this.start()
      }
    } else if (needsReload && this.config.mode === 'local') {
      // Just reload the model
      await this.loadModel(
        this.config.modelType,
        this.config.device,
        this.config.computeType,
        {
          engine: this.config.engine,
          sensevoiceModelId: this.config.sensevoiceModelId,
          sensevoiceUseItn: this.config.sensevoiceUseItn
        }
      )
    }
  }
}

// Singleton instance
let _instance: WhisperServerClient | null = null

export function getWhisperServer(config?: WhisperServerConfig): WhisperServerClient {
  if (!_instance) {
    _instance = new WhisperServerClient(config)
  } else if (config) {
    void _instance.updateConfig(config).catch((err) => {
      console.error('[WhisperServer] Failed to update config:', err)
    })
  }
  return _instance
}

export { WhisperServerClient }
