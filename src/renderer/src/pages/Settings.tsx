import React, { useEffect, useState } from 'react'
import { ModelManager } from '../components/Settings/ModelManager'

type ThemeOption = 'system' | 'light' | 'dark'
type SettingsTab = 'general' | 'audio' | 'recognition' | 'hotkey' | 'output' | 'appearance' | 'advanced'

interface SettingsProps {
  currentTheme: ThemeOption
  onThemeChange: (theme: ThemeOption) => void
}

export function Settings({ currentTheme, onThemeChange }: SettingsProps): React.JSX.Element {
  const [config, setConfig] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')

  useEffect(() => {
    loadConfig()
  }, [])

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
      await window.api.setConfig(newConfig)
      setConfig(newConfig)
    } catch (err) {
      console.error('Failed to save config:', err)
    }
  }

  const handleThemeChange = async (theme: ThemeOption): Promise<void> => {
    onThemeChange(theme)
    await updateConfig({ ui: { theme } })
  }

  const handleModelChange = async (modelType: string): Promise<void> => {
    await updateConfig({
      recognition: {
        local: { modelType }
      }
    })
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
                  <option value="local">本地 (Faster-Whisper)</option>
                  <option value="soniox">Soniox (流式)</option>
                  <option value="api">OpenAI API</option>
                  <option value="groq">Groq (快速云端)</option>
                </select>
              </div>

              {(!config.recognition?.backend || config.recognition?.backend === 'local') && (
                <ModelManager
                  currentModel={config.recognition?.local?.modelType || 'tiny'}
                  onModelChange={handleModelChange}
                />
              )}

              {config.recognition?.backend === 'soniox' && (
                <div className="settings-row">
                  <div className="settings-row__info">
                    <div className="settings-row__label">Soniox API Key</div>
                    <div className="settings-row__desc">输入您的 Soniox API 密钥</div>
                  </div>
                  <input
                    type="password"
                    className="form-input"
                    style={{ width: 240 }}
                    value={config.recognition?.soniox?.apiKey || ''}
                    placeholder="sk-..."
                    onChange={(e) =>
                      updateConfig({ recognition: { soniox: { apiKey: e.target.value } } })
                    }
                  />
                </div>
              )}

              {config.recognition?.backend === 'groq' && (
                <>
                  <div className="settings-row">
                    <div className="settings-row__info">
                      <div className="settings-row__label">Groq API Key</div>
                      <div className="settings-row__desc">输入您的 Groq API 密钥</div>
                    </div>
                    <input
                      type="password"
                      className="form-input"
                      style={{ width: 240 }}
                      value={config.recognition?.groq?.apiKey || ''}
                      placeholder="gsk_..."
                      onChange={(e) =>
                        updateConfig({ recognition: { groq: { apiKey: e.target.value } } })
                      }
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
                </>
              )}
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
                  value={config.hotkey?.triggerKey || 'RAlt'}
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
                  <div className="settings-row__desc">识别结果的插入方式</div>
                </div>
                <select
                  className="form-input form-select"
                  style={{ width: 150 }}
                  value={config.output?.method || 'simulate_input'}
                  onChange={(e) => updateConfig({ output: { method: e.target.value } })}
                >
                  <option value="simulate_input">模拟键盘输入</option>
                  <option value="clipboard">复制到剪贴板</option>
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
