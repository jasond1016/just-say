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

export interface WhisperServerConfig {
  host?: string
  port?: number
  modelType?: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3'
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
  error?: string
}

export interface GpuInfo {
  cuda_available: boolean
  device_name: string | null
  recommended_device: 'cpu' | 'cuda'
  recommended_compute_type: string
}

class WhisperServerClient {
  private config: {
    host: string
    port: number
    modelType: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3'
    device: 'cpu' | 'cuda'
    computeType: string
    autoStart: boolean
    mode: 'local' | 'remote'
    downloadRoot?: string
  }
  private serverProcess: ChildProcess | null = null
  private pythonPath: string
  private scriptPath: string
  private isStarting = false
  private startPromise: Promise<void> | null = null

  constructor(config?: WhisperServerConfig) {
    this.config = {
      host: '127.0.0.1',
      port: 8765,
      modelType: 'tiny',
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
      '--device',
      this.config.device,
      '--compute-type',
      this.config.computeType
    ]

    args.push('--download-root', downloadRoot)

    // Pre-load model on startup
    if (this.config.modelType) {
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
    })

    this.serverProcess.on('error', (err) => {
      console.error('[WhisperServer] Process error:', err)
      this.serverProcess = null
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
    computeType: string = 'int8'
  ): Promise<void> {
    await this.ensureRunning()
    const payload: Record<string, unknown> = {
      model: modelType,
      device,
      compute_type: computeType
    }
    const downloadRoot = this.modelsPath
    if (downloadRoot) {
      payload.download_root = downloadRoot
    }
    await this.httpPost('/model/load', payload)
  }

  /**
   * Unload current model to free memory
   */
  async unloadModel(): Promise<void> {
    await this.ensureRunning()
    await this.httpPost('/model/unload', {})
  }

  /**
   * Transcribe audio
   */
  async transcribe(
    audioBuffer: Buffer,
    options?: {
      modelType?: string
      device?: 'cpu' | 'cuda'
      computeType?: string
      language?: string
    }
  ): Promise<TranscribeResult> {
    await this.ensureRunning()

    const params = new URLSearchParams()

    if (options?.modelType) {
      params.set('model', options.modelType)
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
    const needsRestart =
      config.host !== undefined ||
      config.port !== undefined ||
      config.device !== undefined ||
      config.computeType !== undefined ||
      config.mode !== undefined ||
      config.downloadRoot !== undefined

    Object.assign(this.config, config)

    if (needsRestart && this.serverProcess) {
      await this.stop()
      if (this.config.mode === 'local') {
        await this.start()
      }
    } else if (config.modelType && this.serverProcess && this.config.mode === 'local') {
      // Just reload the model
      await this.loadModel(config.modelType, this.config.device, this.config.computeType)
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
