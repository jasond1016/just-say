import { enUS } from './locales/en-US'
import { zhCN } from './locales/zh-CN'

export type AppLocale = 'en-US' | 'zh-CN'
export type Messages = typeof enUS

const LOCALE_MESSAGES: Record<AppLocale, Messages> = {
  'en-US': enUS,
  'zh-CN': zhCN
}

export function resolveLocale(locale?: string): AppLocale {
  return locale === 'zh-CN' ? 'zh-CN' : 'en-US'
}

export function getMessages(locale: AppLocale): Messages {
  return LOCALE_MESSAGES[locale]
}

export function isZhLocale(locale: AppLocale): boolean {
  return locale === 'zh-CN'
}

export function formatNumber(value: number, locale: AppLocale): string {
  return new Intl.NumberFormat(locale).format(value)
}

export function formatRelativeDateTime(isoString: string, locale: AppLocale): string {
  const date = new Date(isoString)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()
  const time = date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })

  if (isToday) {
    return isZhLocale(locale) ? `今天 ${time}` : `Today, ${time}`
  }

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) {
    return isZhLocale(locale) ? `昨天 ${time}` : `Yesterday, ${time}`
  }

  if (isZhLocale(locale)) {
    return `${date.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })} ${time}`
  }
  return `${date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })}, ${time}`
}

export function formatDurationShort(seconds: number, locale: AppLocale): string {
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes === 0) {
    return isZhLocale(locale) ? `${remainingSeconds}秒` : `${remainingSeconds}s`
  }
  return isZhLocale(locale) ? `${minutes} 分钟` : `${minutes} min`
}
