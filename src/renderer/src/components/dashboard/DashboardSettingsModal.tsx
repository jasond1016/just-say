import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { AppLocale, resolveLocale } from '@/i18n'
import { useI18n } from '@/i18n/useI18n'
import { getMicrophoneDevices } from '../../microphone-capture'
import type { TriggerKey } from '../../../../shared/hotkey'
import { RecognitionTab } from '@/components/Settings/RecognitionTab'
import { AppearanceTab } from '@/components/Settings/AppearanceTab'
import { AboutTab } from '@/components/Settings/AboutTab'
import { getApiKeyProvider } from '@/components/Settings/settings-types'
import type {
  ThemeOption,
  Backend,
  LocalEngine,
  EngineOption,
  ModelType,
  GroqModelType,
  LocalRecognitionMode,
  LocalTranscriptionProfile,
  TranslationProvider,
  MicrophoneDevice,
  RendererConfig
} from '@/components/Settings/settings-types'

type ModalTab = 'recognition' | 'appearance' | 'about'
const modalTabOrder: ModalTab[] = ['recognition', 'appearance', 'about']

interface DashboardSettingsModalProps {
  closing?: boolean
  onClose: () => void
  onSaved: () => Promise<void> | void
  onThemeChange: (theme: ThemeOption) => void
}

