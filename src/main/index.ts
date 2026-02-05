import { app, shell, BrowserWindow, ipcMain, screen, desktopCapturer, clipboard } from 'electron'
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
import { StreamingGroqConfig } from './recognition/streaming-groq'
import { StreamingSonioxConfig } from './recognition/streaming-soniox'

// Window references
let mainWindow: BrowserWindow | null = null
let indicatorWindow: BrowserWindow | null = null
let meetingWindow: BrowserWindow | null = null
let outputWindow: BrowserWindow | null = null
let pendingOutputText: string | null = null

type RecordingUiState = { recording?: boolean; processing?: boolean }
let currentRecordingState: RecordingUiState = { recording: false }

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

function isIndicatorEnabled(): boolean {
  return getConfig().ui?.indicatorEnabled !== false
}

function isSoundFeedbackEnabled(): boolean {
  return getConfig().ui?.soundFeedback !== false
}

function setIndicatorState(state: RecordingUiState): void {
  currentRecordingState = state

  if (!indicatorWindow) return
  if (!isIndicatorEnabled()) {
    indicatorWindow.hide()
    return
  }

  if (state.recording || state.processing) {
    indicatorWindow.show()
    indicatorWindow.webContents.send('recording-state', state)
  } else {
    indicatorWindow.hide()
    indicatorWindow.webContents.send('recording-state', state)
  }
}

