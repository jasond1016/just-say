import { app, shell, BrowserWindow, ipcMain, screen, desktopCapturer } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { setupTray, updateTrayStatus } from './tray'
import { HotkeyManager } from './hotkey'
import { initConfig, getConfig, setConfig, AppConfig } from './config'
import { initSecureStore, getApiKey, setApiKey, deleteApiKey, hasApiKey } from './secureStore'
import { initDatabase } from './database'
import {
  createTranscript,
  getTranscriptWithSegments,
  listTranscripts,
  searchTranscripts,
  updateTranscript,
  deleteTranscript,
  exportTranscript
} from './database/transcriptStore'
import { WebAudioRecorder } from './audio/web-recorder'
import { WebStreamingAudioRecorder } from './audio/web-streaming-recorder'
import { RecognitionController, DownloadProgress } from './recognition'
import { WhisperServerClient } from './recognition/whisperServer'
import { StreamingSonioxRecognizer } from './recognition/streaming-soniox'
import { InputSimulator } from './input/simulator'
import { MeetingTranscriptionManager } from './meeting-transcription'

// Window references
let mainWindow: BrowserWindow | null = null
let indicatorWindow: BrowserWindow | null = null
let meetingWindow: BrowserWindow | null = null

// Core modules
let hotkeyManager: HotkeyManager | null = null
let audioRecorder: WebAudioRecorder | null = null
let webStreamingRecorder: WebStreamingAudioRecorder | null = null
let streamingSoniox: StreamingSonioxRecognizer | null = null
let recognitionController: RecognitionController | null = null
let inputSimulator: InputSimulator | null = null
let meetingTranscription: MeetingTranscriptionManager | null = null

function getRecognitionSignature(config: AppConfig): string {
  return JSON.stringify({
    recognition: config.recognition ?? null,
    sampleRate: config.audio?.sampleRate ?? null
  })
}

function shouldRecreateRecognition(prev: AppConfig, next: AppConfig): boolean {
  return getRecognitionSignature(prev) !== getRecognitionSignature(next)
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : { icon }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // Completely remove the menu bar
  window.setMenuBarVisibility(false)
  window.setMenu(null)

  window.on('ready-to-show', () => {
    window.maximize()
    window.show()
  })

  window.on('close', (e) => {
    const config = getConfig()
    if (config.general?.minimizeToTray !== false) {
      // Minimize to tray instead of closing
      e.preventDefault()
      window.hide()
    }
    // If minimizeToTray is false, allow the window to close normally
  })

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

function createIndicatorWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 220,
    height: 60,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // Position at center bottom
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize
  window.setPosition(Math.round((screenWidth - 220) / 2), screenHeight - 100)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/indicator.html`)
  } else {
    window.loadFile(join(__dirname, '../renderer/indicator.html'))
  }

  return window
}

function createMeetingWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 700,
    height: 600,
    show: false,
    autoHideMenuBar: true,
    title: '会议转录 - JustSay',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  window.on('close', (e) => {
    // Stop transcription when window closes
    if (meetingTranscription?.getStatus() === 'transcribing') {
      meetingTranscription.stopTranscription()
    }
    e.preventDefault()
    window.hide()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/meeting.html`)
  } else {
    window.loadFile(join(__dirname, '../renderer/meeting.html'))
  }

  return window
}

function showMeetingWindow(): void {
  if (!meetingWindow) {
    meetingWindow = createMeetingWindow()
  }
  meetingWindow.show()

  // Pre-connect to recognition service to reduce latency
  const config = getConfig()
  if (!meetingTranscription) {
    meetingTranscription = new MeetingTranscriptionManager({
      ...(config.recognition?.soniox || {}),
      sampleRate: config.audio?.sampleRate
    })
  }
  // Fire and forget - don't block window showing
  meetingTranscription.preConnect().catch((err) => {
    console.error('[Main] Pre-connect failed:', err)
  })
}