export function DashboardSettingsModal({
  closing = false,
  onClose,
  onSaved,
  onThemeChange
}: DashboardSettingsModalProps): React.JSX.Element {
  const { m, locale } = useI18n()
  const [activeTab, setActiveTab] = useState<ModalTab>('recognition')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const panelRef = useRef<HTMLElement | null>(null)
  const tabRefs = useRef<Record<ModalTab, HTMLButtonElement | null>>({
    recognition: null,
    appearance: null,
    about: null
  })
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)

  // ─── State ───
  const [engine, setEngine] = useState<EngineOption>('local-faster-whisper')
  const [appLanguage, setAppLanguage] = useState<AppLocale>(locale)
  const [launchAtLogin, setLaunchAtLogin] = useState(false)
  const [audioDevice, setAudioDevice] = useState('default')
  const [microphoneDevices, setMicrophoneDevices] = useState<MicrophoneDevice[]>([])
  const [microphoneDevicesLoading, setMicrophoneDevicesLoading] = useState(false)
  const [microphoneDevicesError, setMicrophoneDevicesError] = useState(false)
  const [language, setLanguage] = useState('auto')
  const [modelSize, setModelSize] = useState<ModelType>('large-v3')
  const [apiModel, setApiModel] = useState('whisper-1')
  const [sonioxModel, setSonioxModel] = useState('stt-rt-v3')
  const [groqModel, setGroqModel] = useState<GroqModelType>('whisper-large-v3-turbo')
  const [onlineApiKeyInput, setOnlineApiKeyInput] = useState('')
  const [onlineApiKeyConfigured, setOnlineApiKeyConfigured] = useState(false)
  const [updatingOnlineApiKey, setUpdatingOnlineApiKey] = useState(false)
  const [localServerMode, setLocalServerMode] = useState<'local' | 'remote'>('local')
  const [localServerHost, setLocalServerHost] = useState('127.0.0.1')
  const [localServerPortInput, setLocalServerPortInput] = useState('8765')
  const [localRecognitionMode, setLocalRecognitionMode] = useState<LocalRecognitionMode>('auto')
  const [localTranscriptionProfile, setLocalTranscriptionProfile] = useState<LocalTranscriptionProfile>('single_shot')
  const [localHoldMsInput, setLocalHoldMsInput] = useState('260')
  const [testingLocalServer, setTestingLocalServer] = useState(false)
  const [localServerTestResult, setLocalServerTestResult] = useState<boolean | null>(null)
  const [hotkey, setHotkey] = useState<TriggerKey>('RCtrl')
  const [translationEnabled, setTranslationEnabled] = useState(false)
  const [meetingTranslationEnabled, setMeetingTranslationEnabled] = useState(false)
  const [meetingIncludeMicrophone, setMeetingIncludeMicrophone] = useState(false)
  const [targetLanguage, setTargetLanguage] = useState('zh')
  const [translationProvider, setTranslationProvider] = useState<TranslationProvider>('openai-compatible')
  const [translationEndpoint, setTranslationEndpoint] = useState('https://api.openai.com/v1')
  const [translationModel, setTranslationModel] = useState('gpt-4o-mini')
  const [translationApiKeyInput, setTranslationApiKeyInput] = useState('')
  const [translationApiKeyConfigured, setTranslationApiKeyConfigured] = useState(false)
  const [updatingTranslationApiKey, setUpdatingTranslationApiKey] = useState(false)
  const [theme, setTheme] = useState<ThemeOption>('system')
  const [indicatorEnabled, setIndicatorEnabled] = useState(true)
  const [soundEnabled, setSoundEnabled] = useState(true)

  // ─── Derived ───
  const isLocalEngine = useMemo(() => engine === 'local-faster-whisper' || engine === 'local-sensevoice', [engine])
  const isSenseVoiceEngine = engine === 'local-sensevoice'
  const isOnlineEngine = engine === 'api' || engine === 'soniox' || engine === 'groq'
  const isRemoteLocalServer = isLocalEngine && localServerMode === 'remote'
  const isStreamingModeEnabled = isLocalEngine && localRecognitionMode !== 'http_chunk'
  const onlineApiKeyProvider = useMemo(() => getApiKeyProvider(engine), [engine])
  const anyTranslationEnabled = translationEnabled || meetingTranslationEnabled
  const selectedAudioDeviceUnavailable = useMemo(
    () => audioDevice !== 'default' && !microphoneDevices.some((d) => d.id === audioDevice),
    [audioDevice, microphoneDevices]
  )

  // ─── Load config ───
  const loadMicrophoneDeviceOptions = useCallback(async (): Promise<void> => {
    setMicrophoneDevicesLoading(true)
    setMicrophoneDevicesError(false)
    try {
      const devices = await getMicrophoneDevices()
      setMicrophoneDevices(devices)
    } catch (error) {
      console.warn('[Settings] Failed to enumerate microphone devices:', error)
      setMicrophoneDevices([])
      setMicrophoneDevicesError(true)
    } finally {
      setMicrophoneDevicesLoading(false)
    }
  }, [])

  useEffect(() => {
    let mounted = true
    void window.api
      .getConfig()
      .then((config) => {
        if (!mounted) return
        const cfg = config as RendererConfig
        const backend = cfg.recognition?.backend || 'local'
        const localEngine = cfg.recognition?.local?.engine || 'faster-whisper'
        const engineValue: EngineOption =
          backend === 'local'
            ? localEngine === 'sensevoice' ? 'local-sensevoice' : 'local-faster-whisper'
            : backend === 'api' || backend === 'soniox' || backend === 'groq'
              ? backend
              : 'local-faster-whisper'

        setEngine(engineValue)
        setAppLanguage(resolveLocale(cfg.general?.language))
        setLaunchAtLogin(cfg.general?.autostart === true)
        setAudioDevice(cfg.audio?.device || 'default')
        setLanguage(cfg.recognition?.language || 'auto')
        const nextModelSize = (cfg.recognition?.local?.modelType || 'large-v3') as ModelType
        setModelSize(engineValue === 'local-sensevoice' ? 'small' : nextModelSize)
        const configuredLocalMode = cfg.recognition?.local?.mode
        setLocalRecognitionMode(
          configuredLocalMode === 'auto' || configuredLocalMode === 'streaming' || configuredLocalMode === 'http_chunk'
            ? configuredLocalMode : 'auto'
        )
        const configuredTP = cfg.recognition?.local?.transcriptionProfile
        setLocalTranscriptionProfile(configuredTP === 'offline_segmented' ? 'offline_segmented' : 'single_shot')
        const configuredHoldMs = cfg.recognition?.local?.segmentation?.holdMs
        setLocalHoldMsInput(
          typeof configuredHoldMs === 'number' && Number.isFinite(configuredHoldMs) && configuredHoldMs >= 50
            ? String(Math.floor(configuredHoldMs)) : '260'
        )
        setLocalServerMode(cfg.recognition?.local?.serverMode || 'local')
        setLocalServerHost(cfg.recognition?.local?.serverHost || '127.0.0.1')
        setLocalServerPortInput(String(cfg.recognition?.local?.serverPort || 8765))
        setApiModel(cfg.recognition?.api?.model || 'whisper-1')
        setSonioxModel(cfg.recognition?.soniox?.model || 'stt-rt-v3')
        setGroqModel(cfg.recognition?.groq?.model || 'whisper-large-v3-turbo')
        setHotkey((cfg.hotkey?.triggerKey || 'RCtrl') as TriggerKey)
        setMeetingIncludeMicrophone(cfg.recognition?.meeting?.includeMicrophone === true)
        setTranslationEnabled(cfg.recognition?.translation?.enabledForPtt === true)
        setMeetingTranslationEnabled(cfg.recognition?.translation?.enabledForMeeting === true)
        setTargetLanguage(cfg.recognition?.translation?.targetLanguage || 'zh')
        setTranslationProvider(cfg.recognition?.translation?.provider || 'openai-compatible')
        setTranslationEndpoint(cfg.recognition?.translation?.endpoint || 'https://api.openai.com/v1')
        setTranslationModel(cfg.recognition?.translation?.model || 'gpt-4o-mini')
        setTheme(cfg.ui?.theme || 'system')
        setIndicatorEnabled(cfg.ui?.indicatorEnabled !== false)
        setSoundEnabled(cfg.ui?.soundFeedback !== false)
        void window.api.hasApiKey('openai').then((hasKey) => { if (mounted) setTranslationApiKeyConfigured(hasKey) }).catch(() => { if (mounted) setTranslationApiKeyConfigured(false) })
      })
      .finally(() => { if (mounted) setLoading(false) })
    void loadMicrophoneDeviceOptions()
    return () => { mounted = false }
  }, [loadMicrophoneDeviceOptions])

  // ─── Side effects ───
  useEffect(() => { if (isSenseVoiceEngine) setModelSize('small') }, [isSenseVoiceEngine])
  useEffect(() => { setLocalServerTestResult(null) }, [localServerMode, localServerHost, localServerPortInput, engine])

  useEffect(() => {
    setOnlineApiKeyInput('')
    if (!onlineApiKeyProvider) { setOnlineApiKeyConfigured(false); return }
    let mounted = true
    void window.api.hasApiKey(onlineApiKeyProvider).then((hasKey) => { if (mounted) setOnlineApiKeyConfigured(hasKey) }).catch(() => { if (mounted) setOnlineApiKeyConfigured(false) })
    return () => { mounted = false }
  }, [onlineApiKeyProvider])

  // ─── Actions ───
  const clearTranslationApiKey = async (): Promise<void> => {
    if (updatingTranslationApiKey) return
    setUpdatingTranslationApiKey(true)
    try { await window.api.deleteApiKey('openai'); setTranslationApiKeyConfigured(false); setTranslationApiKeyInput('') } finally { setUpdatingTranslationApiKey(false) }
  }

  const clearOnlineApiKey = async (): Promise<void> => {
    if (!onlineApiKeyProvider || updatingOnlineApiKey) return
    setUpdatingOnlineApiKey(true)
    try { await window.api.deleteApiKey(onlineApiKeyProvider); setOnlineApiKeyConfigured(false); setOnlineApiKeyInput('') } finally { setUpdatingOnlineApiKey(false) }
  }

  const resolveLocalServerPort = useCallback((): number => {
    const p = Number.parseInt(localServerPortInput, 10)
    return Number.isNaN(p) || p < 1 || p > 65535 ? 8765 : p
  }, [localServerPortInput])

  const resolveLocalHoldMs = useCallback((): number => {
    const v = Number.parseInt(localHoldMsInput, 10)
    if (Number.isNaN(v)) return 260
    if (v < 50) return 50
    if (v > 5000) return 5000
    return v
  }, [localHoldMsInput])

  const testRemoteLocalServer = async (): Promise<void> => {
    if (testingLocalServer) return
    setTestingLocalServer(true)
    setLocalServerTestResult(null)
    try {
      const healthy = await window.api.testWhisperServer(localServerHost.trim() || '127.0.0.1', resolveLocalServerPort())
      setLocalServerTestResult(healthy)
    } catch { setLocalServerTestResult(false) } finally { setTestingLocalServer(false) }
  }

  // ─── Dialog keyboard ───
  const setTabRef = useCallback((tab: ModalTab) => (node: HTMLButtonElement | null): void => { tabRefs.current[tab] = node }, [])

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const handleKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key !== 'Tab' || !panelRef.current) return
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (event.shiftKey && active === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus() }
    }

    window.addEventListener('keydown', handleKeydown)
    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', handleKeydown)
      previouslyFocusedRef.current?.focus()
    }
  }, [onClose])

  const handleTabTriggerKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>, tab: ModalTab): void => {
    const index = modalTabOrder.indexOf(tab)
    if (index < 0) return
    let nextTab: ModalTab | null = null
    if (event.key === 'ArrowDown') { event.preventDefault(); nextTab = modalTabOrder[(index + 1) % modalTabOrder.length] }
    else if (event.key === 'ArrowUp') { event.preventDefault(); nextTab = modalTabOrder[(index - 1 + modalTabOrder.length) % modalTabOrder.length] }
    else if (event.key === 'Home') { event.preventDefault(); nextTab = modalTabOrder[0] }
    else if (event.key === 'End') { event.preventDefault(); nextTab = modalTabOrder[modalTabOrder.length - 1] }
    if (nextTab) { setActiveTab(nextTab); window.requestAnimationFrame(() => { tabRefs.current[nextTab]?.focus() }) }
  }, [])

  // ─── Save ───
  const saveChanges = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    try {
      const backend: Backend = engine === 'local-faster-whisper' || engine === 'local-sensevoice' ? 'local' : engine as Backend
      const localEngine: LocalEngine = engine === 'local-sensevoice' ? 'sensevoice' : 'faster-whisper'
      await window.api.setConfig({
        general: { language: appLanguage, autostart: launchAtLogin },
        hotkey: { triggerKey: hotkey },
        audio: { device: audioDevice },
        recognition: {
          backend,
          language,
          meeting: { includeMicrophone: meetingIncludeMicrophone },
          translation: {
            provider: translationProvider,
            enabledForPtt: translationEnabled,
            enabledForMeeting: meetingTranslationEnabled,
            targetLanguage,
            endpoint: translationEndpoint.trim(),
            model: translationModel.trim()
          },
          local: {
            engine: localEngine,
            mode: localRecognitionMode,
            transcriptionProfile: localTranscriptionProfile,
            modelType: localEngine === 'sensevoice' ? 'small' : modelSize,
            serverMode: localServerMode,
            serverHost: localServerHost.trim() || '127.0.0.1',
            serverPort: resolveLocalServerPort(),
            segmentation: { holdMs: resolveLocalHoldMs() }
          },
          api: { model: apiModel.trim() || 'whisper-1' },
          soniox: { model: sonioxModel.trim() || 'stt-rt-v3' },
          groq: { model: groqModel }
        },
        ui: { theme, indicatorEnabled, soundFeedback: soundEnabled }
      })

      const nextTranslationApiKey = translationApiKeyInput.trim()
      if (nextTranslationApiKey) {
        await window.api.setApiKey('openai', nextTranslationApiKey)
        setTranslationApiKeyConfigured(true)
        setTranslationApiKeyInput('')
      }

      const nextOnlineApiKey = onlineApiKeyInput.trim()
      if (onlineApiKeyProvider && nextOnlineApiKey) {
        await window.api.setApiKey(onlineApiKeyProvider, nextOnlineApiKey)
        setOnlineApiKeyConfigured(true)
        setOnlineApiKeyInput('')
      }

      onThemeChange(theme)
      await onSaved()
      onClose()
    } finally { setSaving(false) }
  }

  // ─── Render ───
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        aria-hidden="true"
        className={`absolute inset-0 bg-foreground/10 ${closing ? 'animate-[fadeOut_200ms_ease-in_forwards]' : 'animate-[fadeIn_120ms_ease-out]'}`}
        onClick={onClose}
      />

      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-panel-title"
        aria-describedby="settings-panel-description"
        className={`relative z-10 flex w-[520px] max-w-[calc(100vw-4rem)] flex-col bg-card border-l border-border shadow-tinted-xl mt-9 ${closing ? 'animate-[slideOverOut_220ms_var(--ease-out-quart)_forwards]' : 'animate-[slideOverIn_280ms_var(--ease-out-expo)]'}`}
      >
        <p id="settings-panel-description" className="sr-only">{m.settings.modalDescription}</p>

        <header className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 id="settings-panel-title" className="font-display text-xl text-foreground">
            {m.settings.title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="press-scale inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
            aria-label={m.settings.closeAria}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex flex-1 flex-col overflow-hidden">
          {loading ? (
            <div className="flex flex-1 flex-col gap-5 p-5">
              <div className="skeleton h-4 w-24 rounded" />
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="skeleton h-4 w-28 rounded" />
                  <div className="skeleton h-9 w-[220px] rounded-md" />
                </div>
                <div className="flex items-center justify-between">
                  <div className="skeleton h-4 w-20 rounded" />
                  <div className="skeleton h-9 w-[220px] rounded-md" />
                </div>
                <div className="flex items-center justify-between">
                  <div className="skeleton h-4 w-24 rounded" />
                  <div className="skeleton h-9 w-[220px] rounded-md" />
                </div>
                <div className="flex items-center justify-between">
                  <div className="skeleton h-4 w-32 rounded" />
                  <div className="skeleton h-[22px] w-10 rounded-full" />
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-0 border-b border-border px-5">
                {modalTabOrder.map((tab) => {
                  const labels: Record<ModalTab, string> = {
                    recognition: m.settings.tabRecognition,
                    appearance: m.settings.tabAppearance,
                    about: m.settings.tabAbout
                  }
                  return (
                    <button
                      key={tab}
                      ref={setTabRef(tab)}
                      type="button"
                      onClick={() => setActiveTab(tab)}
                      onKeyDown={(e) => handleTabTriggerKeyDown(e, tab)}
                      role="tab"
                      id={`settings-tab-${tab}`}
                      aria-controls={`settings-panel-${tab}`}
                      aria-selected={activeTab === tab}
                      tabIndex={activeTab === tab ? 0 : -1}
                      className={`px-4 py-3 text-[13px] transition-colors focus-visible:outline-none relative ${
                        activeTab === tab
                          ? 'font-medium text-primary'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {labels[tab]}
                      {activeTab === tab && (
                        <span className="absolute bottom-0 left-4 right-4 h-[2px] bg-primary rounded-full" />
                      )}
                    </button>
                  )
                })}
              </div>

              <div className="min-w-0 flex-1 overflow-auto p-5">
                {activeTab === 'recognition' && (
                  <RecognitionTab
                    saving={saving}
                    engine={engine} setEngine={setEngine}
                    language={language} setLanguage={setLanguage}
                    hotkey={hotkey} setHotkey={setHotkey}
                    modelSize={modelSize} setModelSize={setModelSize}
                    meetingIncludeMicrophone={meetingIncludeMicrophone} setMeetingIncludeMicrophone={setMeetingIncludeMicrophone}
                    audioDevice={audioDevice} setAudioDevice={setAudioDevice}
                    microphoneDevices={microphoneDevices}
                    microphoneDevicesLoading={microphoneDevicesLoading}
                    microphoneDevicesError={microphoneDevicesError}
                    selectedAudioDeviceUnavailable={selectedAudioDeviceUnavailable}
                    loadMicrophoneDeviceOptions={loadMicrophoneDeviceOptions}
                    isLocalEngine={isLocalEngine} isSenseVoiceEngine={isSenseVoiceEngine}
                    localRecognitionMode={localRecognitionMode} setLocalRecognitionMode={setLocalRecognitionMode}
                    localTranscriptionProfile={localTranscriptionProfile} setLocalTranscriptionProfile={setLocalTranscriptionProfile}
                    localHoldMsInput={localHoldMsInput} setLocalHoldMsInput={setLocalHoldMsInput}
                    resolveLocalHoldMs={resolveLocalHoldMs} isStreamingModeEnabled={isStreamingModeEnabled}
                    localServerMode={localServerMode} setLocalServerMode={setLocalServerMode}
                    isRemoteLocalServer={isRemoteLocalServer}
                    localServerHost={localServerHost} setLocalServerHost={setLocalServerHost}
                    localServerPortInput={localServerPortInput} setLocalServerPortInput={setLocalServerPortInput}
                    testingLocalServer={testingLocalServer} localServerTestResult={localServerTestResult}
                    testRemoteLocalServer={testRemoteLocalServer}
                    isOnlineEngine={isOnlineEngine}
                    onlineApiKeyInput={onlineApiKeyInput} setOnlineApiKeyInput={setOnlineApiKeyInput}
                    onlineApiKeyConfigured={onlineApiKeyConfigured} updatingOnlineApiKey={updatingOnlineApiKey}
                    clearOnlineApiKey={clearOnlineApiKey}
                    apiModel={apiModel} setApiModel={setApiModel}
                    sonioxModel={sonioxModel} setSonioxModel={setSonioxModel}
                    groqModel={groqModel} setGroqModel={setGroqModel}
                    translationEnabled={translationEnabled} setTranslationEnabled={setTranslationEnabled}
                    meetingTranslationEnabled={meetingTranslationEnabled} setMeetingTranslationEnabled={setMeetingTranslationEnabled}
                    anyTranslationEnabled={anyTranslationEnabled}
                    targetLanguage={targetLanguage} setTargetLanguage={setTargetLanguage}
                    translationProvider={translationProvider} setTranslationProvider={setTranslationProvider}
                    translationModel={translationModel} setTranslationModel={setTranslationModel}
                    translationEndpoint={translationEndpoint} setTranslationEndpoint={setTranslationEndpoint}
                    translationApiKeyInput={translationApiKeyInput} setTranslationApiKeyInput={setTranslationApiKeyInput}
                    translationApiKeyConfigured={translationApiKeyConfigured} updatingTranslationApiKey={updatingTranslationApiKey}
                    clearTranslationApiKey={clearTranslationApiKey}
                  />
                )}
                {activeTab === 'appearance' && (
                  <AppearanceTab
                    theme={theme} setTheme={setTheme}
                    appLanguage={appLanguage} setAppLanguage={setAppLanguage}
                    launchAtLogin={launchAtLogin} setLaunchAtLogin={setLaunchAtLogin}
                    indicatorEnabled={indicatorEnabled} setIndicatorEnabled={setIndicatorEnabled}
                    soundEnabled={soundEnabled} setSoundEnabled={setSoundEnabled}
                  />
                )}
                {activeTab === 'about' && <AboutTab />}
              </div>
            </>
          )}
        </div>

        <footer className="flex justify-end border-t border-border px-6 py-3">
          <Button
            type="button"
            size="sm"
            onClick={() => { void saveChanges() }}
            disabled={loading || saving}
          >
            {saving ? m.settings.saving : m.settings.saveChanges}
          </Button>
        </footer>
      </section>
    </div>
  )
}
