import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Info, Settings, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { TriggerKey } from '../../../../shared/hotkey'

type ThemeOption = 'system' | 'light' | 'dark'
type ModalTab = 'recognition' | 'appearance' | 'about'
type Backend = 'local' | 'api' | 'network' | 'soniox' | 'groq'
type LocalEngine = 'faster-whisper' | 'sensevoice'
type ModelType = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3'
type TranslationProvider = 'openai-compatible'

interface RendererConfig {
  hotkey?: {
    triggerKey?: TriggerKey
  }
  recognition?: {
    backend?: Backend
    language?: string
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
      modelType?: ModelType
    }
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
      className={`relative inline-flex h-6 w-11 items-center rounded-full border transition-colors ${
        checked ? 'border-[#7C3AED] bg-[#7C3AED]' : 'border-border bg-muted'
      } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7C3AED]/40 focus-visible:ring-offset-1`}
    >
      <span
        className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-[22px]' : 'translate-x-[2px]'
        }`}
      />
    </button>
  )
}

export function DashboardSettingsModal({
  onClose,
  onSaved,
  onThemeChange
}: DashboardSettingsModalProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<ModalTab>('recognition')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const modalRef = useRef<HTMLElement | null>(null)
  const tabRefs = useRef<Record<ModalTab, HTMLButtonElement | null>>({
    recognition: null,
    appearance: null,
    about: null
  })
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)

  const [engine, setEngine] = useState<EngineOption>('local-faster-whisper')
  const [language, setLanguage] = useState('auto')
  const [modelSize, setModelSize] = useState<ModelType>('large-v3')
  const [hotkey, setHotkey] = useState<TriggerKey>('RCtrl')
  const [translationEnabled, setTranslationEnabled] = useState(false)
  const [meetingTranslationEnabled, setMeetingTranslationEnabled] = useState(false)
  const [targetLanguage, setTargetLanguage] = useState('zh')
  const [translationProvider, setTranslationProvider] =
    useState<TranslationProvider>('openai-compatible')
  const [translationEndpoint, setTranslationEndpoint] = useState('https://api.openai.com/v1')
  const [translationModel, setTranslationModel] = useState('gpt-4o-mini')
  const [translationApiKeyInput, setTranslationApiKeyInput] = useState('')
  const [translationApiKeyConfigured, setTranslationApiKeyConfigured] = useState(false)
  const [updatingApiKey, setUpdatingApiKey] = useState(false)
  const [theme, setTheme] = useState<ThemeOption>('system')
  const [indicatorEnabled, setIndicatorEnabled] = useState(true)
  const [soundEnabled, setSoundEnabled] = useState(true)

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
            ? localEngine === 'sensevoice'
              ? 'local-sensevoice'
              : 'local-faster-whisper'
            : backend === 'api' || backend === 'soniox' || backend === 'groq'
              ? backend
              : 'local-faster-whisper'

        setEngine(engineValue)
        setLanguage(cfg.recognition?.language || 'auto')
        const nextModelSize = (cfg.recognition?.local?.modelType || 'large-v3') as ModelType
        setModelSize(engineValue === 'local-sensevoice' ? 'small' : nextModelSize)
        setHotkey((cfg.hotkey?.triggerKey || 'RCtrl') as TriggerKey)
        setTranslationEnabled(cfg.recognition?.translation?.enabledForPtt === true)
        setMeetingTranslationEnabled(cfg.recognition?.translation?.enabledForMeeting === true)
        setTargetLanguage(cfg.recognition?.translation?.targetLanguage || 'zh')
        setTranslationProvider(cfg.recognition?.translation?.provider || 'openai-compatible')
        setTranslationEndpoint(
          cfg.recognition?.translation?.endpoint || 'https://api.openai.com/v1'
        )
        setTranslationModel(cfg.recognition?.translation?.model || 'gpt-4o-mini')
        setTheme(cfg.ui?.theme || 'system')
        setIndicatorEnabled(cfg.ui?.indicatorEnabled !== false)
        setSoundEnabled(cfg.ui?.soundFeedback !== false)
        void window.api
          .hasApiKey('openai')
          .then((hasKey) => {
            if (mounted) {
              setTranslationApiKeyConfigured(hasKey)
            }
          })
          .catch(() => {
            if (mounted) {
              setTranslationApiKeyConfigured(false)
            }
          })
      })
      .finally(() => {
        if (mounted) {
          setLoading(false)
        }
      })

    return () => {
      mounted = false
    }
  }, [])

  const isLocalEngine = useMemo(
    () => engine === 'local-faster-whisper' || engine === 'local-sensevoice',
    [engine]
  )
  const isSenseVoiceEngine = engine === 'local-sensevoice'
  const anyTranslationEnabled = translationEnabled || meetingTranslationEnabled
  const fieldClassName =
    'h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[#7C3AED]/35'

  useEffect(() => {
    if (isSenseVoiceEngine) {
      setModelSize('small')
    }
  }, [isSenseVoiceEngine])

  const clearTranslationApiKey = async (): Promise<void> => {
    if (updatingApiKey) return
    setUpdatingApiKey(true)
    try {
      await window.api.deleteApiKey('openai')
      setTranslationApiKeyConfigured(false)
      setTranslationApiKeyInput('')
    } finally {
      setUpdatingApiKey(false)
    }
  }

  const setTabRef = useCallback(
    (tab: ModalTab) =>
      (node: HTMLButtonElement | null): void => {
        tabRefs.current[tab] = node
      },
    []
  )

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const frame = window.requestAnimationFrame(() => {
      tabRefs.current.recognition?.focus()
    })

    const handleKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }

      if (event.key !== 'Tab' || !modalRef.current) {
        return
      }

      const focusable = modalRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (focusable.length === 0) {
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement as HTMLElement | null

      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', handleKeydown)
    return () => {
      window.cancelAnimationFrame(frame)
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', handleKeydown)
      previouslyFocusedRef.current?.focus()
    }
  }, [onClose])

  const handleTabTriggerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, tab: ModalTab): void => {
      const index = modalTabOrder.indexOf(tab)
      if (index < 0) return
      let nextTab: ModalTab | null = null

      if (event.key === 'ArrowRight') {
        event.preventDefault()
        nextTab = modalTabOrder[(index + 1) % modalTabOrder.length]
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        nextTab = modalTabOrder[(index - 1 + modalTabOrder.length) % modalTabOrder.length]
      } else if (event.key === 'Home') {
        event.preventDefault()
        nextTab = modalTabOrder[0]
      } else if (event.key === 'End') {
        event.preventDefault()
        nextTab = modalTabOrder[modalTabOrder.length - 1]
      }

      if (nextTab) {
        setActiveTab(nextTab)
        window.requestAnimationFrame(() => {
          tabRefs.current[nextTab]?.focus()
        })
      }
    },
    []
  )

  const saveChanges = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    try {
      const backend: Backend =
        engine === 'local-faster-whisper' || engine === 'local-sensevoice'
          ? 'local'
          : (engine as Backend)
      const localEngine: LocalEngine =
        engine === 'local-sensevoice' ? 'sensevoice' : 'faster-whisper'

      await window.api.setConfig({
        hotkey: {
          triggerKey: hotkey
        },
        recognition: {
          backend,
          language,
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
            modelType: localEngine === 'sensevoice' ? 'small' : modelSize
          }
        },
        ui: {
          theme,
          indicatorEnabled,
          soundFeedback: soundEnabled
        }
      })

      const nextApiKey = translationApiKeyInput.trim()
      if (nextApiKey) {
        await window.api.setApiKey('openai', nextApiKey)
        setTranslationApiKeyConfigured(true)
        setTranslationApiKeyInput('')
      }

      onThemeChange(theme)
      await onSaved()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        aria-hidden="true"
        className="animate-[fadeIn_140ms_ease-out] absolute inset-0 bg-black/40"
        onClick={onClose}
      />

      <section
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        aria-describedby="settings-modal-description"
        className="animate-[fadeInUp_180ms_var(--ease-out-expo)] relative z-10 flex h-[520px] w-[560px] flex-col overflow-hidden rounded-2xl border bg-background shadow-lg"
      >
        <p id="settings-modal-description" className="sr-only">
          Configure recognition, appearance, and application behavior.
        </p>
        <header className="flex items-center justify-between border-b px-6 py-4">
          <div className="flex items-center gap-2.5">
            <Settings className="h-[18px] w-[18px] text-[#7C3AED]" />
            <h2 id="settings-modal-title" className="text-base font-semibold">
              Settings
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-[4px] text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7C3AED]/40"
            aria-label="Close settings"
          >
            <X className="h-[18px] w-[18px]" />
          </button>
        </header>

        <div role="tablist" aria-label="Settings sections" className="flex border-b px-6">
          <button
            ref={setTabRef('recognition')}
            type="button"
            onClick={() => setActiveTab('recognition')}
            onKeyDown={(event) => handleTabTriggerKeyDown(event, 'recognition')}
            role="tab"
            id="settings-tab-recognition"
            aria-controls="settings-panel-recognition"
            aria-selected={activeTab === 'recognition'}
            tabIndex={activeTab === 'recognition' ? 0 : -1}
            className={`border-b-2 px-4 py-2.5 text-[13px] ${
              activeTab === 'recognition'
                ? 'border-[#7C3AED] font-semibold text-[#7C3AED]'
                : 'border-transparent font-medium text-muted-foreground'
            } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7C3AED]/40`}
          >
            Recognition
          </button>
          <button
            ref={setTabRef('appearance')}
            type="button"
            onClick={() => setActiveTab('appearance')}
            onKeyDown={(event) => handleTabTriggerKeyDown(event, 'appearance')}
            role="tab"
            id="settings-tab-appearance"
            aria-controls="settings-panel-appearance"
            aria-selected={activeTab === 'appearance'}
            tabIndex={activeTab === 'appearance' ? 0 : -1}
            className={`border-b-2 px-4 py-2.5 text-[13px] ${
              activeTab === 'appearance'
                ? 'border-[#7C3AED] font-semibold text-[#7C3AED]'
                : 'border-transparent font-medium text-muted-foreground'
            } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7C3AED]/40`}
          >
            Appearance
          </button>
          <button
            ref={setTabRef('about')}
            type="button"
            onClick={() => setActiveTab('about')}
            onKeyDown={(event) => handleTabTriggerKeyDown(event, 'about')}
            role="tab"
            id="settings-tab-about"
            aria-controls="settings-panel-about"
            aria-selected={activeTab === 'about'}
            tabIndex={activeTab === 'about' ? 0 : -1}
            className={`border-b-2 px-4 py-2.5 text-[13px] ${
              activeTab === 'about'
                ? 'border-[#7C3AED] font-semibold text-[#7C3AED]'
                : 'border-transparent font-medium text-muted-foreground'
            } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7C3AED]/40`}
          >
            About
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-6">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Loading settings...
            </div>
          ) : (
            <>
              {activeTab === 'recognition' && (
                <div
                  role="tabpanel"
                  id="settings-panel-recognition"
                  aria-labelledby="settings-tab-recognition"
                  className="space-y-5"
                >
                  <div className="grid grid-cols-2 gap-4">
                    <label className="space-y-1.5" htmlFor="settings-recognition-engine">
                      <span className="text-sm font-medium">Recognition Engine</span>
                      <select
                        id="settings-recognition-engine"
                        className={fieldClassName}
                        value={engine}
                        onChange={(event) => setEngine(event.target.value as EngineOption)}
                      >
                        <option value="local-faster-whisper">Faster Whisper (Local)</option>
                        <option value="local-sensevoice">SenseVoice (Local)</option>
                        <option value="soniox">Soniox</option>
                        <option value="api">OpenAI API</option>
                        <option value="groq">Groq</option>
                      </select>
                    </label>

                    <label className="space-y-1.5" htmlFor="settings-language">
                      <span className="text-sm font-medium">Language</span>
                      <select
                        id="settings-language"
                        className={fieldClassName}
                        value={language}
                        onChange={(event) => setLanguage(event.target.value)}
                      >
                        <option value="auto">Auto Detect</option>
                        <option value="zh">Chinese</option>
                        <option value="en">English</option>
                        <option value="ja">Japanese</option>
                        <option value="ko">Korean</option>
                      </select>
                    </label>
                  </div>

                  <div
                    className={`grid gap-4 ${isSenseVoiceEngine ? 'grid-cols-1' : 'grid-cols-2'}`}
                  >
                    {!isSenseVoiceEngine ? (
                      <label className="space-y-1.5" htmlFor="settings-model-size">
                        <span className="text-sm font-medium">Model Size</span>
                        <select
                          id="settings-model-size"
                          className={`${fieldClassName} disabled:opacity-50`}
                          value={modelSize}
                          onChange={(event) => setModelSize(event.target.value as ModelType)}
                          disabled={!isLocalEngine}
                        >
                          <option value="tiny">tiny</option>
                          <option value="base">base</option>
                          <option value="small">small</option>
                          <option value="medium">medium</option>
                          <option value="large-v3">large-v3</option>
                        </select>
                      </label>
                    ) : null}

                    <label className="space-y-1.5" htmlFor="settings-hotkey">
                      <span className="text-sm font-medium">Hotkey</span>
                      <select
                        id="settings-hotkey"
                        className={fieldClassName}
                        value={hotkey}
                        onChange={(event) => setHotkey(event.target.value as TriggerKey)}
                      >
                        <option value="RCtrl">Right Ctrl</option>
                        <option value="RAlt">Right Alt</option>
                        <option value="F13">F13</option>
                        <option value="F14">F14</option>
                      </select>
                    </label>
                  </div>

                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p id="settings-translation-ptt-label" className="text-sm font-medium">
                        Enable Translation for PTT
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Translate push-to-talk transcription to target language
                      </p>
                    </div>
                    <Toggle
                      checked={translationEnabled}
                      onChange={setTranslationEnabled}
                      labelledBy="settings-translation-ptt-label"
                    />
                  </div>

                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p id="settings-translation-meeting-label" className="text-sm font-medium">
                        Enable Translation for Meeting
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Translate meeting transcription in real time
                      </p>
                    </div>
                    <Toggle
                      checked={meetingTranslationEnabled}
                      onChange={setMeetingTranslationEnabled}
                      labelledBy="settings-translation-meeting-label"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <label className="space-y-1.5" htmlFor="settings-target-language">
                      <span className="text-sm font-medium">Target Language</span>
                      <select
                        id="settings-target-language"
                        className={`${fieldClassName} disabled:opacity-50`}
                        value={targetLanguage}
                        onChange={(event) => setTargetLanguage(event.target.value)}
                        disabled={!anyTranslationEnabled}
                      >
                        <option value="zh">Chinese (Simplified)</option>
                        <option value="en">English</option>
                        <option value="ja">Japanese</option>
                        <option value="ko">Korean</option>
                      </select>
                    </label>
                    <div />
                  </div>

                  {anyTranslationEnabled && (
                    <>
                      <div className="grid grid-cols-2 gap-4">
                        <label className="space-y-1.5" htmlFor="settings-translation-provider">
                          <span className="text-sm font-medium">Translation Provider</span>
                          <select
                            id="settings-translation-provider"
                            className={fieldClassName}
                            value={translationProvider}
                            onChange={(event) =>
                              setTranslationProvider(event.target.value as TranslationProvider)
                            }
                          >
                            <option value="openai-compatible">OpenAI-Compatible</option>
                          </select>
                        </label>

                        <label className="space-y-1.5" htmlFor="settings-translation-model">
                          <span className="text-sm font-medium">Translation Model</span>
                          <input
                            id="settings-translation-model"
                            type="text"
                            className={fieldClassName}
                            value={translationModel}
                            onChange={(event) => setTranslationModel(event.target.value)}
                            placeholder="gpt-4o-mini"
                          />
                        </label>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <label className="space-y-1.5" htmlFor="settings-translation-endpoint">
                          <span className="text-sm font-medium">Translation Endpoint</span>
                          <input
                            id="settings-translation-endpoint"
                            type="text"
                            className={fieldClassName}
                            value={translationEndpoint}
                            onChange={(event) => setTranslationEndpoint(event.target.value)}
                            placeholder="https://api.openai.com/v1"
                          />
                        </label>
                        <label className="space-y-1.5" htmlFor="settings-translation-api-key">
                          <span className="text-sm font-medium">Translation API Key</span>
                          <input
                            id="settings-translation-api-key"
                            type="password"
                            className={fieldClassName}
                            value={translationApiKeyInput}
                            onChange={(event) => setTranslationApiKeyInput(event.target.value)}
                            placeholder={
                              translationApiKeyConfigured
                                ? 'Stored key is configured (enter to replace)'
                                : 'sk-...'
                            }
                          />
                        </label>
                      </div>

                      <div className="flex items-center justify-between rounded-md border border-border/70 bg-muted/20 px-3 py-2">
                        <p className="text-xs text-muted-foreground">
                          API Key status:{' '}
                          <span className="font-medium text-foreground">
                            {translationApiKeyConfigured ? 'Configured' : 'Not configured'}
                          </span>
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 px-3 text-xs"
                          onClick={() => {
                            void clearTranslationApiKey()
                          }}
                          disabled={!translationApiKeyConfigured || updatingApiKey || saving}
                        >
                          Remove Stored Key
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {activeTab === 'appearance' && (
                <div
                  role="tabpanel"
                  id="settings-panel-appearance"
                  aria-labelledby="settings-tab-appearance"
                  className="space-y-5"
                >
                  <label className="space-y-1.5" htmlFor="settings-theme">
                    <span className="text-sm font-medium">Theme</span>
                    <select
                      id="settings-theme"
                      className={fieldClassName}
                      value={theme}
                      onChange={(event) => setTheme(event.target.value as ThemeOption)}
                    >
                      <option value="system">System</option>
                      <option value="light">Light</option>
                      <option value="dark">Dark</option>
                    </select>
                  </label>

                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p id="settings-indicator-label" className="text-sm font-medium">
                        Recording Indicator
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Show floating indicator while recording
                      </p>
                    </div>
                    <Toggle
                      checked={indicatorEnabled}
                      onChange={setIndicatorEnabled}
                      labelledBy="settings-indicator-label"
                    />
                  </div>

                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p id="settings-sound-label" className="text-sm font-medium">
                        Sound Feedback
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Play sound on recording start and stop
                      </p>
                    </div>
                    <Toggle
                      checked={soundEnabled}
                      onChange={setSoundEnabled}
                      labelledBy="settings-sound-label"
                    />
                  </div>
                </div>
              )}

              {activeTab === 'about' && (
                <div
                  role="tabpanel"
                  id="settings-panel-about"
                  aria-labelledby="settings-tab-about"
                  className="space-y-4"
                >
                  <div className="flex items-start gap-2.5 rounded-lg border bg-muted/30 p-4">
                    <Info className="mt-0.5 h-4 w-4 text-[#7C3AED]" />
                    <div className="space-y-1">
                      <p className="text-sm font-medium">JustSay</p>
                      <p className="text-xs text-muted-foreground">Version 1.0.0</p>
                      <p className="text-xs text-muted-foreground">
                        Push-to-talk and meeting transcription assistant.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <footer className="flex justify-end border-t px-6 py-3">
          <Button
            type="button"
            size="sm"
            className="h-9 bg-[#171717] px-4 text-sm text-white hover:bg-[#262626]"
            onClick={() => {
              void saveChanges()
            }}
            disabled={loading || saving}
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </Button>
        </footer>
      </section>
    </div>
  )
}
