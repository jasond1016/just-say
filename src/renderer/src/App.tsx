import React, { useEffect, useState, useCallback } from 'react'
import { MeetingTranscription } from './pages/MeetingTranscription'
import { TranscriptHistory } from './pages/TranscriptHistory'
import { TranscriptDetail } from './pages/TranscriptDetail'
import { DashboardHome } from './pages/DashboardHome'
import { DashboardSidebar, type DashboardView } from './components/dashboard/DashboardSidebar'
import { DashboardSettingsModal } from './components/dashboard/DashboardSettingsModal'
import { DEFAULT_TRIGGER_KEY, getTriggerKeyLabel } from '../../shared/hotkey'

type ThemeOption = 'system' | 'light' | 'dark'
type ViewType = 'ptt' | 'meeting' | 'history' | 'detail'

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
  const [selectedTranscriptId, setSelectedTranscriptId] = useState<string | null>(null)
  const [theme, setTheme] = useState<ThemeOption>('system')
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [dashboardSettingsOpen, setDashboardSettingsOpen] = useState(false)

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

  // Load config on mount
  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

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

    document.documentElement.classList.toggle('dark', effectiveTheme === 'dark')
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

  const handleThemeChange = (newTheme: ThemeOption): void => {
    setTheme(newTheme)
  }

  const hotkey = getTriggerKeyLabel(config?.hotkey?.triggerKey || DEFAULT_TRIGGER_KEY)
  const dashboardHotkey = hotkey === 'Right Ctrl' ? 'R Ctrl' : hotkey

  const handleDashboardNavigate = useCallback((nextView: DashboardView) => {
    setActiveView(nextView)
    setSelectedTranscriptId(null)
    setDashboardSettingsOpen(false)
  }, [])

  const handleNavigateToDetail = useCallback((id: string) => {
    setSelectedTranscriptId(id)
    setActiveView('detail')
  }, [])

  const handleBackFromDetail = useCallback(() => {
    setSelectedTranscriptId(null)
    setActiveView('history')
  }, [])

  const sidebarActiveView: DashboardView =
    activeView === 'meeting'
      ? 'meeting'
      : activeView === 'history' || activeView === 'detail'
        ? 'history'
        : 'ptt'

  return (
    <>
      <div className="h-full w-full bg-background">
        <div className="mx-auto h-full w-full max-w-[1200px] overflow-hidden bg-background">
          <div className="flex h-full w-full">
            <DashboardSidebar activeView={sidebarActiveView} onNavigate={handleDashboardNavigate} />

            {activeView === 'ptt' && (
              <DashboardHome
                hotkey={dashboardHotkey}
                onNavigate={handleDashboardNavigate}
                onOpenSettings={() => setDashboardSettingsOpen(true)}
                onOpenTranscript={handleNavigateToDetail}
              />
            )}

            {activeView === 'meeting' && (
              <MeetingTranscription onOpenSettings={() => setDashboardSettingsOpen(true)} />
            )}

            {activeView === 'history' && (
              <TranscriptHistory onNavigateToDetail={handleNavigateToDetail} />
            )}

            {activeView === 'detail' && selectedTranscriptId && (
              <TranscriptDetail id={selectedTranscriptId} onBack={handleBackFromDetail} />
            )}

            {activeView === 'detail' && !selectedTranscriptId && (
              <TranscriptHistory onNavigateToDetail={handleNavigateToDetail} />
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
