import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { AppLocale, resolveLocale } from '@/i18n'
import { useI18n } from '@/i18n/useI18n'
import { getMicrophoneDevices } from '../../microphone-capture'
import type { TriggerKey } from '../../../../shared/hotkey'

type ThemeOption = 'system' | 'light' | 'dark'
type ModalTab = 'recognition' | 'appearance' | 'about'
type Backend = 'local' | 'api' | 'network' | 'soniox' | 'groq'
type LocalEngine = 'faster-whisper' | 'sensevoice'
type LocalRecognitionMode = 'auto' | 'streaming' | 'http_chunk'
type LocalTranscriptionProfile = 'single_shot' | 'offline_segmented'
type ModelType = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3'
type GroqModelType = 'whisper-large-v3-turbo' | 'whisper-large-v3'
type TranslationProvider = 'openai-compatible'
type ApiKeyProvider = 'openai' | 'soniox' | 'groq'

interface RendererConfig {
  general?: { language?: AppLocale; autostart?: boolean }
  hotkey?: { triggerKey?: TriggerKey }
  audio?: { device?: string }
  recognition?: {
    backend?: Backend
    language?: string
    meeting?: { includeMicrophone?: boolean }
    translation?: {
      provider?: TranslationProvider
      enabledForPtt?: boolean
      enabledForMeeting?: boolean
      targetLanguage?: string
      endpoint?: string
      model?: string
    }
    local?: {
      engine?: LocalEngine
      mode?: LocalRecognitionMode
      transcriptionProfile?: LocalTranscriptionProfile
      modelType?: ModelType
      serverMode?: 'local' | 'remote'
      serverHost?: string
      serverPort?: number
      segmentation?: { holdMs?: number }
    }
    api?: { model?: string }
    soniox?: { model?: string }
    groq?: { model?: GroqModelType }
  }
  ui?: {
    theme?: ThemeOption
    indicatorEnabled?: boolean
    soundFeedback?: boolean
  }
}

interface DashboardSettingsModalProps {
  onClose: () => void
  onSaved: () => Promise<void> | void
  onThemeChange: (theme: ThemeOption) => void
}

type EngineOption = 'local-faster-whisper' | 'local-sensevoice' | 'soniox' | 'api' | 'groq'
const modalTabOrder: ModalTab[] = ['recognition', 'appearance', 'about']
type MicrophoneDevice = { id: string; name: string; isDefault?: boolean }

function getApiKeyProvider(engine: EngineOption): ApiKeyProvider | null {
  if (engine === 'api') return 'openai'
  if (engine === 'soniox') return 'soniox'
  if (engine === 'groq') return 'groq'
  return null
}

/* ─── Toggle ─── */
function Toggle({
  checked,
  onChange,
  labelledBy
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  labelledBy?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-colors ${
        checked ? 'border-primary bg-primary' : 'border-border bg-muted'
      } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-1`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]'
        }`}
      />
    </button>
  )
}

/* ─── Form field styles ─── */
const fieldClass =
  'h-9 rounded-md border border-input bg-transparent px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/30 placeholder:text-muted-foreground/50'
const fullFieldClass = `${fieldClass} w-full`

/* ─── Section divider ─── */
function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="text-[11px] font-medium tracking-widest uppercase text-muted-foreground mb-3 mt-1">
      {children}
    </p>
  )
}

