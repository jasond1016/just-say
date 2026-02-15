import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ModelManager } from '../components/Settings/ModelManager'
import { getMicrophoneDevices } from '../microphone-capture'
import { hasCapability } from '../../../shared/backend-capabilities'
import { DEFAULT_TRIGGER_KEY } from '../../../shared/hotkey'

type ThemeOption = 'system' | 'light' | 'dark'
type SettingsTab = 'general' | 'audio' | 'recognition' | 'hotkey' | 'output' | 'appearance' | 'advanced'

interface SettingsProps {
  currentTheme: ThemeOption
  onThemeChange: (theme: ThemeOption) => void
}

type RecognitionBackend = 'local' | 'api' | 'network' | 'soniox' | 'groq'
type LocalEngine = 'faster-whisper' | 'sensevoice'

const recognitionLanguageOptions = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'ru', label: 'Русский' }
]

const getRecognitionLanguageSupport = (
  backend: RecognitionBackend | string
): { supported: boolean; reason?: string } => {
  switch (backend) {
    case 'local':
    case 'groq':
      return { supported: true }
    case 'api':
      return { supported: false, reason: 'OpenAI API 目前未接入 language 参数' }
    case 'soniox':
      return { supported: false, reason: 'Soniox 仅支持语言提示，不支持锁定' }
    case 'network':
      return { supported: false, reason: '网络后端未定义语言参数' }
    default:
      return { supported: false, reason: '当前后端不支持语言参数' }
  }
}