async function initializeApp(): Promise<void> {
  // Initialize config, secure store, and database
  initConfig()
  initSecureStore()
  initDatabase()
  const config = getConfig()

  // Create windows
  mainWindow = createMainWindow()
  indicatorWindow = createIndicatorWindow()

  // Setup tray with callbacks
  setupTray({
    showMainWindow: () => mainWindow?.show()
  })

  // Initialize modules
  audioRecorder = new WebAudioRecorder()
  recognitionController = new RecognitionController(config)
  inputSimulator = new InputSimulator()
  hotkeyManager = new HotkeyManager()

  // Check if using streaming Soniox
  const useStreamingSoniox =
    config.recognition?.backend === 'soniox' && config.recognition?.soniox?.apiKey

  if (useStreamingSoniox) {
    console.log('[Main] Using streaming Soniox mode with Web Audio')
    webStreamingRecorder = new WebStreamingAudioRecorder()
    streamingSoniox = new StreamingSonioxRecognizer({
      ...(config.recognition?.soniox || {}),
      sampleRate: config.audio?.sampleRate
    })

    // Pre-initialize the hidden window for faster first recording
    webStreamingRecorder.initialize().catch((err) => {
      console.error('[Main] Failed to pre-initialize audio capture window:', err)
    })

    // Streaming mode: start WebSocket connection and recording together
    hotkeyManager.on('recordStart', async () => {
      console.log('[Main] Recording started (streaming)')
      updateTrayStatus('recording')
      indicatorWindow?.show()
      indicatorWindow?.webContents.send('recording-state', { recording: true })

      try {
        // Start WebSocket connection first
        await streamingSoniox?.startSession()

        // Forward audio chunks to Soniox
        webStreamingRecorder?.on('data', (chunk: Buffer) => {
          streamingSoniox?.sendAudioChunk(chunk)
        })

        // Start recording
        await webStreamingRecorder?.startRecording()
      } catch (error) {
        console.error('[Main] Streaming start error:', error)
        updateTrayStatus('idle')
        indicatorWindow?.hide()
      }
    })

    hotkeyManager.on('recordStop', async () => {
      const stopTime = Date.now()
      console.log('[Main] Recording stopped (streaming)')
      updateTrayStatus('processing')
      indicatorWindow?.webContents.send('recording-state', { recording: false, processing: true })

      try {
        // Stop recording
        webStreamingRecorder?.stopRecording()
        webStreamingRecorder?.removeAllListeners('data')

        // Get final result
        const result = await streamingSoniox?.endSession()
        console.log(
          `[Main] Recognition done in ${result?.durationMs}ms (${Date.now() - stopTime}ms after stop): "${result?.text}"`
        )

        if (result?.text) {
          await inputSimulator?.typeText(result.text)
        }
      } catch (error) {
        console.error('[Main] Streaming recognition error:', error)
      } finally {
        updateTrayStatus('idle')
        indicatorWindow?.hide()
      }
    })
  } else {
    // Non-streaming mode (local, api, network)
    // Pre-initialize the hidden window for faster first recording
    audioRecorder?.initialize().catch((err) => {
      console.error('[Main] Failed to pre-initialize audio recorder window:', err)
    })

    hotkeyManager.on('recordStart', async () => {
      console.log('[Main] Recording started')
      updateTrayStatus('recording')
      indicatorWindow?.show()
      indicatorWindow?.webContents.send('recording-state', { recording: true })
      await audioRecorder?.startRecording()
    })

    hotkeyManager.on('recordStop', async () => {
      console.log('[Main] Recording stopped')
      updateTrayStatus('processing')
      indicatorWindow?.webContents.send('recording-state', { recording: false, processing: true })

      try {
        const audioBuffer = await audioRecorder?.stopRecording()
        if (audioBuffer && audioBuffer.length > 0) {
          const result = await recognitionController?.recognize(audioBuffer)
          if (result?.text) {
            await inputSimulator?.typeText(result.text)
          }
        }
      } catch (error) {
        console.error('[Main] Recognition error:', error)
      } finally {
        updateTrayStatus('idle')
        indicatorWindow?.hide()
      }
    })
  }

  // Start hotkey listener
  hotkeyManager.start()
  console.log('[Main] JustSay ready! Press Right Alt to record.')
}

// App lifecycle
app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.justsay.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  await initializeApp()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  // Don't quit - we're a tray app
})

app.on('before-quit', () => {
  hotkeyManager?.stop()
  // Allow all windows to close on quit
  mainWindow?.removeAllListeners('close')
  meetingWindow?.removeAllListeners('close')
  indicatorWindow?.removeAllListeners('close')
})

// IPC handlers
ipcMain.handle('get-config', () => getConfig())

ipcMain.handle('set-config', (_event, config) => {
  const prevConfig = getConfig()
  setConfig(config)
  const nextConfig = getConfig()
  if (!recognitionController || shouldRecreateRecognition(prevConfig, nextConfig)) {
    recognitionController = new RecognitionController(nextConfig)
  }
})

ipcMain.handle('show-settings', () => {
  mainWindow?.show()
})

ipcMain.handle('quit-app', () => {
  app.quit()
})

ipcMain.handle('show-meeting-window', () => {
  showMeetingWindow()
})

ipcMain.handle('get-local-models', async () => {
  return recognitionController?.getLocalModels() || []
})

ipcMain.handle('download-model', async (_event, modelType) => {
  if (!recognitionController) return

  // Forward progress events to renderer
  const onProgress = (progress: DownloadProgress): void => {
    mainWindow?.webContents.send('download-progress', progress)
  }
  recognitionController.on('download-progress', onProgress)

  try {
    await recognitionController.downloadModel(modelType)
  } finally {
    recognitionController.off('download-progress', onProgress)
  }
})

ipcMain.handle('delete-model', async (_event, modelType) => {
  await recognitionController?.deleteModel(modelType)
})

ipcMain.handle('test-whisper-remote', async (_event, options?: { host?: string; port?: number }) => {
  const host = options?.host || '127.0.0.1'
  const port = typeof options?.port === 'number' ? options.port : 8765
  const client = new WhisperServerClient({ mode: 'remote', host, port, autoStart: false })
  return client.isHealthy()
})

