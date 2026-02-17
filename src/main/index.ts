import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  screen,
  desktopCapturer,
  clipboard,
  dialog,
  MessageBoxOptions
} from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { setupTray, updateTrayStatus, setTrayTooltip } from './tray'
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
import { getHomeStats, recordUsageEvent } from './database/statsStore'
import { WebAudioRecorder } from './audio/web-recorder'
import { WebStreamingAudioRecorder } from './audio/web-streaming-recorder'
import { RecognitionController, DownloadProgress } from './recognition'
import { WhisperServerClient } from './recognition/whisperServer'
import { StreamingSonioxRecognizer } from './recognition/streaming-soniox'
import { InputSimulator } from './input/simulator'
import { MeetingTranscriptionManager, TranscriptSegment } from './meeting-transcription'
import { StreamingGroqConfig } from './recognition/streaming-groq'
import { StreamingSonioxConfig } from './recognition/streaming-soniox'
import { StreamingLocalConfig } from './recognition/streaming-local'
import { TranslationService } from './translation/service'

// Window references
let mainWindow: BrowserWindow | null = null
let indicatorWindow: BrowserWindow | null = null
let outputWindow: BrowserWindow | null = null
let pendingOutputText: string | null = null

const INDICATOR_WINDOW_WIDTH = 240
const INDICATOR_WINDOW_HEIGHT = 64

const OUTPUT_WINDOW_WIDTH = 500
const OUTPUT_WINDOW_HEIGHT = 230
const OUTPUT_CURSOR_OFFSET_Y = 18
const OUTPUT_CURSOR_PADDING = 12

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
let translationService: TranslationService | null = null
let pttRecordingStartedAt: number | null = null
let meetingRecordingStartedAt: number | null = null
let activeMeetingOptions: {
  includeMicrophone: boolean
  translationEnabled?: boolean
  targetLanguage?: string
} | null = null
let meetingPersistedByMain = false
let transientTrayTimer: NodeJS.Timeout | null = null
let shutdownInProgress = false
let allowQuit = false

function getMeetingStatus(): string {
  return meetingTranscription?.getStatus() || 'idle'
}

function isMeetingBusy(): boolean {
  return getMeetingStatus() !== 'idle'
}

function isPttBusy(): boolean {
  return !!currentRecordingState.recording || !!currentRecordingState.processing
}

function getBaseTrayStatus(): 'idle' | 'recording' | 'processing' | 'meeting' {
  if (currentRecordingState.recording) return 'recording'
  if (currentRecordingState.processing) return 'processing'
  if (isMeetingBusy()) return 'meeting'
  return 'idle'
}

function refreshTrayStatus(): void {
  updateTrayStatus(getBaseTrayStatus())
}

function showTransientRuntimeHint(message: string, durationMs = 2200): void {
  setTrayTooltip(`JustSay - ${message}`)
  if (transientTrayTimer) {
    clearTimeout(transientTrayTimer)
  }
  transientTrayTimer = setTimeout(() => {
    refreshTrayStatus()
    transientTrayTimer = null
  }, durationMs)

  if (!indicatorWindow || indicatorWindow.isDestroyed() || !isIndicatorEnabled()) {
    return
  }
  indicatorWindow.show()
  indicatorWindow.webContents.send('indicator-feedback', { message })
}

function sendMeetingEvent(
  channel: 'meeting-transcript' | 'meeting-status',
  payload: unknown
): void {
  const targets = [mainWindow]
  const sentWebContents = new Set<number>()

  for (const target of targets) {
    if (!target || target.isDestroyed()) continue
    const webContentsId = target.webContents.id
    if (sentWebContents.has(webContentsId)) continue
    sentWebContents.add(webContentsId)
    target.webContents.send(channel, payload)
  }
}

function getRecognitionSignature(config: AppConfig): string {
  return JSON.stringify({
    recognition: config.recognition ?? null,
    sampleRate: config.audio?.sampleRate ?? null
  })
}