export function DashboardSettingsModal({
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
  const [localTranscriptionProfile, setLocalTranscriptionProfile] =
    useState<LocalTranscriptionProfile>('single_shot')
  const [localHoldMsInput, setLocalHoldMsInput] = useState('260')
  const [testingLocalServer, setTestingLocalServer] = useState(false)
  const [localServerTestResult, setLocalServerTestResult] = useState<boolean | null>(null)
  const [hotkey, setHotkey] = useState<TriggerKey>('RCtrl')
  const [translationEnabled, setTranslationEnabled] = useState(false)
  const [meetingTranslationEnabled, setMeetingTranslationEnabled] = useState(false)
  const [meetingIncludeMicrophone, setMeetingIncludeMicrophone] = useState(false)
  const [targetLanguage, setTargetLanguage] = useState('zh')
  const [translationProvider, setTranslationProvider] =
    useState<TranslationProvider>('openai-compatible')
  const [translationEndpoint, setTranslationEndpoint] = useState('https://api.openai.com/v1')
  const [translationModel, setTranslationModel] = useState('gpt-4o-mini')
  const [translationApiKeyInput, setTranslationApiKeyInput] = useState('')
  const [translationApiKeyConfigured, setTranslationApiKeyConfigured] = useState(false)
  const [updatingTranslationApiKey, setUpdatingTranslationApiKey] = useState(false)
  const [theme, setTheme] = useState<ThemeOption>('system')
  const [indicatorEnabled, setIndicatorEnabled] = useState(true)
  const [soundEnabled, setSoundEnabled] = useState(true)

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

  useEffect(() => { if (isSenseVoiceEngine) setModelSize('small') }, [isSenseVoiceEngine])
  useEffect(() => { setLocalServerTestResult(null) }, [localServerMode, localServerHost, localServerPortInput, engine])

  useEffect(() => {
    setOnlineApiKeyInput('')
    if (!onlineApiKeyProvider) { setOnlineApiKeyConfigured(false); return }
    let mounted = true
    void window.api.hasApiKey(onlineApiKeyProvider).then((hasKey) => { if (mounted) setOnlineApiKeyConfigured(hasKey) }).catch(() => { if (mounted) setOnlineApiKeyConfigured(false) })
    return () => { mounted = false }
  }, [onlineApiKeyProvider])

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

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-foreground/10 animate-[fadeIn_120ms_ease-out]"
        onClick={onClose}
      />

      {/* Slide-over panel */}
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-panel-title"
        aria-describedby="settings-panel-description"
        className="relative z-10 flex h-full w-[520px] max-w-[calc(100vw-4rem)] flex-col bg-card border-l border-border animate-[slideOverIn_280ms_var(--ease-out-expo)]"
      >
        <p id="settings-panel-description" className="sr-only">{m.settings.modalDescription}</p>

        {/* Panel header */}
        <header className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 id="settings-panel-title" className="font-display text-xl italic text-foreground">
            {m.settings.title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
            aria-label={m.settings.closeAria}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* Tabs + Content */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {loading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              {m.settings.loading}
            </div>
          ) : (
            <>
              {/* Tab list */}
              <aside className="w-36 shrink-0 border-r border-border px-3 py-4">
                <div role="tablist" aria-label={m.settings.sectionsAria} aria-orientation="vertical" className="flex flex-col gap-0.5">
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
                        className={`px-3 py-2 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded-sm ${
                          activeTab === tab
                            ? 'font-medium text-primary'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {labels[tab]}
                        {activeTab === tab && <span className="block h-[2px] w-4 bg-primary mt-0.5 rounded-full" />}
                      </button>
                    )
                  })}
                </div>
              </aside>

              {/* Panel content */}
              <div className="min-w-0 flex-1 overflow-auto p-5">

                {/* ─── Recognition ─── */}
                {activeTab === 'recognition' && (
                  <div role="tabpanel" id="settings-panel-recognition" aria-labelledby="settings-tab-recognition" className="space-y-5">

                    <SectionLabel>{m.settings.recognitionEngine}</SectionLabel>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="space-y-1.5" htmlFor="s-engine">
                        <span className="text-[13px] font-medium">{m.settings.recognitionEngine}</span>
                        <select id="s-engine" className={fullFieldClass} value={engine} onChange={(e) => setEngine(e.target.value as EngineOption)}>
                          <option value="local-faster-whisper">{m.settings.engineFasterWhisperLocal}</option>
                          <option value="local-sensevoice">{m.settings.engineSenseVoiceLocal}</option>
                          <option value="soniox">{m.settings.engineSoniox}</option>
                          <option value="api">{m.settings.engineOpenAiApi}</option>
                          <option value="groq">{m.settings.engineGroq}</option>
                        </select>
                      </label>
                      <label className="space-y-1.5" htmlFor="s-lang">
                        <span className="text-[13px] font-medium">{m.settings.language}</span>
                        <select id="s-lang" className={fullFieldClass} value={language} onChange={(e) => setLanguage(e.target.value)}>
                          <option value="auto">{m.settings.autoDetect}</option>
                          <option value="zh">{m.settings.chinese}</option>
                          <option value="en">{m.settings.english}</option>
                          <option value="ja">{m.settings.japanese}</option>
                          <option value="ko">{m.settings.korean}</option>
                        </select>
                      </label>
                    </div>

                    <div className="space-y-3 pt-2">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <p id="s-mic-label" className="text-[13px] font-medium">{m.settings.meetingIncludeMicrophone}</p>
                          <p className="text-[12px] text-muted-foreground">{m.settings.meetingIncludeMicrophoneDescription}</p>
                        </div>
                        <Toggle checked={meetingIncludeMicrophone} onChange={setMeetingIncludeMicrophone} labelledBy="s-mic-label" />
                      </div>

                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-3">
                          <label className="text-[13px] font-medium" htmlFor="s-audio-device">{m.settings.microphoneDevice}</label>
                          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[12px]" onClick={() => { void loadMicrophoneDeviceOptions() }} disabled={microphoneDevicesLoading || saving}>
                            {microphoneDevicesLoading ? m.settings.refreshing : m.settings.refresh}
                          </Button>
                        </div>
                        <select id="s-audio-device" className={fullFieldClass} value={audioDevice} onChange={(e) => setAudioDevice(e.target.value)} disabled={microphoneDevicesLoading}>
                          <option value="default">{m.settings.defaultDevice}</option>
                          {selectedAudioDeviceUnavailable ? <option value={audioDevice}>{m.settings.savedDeviceUnavailable}</option> : null}
                          {microphoneDevices.filter((d) => d.id && d.id !== 'default').map((d, i) => (
                            <option key={`${d.id}-${i}`} value={d.id}>{d.name}</option>
                          ))}
                        </select>
                        {microphoneDevicesError && <p className="text-[11px] text-muted-foreground">{m.settings.microphoneLoadFailed}</p>}
                      </div>
                    </div>

                    <div className={`grid gap-3 ${isLocalEngine && !isSenseVoiceEngine ? 'grid-cols-2' : 'grid-cols-1'}`}>
                      {isLocalEngine && !isSenseVoiceEngine && (
                        <label className="space-y-1.5" htmlFor="s-model">
                          <span className="text-[13px] font-medium">{m.settings.modelSize}</span>
                          <select id="s-model" className={fullFieldClass} value={modelSize} onChange={(e) => setModelSize(e.target.value as ModelType)}>
                            <option value="tiny">tiny</option>
                            <option value="base">base</option>
                            <option value="small">small</option>
                            <option value="medium">medium</option>
                            <option value="large-v3">large-v3</option>
                          </select>
                        </label>
                      )}
                      <label className="space-y-1.5" htmlFor="s-hotkey">
                        <span className="text-[13px] font-medium">{m.settings.hotkey}</span>
                        <select id="s-hotkey" className={fullFieldClass} value={hotkey} onChange={(e) => setHotkey(e.target.value as TriggerKey)}>
                          <option value="RCtrl">{m.settings.rightCtrl}</option>
                          <option value="RAlt">{m.settings.rightAlt}</option>
                          <option value="F13">F13</option>
                          <option value="F14">F14</option>
                        </select>
                      </label>
                    </div>

                    {isLocalEngine && (
                      <>
                        <SectionLabel>Local Engine</SectionLabel>
                        <div className="grid grid-cols-2 gap-3">
                          <label className="space-y-1.5" htmlFor="s-local-mode">
                            <span className="text-[13px] font-medium">{m.settings.localRecognitionMode}</span>
                            <select id="s-local-mode" className={fullFieldClass} value={localRecognitionMode} onChange={(e) => setLocalRecognitionMode(e.target.value as LocalRecognitionMode)}>
                              <option value="auto">{m.settings.localRecognitionModeAuto}</option>
                              <option value="streaming">{m.settings.localRecognitionModeStreaming}</option>
                              <option value="http_chunk">{m.settings.localRecognitionModeHttpChunk}</option>
                            </select>
                          </label>
                          <label className="space-y-1.5" htmlFor="s-local-profile">
                            <span className="text-[13px] font-medium">{m.settings.localTranscriptionProfile}</span>
                            <select id="s-local-profile" className={fullFieldClass} value={localTranscriptionProfile} onChange={(e) => setLocalTranscriptionProfile(e.target.value as LocalTranscriptionProfile)}>
                              <option value="single_shot">{m.settings.localTranscriptionProfileSingleShot}</option>
                              <option value="offline_segmented">{m.settings.localTranscriptionProfileOfflineSegmented}</option>
                            </select>
                            <p className="text-[11px] text-muted-foreground">{m.settings.localTranscriptionProfileDescription}</p>
                          </label>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          <label className="space-y-1.5" htmlFor="s-hold-ms">
                            <span className="text-[13px] font-medium">{m.settings.localHoldMs}</span>
                            <input id="s-hold-ms" type="number" min={50} max={5000} className={`${fullFieldClass} disabled:opacity-40`} value={localHoldMsInput} onChange={(e) => setLocalHoldMsInput(e.target.value)} onBlur={() => setLocalHoldMsInput(String(resolveLocalHoldMs()))} placeholder="260" disabled={!isStreamingModeEnabled} />
                            <p className="text-[11px] text-muted-foreground">{m.settings.localHoldMsDescription}</p>
                          </label>
                          <div />
                        </div>

                        <label className="space-y-1.5 block" htmlFor="s-server-mode">
                          <span className="text-[13px] font-medium">{m.settings.localServerMode}</span>
                          <select id="s-server-mode" className={`${fieldClass} w-[200px]`} value={localServerMode} onChange={(e) => setLocalServerMode(e.target.value as 'local' | 'remote')}>
                            <option value="local">{m.settings.localServerModeLocal}</option>
                            <option value="remote">{m.settings.localServerModeRemote}</option>
                          </select>
                        </label>

                        {isRemoteLocalServer && (
                          <>
                            <div className="grid grid-cols-2 gap-3">
                              <label className="space-y-1.5" htmlFor="s-host">
                                <span className="text-[13px] font-medium">{m.settings.localServerHost}</span>
                                <input id="s-host" type="text" className={fullFieldClass} value={localServerHost} onChange={(e) => setLocalServerHost(e.target.value)} placeholder="127.0.0.1" />
                              </label>
                              <label className="space-y-1.5" htmlFor="s-port">
                                <span className="text-[13px] font-medium">{m.settings.localServerPort}</span>
                                <input id="s-port" type="number" min={1} max={65535} className={fullFieldClass} value={localServerPortInput} onChange={(e) => setLocalServerPortInput(e.target.value)} placeholder="8765" />
                              </label>
                            </div>
                            <div className="flex items-center justify-between border border-border bg-muted/30 px-3 py-2 rounded-sm">
                              <p className="text-[12px] text-muted-foreground">
                                {localServerTestResult === null
                                  ? m.settings.localServerTestIdle
                                  : localServerTestResult
                                    ? m.settings.localServerTestSuccess
                                    : m.settings.localServerTestFailed}
                              </p>
                              <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-[12px]" onClick={() => { void testRemoteLocalServer() }} disabled={testingLocalServer || saving}>
                                {testingLocalServer ? m.settings.localServerTesting : m.settings.testLocalServer}
                              </Button>
                            </div>
                          </>
                        )}
                      </>
                    )}

                    {isOnlineEngine && (
                      <>
                        <SectionLabel>API</SectionLabel>
                        <div className="grid grid-cols-2 gap-3">
                          <label className="space-y-1.5" htmlFor="s-api-key">
                            <span className="text-[13px] font-medium">{m.settings.recognitionApiKey}</span>
                            <input id="s-api-key" type="password" className={fullFieldClass} value={onlineApiKeyInput} onChange={(e) => setOnlineApiKeyInput(e.target.value)} placeholder={onlineApiKeyConfigured ? m.settings.storedKeyPlaceholder : m.settings.enterApiKey} />
                          </label>
                          <label className="space-y-1.5" htmlFor="s-model-type">
                            <span className="text-[13px] font-medium">{m.settings.modelType}</span>
                            {engine === 'groq' ? (
                              <select id="s-model-type" className={fullFieldClass} value={groqModel} onChange={(e) => setGroqModel(e.target.value as GroqModelType)}>
                                <option value="whisper-large-v3-turbo">whisper-large-v3-turbo</option>
                                <option value="whisper-large-v3">whisper-large-v3</option>
                              </select>
                            ) : (
                              <input id="s-model-type" type="text" className={fullFieldClass} value={engine === 'api' ? apiModel : sonioxModel} onChange={(e) => { if (engine === 'api') setApiModel(e.target.value); else if (engine === 'soniox') setSonioxModel(e.target.value) }} placeholder={engine === 'api' ? 'whisper-1' : 'stt-rt-v3'} />
                            )}
                          </label>
                        </div>
                        <div className="flex items-center justify-between border border-border bg-muted/30 px-3 py-2 rounded-sm">
                          <p className="text-[12px] text-muted-foreground">
                            {m.settings.apiKeyStatus}{' '}
                            <span className="font-medium text-foreground">{onlineApiKeyConfigured ? m.settings.configured : m.settings.notConfigured}</span>
                          </p>
                          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[12px]" onClick={() => { void clearOnlineApiKey() }} disabled={!onlineApiKeyConfigured || updatingOnlineApiKey || saving}>
                            {m.settings.removeStoredKey}
                          </Button>
                        </div>
                      </>
                    )}

                    <SectionLabel>Translation</SectionLabel>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <p id="s-t-ptt" className="text-[13px] font-medium">{m.settings.enableTranslationForPtt}</p>
                          <p className="text-[12px] text-muted-foreground">{m.settings.translationPttDescription}</p>
                        </div>
                        <Toggle checked={translationEnabled} onChange={setTranslationEnabled} labelledBy="s-t-ptt" />
                      </div>
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <p id="s-t-mtg" className="text-[13px] font-medium">{m.settings.enableTranslationForMeeting}</p>
                          <p className="text-[12px] text-muted-foreground">{m.settings.translationMeetingDescription}</p>
                        </div>
                        <Toggle checked={meetingTranslationEnabled} onChange={setMeetingTranslationEnabled} labelledBy="s-t-mtg" />
                      </div>
                    </div>

                    <label className="space-y-1.5 block" htmlFor="s-target-lang">
                      <span className="text-[13px] font-medium">{m.settings.targetLanguage}</span>
                      <select id="s-target-lang" className={`${fieldClass} w-[200px] disabled:opacity-40`} value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value)} disabled={!anyTranslationEnabled}>
                        <option value="zh">{m.settings.chineseSimplified}</option>
                        <option value="en">{m.settings.english}</option>
                        <option value="ja">{m.settings.japanese}</option>
                        <option value="ko">{m.settings.korean}</option>
                      </select>
                    </label>

                    {anyTranslationEnabled && (
                      <>
                        <div className="grid grid-cols-2 gap-3">
                          <label className="space-y-1.5" htmlFor="s-t-provider">
                            <span className="text-[13px] font-medium">{m.settings.translationProvider}</span>
                            <select id="s-t-provider" className={fullFieldClass} value={translationProvider} onChange={(e) => setTranslationProvider(e.target.value as TranslationProvider)}>
                              <option value="openai-compatible">{m.settings.openaiCompatible}</option>
                            </select>
                          </label>
                          <label className="space-y-1.5" htmlFor="s-t-model">
                            <span className="text-[13px] font-medium">{m.settings.translationModel}</span>
                            <input id="s-t-model" type="text" className={fullFieldClass} value={translationModel} onChange={(e) => setTranslationModel(e.target.value)} placeholder="gpt-4o-mini" />
                          </label>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <label className="space-y-1.5" htmlFor="s-t-endpoint">
                            <span className="text-[13px] font-medium">{m.settings.translationEndpoint}</span>
                            <input id="s-t-endpoint" type="text" className={fullFieldClass} value={translationEndpoint} onChange={(e) => setTranslationEndpoint(e.target.value)} placeholder="https://api.openai.com/v1" />
                          </label>
                          <label className="space-y-1.5" htmlFor="s-t-key">
                            <span className="text-[13px] font-medium">{m.settings.translationApiKey}</span>
                            <input id="s-t-key" type="password" className={fullFieldClass} value={translationApiKeyInput} onChange={(e) => setTranslationApiKeyInput(e.target.value)} placeholder={translationApiKeyConfigured ? m.settings.storedKeyPlaceholder : m.settings.translationApiKeyPlaceholder} />
                          </label>
                        </div>
                        <div className="flex items-center justify-between border border-border bg-muted/30 px-3 py-2 rounded-sm">
                          <p className="text-[12px] text-muted-foreground">
                            {m.settings.apiKeyStatus}{' '}
                            <span className="font-medium text-foreground">{translationApiKeyConfigured ? m.settings.configured : m.settings.notConfigured}</span>
                          </p>
                          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[12px]" onClick={() => { void clearTranslationApiKey() }} disabled={!translationApiKeyConfigured || updatingTranslationApiKey || saving}>
                            {m.settings.removeStoredKey}
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* ─── Appearance ─── */}
                {activeTab === 'appearance' && (
                  <div role="tabpanel" id="settings-panel-appearance" aria-labelledby="settings-tab-appearance" className="space-y-5">
                    <SectionLabel>{m.settings.tabAppearance}</SectionLabel>

                    <div className="flex items-center justify-between gap-4">
                      <label className="text-[13px] font-medium" htmlFor="s-theme">{m.settings.theme}</label>
                      <select id="s-theme" className={`${fieldClass} w-[160px]`} value={theme} onChange={(e) => setTheme(e.target.value as ThemeOption)}>
                        <option value="system">{m.settings.system}</option>
                        <option value="light">{m.settings.light}</option>
                        <option value="dark">{m.settings.dark}</option>
                      </select>
                    </div>

                    <div className="flex items-center justify-between gap-4">
                      <label className="text-[13px] font-medium" htmlFor="s-app-lang">{m.settings.interfaceLanguage}</label>
                      <select id="s-app-lang" className={`${fieldClass} w-[160px]`} value={appLanguage} onChange={(e) => setAppLanguage(resolveLocale(e.target.value))}>
                        <option value="zh-CN">{m.settings.languageOptionZhCn}</option>
                        <option value="en-US">{m.settings.languageOptionEnUs}</option>
                      </select>
                    </div>

                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p id="s-launch-label" className="text-[13px] font-medium">{m.settings.launchAtLogin}</p>
                        <p className="text-[12px] text-muted-foreground">{m.settings.launchAtLoginDescription}</p>
                      </div>
                      <Toggle checked={launchAtLogin} onChange={setLaunchAtLogin} labelledBy="s-launch-label" />
                    </div>

                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p id="s-indicator-label" className="text-[13px] font-medium">{m.settings.recordingIndicator}</p>
                        <p className="text-[12px] text-muted-foreground">{m.settings.recordingIndicatorDescription}</p>
                      </div>
                      <Toggle checked={indicatorEnabled} onChange={setIndicatorEnabled} labelledBy="s-indicator-label" />
                    </div>

                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p id="s-sound-label" className="text-[13px] font-medium">{m.settings.soundFeedback}</p>
                        <p className="text-[12px] text-muted-foreground">{m.settings.soundFeedbackDescription}</p>
                      </div>
                      <Toggle checked={soundEnabled} onChange={setSoundEnabled} labelledBy="s-sound-label" />
                    </div>
                  </div>
                )}

                {/* ─── About ─── */}
                {activeTab === 'about' && (
                  <div role="tabpanel" id="settings-panel-about" aria-labelledby="settings-tab-about" className="space-y-4">
                    <SectionLabel>{m.settings.tabAbout}</SectionLabel>
                    <div className="border-l-2 border-primary pl-4 py-2">
                      <p className="text-sm font-medium">{m.common.appName}</p>
                      <p className="font-mono text-[12px] text-muted-foreground">{m.settings.version} 1.0.0</p>
                      <p className="text-[13px] text-muted-foreground mt-1">{m.settings.aboutDescription}</p>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
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
