import type { AppLocale, Messages } from './index'
import { isZhLocale } from './index'
import { useI18nContext } from './context'

interface UseI18nResult {
  locale: AppLocale
  isZh: boolean
  m: Messages
}

export function useI18n(): UseI18nResult {
  const { locale, messages } = useI18nContext()
  return {
    locale,
    isZh: isZhLocale(locale),
    m: messages
  }
}
