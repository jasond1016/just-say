import React from 'react'
import { useI18n } from '@/i18n/useI18n'
import { SectionLabel } from './settings-primitives'

export function AboutTab(): React.JSX.Element {
  const { m } = useI18n()

  return (
    <div role="tabpanel" id="settings-panel-about" aria-labelledby="settings-tab-about" className="space-y-4">
      <SectionLabel>{m.settings.tabAbout}</SectionLabel>
      <div className="border-l-2 border-primary pl-4 py-2">
        <p className="text-sm font-medium">{m.common.appName}</p>
        <p className="font-mono text-[12px] text-muted-foreground">{m.settings.version} 1.0.0</p>
        <p className="text-[13px] text-muted-foreground mt-1">{m.settings.aboutDescription}</p>
      </div>
    </div>
  )
}
