import React, { useMemo } from 'react'
import { getMessages, resolveLocale } from './index'
import { I18nContext, type I18nContextValue } from './context'

interface I18nProviderProps {
  locale?: string
  children: React.ReactNode
}

export function I18nProvider({ locale, children }: I18nProviderProps): React.JSX.Element {
  const resolvedLocale = resolveLocale(locale)
  const value = useMemo<I18nContextValue>(
    () => ({
      locale: resolvedLocale,
      messages: getMessages(resolvedLocale)
    }),
    [resolvedLocale]
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
