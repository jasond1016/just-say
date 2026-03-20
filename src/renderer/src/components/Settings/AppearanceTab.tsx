import React from 'react'
import { useI18n } from '@/i18n/useI18n'
import type { AppLocale } from '@/i18n'
import { resolveLocale } from '@/i18n'
import { FieldRow, ToggleRow, SectionLabel, fullFieldClass } from './settings-primitives'
import type { ThemeOption } from './settings-types'

export interface AppearanceTabProps {
  theme: ThemeOption
  setTheme: (v: ThemeOption) => void
  appLanguage: AppLocale
  setAppLanguage: (v: AppLocale) => void
  launchAtLogin: boolean
  setLaunchAtLogin: (v: boolean) => void
  indicatorEnabled: boolean
  setIndicatorEnabled: (v: boolean) => void
  soundEnabled: boolean
  setSoundEnabled: (v: boolean) => void
}

export function AppearanceTab(props: AppearanceTabProps): React.JSX.Element {
  const { m } = useI18n()

  return (
    <div role="tabpanel" id="settings-panel-appearance" aria-labelledby="settings-tab-appearance" className="space-y-4">
      <SectionLabel>{m.settings.tabAppearance}</SectionLabel>

      <FieldRow label={m.settings.theme} htmlFor="s-theme">
        <select id="s-theme" className={fullFieldClass} value={props.theme} onChange={(e) => props.setTheme(e.target.value as ThemeOption)}>
          <option value="system">{m.settings.system}</option>
          <option value="light">{m.settings.light}</option>
          <option value="dark">{m.settings.dark}</option>
        </select>
      </FieldRow>

      <FieldRow label={m.settings.interfaceLanguage} htmlFor="s-app-lang">
        <select id="s-app-lang" className={fullFieldClass} value={props.appLanguage} onChange={(e) => props.setAppLanguage(resolveLocale(e.target.value))}>
          <option value="zh-CN">{m.settings.languageOptionZhCn}</option>
          <option value="en-US">{m.settings.languageOptionEnUs}</option>
        </select>
      </FieldRow>

      <ToggleRow id="s-launch-label" label={m.settings.launchAtLogin} description={m.settings.launchAtLoginDescription} checked={props.launchAtLogin} onChange={props.setLaunchAtLogin} />
      <ToggleRow id="s-indicator-label" label={m.settings.recordingIndicator} description={m.settings.recordingIndicatorDescription} checked={props.indicatorEnabled} onChange={props.setIndicatorEnabled} />
      <ToggleRow id="s-sound-label" label={m.settings.soundFeedback} description={m.settings.soundFeedbackDescription} checked={props.soundEnabled} onChange={props.setSoundEnabled} />
    </div>
  )
}
