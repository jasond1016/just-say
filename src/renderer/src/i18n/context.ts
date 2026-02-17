import { createContext, useContext } from 'react'
import { AppLocale, getMessages } from './index'

export interface I18nContextValue {
  locale: AppLocale
  messages: ReturnType<typeof getMessages>
}

const DEFAULT_LOCALE: AppLocale = 'en-US'

export const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_LOCALE,
  messages: getMessages(DEFAULT_LOCALE)
})

export function useI18nContext(): I18nContextValue {
  return useContext(I18nContext)
}