// Meeting transcription IPC handlers
ipcMain.handle('get-system-audio-sources', async () => {
  if (!meetingTranscription) {
    const config = getConfig()
    meetingTranscription = new MeetingTranscriptionManager({
      ...(config.recognition?.soniox || {}),
      sampleRate: config.audio?.sampleRate
    })
  }
  return meetingTranscription.getSystemAudioSources()
})

ipcMain.handle('start-meeting-transcription', async (_event, options) => {
  const config = getConfig()

  if (!meetingTranscription) {
    meetingTranscription = new MeetingTranscriptionManager({
      ...(config.recognition?.soniox || {}),
      sampleRate: config.audio?.sampleRate
    })
  }

  // Set up event forwarding to renderer
  meetingTranscription.removeAllListeners()

  meetingTranscription.on('transcript', (segment) => {
    // Send to main window (embedded meeting transcription)
    mainWindow?.webContents.send('meeting-transcript', segment)
  })

  meetingTranscription.on('status', (status) => {
    mainWindow?.webContents.send('meeting-status', status)
  })

  meetingTranscription.on('error', (err) => {
    console.error('[Main] Meeting transcription error:', err)
    mainWindow?.webContents.send('meeting-status', 'error')
  })

  await meetingTranscription.startTranscription(options)
})

ipcMain.handle('stop-meeting-transcription', async () => {
  if (meetingTranscription) {
    await meetingTranscription.stopTranscription()
  }
})

// Desktop capturer IPC handler (for renderer to get screen sources)
ipcMain.handle('get-desktop-capturer-sources', async (_event, options: { types: string[] }) => {
  return desktopCapturer.getSources(options as Electron.SourcesOptions)
})

// System audio capture IPC handlers (audio captured in renderer, sent to main)
ipcMain.on('system-audio-chunk', (_event, chunk: ArrayBuffer) => {
  if (meetingTranscription) {
    meetingTranscription.handleRendererAudioChunk(Buffer.from(chunk))
  }
})

ipcMain.on('system-audio-started', () => {
  console.log('[Main] System audio capture started in renderer')
})

ipcMain.on('system-audio-stopped', () => {
  console.log('[Main] System audio capture stopped in renderer')
})

ipcMain.on('system-audio-error', (_event, message: string) => {
  console.error('[Main] System audio capture error:', message)
  mainWindow?.webContents.send('meeting-status', 'error')
})

// Microphone capture IPC handlers (audio captured in renderer, sent to main)
ipcMain.on('microphone-audio-chunk', (_event, chunk: ArrayBuffer) => {
  if (meetingTranscription) {
    meetingTranscription.handleMicrophoneAudioChunk(Buffer.from(chunk))
  }
})

ipcMain.on('microphone-started', () => {
  console.log('[Main] Microphone capture started in renderer')
})

ipcMain.on('microphone-stopped', () => {
  console.log('[Main] Microphone capture stopped in renderer')
})

ipcMain.on('microphone-error', (_event, message: string) => {
  console.error('[Main] Microphone capture error:', message)
  meetingWindow?.webContents.send('meeting-status', 'error')
})

// Secure API Key IPC handlers
ipcMain.handle('get-api-key', (_event, provider: 'soniox' | 'groq') => {
  return getApiKey(provider)
})

ipcMain.handle('set-api-key', (_event, provider: 'soniox' | 'groq', apiKey: string) => {
  setApiKey(provider, apiKey)
})

ipcMain.handle('delete-api-key', (_event, provider: 'soniox' | 'groq') => {
  deleteApiKey(provider)
})

ipcMain.handle('has-api-key', (_event, provider: 'soniox' | 'groq') => {
  return hasApiKey(provider)
})

// Transcript storage IPC handlers
ipcMain.handle('save-transcript', (_event, data: {
  title?: string
  note?: string
  duration_seconds: number
  translation_enabled: boolean
  target_language?: string
  include_microphone: boolean
  segments: {
    speaker: number
    text: string
    translated_text?: string
    sentence_pairs?: { original: string; translated?: string }[]
  }[]
}) => {
  return createTranscript(data)
})

ipcMain.handle('list-transcripts', (_event, options?: { page?: number; pageSize?: number; orderBy?: string; order?: string }) => {
  return listTranscripts(options as { page?: number; pageSize?: number; orderBy?: 'created_at' | 'updated_at' | 'duration_seconds'; order?: 'ASC' | 'DESC' } | undefined)
})

ipcMain.handle('search-transcripts', (_event, options: { query: string; page?: number; pageSize?: number }) => {
  return searchTranscripts(options)
})

ipcMain.handle('get-transcript', (_event, id: string) => {
  return getTranscriptWithSegments(id)
})

ipcMain.handle('update-transcript', (_event, id: string, data: { title?: string; note?: string }) => {
  return updateTranscript(id, data)
})

ipcMain.handle('delete-transcript', (_event, id: string) => {
  return deleteTranscript(id)
})

ipcMain.handle('export-transcript', (_event, id: string) => {
  return exportTranscript(id)
})
