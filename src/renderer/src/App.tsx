import React, { useEffect, useState, useCallback } from 'react'
import './styles/design-system.css'
import { Layout } from './components/Layout'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { PushToTalk } from './pages/PushToTalk'
import { MeetingTranscription } from './pages/MeetingTranscription'
import { Settings } from './pages/Settings'

type ThemeOption = 'system' | 'light' | 'dark'
type ViewType = 'ptt' | 'meeting' | 'settings'

interface AppConfig {
  ui?: {
    theme?: ThemeOption
  }
  hotkey?: {
    triggerKey?: string
  }
  recognition?: {
    backend?: string
  }
}

function App(): React.JSX.Element {
  const [activeView, setActiveView] = useState<ViewType>('ptt')
  const [theme, setTheme] = useState<ThemeOption>('system')
  const [pttStatus, setPttStatus] = useState<'idle' | 'recording' | 'processing'>('idle')
  const [config, setConfig] = useState<AppConfig | null>(null)

  // Load config on mount
  useEffect(() => {
    loadConfig()
  }, [])

  const loadConfig = async (): Promise<void> => {
    try {
      const cfg = (await window.api.getConfig()) as AppConfig
      setConfig(cfg)
      if (cfg.ui?.theme) {
        setTheme(cfg.ui.theme)
      }
    } catch (err) {
      console.error('Failed to load config:', err)
    }
  }

  // Apply theme based on preference
  const applyTheme = useCallback((themeOption: ThemeOption) => {
    let effectiveTheme: 'light' | 'dark'

    if (themeOption === 'system') {
      // Check system preference
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      effectiveTheme = prefersDark ? 'dark' : 'light'
    } else {
      effectiveTheme = themeOption
    }

    // Apply to document
    if (effectiveTheme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light')
    } else {
      document.documentElement.removeAttribute('data-theme')
    }
  }, [])

  // Apply theme when it changes
  useEffect(() => {
    applyTheme(theme)
  }, [theme, applyTheme])

  // Listen for system theme changes
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

  // Listen for recording state changes from main process
  useEffect(() => {
    const handleRecordingState = (state: { recording?: boolean; processing?: boolean }): void => {
      if (state.recording) {
        setPttStatus('recording')
      } else if (state.processing) {
        setPttStatus('processing')
      } else {
        setPttStatus('idle')
      }
    }

    if (window.api?.onRecordingState) {
      window.api.onRecordingState(handleRecordingState)
    }
  }, [])

  const handleThemeChange = (newTheme: ThemeOption): void => {
    setTheme(newTheme)
  }

  const hotkey = config?.hotkey?.triggerKey || 'Right Alt'
  const engine =
    config?.recognition?.backend === 'soniox'
      ? 'Soniox'
      : config?.recognition?.backend === 'api'
        ? 'OpenAI'
        : 'Local'

  return (
    <Layout
      sidebar={
        <Sidebar activeView={activeView} onViewChange={(v) => setActiveView(v as ViewType)} />
      }
      statusBar={<StatusBar status={pttStatus} engine={engine} hotkey={hotkey} />}
    >
      {activeView === 'ptt' && <PushToTalk status={pttStatus} hotkey={hotkey} />}
      {activeView === 'meeting' && <MeetingTranscription />}
      {activeView === 'settings' && (
        <Settings currentTheme={theme} onThemeChange={handleThemeChange} />
      )}
    </Layout>
  )
}

export default App