function syncIndicatorVisibilityFromConfig(): void {
  if (!indicatorWindow) return
  if (!isIndicatorEnabled()) {
    indicatorWindow.hide()
    return
  }

  if (currentRecordingState.recording || currentRecordingState.processing) {
    indicatorWindow.show()
    indicatorWindow.webContents.send('recording-state', currentRecordingState)
  } else {
    indicatorWindow.hide()
  }
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

function createOutputWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 520,
    height: 240,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  window.setMenuBarVisibility(false)
  window.setMenu(null)

  window.on('close', (e) => {
    e.preventDefault()
    window.hide()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/output.html`)
  } else {
    window.loadFile(join(__dirname, '../renderer/output.html'))
  }

  window.webContents.on('did-finish-load', () => {
    if (pendingOutputText) {
      window.webContents.send('output-text', { text: pendingOutputText })
      pendingOutputText = null
    }
  })

  return window
}

function showOutputWindow(text: string): void {
  if (!text?.trim()) return

  if (!outputWindow) {
    outputWindow = createOutputWindow()
  }

  // Position near cursor (clamped to display work area)
  try {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const { x, y, width, height } = display.workArea
    const winW = 520
    const winH = 240
    const nextX = Math.min(Math.max(cursor.x - Math.round(winW / 2), x), x + width - winW)
    const nextY = Math.min(Math.max(cursor.y + 20, y), y + height - winH)
    outputWindow.setPosition(nextX, nextY)
  } catch (err) {
    console.warn('[Main] Failed to position output window:', err)
  }

  if (outputWindow.webContents.isLoading()) {
    pendingOutputText = text
  } else {
    outputWindow.webContents.send('output-text', { text })
  }

  // Show without stealing focus when possible
  try {
    outputWindow.showInactive()
  } catch {
    outputWindow.show()
  }
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
    meetingTranscription = createMeetingTranscriptionManager(config)
  }
  // Fire and forget - don't block window showing
  meetingTranscription.preConnect().catch((err) => {
    console.error('[Main] Pre-connect failed:', err)
  })
}

/**
 * Create MeetingTranscriptionManager based on global backend setting.
 * Supports both Soniox (streaming WebSocket) and Groq (REST API with buffering).
 */
function createMeetingTranscriptionManager(config: AppConfig): MeetingTranscriptionManager {
  const backend = config.recognition?.backend
  const sampleRate = config.audio?.sampleRate

  if (backend === 'groq') {
    // Groq backend: uses Whisper API for transcription + Chat API for translation
    const groqApiKey = getApiKey('groq')
    const groqConfig: StreamingGroqConfig = {
      apiKey: groqApiKey || undefined,
      whisperModel: config.recognition?.groq?.model || 'whisper-large-v3-turbo',
      chatModel: config.recognition?.groq?.chatModel || 'llama-3.3-70b-versatile',
      language: config.recognition?.language,
      sampleRate: sampleRate
    }
    console.log('[Main] Creating MeetingTranscriptionManager with Groq backend')
    return new MeetingTranscriptionManager('groq', undefined, groqConfig)
  } else {
    // Default: Soniox backend (streaming WebSocket)
    const sonioxApiKey = getApiKey('soniox')
    const sonioxConfig: StreamingSonioxConfig = {
      ...(config.recognition?.soniox || {}),
      apiKey: sonioxApiKey || config.recognition?.soniox?.apiKey,
      sampleRate: sampleRate
    }
    console.log('[Main] Creating MeetingTranscriptionManager with Soniox backend')
    return new MeetingTranscriptionManager('soniox', sonioxConfig, undefined)
  }
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
  hotkeyManager = new HotkeyManager(config.hotkey?.triggerKey)

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
      setIndicatorState({ recording: true })
      if (isSoundFeedbackEnabled()) shell.beep()

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
        setIndicatorState({ recording: false })
      }
    })

    hotkeyManager.on('recordStop', async () => {
      const stopTime = Date.now()
      console.log('[Main] Recording stopped (streaming)')
      updateTrayStatus('processing')
      setIndicatorState({ recording: false, processing: true })
      if (isSoundFeedbackEnabled()) shell.beep()

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
          const config = getConfig()
          const method = config.output?.method || 'simulate_input'
          const finalText = await inputSimulator?.typeText(result.text, {
            method,
            autoSpace: config.output?.autoSpace,
            capitalize: config.output?.capitalize
          })
          if (method === 'popup' && finalText) {
            showOutputWindow(finalText)
          }
        }
      } catch (error) {
        console.error('[Main] Streaming recognition error:', error)
      } finally {
        updateTrayStatus('idle')
        setIndicatorState({ recording: false })
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
      setIndicatorState({ recording: true })
      if (isSoundFeedbackEnabled()) shell.beep()
      await audioRecorder?.startRecording()
    })

    hotkeyManager.on('recordStop', async () => {
      console.log('[Main] Recording stopped')
      updateTrayStatus('processing')
      setIndicatorState({ recording: false, processing: true })
      if (isSoundFeedbackEnabled()) shell.beep()

      try {
        const audioBuffer = await audioRecorder?.stopRecording()
        if (audioBuffer && audioBuffer.length > 0) {
          const result = await recognitionController?.recognize(audioBuffer)
          if (result?.text) {
            const config = getConfig()
            const method = config.output?.method || 'simulate_input'
            const finalText = await inputSimulator?.typeText(result.text, {
              method,
              autoSpace: config.output?.autoSpace,
              capitalize: config.output?.capitalize
            })
            if (method === 'popup' && finalText) {
              showOutputWindow(finalText)
            }
          }
        }
      } catch (error) {
        console.error('[Main] Recognition error:', error)
      } finally {
        updateTrayStatus('idle')
        setIndicatorState({ recording: false })
      }
    })
  }

  // Start hotkey listener
  hotkeyManager.start()
  console.log(`[Main] JustSay ready! Hold ${hotkeyManager.getTriggerKeyLabel()} to record.`)
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
  outputWindow?.removeAllListeners('close')
})

// IPC handlers
ipcMain.handle('get-config', () => getConfig())

ipcMain.handle('set-config', (_event, config) => {
  const prevConfig = getConfig()
  setConfig(config)
  const nextConfig = getConfig()
  if (prevConfig.hotkey?.triggerKey !== nextConfig.hotkey?.triggerKey) {
    hotkeyManager?.setTriggerKey(nextConfig.hotkey?.triggerKey)
  }
  if (!recognitionController || shouldRecreateRecognition(prevConfig, nextConfig)) {
    recognitionController = new RecognitionController(nextConfig)
  }
  syncIndicatorVisibilityFromConfig()
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

ipcMain.handle('close-output-window', () => {
  outputWindow?.hide()
})

ipcMain.handle('copy-to-clipboard', (_event, text: string) => {
  clipboard.writeText(text || '')
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
    meetingTranscription = createMeetingTranscriptionManager(config)
  }
  return meetingTranscription.getSystemAudioSources()
})

ipcMain.handle('start-meeting-transcription', async (_event, options) => {
  const config = getConfig()

  if (!meetingTranscription) {
    meetingTranscription = createMeetingTranscriptionManager(config)
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
ipcMain.handle('get-api-key', (_event, provider: 'soniox' | 'groq' | 'openai') => {
  return getApiKey(provider)
})

ipcMain.handle('set-api-key', (_event, provider: 'soniox' | 'groq' | 'openai', apiKey: string) => {
  setApiKey(provider, apiKey)
})

ipcMain.handle('delete-api-key', (_event, provider: 'soniox' | 'groq' | 'openai') => {
  deleteApiKey(provider)
})

ipcMain.handle('has-api-key', (_event, provider: 'soniox' | 'groq' | 'openai') => {
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