function shouldRecreateRecognition(prev: AppConfig, next: AppConfig): boolean {
  return getRecognitionSignature(prev) !== getRecognitionSignature(next)
}

function shouldRecreateMeeting(prev: AppConfig, next: AppConfig): boolean {
  return getRecognitionSignature(prev) !== getRecognitionSignature(next)
}

async function maybeTranslatePttText(text: string): Promise<string> {
  if (!translationService || !text?.trim()) {
    return text
  }
  if (!translationService.isPttEnabled()) {
    return text
  }

  const targetLanguage = translationService.getPttTargetLanguage()
  const result = await translationService.translate(text, targetLanguage, {
    context: 'ptt',
    fallbackToSource: true
  })

  console.log(
    '[Main] PTT translation:',
    JSON.stringify({
      target_language: targetLanguage,
      translated: result.translated,
      fallback: result.fallback,
      latency_ms: result.latencyMs,
      error: result.error || null
    })
  )

  return result.text || text
}

function prewarmLocalRecognition(reason: string): void {
  if (!recognitionController) {
    return
  }

  void recognitionController.prewarmLocalBackend(reason).catch((err) => {
    console.error(`[Main] Local recognition prewarm failed (${reason}):`, err)
  })
}

function isIndicatorEnabled(): boolean {
  return getConfig().ui?.indicatorEnabled !== false
}

function isSoundFeedbackEnabled(): boolean {
  return getConfig().ui?.soundFeedback !== false
}

function applyLaunchAtLogin(enabled: boolean): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    console.info(`[Main] Launch at login is not supported on ${process.platform}; skipping.`)
    return
  }

  try {
    app.setLoginItemSettings({
      openAtLogin: enabled
    })
    console.log(`[Main] Launch at login ${enabled ? 'enabled' : 'disabled'}`)
  } catch (error) {
    console.warn('[Main] Failed to apply launch-at-login setting:', error)
  }
}

