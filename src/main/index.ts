import { app, shell, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { setupTray, updateTrayStatus } from './tray'
import { HotkeyManager } from './hotkey'
import { initConfig, getConfig, setConfig } from './config'
import { AudioRecorder } from './audio/recorder'
import { RecognitionController } from './recognition'
import { InputSimulator } from './input/simulator'

// Window references
let mainWindow: BrowserWindow | null = null
let indicatorWindow: BrowserWindow | null = null

// Core modules
let hotkeyManager: HotkeyManager | null = null
let audioRecorder: AudioRecorder | null = null
let recognitionController: RecognitionController | null = null
let inputSimulator: InputSimulator | null = null

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

  window.on('ready-to-show', () => {
    // Don't show by default - it's a tray app
    // window.show()
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

async function initializeApp(): Promise<void> {
  // Initialize config
  initConfig()
  const config = getConfig()

  // Create windows
  mainWindow = createMainWindow()
  indicatorWindow = createIndicatorWindow()

  // Setup tray
  setupTray(mainWindow)

  // Initialize modules
  audioRecorder = new AudioRecorder()
  recognitionController = new RecognitionController(config)
  inputSimulator = new InputSimulator()
  hotkeyManager = new HotkeyManager()

  // Handle recording
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
  // Allow window to close on quit
  mainWindow?.removeAllListeners('close')
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

ipcMain.handle('get-local-models', async () => {
  return recognitionController?.getLocalModels() || []
})

ipcMain.handle('download-model', async (_event, modelType) => {
  await recognitionController?.downloadModel(modelType)
})
