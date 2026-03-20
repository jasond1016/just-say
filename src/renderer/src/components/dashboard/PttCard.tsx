import { useEffect, useMemo, useState, type JSX } from 'react'

import { formatNumber } from '@/i18n'
import { useI18n } from '@/i18n/useI18n'

interface PttCardProps {
  hotkey: string
  todayCount: number
  todayChars: number
  todayCountDelta: number
  todayCharsDelta: number
  dailyStats: Array<{
    startMs: number
    pttCount: number
    charsSum: number
  }>
  loading?: boolean
  error?: string | null
  updatedAt?: number
}

function getDayLabel(startMs: number, locale: string): string {
  return new Date(startMs).toLocaleDateString(locale, { weekday: 'short' })
}

export function PttCard({
  todayCount,
  todayChars,
  todayCountDelta,
  todayCharsDelta,
  dailyStats,
  loading = false,
  error = null,
  updatedAt = 0
}: PttCardProps): JSX.Element {
  const { m, locale } = useI18n()
  const [flash, setFlash] = useState(false)
  const countLabel = loading ? '—' : formatNumber(todayCount, locale)
  const charsLabel = loading ? '—' : formatNumber(todayChars, locale)

  const formatDelta = (value: number, suffix = ''): string => {
    const withSuffix = suffix ? ` ${suffix}` : ''
    const formatted = formatNumber(value, locale)
    if (value > 0) return m.pttCard.deltaPositive(formatted, withSuffix)
    if (value < 0) return m.pttCard.deltaNegative(formatted, withSuffix)
    return m.pttCard.deltaNeutral(withSuffix)
  }

  const bars = useMemo(() => {
    if (dailyStats.length === 0) {
      return Array.from({ length: 7 }, (_, index) => ({
        key: `ph-${index}`,
        label: '-',
        pttCount: 0,
        heightPercent: 6
      }))
    }

    const maxCount = dailyStats.reduce((max, day) => Math.max(max, day.pttCount), 0)
    return dailyStats.map((day) => {
      const ratio = maxCount > 0 ? day.pttCount / maxCount : 0
      return {
        key: String(day.startMs),
        label: getDayLabel(day.startMs, locale),
        pttCount: day.pttCount,
        heightPercent: Math.max(6, Math.round(ratio * 100))
      }
    })
  }, [dailyStats, locale])

  useEffect(() => {
    if (!updatedAt) return
    setFlash(true)
    const timer = setTimeout(() => setFlash(false), 400)
    return () => clearTimeout(timer)
  }, [updatedAt])

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="flex items-baseline gap-6">
          <div className="skeleton h-8 w-16 rounded-md" />
          <div className="skeleton h-8 w-20 rounded-md" />
        </div>
        <div className="skeleton h-3 w-48 rounded" />
        <div className="flex items-end gap-2 pt-1">
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="flex flex-col items-center gap-1.5 flex-1">
              <div className="skeleton h-10 w-full max-w-[20px] rounded-sm" />
              <div className="skeleton h-3 w-6 rounded" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* Stats row */}
      <div className="flex items-baseline gap-6 mb-1.5">
        <div className="flex items-baseline gap-2">
          <span
            className={`font-display text-3xl tabular-nums text-foreground transition-transform duration-200 ${
              flash ? 'scale-[1.03]' : ''
            }`}
          >
            {countLabel}
          </span>
          <span className="text-xs text-muted-foreground">{m.pttCard.today}</span>
        </div>
        <div className="flex items-baseline gap-2">
          <span
            className={`font-display text-3xl tabular-nums text-foreground transition-transform duration-200 ${
              flash ? 'scale-[1.03]' : ''
            }`}
          >
            {charsLabel}
          </span>
          <span className="text-xs text-muted-foreground">{m.pttCard.chars}</span>
        </div>
      </div>

      <div className="flex items-center gap-4 text-[12px] text-muted-foreground mb-3">
        <span>{formatDelta(todayCountDelta)}</span>
        <span>{formatDelta(todayCharsDelta, m.pttCard.chars)}</span>
      </div>

      {/* 7-day activity */}
      <div className="flex items-end gap-2" role="img" aria-label="7-day PTT activity chart">
        {bars.map((day, index) => {
          const isToday = index === bars.length - 1
          return (
            <div key={day.key} className="flex flex-col items-center gap-1.5 flex-1">
              <div className="flex h-10 w-full items-end justify-center">
                <div
                  title={m.pttCard.barTooltip(day.label, day.pttCount)}
                  aria-label={m.pttCard.barTooltip(day.label, day.pttCount)}
                  className={`w-full max-w-[20px] rounded-sm transition-all duration-500 ${
                    isToday ? 'bg-primary' : 'bg-border'
                  }`}
                  style={{ height: `${day.heightPercent}%` }}
                />
              </div>
              <span className={`font-mono text-[10px] tabular-nums ${isToday ? 'text-primary font-medium' : 'text-muted-foreground'}`}>
                {day.label}
              </span>
            </div>
          )
        })}
      </div>

      {error && <p className="mt-3 text-xs text-destructive">{m.pttCard.statsUnavailable}</p>}
    </div>
  )
}
