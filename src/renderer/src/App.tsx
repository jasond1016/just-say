import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  MeetingTranscription,
  MeetingSessionState,
  SpeakerSegment
} from './pages/MeetingTranscription'
import { TranscriptHistory } from './pages/TranscriptHistory'
import { TranscriptDetail } from './pages/TranscriptDetail'
import { DashboardHome } from './pages/DashboardHome'
import { DashboardSidebar, type DashboardView } from './components/dashboard/DashboardSidebar'
import { DashboardSettingsModal } from './components/dashboard/DashboardSettingsModal'
import { DEFAULT_TRIGGER_KEY, getTriggerKeyLabel } from '../../shared/hotkey'
import { startSystemAudioCapture, stopSystemAudioCapture } from './system-audio-capture'
import { stopMicrophoneCapture } from './microphone-capture'

type ThemeOption = 'system' | 'light' | 'dark'
type AppView = 'workspace' | 'meeting-session'
type WorkspaceView = 'ptt' | 'history' | 'detail'

interface AppConfig {
  ui?: {
    theme?: ThemeOption
  }
  hotkey?: {
    triggerKey?: string
  }
  recognition?: {
    backend?: string
    translation?: {
      enabledForMeeting?: boolean
      targetLanguage?: string
    }
  }
}

interface MeetingTranscriptEvent {
  isFinal: boolean
  speakerSegments?: SpeakerSegment[]
  currentSpeakerSegment?: SpeakerSegment
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

function splitStablePreview(prev: string, next: string): { stable: string; preview: string } {
  if (!next) {
    return { stable: '', preview: '' }
  }
  if (!prev) {
    return { stable: '', preview: next }
  }

  const max = Math.min(prev.length, next.length)
  let index = 0
  while (index < max && prev[index] === next[index]) {
    index += 1
  }

  return { stable: next.slice(0, index), preview: next.slice(index) }
}

function isMeetingActiveStatus(status: MeetingSessionState['status']): boolean {
  return status === 'starting' || status === 'transcribing' || status === 'stopping'
}

function mergeSpeakerSegments(
  prevSegments: SpeakerSegment[],
  incoming: SpeakerSegment[]
): SpeakerSegment[] {
  if (incoming.length === 0) {
    return prevSegments
  }

  const nextSegments = [...prevSegments]
  for (let i = 0; i < incoming.length; i += 1) {
    const incomingSegment = incoming[i]
    if (!incomingSegment.text.trim()) {
      continue
    }

    if (i < nextSegments.length) {
      const existing = nextSegments[i]
      nextSegments[i] = {
        ...existing,
        ...incomingSegment,
        timestamp: existing.timestamp ?? Date.now()
      }
    } else {
      nextSegments.push({
        ...incomingSegment,
        timestamp: Date.now()
      })
    }
  }

  return nextSegments
}

function App(): React.JSX.Element {
  const [appView, setAppView] = useState<AppView>('workspace')
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('ptt')
  const [selectedTranscriptId, setSelectedTranscriptId] = useState<string | null>(null)
  const [theme, setTheme] = useState<ThemeOption>('system')
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [dashboardSettingsOpen, setDashboardSettingsOpen] = useState(false)
  const [meetingState, setMeetingState] = useState<MeetingSessionState>(INITIAL_MEETING_STATE)

  const meetingStateRef = useRef<MeetingSessionState>(INITIAL_MEETING_STATE)
  const meetingSecondsTimerRef = useRef<NodeJS.Timeout | null>(null)
  const lastCurrentTextRef = useRef('')

  meetingStateRef.current = meetingState

  const loadConfig = useCallback(async (): Promise<void> => {
    try {
      const cfg = (await window.api.getConfig()) as AppConfig
      setConfig(cfg)
      if (cfg.ui?.theme) {
        setTheme(cfg.ui.theme)
      }
    } catch (err) {
      console.error('Failed to load config:', err)
    }
  }, [])

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

  const handleMeetingTranscript = useCallback((segment: MeetingTranscriptEvent) => {
    setMeetingState((prev) => {
      const speakerSegments = segment.speakerSegments || []

      if (segment.isFinal) {
        const nextSegments = mergeSpeakerSegments(prev.segments, speakerSegments)

        if (segment.currentSpeakerSegment && segment.currentSpeakerSegment.text.trim()) {
          const lastSegment = nextSegments[nextSegments.length - 1]
          const isSameAsLast =
            !!lastSegment &&
            lastSegment.speaker === segment.currentSpeakerSegment.speaker &&
            lastSegment.text === segment.currentSpeakerSegment.text

          if (isSameAsLast) {
            nextSegments[nextSegments.length - 1] = {
              ...lastSegment,
              ...segment.currentSpeakerSegment,
              timestamp: lastSegment.timestamp ?? Date.now()
            }
          } else {
            nextSegments.push({ ...segment.currentSpeakerSegment, timestamp: Date.now() })
          }
        }
        lastCurrentTextRef.current = ''
        return { ...prev, segments: nextSegments, currentSegment: null }
      }

      const nextSegments = mergeSpeakerSegments(prev.segments, speakerSegments)

      let nextCurrentSegment: SpeakerSegment | null = null
      if (segment.currentSpeakerSegment && segment.currentSpeakerSegment.text.trim()) {
        const { stable, preview } = splitStablePreview(
          lastCurrentTextRef.current,
          segment.currentSpeakerSegment.text
        )
        lastCurrentTextRef.current = segment.currentSpeakerSegment.text
        nextCurrentSegment = {
          ...segment.currentSpeakerSegment,
          stableText: stable,
          previewText: preview,
          timestamp: Date.now()
        }
      } else {
        lastCurrentTextRef.current = ''
      }

      return {
        ...prev,
        segments: nextSegments,
        currentSegment: nextCurrentSegment
      }
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

  const runMeetingPreconnect = useCallback(async (): Promise<void> => {
    if (isMeetingActiveStatus(meetingStateRef.current.status)) {
      return
    }

    setMeetingState((prev) => ({
      ...prev,
      isPreconnecting: true,
      preconnectFailed: false
    }))

    try {
      const ok = await window.api.preconnectMeetingTranscription()
      if (!ok) {
        throw new Error('Preconnect unavailable')
      }
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
      await window.api.startMeetingTranscription({
        includeMicrophone: false,
        translationEnabled,
        targetLanguage: translationEnabled ? targetLanguage : undefined
      })
      await startSystemAudioCapture(null)
      lastCurrentTextRef.current = ''
      setMeetingState((prev) => ({
        ...prev,
        status: 'transcribing',
        seconds: 0,
        startedAt: Date.now()
      }))
      startMeetingSecondsTimer()
    } catch (err) {
      stopSystemAudioCapture()
      stopMicrophoneCapture()
      stopMeetingSecondsTimer()
      setMeetingState((prev) => ({
        ...prev,
        status: 'error',
        lastError: err instanceof Error ? err.message : String(err)
      }))
    }
  }, [startMeetingSecondsTimer, stopMeetingSecondsTimer])

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

  const stopAndReturnToWorkspace = useCallback(async (): Promise<void> => {
    await stopMeetingSession()
    setAppView('workspace')
    setWorkspaceView('ptt')
  }, [stopMeetingSession])

  const returnToWorkspace = useCallback((): void => {
    if (isMeetingActiveStatus(meetingStateRef.current.status)) return
    setAppView('workspace')
    setWorkspaceView('ptt')
  }, [])

  // Load config on mount
  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  // Apply theme based on preference
  const applyTheme = useCallback((themeOption: ThemeOption) => {
    let effectiveTheme: 'light' | 'dark'

    if (themeOption === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      effectiveTheme = prefersDark ? 'dark' : 'light'
    } else {
      effectiveTheme = themeOption
    }

    document.documentElement.classList.toggle('dark', effectiveTheme === 'dark')
    if (effectiveTheme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light')
    } else {
      document.documentElement.removeAttribute('data-theme')
    }
  }, [])

  useEffect(() => {
    applyTheme(theme)
  }, [theme, applyTheme])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (): void => {
      if (theme === 'system') {
        applyTheme('system')
      }
    }

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

  useEffect(() => {
    if (appView === 'meeting-session') {
      void runMeetingPreconnect()
    }
  }, [appView, runMeetingPreconnect])

  useEffect(() => {
    void window.api
      .getMeetingRuntimeState()
      .then((runtime) => {
        if (runtime.status && runtime.status !== 'idle') {
          setAppView('meeting-session')
          setMeetingState((prev) => ({
            ...prev,
            status: runtime.status as MeetingSessionState['status'],
            startedAt: runtime.startedAt
          }))
        }
      })
      .catch((err) => {
        console.warn('Failed to read meeting runtime state:', err)
      })
  }, [])

  const handleThemeChange = (newTheme: ThemeOption): void => {
    setTheme(newTheme)
  }

  const hotkey = getTriggerKeyLabel(config?.hotkey?.triggerKey || DEFAULT_TRIGGER_KEY)
  const dashboardHotkey = hotkey === 'Right Ctrl' ? 'R Ctrl' : hotkey

  const handleDashboardNavigate = useCallback(
    (nextView: DashboardView) => {
      if (nextView === 'meeting') {
        setAppView('meeting-session')
        setDashboardSettingsOpen(false)
        return
      }

      if (appView === 'meeting-session' && isMeetingActiveStatus(meetingStateRef.current.status)) {
        return
      }

      setAppView('workspace')
      setSelectedTranscriptId(null)
      setDashboardSettingsOpen(false)
      setWorkspaceView(nextView === 'history' ? 'history' : 'ptt')
    },
    [appView]
  )

  const handleNavigateToDetail = useCallback((id: string) => {
    setSelectedTranscriptId(id)
    setAppView('workspace')
    setWorkspaceView('detail')
  }, [])

  const handleBackFromDetail = useCallback(() => {
    setSelectedTranscriptId(null)
    setAppView('workspace')
    setWorkspaceView('history')
  }, [])

  const sidebarActiveView: DashboardView =
    appView === 'meeting-session'
      ? 'meeting'
      : workspaceView === 'history' || workspaceView === 'detail'
        ? 'history'
        : 'ptt'

  return (
    <>
      <div className="h-full w-full bg-background">
        <div className="mx-auto h-full w-full max-w-[1200px] overflow-hidden bg-background">
          <div className="flex h-full w-full">
            <DashboardSidebar
              activeView={sidebarActiveView}
              onNavigate={handleDashboardNavigate}
              meetingSessionLocked={appView === 'meeting-session'}
            />

            {appView === 'workspace' && workspaceView === 'ptt' && (
              <DashboardHome
                hotkey={dashboardHotkey}
                onNavigate={handleDashboardNavigate}
                onOpenSettings={() => setDashboardSettingsOpen(true)}
                onOpenTranscript={handleNavigateToDetail}
              />
            )}

            {appView === 'workspace' && workspaceView === 'history' && (
              <TranscriptHistory onNavigateToDetail={handleNavigateToDetail} />
            )}

            {appView === 'workspace' && workspaceView === 'detail' && selectedTranscriptId && (
              <TranscriptDetail id={selectedTranscriptId} onBack={handleBackFromDetail} />
            )}

            {appView === 'workspace' && workspaceView === 'detail' && !selectedTranscriptId && (
              <TranscriptHistory onNavigateToDetail={handleNavigateToDetail} />
            )}

            {appView === 'meeting-session' && (
              <MeetingTranscription
                state={meetingState}
                onOpenSettings={() => setDashboardSettingsOpen(true)}
                onStart={startMeetingSession}
                onStopAndReturn={stopAndReturnToWorkspace}
                onReturnToWorkspace={returnToWorkspace}
              />
            )}
          </div>
        </div>
      </div>

      {dashboardSettingsOpen && (
        <DashboardSettingsModal
          onClose={() => setDashboardSettingsOpen(false)}
          onSaved={loadConfig}
          onThemeChange={handleThemeChange}
        />
      )}
    </>
  )
}

export default App