export function Settings({ currentTheme, onThemeChange }: SettingsProps): React.JSX.Element {
  const [config, setConfig] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const [sonioxApiKey, setSonioxApiKey] = useState('')
  const [groqApiKey, setGroqApiKey] = useState('')
  const [openaiApiKey, setOpenaiApiKey] = useState('')
  const [hasSonioxKey, setHasSonioxKey] = useState(false)
  const [hasGroqKey, setHasGroqKey] = useState(false)
  const [hasOpenaiKey, setHasOpenaiKey] = useState(false)
  const [openaiEndpointDraft, setOpenaiEndpointDraft] = useState('')
  const [translationEndpointDraft, setTranslationEndpointDraft] = useState('')
  const [translationModelDraft, setTranslationModelDraft] = useState('')
  const [connectionStatus, setConnectionStatus] = useState<
    'idle' | 'testing' | 'success' | 'failed'
  >('idle')
  const [connectionMessage, setConnectionMessage] = useState<string>('')
  const [localServerHostDraft, setLocalServerHostDraft] = useState('')
  const [localServerPortDraft, setLocalServerPortDraft] = useState('')
  const connectionRequestRef = useRef(0)
  const draftCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [audioDevices, setAudioDevices] = useState<
    Array<{ id: string; name: string; isDefault?: boolean }>
  >([])
  const [audioDevicesLoading, setAudioDevicesLoading] = useState(false)
  const currentServerHost = config?.recognition?.local?.serverHost || '127.0.0.1'
  const currentServerPort = config?.recognition?.local?.serverPort || 8765
  const currentServerMode = config?.recognition?.local?.serverMode || 'local'

  useEffect(() => {
    loadConfig()
    loadApiKeys()
  }, [])

  const loadAudioDevices = useCallback(async (): Promise<void> => {
    setAudioDevicesLoading(true)
    try {
      const devices = await getMicrophoneDevices()
      setAudioDevices(devices)
    } catch (err) {
      console.error('Failed to load audio devices:', err)
      setAudioDevices([])
    } finally {
      setAudioDevicesLoading(false)
    }
  }, [])

  useEffect(() => {
    if (activeTab === 'audio') {
      loadAudioDevices()
    }
  }, [activeTab, loadAudioDevices])

  useEffect(() => {
    if (!config) return
    setConnectionStatus('idle')
    setConnectionMessage('')
    connectionRequestRef.current += 1
  }, [
    localServerHostDraft,
    localServerPortDraft,
    config?.recognition?.local?.serverMode
  ])

  useEffect(() => {
    if (!config) return
    const nextHost = currentServerHost
    const nextPort = currentServerPort
    setLocalServerHostDraft(nextHost)
    setLocalServerPortDraft(String(nextPort))
  }, [config?.recognition?.local?.serverHost, config?.recognition?.local?.serverPort, currentServerHost, currentServerPort])

  const loadApiKeys = async (): Promise<void> => {
    const [sonioxKey, groqKey, openaiKey, hasSoniox, hasGroq, hasOpenai] = await Promise.all([
      window.api.getApiKey('soniox'),
      window.api.getApiKey('groq'),
      window.api.getApiKey('openai'),
      window.api.hasApiKey('soniox'),
      window.api.hasApiKey('groq'),
      window.api.hasApiKey('openai')
    ])
    if (sonioxKey) setSonioxApiKey(sonioxKey)
    if (groqKey) setGroqApiKey(groqKey)
    if (openaiKey) setOpenaiApiKey(openaiKey)
    setHasSonioxKey(hasSoniox)
    setHasGroqKey(hasGroq)
    setHasOpenaiKey(hasOpenai)
  }

  const handleSonioxApiKeyChange = async (value: string): Promise<void> => {
    setSonioxApiKey(value)
    if (value.trim()) {
      await window.api.setApiKey('soniox', value)
      setHasSonioxKey(true)
    } else {
      await window.api.deleteApiKey('soniox')
      setHasSonioxKey(false)
    }
  }

  const handleGroqApiKeyChange = async (value: string): Promise<void> => {
    setGroqApiKey(value)
    if (value.trim()) {
      await window.api.setApiKey('groq', value)
      setHasGroqKey(true)
    } else {
      await window.api.deleteApiKey('groq')
      setHasGroqKey(false)
    }
  }

  const handleOpenaiApiKeyChange = async (value: string): Promise<void> => {
    setOpenaiApiKey(value)
    if (value.trim()) {
      await window.api.setApiKey('openai', value)
      setHasOpenaiKey(true)
    } else {
      await window.api.deleteApiKey('openai')
      setHasOpenaiKey(false)
    }
  }

  const commitOpenaiEndpoint = async (nextValue?: string): Promise<void> => {
    if (!config) return
    const trimmed = (nextValue ?? openaiEndpointDraft).trim()
    const currentEndpoint = config.recognition?.api?.endpoint || 'https://api.openai.com/v1'
    if (!trimmed) {
      setOpenaiEndpointDraft(currentEndpoint)
      return
    }
    if (trimmed === currentEndpoint) return
    await updateConfig({ recognition: { api: { endpoint: trimmed } } })
  }

  const commitTranslationEndpoint = async (nextValue?: string): Promise<void> => {
    if (!config) return
    const trimmed = (nextValue ?? translationEndpointDraft).trim()
    const currentEndpoint =
      config.recognition?.translation?.endpoint || 'https://api.openai.com/v1'
    if (!trimmed) {
      setTranslationEndpointDraft(currentEndpoint)
      return
    }
    if (trimmed === currentEndpoint) return
    await updateConfig({ recognition: { translation: { endpoint: trimmed } } })
  }

  const commitTranslationModel = async (nextValue?: string): Promise<void> => {
    if (!config) return
    const trimmed = (nextValue ?? translationModelDraft).trim()
    const currentModel = config.recognition?.translation?.model || 'gpt-4o-mini'
    if (!trimmed) {
      setTranslationModelDraft(currentModel)
      return
    }
    if (trimmed === currentModel) return
    await updateConfig({ recognition: { translation: { model: trimmed } } })
  }

  const loadConfig = async (): Promise<void> => {
    try {
      const cfg = await window.api.getConfig()
      setConfig(cfg)
    } catch (err) {
      console.error('Failed to load config:', err)
    } finally {
      setLoading(false)
    }
  }

  const updateConfig = async (updates: any): Promise<void> => {
    if (!config) return
    try {
      const newConfig = deepMerge(config, updates)
      setConfig(newConfig)
      await window.api.setConfig(newConfig)
    } catch (err) {
      console.error('Failed to save config:', err)
    }
  }

  const handleThemeChange = async (theme: ThemeOption): Promise<void> => {
    onThemeChange(theme)
    await updateConfig({ ui: { theme } })
  }

  const handleModelChange = async (modelType: string): Promise<void> => {
    const localEngine = (config?.recognition?.local?.engine || 'faster-whisper') as LocalEngine
    if (localEngine === 'sensevoice') {
      await updateConfig({
        recognition: {
          local: {
            sensevoice: { modelId: 'FunAudioLLM/SenseVoiceSmall' }
          }
        }
      })
      return
    }

    await updateConfig({
      recognition: {
        local: { modelType }
      }
    })
  }

  const handleLocalEngineChange = async (engine: LocalEngine): Promise<void> => {
    await updateConfig({
      recognition: {
        local: { engine }
      }
    })
  }

  useEffect(() => {
    if (!config) return
    const currentEndpoint = config.recognition?.api?.endpoint || 'https://api.openai.com/v1'
    setOpenaiEndpointDraft(currentEndpoint)
  }, [config?.recognition?.api?.endpoint])

  useEffect(() => {
    if (!config) return
    const currentEndpoint = config.recognition?.translation?.endpoint || 'https://api.openai.com/v1'
    const currentModel = config.recognition?.translation?.model || 'gpt-4o-mini'
    setTranslationEndpointDraft(currentEndpoint)
    setTranslationModelDraft(currentModel)
  }, [config?.recognition?.translation?.endpoint, config?.recognition?.translation?.model])

  useEffect(() => {
    if (!config) return
    if (currentServerMode !== 'remote') return

    const host = localServerHostDraft.trim()
    const parsedPort = parseInt(localServerPortDraft, 10)
    const hostChanged = !!host && host !== currentServerHost
    const portValid = Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535
    const portChanged = portValid && parsedPort !== currentServerPort

    if (!hostChanged && !portChanged) return

    if (draftCommitTimerRef.current) {
      clearTimeout(draftCommitTimerRef.current)
    }

    draftCommitTimerRef.current = setTimeout(() => {
      const updates: { serverHost?: string; serverPort?: number } = {}
      if (hostChanged) {
        updates.serverHost = host
      }
      if (portChanged) {
        updates.serverPort = parsedPort
      }
      if (Object.keys(updates).length > 0) {
        void updateConfig({ recognition: { local: updates } })
      }
    }, 500)

    return () => {
      if (draftCommitTimerRef.current) {
        clearTimeout(draftCommitTimerRef.current)
      }
    }
  }, [
    config,
    currentServerHost,
    currentServerMode,
    currentServerPort,
    localServerHostDraft,
    localServerPortDraft
  ])

  const commitLocalServerHost = async (nextValue?: string): Promise<void> => {
    if (!config) return
    const trimmed = (nextValue ?? localServerHostDraft).trim()
    if (!trimmed) {
      setLocalServerHostDraft(currentServerHost)
      return
    }
    if (trimmed === currentServerHost) return
    await updateConfig({ recognition: { local: { serverHost: trimmed } } })
  }

  const commitLocalServerPort = async (nextValue?: string): Promise<void> => {
    if (!config) return
    const parsed = parseInt(nextValue ?? localServerPortDraft, 10)
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
      setLocalServerPortDraft(String(currentServerPort))
      return
    }
    if (parsed === currentServerPort) return
    await updateConfig({ recognition: { local: { serverPort: parsed } } })
  }

  const handleTestConnection = async (): Promise<void> => {
    const host = localServerHostDraft.trim()
    const port = parseInt(localServerPortDraft, 10)
    const requestId = connectionRequestRef.current + 1
    connectionRequestRef.current = requestId
    if (!host) {
      setConnectionStatus('failed')
      setConnectionMessage('请先填写服务器地址')
      return
    }
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      setConnectionStatus('failed')
      setConnectionMessage('请填写正确的端口')
      return
    }
    setConnectionStatus('testing')
    setConnectionMessage('')
    try {
      const ok = await window.api.testWhisperServer(host, port)
      if (requestId !== connectionRequestRef.current) {
        return
      }
      if (ok) {
        setConnectionStatus('success')
        setConnectionMessage('连接成功')
      } else {
        setConnectionStatus('failed')
        setConnectionMessage('连接失败，请确认服务端已启动并可访问')
      }
    } catch (err) {
      if (requestId !== connectionRequestRef.current) {
        return
      }
      setConnectionStatus('failed')
      setConnectionMessage(`连接失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (loading) {
    return (
      <div className="content-view">
        <div className="content-header">
          <div className="content-header__title">
            <span className="content-header__title-icon">⚙️</span>
            <h1>设置</h1>
          </div>
        </div>
        <div className="ptt-container">
          <div className="text-muted">加载中...</div>
        </div>
      </div>
    )
  }

  if (!config) {
    return (
      <div className="content-view">
        <div className="content-header">
          <div className="content-header__title">
            <span className="content-header__title-icon">⚙️</span>
            <h1>设置</h1>
          </div>
        </div>
        <div className="ptt-container">
          <div className="text-muted">加载设置失败</div>
        </div>
      </div>
    )
  }

  const selectedAudioDevice = config.audio?.device || 'default'
  const availableAudioDevices = audioDevices.filter((device) => device.id !== 'default')
  const hasSelectedDevice =
    selectedAudioDevice === 'default' ||
    audioDevices.some((device) => device.id === selectedAudioDevice)
  const sampleRateOptions = [8000, 16000, 22050, 44100, 48000]
  const recognitionBackend = (config.recognition?.backend || 'local') as RecognitionBackend
  const isLocalBackend = !config.recognition?.backend || config.recognition?.backend === 'local'
  const localEngine = (config.recognition?.local?.engine || 'faster-whisper') as LocalEngine
  const localServerMode = config.recognition?.local?.serverMode || 'local'
  const isRemoteServerMode = localServerMode === 'remote'
  const currentLocalModel = localEngine === 'sensevoice'
    ? 'sensevoice-small'
    : config.recognition?.local?.modelType || 'tiny'
  const recognitionLanguage = config.recognition?.language || 'auto'
  const translationEnabledForPtt = config.recognition?.translation?.enabledForPtt === true
  const translationTargetLanguage = config.recognition?.translation?.targetLanguage || 'en'
  const recognitionLanguageLocked = recognitionLanguage !== 'auto'
  const recognitionLanguageSupport = getRecognitionLanguageSupport(recognitionBackend)
  const recognitionLanguageHint = recognitionLanguageSupport.supported
    ? '锁定语言可提高准确率与速度，但多语言可能更差'
    : `锁定语言可提高准确率与速度，但多语言可能更差（${recognitionLanguageSupport.reason}）`
  const lockedLanguageValue = recognitionLanguageLocked ? recognitionLanguage : 'zh'
  const hasLockedLanguageOption = recognitionLanguageOptions.some(
    (option) => option.value === lockedLanguageValue
  )

  return (
    <div className="content-view">
      <div className="content-header">
        <div className="content-header__title">
          <span className="content-header__title-icon">⚙️</span>
          <h1>设置</h1>
        </div>
      </div>

      <div className="settings-container">
        <nav className="settings-nav">
          <button
            className={`settings-nav__item ${activeTab === 'general' ? 'active' : ''}`}
            onClick={() => setActiveTab('general')}
          >
            常规
          </button>
          <button
            className={`settings-nav__item ${activeTab === 'audio' ? 'active' : ''}`}
            onClick={() => setActiveTab('audio')}
          >
            音频
          </button>
          <button
            className={`settings-nav__item ${activeTab === 'recognition' ? 'active' : ''}`}
            onClick={() => setActiveTab('recognition')}
          >
            识别
          </button>
          <button
            className={`settings-nav__item ${activeTab === 'hotkey' ? 'active' : ''}`}
            onClick={() => setActiveTab('hotkey')}
          >
            快捷键
          </button>
          <button
            className={`settings-nav__item ${activeTab === 'output' ? 'active' : ''}`}
            onClick={() => setActiveTab('output')}
          >
            输出
          </button>
          <button
            className={`settings-nav__item ${activeTab === 'appearance' ? 'active' : ''}`}
            onClick={() => setActiveTab('appearance')}
          >
            外观
          </button>
          <button
            className={`settings-nav__item ${activeTab === 'advanced' ? 'active' : ''}`}
            onClick={() => setActiveTab('advanced')}
          >
            高级
          </button>
        </nav>

        <div className="settings-content">
          {activeTab === 'general' && (
            <div className="settings-section">
              <h2 className="settings-section__title">常规设置</h2>

              <div className="settings-row">
                <div className="settings-row__info">
                  <div className="settings-row__label">界面语言</div>
                  <div className="settings-row__desc">选择应用界面显示的语言</div>
                </div>
                <select
                  className="form-input form-select"
                  style={{ width: 150 }}
                  value={config.general?.language || 'zh-CN'}
                  onChange={(e) => updateConfig({ general: { language: e.target.value } })}
                >
                  <option value="zh-CN">简体中文</option>
                  <option value="en">English</option>
                </select>
              </div>

              <div className="settings-row">
                <div className="settings-row__info">
                  <div className="settings-row__label">开机自动启动</div>
                  <div className="settings-row__desc">系统启动时自动运行 JustSay</div>
                </div>
                <label className="toggle">
                  <input
                    type="checkbox"
                    className="toggle__input"
                    checked={config.general?.autostart || false}
                    onChange={(e) => updateConfig({ general: { autostart: e.target.checked } })}
                  />
                  <span className="toggle__slider" />
                </label>
              </div>

              <div className="settings-row">
                <div className="settings-row__info">
                  <div className="settings-row__label">关闭时最小化到托盘</div>
                  <div className="settings-row__desc">点击关闭按钮时隐藏到系统托盘而不是退出</div>
                </div>
                <label className="toggle">
                  <input
                    type="checkbox"
                    className="toggle__input"
                    checked={config.general?.minimizeToTray !== false}
                    onChange={(e) => updateConfig({ general: { minimizeToTray: e.target.checked } })}
                  />
                  <span className="toggle__slider" />
                </label>
              </div>
            </div>
          )}

          {activeTab === 'audio' && (
            <div className="settings-section">
              <h2 className="settings-section__title">音频设置</h2>

              <div className="settings-row">
                <div className="settings-row__info">
                  <div className="settings-row__label">输入设备</div>
                  <div className="settings-row__desc">选择麦克风输入源</div>
                </div>
                <select
                  className="form-input form-select"
                  style={{ width: 240 }}
                  value={selectedAudioDevice}
                  onChange={(e) => updateConfig({ audio: { device: e.target.value } })}
                  disabled={audioDevicesLoading}
                >
                  <option value="default">系统默认</option>
                  {availableAudioDevices.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.name}
                      {device.isDefault ? ' (默认)' : ''}
                    </option>
                  ))}
                  {!hasSelectedDevice && selectedAudioDevice !== 'default' && (
                    <option value={selectedAudioDevice}>当前设备 (不可用)</option>
                  )}
                </select>
              </div>

              <div className="settings-row">
                <div className="settings-row__info">
                  <div className="settings-row__label">采样率</div>
                  <div className="settings-row__desc">推荐 16kHz，兼容语音识别</div>
                </div>
                <select
                  className="form-input form-select"
                  style={{ width: 150 }}
                  value={config.audio?.sampleRate || 16000}
                  onChange={(e) =>
                    updateConfig({ audio: { sampleRate: parseInt(e.target.value) } })
                  }
                >
                  {sampleRateOptions.map((rate) => (
                    <option key={rate} value={rate}>
                      {rate} Hz
                    </option>
                  ))}
                </select>
              </div>

              <div className="settings-row">
                <div className="settings-row__info">
                  <div className="settings-row__label">最短录制时长</div>
                  <div className="settings-row__desc">低于此时长的录音将被忽略</div>
                </div>
                <select
                  className="form-input form-select"
                  style={{ width: 120 }}
                  value={config.audio?.minDurationMs || 500}
                  onChange={(e) =>
                    updateConfig({ audio: { minDurationMs: parseInt(e.target.value) } })
                  }
                >
                  <option value="300">0.3 秒</option>
                  <option value="500">0.5 秒</option>
                  <option value="1000">1.0 秒</option>
                </select>
              </div>

              <div className="settings-row">
                <div className="settings-row__info">
                  <div className="settings-row__label">最长录制时长</div>
                  <div className="settings-row__desc">达到此时长后自动停止录音</div>
                </div>
                <select
                  className="form-input form-select"
                  style={{ width: 120 }}
                  value={config.audio?.maxDurationSec || 60}
                  onChange={(e) =>
                    updateConfig({ audio: { maxDurationSec: parseInt(e.target.value) } })
                  }
                >
                  <option value="30">30 秒</option>
                  <option value="60">60 秒</option>
                  <option value="120">120 秒</option>
                </select>
              </div>
            </div>
          )}

          {activeTab === 'recognition' && (
            <div className="settings-section">
              <h2 className="settings-section__title">识别设置</h2>

              <div className="settings-row">
                <div className="settings-row__info">
                  <div className="settings-row__label">识别后端</div>
                  <div className="settings-row__desc">选择语音识别引擎</div>
                </div>
                <select
                  className="form-input form-select"
                  style={{ width: 180 }}
                  value={config.recognition?.backend || 'local'}
                  onChange={(e) => updateConfig({ recognition: { backend: e.target.value } })}
                >
                  <option value="local">本地 (Faster-Whisper / SenseVoice)</option>
                  <option value="soniox">Soniox (流式)</option>
                  <option value="api">OpenAI API</option>
                  <option value="groq">Groq (快速云端)</option>
                </select>
              </div>

              {isLocalBackend && (
                <>
                  <div className="settings-row">
                    <div className="settings-row__info">
                      <div className="settings-row__label">本地引擎</div>
                      <div className="settings-row__desc">切换 Faster-Whisper 或 SenseVoiceSmall</div>
                    </div>
                    <select
                      className="form-input form-select"
                      style={{ width: 240 }}
                      value={localEngine}
                      onChange={(e) => {
                        void handleLocalEngineChange(e.target.value as LocalEngine)
                      }}
                    >
                      <option value="faster-whisper">Faster-Whisper</option>
                      <option value="sensevoice">SenseVoiceSmall</option>
                    </select>
                  </div>

                  <div className="settings-row">
                    <div className="settings-row__info">
                      <div className="settings-row__label">运行模式</div>
                      <div className="settings-row__desc">本地运行或使用内网服务器</div>
                    </div>
                    <select
                      className="form-input form-select"
                      style={{ width: 180 }}
                      value={localServerMode}
                      onChange={(e) =>
                        updateConfig({
                          recognition: { local: { serverMode: e.target.value } }
                        })
                      }
                    >
                      <option value="local">本地</option>
                      <option value="remote">内网服务器</option>
                    </select>
                  </div>

                  {isRemoteServerMode && (
                    <>
                      <div className="settings-row">
                        <div className="settings-row__info">
                          <div className="settings-row__label">服务器地址</div>
                          <div className="settings-row__desc">填写内网服务器 IP 或域名</div>
                        </div>
                        <input
                          className="form-input"
                          style={{ width: 240 }}
                          value={localServerHostDraft}
                          placeholder="192.168.1.10"
                          onChange={(e) => setLocalServerHostDraft(e.target.value)}
                          onBlur={() => commitLocalServerHost()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              void commitLocalServerHost()
                              e.currentTarget.blur()
                            }
                          }}
                        />
                      </div>
                      <div className="settings-row">
                        <div className="settings-row__info">
                          <div className="settings-row__label">端口</div>
                          <div className="settings-row__desc">默认 8765</div>
                        </div>
                        <input
                          className="form-input"
                          style={{ width: 120 }}
                          type="number"
                          value={localServerPortDraft}
                          onChange={(e) => setLocalServerPortDraft(e.target.value)}
                          onBlur={() => commitLocalServerPort()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              void commitLocalServerPort()
                              e.currentTarget.blur()
                            }
                          }}
                        />
                      </div>
                      <div className="settings-row">
                        <div className="settings-row__info">
                          <div className="settings-row__label">测试连接</div>
                          <div className="settings-row__desc">检查 /health 是否可用</div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <button
                            onClick={handleTestConnection}
                            disabled={connectionStatus === 'testing'}
                          >
                            {connectionStatus === 'testing' ? '测试中...' : '测试连接'}
                          </button>
                          {connectionMessage && (
                            <span
                              style={{
                                color: connectionStatus === 'success' ? '#4caf50' : '#ff6b6b'
                              }}
                            >
                              {connectionMessage}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="settings-row">
                        <div className="settings-row__info">
                          <div className="settings-row__label">服务端启动</div>
                          <div className="settings-row__desc">
                            Linux 服务器运行：python whisper_server.py --host 0.0.0.0 --port 8765
                          </div>
                        </div>
                      </div>
                    </>
                  )}

                  {!isRemoteServerMode && (
                    <ModelManager
                      engine={localEngine}
                      currentModel={currentLocalModel}
                      onModelChange={handleModelChange}
                    />
                  )}

                  {isRemoteServerMode && (
                    <div className="settings-row">
                      <div className="settings-row__info">
                        <div className="settings-row__label">模型管理</div>
                        <div className="settings-row__desc">
                          远程模式不支持本地模型管理，请在远端服务配置对应引擎与模型
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}

              {config.recognition?.backend === 'soniox' && (
                <div className="settings-row">
                  <div className="settings-row__info">
                    <div className="settings-row__label">Soniox API Key</div>
                    <div className="settings-row__desc">
                      {hasSonioxKey ? '已安全存储 (加密)' : '输入您的 Soniox API 密钥'}
                    </div>
                  </div>
                  <input
                    type="password"
                    className="form-input"
                    style={{ width: 240 }}
                    value={sonioxApiKey}
                    placeholder="sk-..."
                    onChange={(e) => handleSonioxApiKeyChange(e.target.value)}
                  />
                </div>
              )}

              {config.recognition?.backend === 'groq' && (
                <>
                  <div className="settings-row">
                    <div className="settings-row__info">
                      <div className="settings-row__label">Groq API Key</div>
                      <div className="settings-row__desc">
                        {hasGroqKey ? '已安全存储 (加密)' : '输入您的 Groq API 密钥'}
                      </div>
                    </div>
                    <input
                      type="password"
                      className="form-input"
                      style={{ width: 240 }}
                      value={groqApiKey}
                      placeholder="gsk_..."
                      onChange={(e) => handleGroqApiKeyChange(e.target.value)}
                    />
                  </div>
                  <div className="settings-row">
                    <div className="settings-row__info">
                      <div className="settings-row__label">模型</div>
                      <div className="settings-row__desc">whisper-large-v3-turbo 更快且便宜</div>
                    </div>
                    <select
                      className="form-input form-select"
                      style={{ width: 200 }}
                      value={config.recognition?.groq?.model || 'whisper-large-v3-turbo'}
                      onChange={(e) =>
                        updateConfig({ recognition: { groq: { model: e.target.value } } })
                      }
                    >
                      <option value="whisper-large-v3-turbo">whisper-large-v3-turbo</option>
                      <option value="whisper-large-v3">whisper-large-v3</option>
                    </select>
                  </div>
                  <div className="settings-row">
                    <div className="settings-row__info">
                      <div className="settings-row__label">翻译模型</div>
                      <div className="settings-row__desc">
                        兼容保留项，推荐使用下方统一翻译配置
                      </div>
                    </div>
                    <select
                      className="form-input form-select"
                      style={{ width: 200 }}
                      value={config.recognition?.groq?.chatModel || 'moonshotai/kimi-k2-instruct-0905'}
                      onChange={(e) =>
                        updateConfig({ recognition: { groq: { chatModel: e.target.value } } })
                      }
                    >
                      <option value="moonshotai/kimi-k2-instruct-0905">Kimi K2 (推荐)</option>
                      <option value="llama-3.3-70b-versatile">Llama 3.3 70B</option>
                      <option value="llama-3.1-70b-versatile">Llama 3.1 70B</option>
                      <option value="mixtral-8x7b-32768">Mixtral 8x7B (更快)</option>
                    </select>
                  </div>
                  {hasCapability(config.recognition?.backend, 'punctuation') && (
                    <div className="settings-row">
                      <div className="settings-row__info">
                        <div className="settings-row__label">自动标点</div>
                        <div className="settings-row__desc">让模型自动添加标点符号</div>
                      </div>
                      <label className="toggle">
                        <input
                          type="checkbox"
                          className="toggle__input"
                          checked={config.recognition?.punctuation !== false}
                          onChange={(e) =>
                            updateConfig({ recognition: { punctuation: e.target.checked } })
                          }
                        />
                        <span className="toggle__slider" />
                      </label>
                    </div>
                  )}
                </>
              )}

              {config.recognition?.backend === 'api' && (
                <>
                  <div className="settings-row">
                    <div className="settings-row__info">
                      <div className="settings-row__label">API Endpoint</div>
                      <div className="settings-row__desc">OpenAI 兼容的 API 地址</div>
                    </div>
                    <input
                      className="form-input"
                      style={{ width: 280 }}
                      value={openaiEndpointDraft}
                      placeholder="https://api.openai.com/v1"
                      onChange={(e) => setOpenaiEndpointDraft(e.target.value)}
                      onBlur={() => commitOpenaiEndpoint()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          void commitOpenaiEndpoint()
                          e.currentTarget.blur()
                        }
                      }}
                    />
                  </div>

                  <div className="settings-row">
                    <div className="settings-row__info">
                      <div className="settings-row__label">API Key</div>
                      <div className="settings-row__desc">
                        {hasOpenaiKey ? '已安全存储 (加密)' : '输入您的 OpenAI API 密钥'}
                      </div>
                    </div>
                    <input
                      type="password"
                      className="form-input"
                      style={{ width: 280 }}
                      value={openaiApiKey}
                      placeholder="sk-..."
                      onChange={(e) => handleOpenaiApiKeyChange(e.target.value)}
                    />
                  </div>

                  <div className="settings-row">
                    <div className="settings-row__info">
                      <div className="settings-row__label">模型</div>
                      <div className="settings-row__desc">选择 Whisper 模型版本</div>
                    </div>
                    <select
                      className="form-input form-select"
                      style={{ width: 200 }}
                      value={config.recognition?.api?.model || 'whisper-1'}
                      onChange={(e) =>
                        updateConfig({ recognition: { api: { model: e.target.value } } })
                      }
                    >
                      <option value="whisper-1">whisper-1</option>
                    </select>
                  </div>
                </>
              )}

              <div className="settings-row">
                <div className="settings-row__info">
                  <div className="settings-row__label">PTT 翻译</div>
                  <div className="settings-row__desc">
                    开启后将按键转录结果翻译后再输出（OpenAI Compatible）
                  </div>
                </div>
                <label className="toggle">
                  <input
                    type="checkbox"
                    className="toggle__input"
                    checked={translationEnabledForPtt}
                    onChange={(e) =>
                      updateConfig({ recognition: { translation: { enabledForPtt: e.target.checked } } })
                    }
                  />
                  <span className="toggle__slider" />
                </label>
              </div>

              {translationEnabledForPtt && (
                <div className="settings-row">
                  <div className="settings-row__info">
                    <div className="settings-row__label">PTT 目标语言</div>
                    <div className="settings-row__desc">按键转录将翻译到该语言</div>
                  </div>
                  <select
                    className="form-input form-select"
                    style={{ width: 160 }}
                    value={translationTargetLanguage}
                    onChange={(e) =>
                      updateConfig({ recognition: { translation: { targetLanguage: e.target.value } } })
                    }
                  >
                    {recognitionLanguageOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="settings-row">
                <div className="settings-row__info">
                  <div className="settings-row__label">翻译 API Endpoint</div>
                  <div className="settings-row__desc">OpenAI 兼容地址（默认 /v1）</div>
                </div>
                <input
                  className="form-input"
                  style={{ width: 280 }}
                  value={translationEndpointDraft}
                  placeholder="https://api.openai.com/v1"
                  onChange={(e) => setTranslationEndpointDraft(e.target.value)}
                  onBlur={() => commitTranslationEndpoint()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      void commitTranslationEndpoint()
                      e.currentTarget.blur()
                    }
                  }}
                />
              </div>

              <div className="settings-row">
                <div className="settings-row__info">
                  <div className="settings-row__label">翻译模型</div>
                  <div className="settings-row__desc">用于文本翻译（chat/completions）</div>
                </div>
                <input
                  className="form-input"
                  style={{ width: 220 }}
                  value={translationModelDraft}
                  placeholder="gpt-4o-mini"
                  onChange={(e) => setTranslationModelDraft(e.target.value)}
                  onBlur={() => commitTranslationModel()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      void commitTranslationModel()
                      e.currentTarget.blur()
                    }
                  }}
                />
              </div>

              <div className="settings-row">
                <div className="settings-row__info">
                  <div className="settings-row__label">翻译 API Key</div>
                  <div className="settings-row__desc">
                    {hasOpenaiKey ? '已安全存储 (加密)' : '输入 OpenAI Compatible API Key'}
                  </div>
                </div>
                <input
                  type="password"
                  className="form-input"
                  style={{ width: 280 }}
                  value={openaiApiKey}
                  placeholder="sk-..."
                  onChange={(e) => handleOpenaiApiKeyChange(e.target.value)}
                />
              </div>
            </div>
          )}

          {activeTab === 'hotkey' && (
            <div className="settings-section">
              <h2 className="settings-section__title">快捷键设置</h2>

              <div className="settings-row">
                <div className="settings-row__info">
                  <div className="settings-row__label">触发按键</div>
                  <div className="settings-row__desc">按住此键开始录音</div>
                </div>
                <select
                  className="form-input form-select"
                  style={{ width: 150 }}
                  value={config.hotkey?.triggerKey || DEFAULT_TRIGGER_KEY}
                  onChange={(e) => updateConfig({ hotkey: { triggerKey: e.target.value } })}
                >
                  <option value="RAlt">Right Alt</option>
                  <option value="RCtrl">Right Ctrl</option>
                  <option value="F13">F13</option>
                  <option value="F14">F14</option>
                </select>
              </div>
            </div>
          )}

          {activeTab === 'output' && (
            <div className="settings-section">
              <h2 className="settings-section__title">输出设置</h2>

              <div className="settings-row">
                <div className="settings-row__info">
                  <div className="settings-row__label">输出方式</div>
                  <div className="settings-row__desc">
                    自动粘贴为默认推荐；如需更稳定可选“仅复制”或“弹出结果”
                  </div>
                </div>
                <select
                  className="form-input form-select"
                  style={{ width: 220 }}
                  value={config.output?.method || 'simulate_input'}
                  onChange={(e) => updateConfig({ output: { method: e.target.value } })}
                >
                  <option value="simulate_input">自动粘贴（推荐）</option>
                  <option value="clipboard">仅复制到剪贴板</option>
                  <option value="popup">弹出结果窗口（自动复制）</option>
                </select>
              </div>

              <div className="settings-row">
                <div className="settings-row__info">
                  <div className="settings-row__label">自动空格</div>
                  <div className="settings-row__desc">连续输入时自动添加空格</div>
                </div>
                <label className="toggle">
                  <input
                    type="checkbox"
                    className="toggle__input"
                    checked={config.output?.autoSpace !== false}
                    onChange={(e) => updateConfig({ output: { autoSpace: e.target.checked } })}
                  />
                  <span className="toggle__slider" />
                </label>
              </div>

              <div className="settings-row">
                <div className="settings-row__info">
                  <div className="settings-row__label">首字母大写</div>
                  <div className="settings-row__desc">自动将每次识别结果的首字母大写</div>
                </div>
                <label className="toggle">
                  <input
                    type="checkbox"
                    className="toggle__input"
                    checked={config.output?.capitalize !== false}
                    onChange={(e) => updateConfig({ output: { capitalize: e.target.checked } })}
                  />
                  <span className="toggle__slider" />
                </label>
              </div>
            </div>
          )}

          {activeTab === 'appearance' && (
            <div className="settings-section">
              <h2 className="settings-section__title">外观设置</h2>

              <div className="settings-row">
                <div className="settings-row__info">
                  <div className="settings-row__label">主题</div>
                  <div className="settings-row__desc">选择应用外观主题</div>
                </div>
                <select
                  className="form-input form-select"
                  style={{ width: 150 }}
                  value={currentTheme}
                  onChange={(e) => handleThemeChange(e.target.value as ThemeOption)}
                >
                  <option value="system">跟随系统</option>
                  <option value="light">浅色模式</option>
                  <option value="dark">深色模式</option>
                </select>
              </div>

              <div className="settings-row">
                <div className="settings-row__info">
                  <div className="settings-row__label">录音指示器</div>
                  <div className="settings-row__desc">录音时显示悬浮指示器</div>
                </div>
                <label className="toggle">
                  <input
                    type="checkbox"
                    className="toggle__input"
                    checked={config.ui?.indicatorEnabled !== false}
                    onChange={(e) => updateConfig({ ui: { indicatorEnabled: e.target.checked } })}
                  />
                  <span className="toggle__slider" />
                </label>
              </div>

              <div className="settings-row">
                <div className="settings-row__info">
                  <div className="settings-row__label">提示音</div>
                  <div className="settings-row__desc">录音开始和结束时播放提示音</div>
                </div>
                <label className="toggle">
                  <input
                    type="checkbox"
                    className="toggle__input"
                    checked={config.ui?.soundFeedback !== false}
                    onChange={(e) => updateConfig({ ui: { soundFeedback: e.target.checked } })}
                  />
                  <span className="toggle__slider" />
                </label>
              </div>
            </div>
          )}

          {activeTab === 'advanced' && (
            <div className="settings-section">
              <h2 className="settings-section__title">高级设置</h2>

              <div className="settings-row">
                <div className="settings-row__info">
                  <div className="settings-row__label">关于</div>
                  <div className="settings-row__desc">JustSay v1.0.0</div>
                </div>
              </div>
              <div className="settings-row">
                <div className="settings-row__info">
                  <div className="settings-row__label">识别语言</div>
                  <div className="settings-row__desc">{recognitionLanguageHint}</div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <select
                    className="form-input form-select"
                    style={{ width: 120 }}
                    value={recognitionLanguageLocked ? 'locked' : 'auto'}
                    disabled={!recognitionLanguageSupport.supported}
                    onChange={(e) => {
                      const mode = e.target.value
                      if (mode === 'auto') {
                        updateConfig({ recognition: { language: 'auto' } })
                      } else {
                        const nextLanguage =
                          recognitionLanguage !== 'auto' ? recognitionLanguage : 'zh'
                        updateConfig({ recognition: { language: nextLanguage } })
                      }
                    }}
                  >
                    <option value="auto">自动</option>
                    <option value="locked">锁定</option>
                  </select>
                  {recognitionLanguageLocked && (
                    <select
                      className="form-input form-select"
                      style={{ width: 160 }}
                      value={lockedLanguageValue}
                      disabled={!recognitionLanguageSupport.supported}
                      onChange={(e) => updateConfig({ recognition: { language: e.target.value } })}
                    >
                      {recognitionLanguageOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                      {!hasLockedLanguageOption && (
                        <option value={lockedLanguageValue}>{lockedLanguageValue}</option>
                      )}
                    </select>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Helper function to deep merge objects
function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target }
  for (const key in source) {
    if (source[key] !== undefined) {
      if (
        typeof source[key] === 'object' &&
        source[key] !== null &&
        !Array.isArray(source[key])
      ) {
        result[key] = deepMerge(
          (target[key] as object) || {},
          source[key] as object
        ) as T[typeof key]
      } else {
        result[key] = source[key] as T[typeof key]
      }
    }
  }
  return result
}
