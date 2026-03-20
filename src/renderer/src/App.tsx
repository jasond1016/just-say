import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { MeetingTranscriptEvent, SpeakerSegment } from '../../shared/transcription-types'
import { MeetingTranscription, MeetingSessionState } from './pages/MeetingTranscription'
import { TranscriptHistory } from './pages/TranscriptHistory'
import { TranscriptDetail } from './pages/TranscriptDetail'
import { DashboardHome } from './pages/DashboardHome'
import { DashboardSidebar, type DashboardView } from './components/dashboard/DashboardSidebar'
import { DashboardSettingsModal } from './components/dashboard/DashboardSettingsModal'
import { DEFAULT_TRIGGER_KEY, getTriggerKeyLabel } from '../../shared/hotkey'
import { startSystemAudioCapture, stopSystemAudioCapture } from './system-audio-capture'
import { startMicrophoneCapture, stopMicrophoneCapture } from './microphone-capture'
import { I18nProvider } from './i18n/I18nProvider'
import { AppLocale, resolveLocale } from './i18n'

type ThemeOption = 'system' | 'light' | 'dark'
type AppView = 'ptt' | 'meeting' | 'history' | 'detail'

interface AppConfig {
  general?: { language?: AppLocale }
  ui?: { theme?: ThemeOption }
  hotkey?: { triggerKey?: string }
  recognition?: {
    backend?: string
    meeting?: { includeMicrophone?: boolean }
    translation?: { enabledForMeeting?: boolean; targetLanguage?: string }
  }
}

const INITIAL_MEETING_STATE: MeetingSessionState = {
  status: 'idle',
  isPreconnecting: false,
  preconnectFailed: false,
  seconds: 0,
  startedAt: null,
  segments: [],
  currentSegment: null,
  lastError: null
}

function isMeetingActiveStatus(status: MeetingSessionState['status']): boolean {
  return status === 'starting' || status === 'transcribing' || status === 'stopping'
}

function mergeSpeakerSegments(
  prevSegments: SpeakerSegment[],
  incoming: SpeakerSegment[]
): SpeakerSegment[] {
  const previousByIdentity = new Map<string, SpeakerSegment>()
  const previousIdentityCounts = new Map<string, number>()
  for (const segment of prevSegments) {
    if (!segment.text.trim()) continue
    const baseIdentity =
      typeof segment.timestamp === 'number'
        ? `timestamp:${segment.timestamp}`
        : `source:${segment.source || 'unknown'}|speaker:${segment.speaker}|text:${segment.text}`
    const occurrence = (previousIdentityCounts.get(baseIdentity) || 0) + 1
    previousIdentityCounts.set(baseIdentity, occurrence)
    previousByIdentity.set(`${baseIdentity}|occurrence:${occurrence}`, segment)
  }

  const nextSegments: SpeakerSegment[] = []
  const incomingIdentityCounts = new Map<string, number>()
  for (let i = 0; i < incoming.length; i += 1) {
    const incomingSegment = incoming[i]
    if (!incomingSegment.text.trim()) continue
    const baseIdentity =
      typeof incomingSegment.timestamp === 'number'
        ? `timestamp:${incomingSegment.timestamp}`
        : `source:${incomingSegment.source || 'unknown'}|speaker:${incomingSegment.speaker}|text:${incomingSegment.text}`
    const occurrence = (incomingIdentityCounts.get(baseIdentity) || 0) + 1
    incomingIdentityCounts.set(baseIdentity, occurrence)
    const existing = previousByIdentity.get(`${baseIdentity}|occurrence:${occurrence}`)
    nextSegments.push({
      ...existing,
      ...incomingSegment,
      timestamp: existing?.timestamp ?? incomingSegment.timestamp ?? Date.now()
    })
  }
  return nextSegments
}