function setIndicatorState(state: RecordingUiState): void {
  currentRecordingState = state

  refreshTrayStatus()

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

async function confirmCloseToTray(window: BrowserWindow): Promise<boolean> {
  if (!isMeetingBusy()) {
    return true
  }

  const choice = await dialog.showMessageBox(window, {
    type: 'question',
    buttons: ['继续后台运行', '停止并保存后最小化', '取消'],
    defaultId: 0,
    cancelId: 2,
    title: 'Meeting 仍在进行',
    message: '会议转录仍在运行。关闭窗口到托盘时要如何处理？',
    detail: '继续后台运行可保持实时转录；停止并保存会结束当前会话。'
  })

  if (choice.response === 2) {
    return false
  }

  if (choice.response === 1) {
    await stopMeetingAndPersist('close-to-tray')
  }

  return true
}

async function requestAppQuit(): Promise<void> {
  if (shutdownInProgress) {
    return
  }
  shutdownInProgress = true

  try {
    if (isMeetingBusy()) {
      const promptOptions: MessageBoxOptions = {
        type: 'question',
        buttons: ['停止并保存后退出', '直接退出', '取消'],
        defaultId: 0,
        cancelId: 2,
        title: '退出 JustSay',
        message: '会议转录仍在进行，退出前如何处理？',
        detail: '建议先停止并保存，避免丢失当前会话内容。'
      }
      const choice = mainWindow
        ? await dialog.showMessageBox(mainWindow, promptOptions)
        : await dialog.showMessageBox(promptOptions)

      if (choice.response === 2) {
        return
      }

      if (choice.response === 0) {
        await stopMeetingAndPersist('quit-app')
      }
    }

    allowQuit = true
    app.quit()
  } finally {
    shutdownInProgress = false
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
    if (allowQuit) {
      return
    }

    const config = getConfig()
    if (config.general?.minimizeToTray !== false) {
      // Minimize to tray instead of closing
      e.preventDefault()
      void confirmCloseToTray(window).then((shouldHide) => {
        if (shouldHide) {
          window.hide()
        }
      })
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
    width: INDICATOR_WINDOW_WIDTH,
    height: INDICATOR_WINDOW_HEIGHT,
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
  window.setPosition(
    Math.round((screenWidth - INDICATOR_WINDOW_WIDTH) / 2),
    screenHeight - INDICATOR_WINDOW_HEIGHT - 20
  )

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/indicator.html`)
  } else {
    window.loadFile(join(__dirname, '../renderer/indicator.html'))
  }

  return window
}

function createOutputWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: OUTPUT_WINDOW_WIDTH,
    height: OUTPUT_WINDOW_HEIGHT,
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

    const minX = x + OUTPUT_CURSOR_PADDING
    const minY = y + OUTPUT_CURSOR_PADDING
    const maxX = x + width - OUTPUT_WINDOW_WIDTH - OUTPUT_CURSOR_PADDING
    const maxY = y + height - OUTPUT_WINDOW_HEIGHT - OUTPUT_CURSOR_PADDING

    const centeredX = cursor.x - Math.round(OUTPUT_WINDOW_WIDTH / 2)
    const nextX = Math.min(Math.max(centeredX, minX), Math.max(minX, maxX))

    const belowY = cursor.y + OUTPUT_CURSOR_OFFSET_Y
    const aboveY = cursor.y - OUTPUT_WINDOW_HEIGHT - OUTPUT_CURSOR_OFFSET_Y
    const preferBelow = belowY <= maxY
    const rawY = preferBelow ? belowY : aboveY
    const nextY = Math.min(Math.max(rawY, minY), Math.max(minY, maxY))

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

function notifyIndicatorOutputText(text: string): void {
  if (!text?.trim() || !indicatorWindow || indicatorWindow.isDestroyed()) return
  indicatorWindow.webContents.send('output-text', { text })
}

function notifyHomeStatsUpdated(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('home-stats-updated')
}

function trackPttUsage(text: string, startedAt: number | null): void {
  const trimmed = text.trim()
  if (!trimmed) return

  const durationMs = startedAt ? Math.max(0, Date.now() - startedAt) : undefined
  recordUsageEvent({
    mode: 'ptt',
    chars: trimmed.length,
    durationMs,
    success: true
  })
  notifyHomeStatsUpdated()
}

function getPttDurationSeconds(startedAt: number | null): number {
  if (!startedAt) return 0
  return Math.max(1, Math.round((Date.now() - startedAt) / 1000))
}

function persistPttTranscript(
  sourceText: string,
  translatedText: string,
  startedAt: number | null
): void {
  const original = sourceText.trim()
  const translated = translatedText.trim()
  if (!original) return

  const config = getConfig()
  applyLaunchAtLogin(config.general?.autostart === true)
  const pttTranslationEnabled = config.recognition?.translation?.enabledForPtt === true
  const targetLanguage = config.recognition?.translation?.targetLanguage
  const hasTranslation = pttTranslationEnabled && translated.length > 0 && translated !== original

  try {
    const transcript = createTranscript({
      duration_seconds: getPttDurationSeconds(startedAt),
      translation_enabled: hasTranslation,
      target_language: hasTranslation ? targetLanguage : undefined,
      include_microphone: false,
      source_mode: 'ptt',
      segments: [
        {
          speaker: 0,
          text: original,
          translated_text: hasTranslation ? translated : undefined
        }
      ]
    })
    console.log(`[Main] Saved PTT transcript: ${transcript.id}`)
  } catch (err) {
    console.error('[Main] Failed to save PTT transcript:', err)
  }
}

function buildMeetingSegmentsForPersistence(history: TranscriptSegment[]): Array<{
  speaker: number
  text: string
  translated_text?: string
  sentence_pairs?: { original: string; translated?: string }[]
}> {
  const directSpeakerSegments = history.flatMap((item) => item.speakerSegments || [])
  if (directSpeakerSegments.length > 0) {
    return directSpeakerSegments
      .filter((segment) => segment.text.trim())
      .map((segment) => ({
        speaker: segment.speaker,
        text: segment.text,
        translated_text: segment.translatedText,
        sentence_pairs: segment.sentencePairs?.map((pair) => ({
          original: pair.original,
          translated: pair.translated
        }))
      }))
  }

  const currentSegments = history
    .map((item) => item.currentSpeakerSegment)
    .filter((segment): segment is NonNullable<TranscriptSegment['currentSpeakerSegment']> =>
      Boolean(segment?.text?.trim())
    )
  if (currentSegments.length > 0) {
    return currentSegments.map((segment) => ({
      speaker: segment.speaker ?? 0,
      text: segment.text,
      translated_text: segment.translatedText,
      sentence_pairs: segment.sentencePairs?.map((pair) => ({
        original: pair.original,
        translated: pair.translated
      }))
    }))
  }

  return history
    .filter((item) => item.text.trim())
    .map((item) => ({
      speaker: item.speaker ?? 0,
      text: item.text,
      translated_text: item.translatedText
    }))
}

function persistMeetingTranscript(history: TranscriptSegment[], reason: string): void {
  if (meetingPersistedByMain) {
    return
  }

  const segments = buildMeetingSegmentsForPersistence(history)
  if (segments.length === 0) {
    return
  }

  const options = activeMeetingOptions || { includeMicrophone: false, translationEnabled: false }
  const durationSeconds = meetingRecordingStartedAt
    ? Math.max(1, Math.round((Date.now() - meetingRecordingStartedAt) / 1000))
    : 0

  try {
    const transcript = createTranscript({
      duration_seconds: durationSeconds,
      translation_enabled: !!options.translationEnabled,
      target_language: options.translationEnabled ? options.targetLanguage : undefined,
      include_microphone: options.includeMicrophone,
      source_mode: 'meeting',
      segments
    })
    meetingPersistedByMain = true
    console.log(`[Main] Saved meeting transcript (${reason}): ${transcript.id}`)
  } catch (err) {
    console.error(`[Main] Failed to save meeting transcript (${reason}):`, err)
  }
}

async function stopMeetingAndPersist(reason: string): Promise<void> {
  if (!meetingTranscription || getMeetingStatus() === 'idle') {
    return
  }

  try {
    const history = await meetingTranscription.stopTranscription()
    persistMeetingTranscript(history, reason)
  } catch (err) {
    console.error(`[Main] Failed to stop meeting transcription (${reason}):`, err)
  } finally {
    activeMeetingOptions = null
    meetingRecordingStartedAt = null
    refreshTrayStatus()
  }
}

/**
 * Create MeetingTranscriptionManager based on global backend setting.
 * Supports Soniox/Groq and local faster-whisper (including remote LAN server mode).
 */
function createMeetingTranscriptionManager(config: AppConfig): MeetingTranscriptionManager {
  const backend = config.recognition?.backend
  const sampleRate = config.audio?.sampleRate
  const service = translationService
  const externalTranslator = service
    ? async (text: string, targetLanguage: string): Promise<string> => {
        const translated = await service.translateForMeeting(text, targetLanguage)
        return translated.text
      }
    : undefined

  if (backend === 'groq') {
    // Groq backend: transcription by Groq Whisper, translation delegated to external translator.
    const groqApiKey = getApiKey('groq')
    const groqConfig: StreamingGroqConfig = {
      apiKey: groqApiKey || undefined,
      whisperModel: config.recognition?.groq?.model || 'whisper-large-v3-turbo',
      chatModel: config.recognition?.groq?.chatModel || 'llama-3.3-70b-versatile',
      rateControl: config.recognition?.groq?.rateControl,
      language: config.recognition?.language,
      sampleRate: sampleRate
    }
    console.log('[Main] Creating MeetingTranscriptionManager with Groq backend')
    return new MeetingTranscriptionManager(
      'groq',
      undefined,
      groqConfig,
      undefined,
      externalTranslator
    )
  } else if (backend === 'local' || !backend || backend === 'network' || backend === 'api') {
    const localConfig: StreamingLocalConfig = {
      ...(config.recognition?.local || {}),
      language: config.recognition?.language,
      sampleRate
    }
    const fallbackInfo =
      backend && backend !== 'local'
        ? ` (fallback from unsupported meeting backend: ${backend})`
        : ''
    console.log(`[Main] Creating MeetingTranscriptionManager with Local backend${fallbackInfo}`)
    return new MeetingTranscriptionManager(
      'local',
      undefined,
      undefined,
      localConfig,
      externalTranslator
    )
  } else {
    // Soniox backend (streaming WebSocket)
    const sonioxApiKey = getApiKey('soniox')
    const sonioxConfig: StreamingSonioxConfig = {
      ...(config.recognition?.soniox || {}),
      apiKey: sonioxApiKey || config.recognition?.soniox?.apiKey,
      sampleRate: sampleRate
    }
    console.log('[Main] Creating MeetingTranscriptionManager with Soniox backend')
    return new MeetingTranscriptionManager('soniox', sonioxConfig, undefined, undefined, undefined)
  }
}

async function initializeApp(): Promise<void> {
  // Initialize config, secure store, and database
  initConfig()
  initSecureStore()
  initDatabase()
  translationService = new TranslationService(
    () => getConfig(),
    () => getApiKey('openai') || getConfig().recognition?.api?.apiKey
  )
  const config = getConfig()

  // Create windows
  mainWindow = createMainWindow()
  indicatorWindow = createIndicatorWindow()

  // Setup tray with callbacks
  setupTray({
    showMainWindow: () => mainWindow?.show(),
    quitApp: () => {
      void requestAppQuit()
    }
  })

  // Initialize modules
  audioRecorder = new WebAudioRecorder()
  recognitionController = new RecognitionController(config)
  prewarmLocalRecognition('app-startup')
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
      if (isMeetingBusy()) {
        showTransientRuntimeHint('Meeting进行中，PTT已禁用')
        return
      }

      console.log('[Main] Recording started (streaming)')
      pttRecordingStartedAt = Date.now()
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
        setIndicatorState({ recording: false })
      }
    })

    hotkeyManager.on('recordStop', async () => {
      if (!currentRecordingState.recording) {
        return
      }

      const stopTime = Date.now()
      console.log('[Main] Recording stopped (streaming)')
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
          const translatedText = await maybeTranslatePttText(result.text)
          const method = config.output?.method || 'simulate_input'
          const finalText = await inputSimulator?.typeText(translatedText, {
            method,
            autoSpace: config.output?.autoSpace,
            capitalize: config.output?.capitalize
          })
          trackPttUsage(finalText || translatedText || result.text, pttRecordingStartedAt)
          persistPttTranscript(result.text, translatedText, pttRecordingStartedAt)
          if (finalText) {
            notifyIndicatorOutputText(finalText)
          }
          if (method === 'popup' && finalText) {
            showOutputWindow(finalText)
          }
        }
      } catch (error) {
        console.error('[Main] Streaming recognition error:', error)
      } finally {
        pttRecordingStartedAt = null
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
      if (isMeetingBusy()) {
        showTransientRuntimeHint('Meeting进行中，PTT已禁用')
        return
      }

      console.log('[Main] Recording started')
      pttRecordingStartedAt = Date.now()
      setIndicatorState({ recording: true })
      if (isSoundFeedbackEnabled()) shell.beep()
      await audioRecorder?.startRecording()
    })

    hotkeyManager.on('recordStop', async () => {
      if (!currentRecordingState.recording) {
        return
      }

      console.log('[Main] Recording stopped')
      setIndicatorState({ recording: false, processing: true })
      if (isSoundFeedbackEnabled()) shell.beep()

      try {
        const audioBuffer = await audioRecorder?.stopRecording()
        if (audioBuffer && audioBuffer.length > 0) {
          const result = await recognitionController?.recognize(audioBuffer)
          if (result?.text) {
            const config = getConfig()
            const translatedText = await maybeTranslatePttText(result.text)
            const method = config.output?.method || 'simulate_input'
            const finalText = await inputSimulator?.typeText(translatedText, {
              method,
              autoSpace: config.output?.autoSpace,
              capitalize: config.output?.capitalize
            })
            trackPttUsage(finalText || translatedText || result.text, pttRecordingStartedAt)
            persistPttTranscript(result.text, translatedText, pttRecordingStartedAt)
            if (finalText) {
              notifyIndicatorOutputText(finalText)
            }
            if (method === 'popup' && finalText) {
              showOutputWindow(finalText)
            }
          }
        }
      } catch (error) {
        console.error('[Main] Recognition error:', error)
      } finally {
        pttRecordingStartedAt = null
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

app.on('before-quit', (e) => {
  if (!allowQuit) {
    e.preventDefault()
    void requestAppQuit()
    return
  }

  hotkeyManager?.stop()
  // Allow all windows to close on quit
  mainWindow?.removeAllListeners('close')
  indicatorWindow?.removeAllListeners('close')
  outputWindow?.removeAllListeners('close')
})

// IPC handlers
ipcMain.handle('get-config', () => getConfig())

ipcMain.handle('set-config', (_event, config) => {
  const prevConfig = getConfig()
  setConfig(config)
  const nextConfig = getConfig()
  const recognitionChanged = shouldRecreateRecognition(prevConfig, nextConfig)
  const meetingRecognitionChanged = shouldRecreateMeeting(prevConfig, nextConfig)
  const autostartChanged = prevConfig.general?.autostart !== nextConfig.general?.autostart
  if (prevConfig.hotkey?.triggerKey !== nextConfig.hotkey?.triggerKey) {
    hotkeyManager?.setTriggerKey(nextConfig.hotkey?.triggerKey)
  }
  if (autostartChanged) {
    applyLaunchAtLogin(nextConfig.general?.autostart === true)
  }
  if (!recognitionController || recognitionChanged) {
    recognitionController = new RecognitionController(nextConfig)
  }
  if (meetingRecognitionChanged && meetingTranscription?.getStatus() === 'idle') {
    meetingTranscription = null
    activeMeetingOptions = null
    meetingRecordingStartedAt = null
  }
  prewarmLocalRecognition('config-update')
  syncIndicatorVisibilityFromConfig()
  refreshTrayStatus()
})

ipcMain.handle('show-settings', () => {
  mainWindow?.show()
})

ipcMain.handle('quit-app', () => {
  void requestAppQuit()
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

ipcMain.handle(
  'test-whisper-remote',
  async (_event, options?: { host?: string; port?: number }) => {
    const host = options?.host || '127.0.0.1'
    const port = typeof options?.port === 'number' ? options.port : 8765
    const client = new WhisperServerClient({ mode: 'remote', host, port, autoStart: false })
    return client.isHealthy()
  }
)

// Meeting transcription IPC handlers
ipcMain.handle('get-system-audio-sources', async () => {
  if (!meetingTranscription) {
    const config = getConfig()
    meetingTranscription = createMeetingTranscriptionManager(config)
  }
  return meetingTranscription.getSystemAudioSources()
})

ipcMain.handle('get-meeting-runtime-state', () => {
  return {
    status: getMeetingStatus(),
    startedAt: meetingRecordingStartedAt
  }
})

ipcMain.handle('get-ptt-runtime-state', () => {
  return {
    recording: !!currentRecordingState.recording,
    processing: !!currentRecordingState.processing
  }
})

ipcMain.handle('preconnect-meeting-transcription', async () => {
  if (meetingTranscription?.getStatus() !== 'transcribing') {
    const config = getConfig()
    if (!meetingTranscription) {
      meetingTranscription = createMeetingTranscriptionManager(config)
    }
  }

  if (!meetingTranscription) {
    return false
  }

  try {
    await meetingTranscription.preConnect()
    return true
  } catch (err) {
    console.warn('[Main] Meeting transcription preconnect failed:', err)
    return false
  }
})

ipcMain.handle('start-meeting-transcription', async (_event, options) => {
  if (isPttBusy()) {
    showTransientRuntimeHint('PTT进行中，请先结束后再启动Meeting')
    throw new Error('PTT is active. Stop push-to-talk before starting meeting transcription.')
  }

  const config = getConfig()

  if (!meetingTranscription) {
    meetingTranscription = createMeetingTranscriptionManager(config)
  }

  // Set up event forwarding to renderer
  meetingTranscription.removeAllListeners()

  meetingTranscription.on('transcript', (segment) => {
    sendMeetingEvent('meeting-transcript', segment)
  })

  meetingTranscription.on('status', (status) => {
    refreshTrayStatus()
    sendMeetingEvent('meeting-status', status)
  })

  meetingTranscription.on('error', (err) => {
    console.error('[Main] Meeting transcription error:', err)
    sendMeetingEvent('meeting-status', 'error')
  })

  await meetingTranscription.startTranscription(options)
  meetingRecordingStartedAt = Date.now()
  activeMeetingOptions = {
    includeMicrophone: !!options?.includeMicrophone,
    translationEnabled: !!options?.translationEnabled,
    targetLanguage: options?.targetLanguage
  }
  meetingPersistedByMain = false
  refreshTrayStatus()
})

ipcMain.handle('stop-meeting-transcription', async () => {
  await stopMeetingAndPersist('renderer-stop')
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
  sendMeetingEvent('meeting-status', 'error')
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
  sendMeetingEvent('meeting-status', 'error')
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
ipcMain.handle(
  'save-transcript',
  (
    _event,
    data: {
      title?: string
      note?: string
      duration_seconds: number
      translation_enabled: boolean
      target_language?: string
      include_microphone: boolean
      source_mode?: 'ptt' | 'meeting'
      segments: {
        speaker: number
        text: string
        translated_text?: string
        sentence_pairs?: { original: string; translated?: string }[]
      }[]
    }
  ) => {
    return createTranscript(data)
  }
)

ipcMain.handle(
  'list-transcripts',
  (
    _event,
    options?: {
      page?: number
      pageSize?: number
      orderBy?: string
      order?: string
      sourceMode?: 'ptt' | 'meeting'
    }
  ) => {
    return listTranscripts(
      options as
        | {
            page?: number
            pageSize?: number
            orderBy?: 'created_at' | 'updated_at' | 'duration_seconds'
            order?: 'ASC' | 'DESC'
            sourceMode?: 'ptt' | 'meeting'
          }
        | undefined
    )
  }
)

ipcMain.handle(
  'search-transcripts',
  (
    _event,
    options: { query: string; page?: number; pageSize?: number; sourceMode?: 'ptt' | 'meeting' }
  ) => {
    return searchTranscripts(options)
  }
)

ipcMain.handle('get-transcript', (_event, id: string) => {
  return getTranscriptWithSegments(id)
})

ipcMain.handle(
  'update-transcript',
  (_event, id: string, data: { title?: string; note?: string }) => {
    return updateTranscript(id, data)
  }
)

ipcMain.handle('delete-transcript', (_event, id: string) => {
  return deleteTranscript(id)
})

ipcMain.handle('export-transcript', (_event, id: string) => {
  return exportTranscript(id)
})

ipcMain.handle('get-home-stats', () => {
  return getHomeStats()
})
