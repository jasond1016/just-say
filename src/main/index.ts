import { app, shell, BrowserWindow, ipcMain, screen, desktopCapturer } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { setupTray, updateTrayStatus } from './tray'
import { HotkeyManager } from './hotkey'
import { initConfig, getConfig, setConfig } from './config'
import { AudioRecorder } from './audio/recorder'
import { StreamingAudioRecorder } from './audio/streaming-recorder'
import { RecognitionController } from './recognition'
import { StreamingSonioxRecognizer } from './recognition/streaming-soniox'
import { InputSimulator } from './input/simulator'
import { MeetingTranscriptionManager } from './meeting-transcription'

// Window references
let mainWindow: BrowserWindow | null = null
let indicatorWindow: BrowserWindow | null = null
let meetingWindow: BrowserWindow | null = null

// Core modules
let hotkeyManager: HotkeyManager | null = null
let audioRecorder: AudioRecorder | null = null
let streamingRecorder: StreamingAudioRecorder | null = null
let streamingSoniox: StreamingSonioxRecognizer | null = null
let recognitionController: RecognitionController | null = null
let inputSimulator: InputSimulator | null = null
let meetingTranscription: MeetingTranscriptionManager | null = null

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // Completely remove the menu bar
  window.setMenuBarVisibility(false)
  window.setMenu(null)

  window.on('ready-to-show', () => {
    window.show()
  })

  window.on('close', (e) => {
    // Minimize to tray instead of closing
    e.preventDefault()
    window.hide()
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
    meetingTranscription = new MeetingTranscriptionManager(config.recognition?.soniox || {})
  }
  // Fire and forget - don't block window showing
  meetingTranscription.preConnect().catch((err) => {
    console.error('[Main] Pre-connect failed:', err)
  })
}

async function initializeApp(): Promise<void> {
  // Initialize config
  initConfig()
  const config = getConfig()

  // Create windows
  mainWindow = createMainWindow()
  indicatorWindow = createIndicatorWindow()

  // Setup tray with callbacks
  setupTray({
    showMainWindow: () => mainWindow?.show()
  })

  // Initialize modules
  audioRecorder = new AudioRecorder()
  recognitionController = new RecognitionController(config)
  inputSimulator = new InputSimulator()
  hotkeyManager = new HotkeyManager()

  // Check if using streaming Soniox
  const useStreamingSoniox =
    config.recognition?.backend === 'soniox' && config.recognition?.soniox?.apiKey

  if (useStreamingSoniox) {
    console.log('[Main] Using streaming Soniox mode')
    streamingRecorder = new StreamingAudioRecorder()
    streamingSoniox = new StreamingSonioxRecognizer(config.recognition?.soniox)

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
        streamingRecorder?.on('data', (chunk: Buffer) => {
          streamingSoniox?.sendAudioChunk(chunk)
        })

        // Start recording
        await streamingRecorder?.startRecording()
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
        streamingRecorder?.stopRecording()
        streamingRecorder?.removeAllListeners('data')

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
  setConfig(config)
  // Recreate recognition controller with new config
  recognitionController = new RecognitionController(getConfig())
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
  await recognitionController?.downloadModel(modelType)
})

// Meeting transcription IPC handlers
ipcMain.handle('get-system-audio-sources', async () => {
  if (!meetingTranscription) {
    const config = getConfig()
    meetingTranscription = new MeetingTranscriptionManager(config.recognition?.soniox || {})
  }
  return meetingTranscription.getSystemAudioSources()
})

ipcMain.handle('start-meeting-transcription', async (_event, options) => {
  const config = getConfig()

  if (!meetingTranscription) {
    meetingTranscription = new MeetingTranscriptionManager(config.recognition?.soniox || {})
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
