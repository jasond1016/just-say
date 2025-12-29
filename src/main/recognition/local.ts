import { spawn, execSync } from 'child_process'
import { join } from 'path'
import { app } from 'electron'
import * as fs from 'fs'
import { SpeechRecognizer, RecognitionResult } from './index'

export interface LocalRecognizerConfig {
  modelPath?: string
  modelType?: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3'
  device?: 'cpu' | 'cuda'
  language?: string
  threads?: number
  computeType?: string
}

export class LocalRecognizer implements SpeechRecognizer {
  private config: LocalRecognizerConfig
  private pythonPath: string
  private scriptPath: string

  constructor(config?: LocalRecognizerConfig) {
    this.config = {
      modelType: 'tiny',
      device: 'cpu',
      language: 'auto',
      threads: 4,
      computeType: 'int8',
      ...config
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

  async recognize(audioBuffer: Buffer): Promise<RecognitionResult> {
    return new Promise((resolve, reject) => {
      // Write audio to temp file
      const tempDir = join(app.getPath('temp'), 'justsay')
      const audioPath = join(tempDir, `input_${Date.now()}.wav`)

      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true })
      }

      fs.writeFileSync(audioPath, audioBuffer)

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
        this.config.device || 'cpu',
        '--compute-type',
        this.config.computeType || 'int8',
        '--download-root',
        modelsPath
      ]

      if (this.config.language && this.config.language !== 'auto') {
        args.push('--language', this.config.language)
      }

      // console.log('[LocalRecognizer] Running:', this.pythonPath, args.slice(0, 4).join(' '), '...')
      console.log('[LocalRecognizer] Running:', this.pythonPath, args.join(' '))

      const proc = spawn(this.pythonPath, args)
      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        // Cleanup
        try {
          fs.unlinkSync(audioPath)
        } catch {
          /* ignore */
        }

        if (code === 0) {
          try {
            const result = JSON.parse(stdout.trim())
            resolve({
              text: result.text || '',
              language: result.language,
              confidence: result.language_probability,
              durationMs: 0
            })
          } catch {
            resolve({ text: stdout.trim(), durationMs: 0 })
          }
        } else {
          reject(new Error(`Failed (code ${code}): ${stderr}`))
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
      const proc = spawn(this.pythonPath, args)

      let stderr = ''

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
        console.log('[Download Progress]', data.toString().trim())
      })

      proc.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`Download failed: ${stderr}`))
        }
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
      // Filter for hugginface cache folders
      // Format: models--systran--faster-whisper-{type}
      const models = files
        .filter((f) => f.startsWith('models--systran--faster-whisper-'))
        .map((f) => f.replace('models--systran--faster-whisper-', ''))

      return models
    } catch (error) {
      console.error('Error listing models:', error)
      return []
    }
  }
}