function App(): React.JSX.Element {
  const [currentView, setCurrentView] = useState<AppView>('ptt')
  const [selectedTranscriptId, setSelectedTranscriptId] = useState<string | null>(null)
  const [theme, setTheme] = useState<ThemeOption>('system')
  const [appLocale, setAppLocale] = useState<AppLocale>('en-US')
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [meetingState, setMeetingState] = useState<MeetingSessionState>(INITIAL_MEETING_STATE)

  const meetingStateRef = useRef<MeetingSessionState>(INITIAL_MEETING_STATE)
  const meetingSecondsTimerRef = useRef<NodeJS.Timeout | null>(null)
  meetingStateRef.current = meetingState

  const meetingActive = isMeetingActiveStatus(meetingState.status)

  // ─── Config ───

  const loadConfig = useCallback(async (): Promise<void> => {
    try {
      const cfg = (await window.api.getConfig()) as AppConfig
      setConfig(cfg)
      setAppLocale(resolveLocale(cfg.general?.language))
      if (cfg.ui?.theme) setTheme(cfg.ui.theme)
    } catch (err) {
      console.error('Failed to load config:', err)
    }
  }, [])

  // ─── Meeting timer ───

  const stopMeetingSecondsTimer = useCallback((): void => {
    if (meetingSecondsTimerRef.current) {
      clearInterval(meetingSecondsTimerRef.current)
      meetingSecondsTimerRef.current = null
    }
  }, [])

  const startMeetingSecondsTimer = useCallback((): void => {
    stopMeetingSecondsTimer()
    meetingSecondsTimerRef.current = setInterval(() => {
      setMeetingState((prev) => ({ ...prev, seconds: prev.seconds + 1 }))
    }, 1000)
  }, [stopMeetingSecondsTimer])

  // ─── Meeting transcript handling ───

  const handleMeetingTranscript = useCallback((segment: MeetingTranscriptEvent) => {
    setMeetingState((prev) => {
      const speakerSegments = segment.speakerSegments || []

      if (segment.isFinal) {
        const nextSegments = mergeSpeakerSegments(prev.segments, speakerSegments)
        if (segment.currentSpeakerSegment && segment.currentSpeakerSegment.text.trim()) {
          const lastSegment = nextSegments[nextSegments.length - 1]
          const isSameAsLast =
            !!lastSegment &&
            lastSegment.source === segment.currentSpeakerSegment.source &&
            lastSegment.speaker === segment.currentSpeakerSegment.speaker &&
            lastSegment.text === segment.currentSpeakerSegment.text
          if (isSameAsLast) {
            nextSegments[nextSegments.length - 1] = {
              ...lastSegment,
              ...segment.currentSpeakerSegment,
              timestamp: lastSegment.timestamp ?? segment.currentSpeakerSegment.timestamp ?? Date.now()
            }
          } else {
            nextSegments.push({
              ...segment.currentSpeakerSegment,
              timestamp: segment.currentSpeakerSegment.timestamp ?? Date.now()
            })
          }
        }
        return { ...prev, segments: nextSegments, currentSegment: null }
      }

      const nextSegments = mergeSpeakerSegments(prev.segments, speakerSegments)
      let nextCurrentSegment: SpeakerSegment | null = null
      if (segment.currentSpeakerSegment && segment.currentSpeakerSegment.text.trim()) {
        const previousCurrentSegment =
          prev.currentSegment?.source === segment.currentSpeakerSegment.source &&
          prev.currentSegment?.speaker === segment.currentSpeakerSegment.speaker
            ? prev.currentSegment
            : null
        nextCurrentSegment = {
          ...segment.currentSpeakerSegment,
          wordTimings: segment.currentSpeakerSegment.wordTimings ?? segment.currentWordTimings ?? undefined,
          timestamp: previousCurrentSegment?.timestamp ?? segment.currentSpeakerSegment.timestamp ?? Date.now()
        }
      }
      return { ...prev, segments: nextSegments, currentSegment: nextCurrentSegment }
    })
  }, [])

  const handleMeetingStatus = useCallback(
    (nextStatusRaw: string) => {
      const nextStatus = nextStatusRaw as MeetingSessionState['status']
      if (nextStatus === 'error') {
        stopMeetingSecondsTimer()
        setMeetingState((prev) => ({ ...prev, status: 'error' }))
        return
      }
      if (nextStatus === 'transcribing') {
        startMeetingSecondsTimer()
      } else if (nextStatus === 'idle') {
        stopMeetingSecondsTimer()
        stopSystemAudioCapture()
        stopMicrophoneCapture()
      }
      setMeetingState((prev) => ({ ...prev, status: nextStatus }))
    },
    [startMeetingSecondsTimer, stopMeetingSecondsTimer]
  )

  // ─── Meeting actions ───

  const runMeetingPreconnect = useCallback(async (): Promise<void> => {
    if (isMeetingActiveStatus(meetingStateRef.current.status)) return
    setMeetingState((prev) => ({ ...prev, isPreconnecting: true, preconnectFailed: false }))
    try {
      const ok = await window.api.preconnectMeetingTranscription()
      if (!ok) throw new Error('Preconnect unavailable')
      setMeetingState((prev) => ({ ...prev, isPreconnecting: false, preconnectFailed: false }))
    } catch {
      setMeetingState((prev) => ({ ...prev, isPreconnecting: false, preconnectFailed: true }))
    }
  }, [])

  const startMeetingSession = useCallback(async (): Promise<void> => {
    if (isMeetingActiveStatus(meetingStateRef.current.status)) return
    setMeetingState((prev) => ({
      ...prev,
      status: 'starting',
      seconds: 0,
      startedAt: null,
      segments: [],
      currentSegment: null,
      lastError: null
    }))
    try {
      const runtimeConfig = (await window.api.getConfig()) as AppConfig
      const translationEnabled = runtimeConfig.recognition?.translation?.enabledForMeeting === true
      const targetLanguage = runtimeConfig.recognition?.translation?.targetLanguage
      const includeMicrophone = runtimeConfig.recognition?.meeting?.includeMicrophone === true
      await window.api.startMeetingTranscription({
        includeMicrophone,
        translationEnabled,
        targetLanguage: translationEnabled ? targetLanguage : undefined
      })
      await startSystemAudioCapture(null)
      if (includeMicrophone) await startMicrophoneCapture()
      setMeetingState((prev) => ({ ...prev, status: 'transcribing', seconds: 0, startedAt: Date.now() }))
      startMeetingSecondsTimer()
    } catch (err) {
      stopSystemAudioCapture()
      stopMicrophoneCapture()
      try { await window.api.stopMeetingTranscription() } catch { /* ignore */ }
      stopMeetingSecondsTimer()
      setMeetingState((prev) => ({
        ...prev,
        status: 'error',
        lastError: err instanceof Error ? err.message : String(err)
      }))
    }
  }, [startMeetingSecondsTimer, stopMeetingSecondsTimer])

  /** Stop meeting — stays on current page */
  const stopMeetingSession = useCallback(async (): Promise<void> => {
    if (!isMeetingActiveStatus(meetingStateRef.current.status)) return
    setMeetingState((prev) => ({ ...prev, status: 'stopping' }))
    stopSystemAudioCapture()
    stopMicrophoneCapture()
    stopMeetingSecondsTimer()
    try {
      await window.api.stopMeetingTranscription()
      setMeetingState((prev) => ({ ...prev, status: 'idle' }))
    } catch (err) {
      setMeetingState((prev) => ({
        ...prev,
        status: 'error',
        lastError: err instanceof Error ? err.message : String(err)
      }))
    }
  }, [stopMeetingSecondsTimer])

  // ─── Effects ───

  useEffect(() => { void loadConfig() }, [loadConfig])

  const applyTheme = useCallback((themeOption: ThemeOption) => {
    let effectiveTheme: 'light' | 'dark'
    if (themeOption === 'system') {
      effectiveTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    } else {
      effectiveTheme = themeOption
    }
    document.documentElement.classList.toggle('dark', effectiveTheme === 'dark')
    if (effectiveTheme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light')
    } else {
      document.documentElement.removeAttribute('data-theme')
    }

    // Sync title bar overlay color with theme
    const overlayTheme = effectiveTheme === 'dark'
      ? { color: '#1A1816', symbolColor: '#E8E4DD' }
      : { color: '#FAF8F3', symbolColor: '#2D2A26' }
    void window.api.updateTitleBarOverlay(overlayTheme).catch(() => { /* ignore on unsupported platforms */ })
  }, [])

  useEffect(() => { applyTheme(theme) }, [theme, applyTheme])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (): void => { if (theme === 'system') applyTheme('system') }
    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [theme, applyTheme])

  useEffect(() => {
    window.api.onMeetingTranscript(handleMeetingTranscript)
    window.api.onMeetingStatus(handleMeetingStatus)
    return () => {
      window.api.removeAllListeners('meeting-transcript')
      window.api.removeAllListeners('meeting-status')
      stopMeetingSecondsTimer()
    }
  }, [handleMeetingStatus, handleMeetingTranscript, stopMeetingSecondsTimer])

  // Preconnect when navigating TO meeting view
  useEffect(() => {
    if (currentView === 'meeting') void runMeetingPreconnect()
  }, [currentView, runMeetingPreconnect])

  // Restore meeting state on app restart
  useEffect(() => {
    void window.api
      .getMeetingRuntimeState()
      .then((runtime) => {
        if (runtime.status && runtime.status !== 'idle') {
          setCurrentView('meeting')
          setMeetingState((prev) => ({
            ...prev,
            status: runtime.status as MeetingSessionState['status'],
            startedAt: runtime.startedAt
          }))
        }
      })
      .catch((err) => { console.warn('Failed to read meeting runtime state:', err) })
  }, [])

  // ─── Navigation ───

  const handleThemeChange = (newTheme: ThemeOption): void => { setTheme(newTheme) }

  const hotkey = getTriggerKeyLabel(config?.hotkey?.triggerKey || DEFAULT_TRIGGER_KEY)
  const dashboardHotkey = hotkey === 'Right Ctrl' ? 'R Ctrl' : hotkey

  const handleNavigate = useCallback((nextView: DashboardView) => {
    setSettingsOpen(false)
    setSelectedTranscriptId(null)
    setCurrentView(nextView)
  }, [])

  const handleNavigateToDetail = useCallback((id: string) => {
    setSelectedTranscriptId(id)
    setCurrentView('detail')
  }, [])

  const handleBackFromDetail = useCallback(() => {
    setSelectedTranscriptId(null)
    setCurrentView('history')
  }, [])

  const handleReturnToMeeting = useCallback(() => {
    setCurrentView('meeting')
  }, [])

  // Sidebar active view (detail → history highlight)
  const sidebarActiveView: DashboardView =
    currentView === 'detail' ? 'history' : currentView === 'meeting' ? 'meeting' : currentView === 'history' ? 'history' : 'ptt'

  return (
    <I18nProvider locale={appLocale}>
      <>
        <div className="h-full w-full bg-background">
          <div className="flex h-full w-full">
            <DashboardSidebar
              activeView={sidebarActiveView}
              onNavigate={handleNavigate}
              onOpenSettings={() => setSettingsOpen(true)}
              meetingActive={meetingActive}
            />

            {currentView === 'ptt' && (
              <DashboardHome
                hotkey={dashboardHotkey}
                onNavigate={handleNavigate}
                onOpenTranscript={handleNavigateToDetail}
                meetingActive={meetingActive}
                meetingSeconds={meetingState.seconds}
                onReturnToMeeting={handleReturnToMeeting}
                onStopMeeting={() => { void stopMeetingSession() }}
              />
            )}

            {currentView === 'history' && (
              <TranscriptHistory onNavigateToDetail={handleNavigateToDetail} />
            )}

            {currentView === 'detail' && selectedTranscriptId && (
              <TranscriptDetail id={selectedTranscriptId} onBack={handleBackFromDetail} />
            )}

            {currentView === 'detail' && !selectedTranscriptId && (
              <TranscriptHistory onNavigateToDetail={handleNavigateToDetail} />
            )}

            {currentView === 'meeting' && (
              <MeetingTranscription
                state={meetingState}
                onStart={startMeetingSession}
                onStop={stopMeetingSession}
              />
            )}
          </div>
        </div>

        {settingsOpen && (
          <DashboardSettingsModal
            onClose={() => setSettingsOpen(false)}
            onSaved={loadConfig}
            onThemeChange={handleThemeChange}
          />
        )}
      </>
    </I18nProvider>
  )
}

export default App
