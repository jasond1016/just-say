import { useEffect, useMemo, useState, type JSX } from 'react'
import { Mic } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'

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

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

function formatDelta(value: number, suffix = ''): string {
  const withSuffix = suffix ? ` ${suffix}` : ''
  if (value > 0) return `+${formatCompactNumber(value)}${withSuffix} vs yesterday`
  if (value < 0) return `${formatCompactNumber(value)}${withSuffix} vs yesterday`
  return `No change${withSuffix} vs yesterday`
}

function getDayLabel(startMs: number): string {
  return new Date(startMs).toLocaleDateString('en-US', { weekday: 'short' })
}

export function PttCard({
  hotkey,
  todayCount,
  todayChars,
  todayCountDelta,
  todayCharsDelta,
  dailyStats,
  loading = false,
  error = null,
  updatedAt = 0
}: PttCardProps): JSX.Element {
  const [flash, setFlash] = useState(false)
  const countLabel = loading ? '--' : formatCompactNumber(todayCount)
  const charsLabel = loading ? '--' : formatCompactNumber(todayChars)
  const bars = useMemo(() => {
    if (dailyStats.length === 0) {
      return Array.from({ length: 7 }, (_, index) => ({
        key: `placeholder-${index}`,
        label: '-',
        pttCount: 0,
        heightPercent: 8
      }))
    }

    const maxCount = dailyStats.reduce((max, day) => Math.max(max, day.pttCount), 0)
    return dailyStats.map((day) => {
      const ratio = maxCount > 0 ? day.pttCount / maxCount : 0
      const heightPercent = Math.max(8, Math.round(ratio * 100))
      return {
        key: String(day.startMs),
        label: getDayLabel(day.startMs),
        pttCount: day.pttCount,
        heightPercent
      }
    })
  }, [dailyStats])

  useEffect(() => {
    if (!updatedAt) return
    setFlash(true)
    const timer = setTimeout(() => setFlash(false), 420)
    return () => clearTimeout(timer)
  }, [updatedAt])

  return (
    <Card
      className={`border-[#E9E5FF] bg-[#F5F3FF] transition-shadow duration-300 ${
        flash ? 'shadow-[0_0_0_2px_rgba(124,58,237,0.18)]' : ''
      }`}
    >
      <CardContent className="flex items-center justify-between gap-5 p-5">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center gap-2">
            <Mic className="h-[18px] w-[18px] text-[#7C3AED]" />
            <span className="text-base font-semibold text-[#1A1A1A]">Push to Talk</span>
            <Badge className="bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-500">Ready</Badge>
          </div>
          <p className="text-[13px] leading-5 text-[#6B7280]">
            Hold the hotkey to record and transcribe your voice. Text is automatically inserted at
            your cursor position.
          </p>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-1.5">
              <span
                className={`text-lg leading-none font-bold text-[#7C3AED] transition-transform duration-300 ${
                  flash ? 'scale-105' : ''
                }`}
              >
                {countLabel}
              </span>
              <span className="text-xs text-[#9CA3AF]">today</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span
                className={`text-lg leading-none font-bold text-[#7C3AED] transition-transform duration-300 ${
                  flash ? 'scale-105' : ''
                }`}
              >
                {charsLabel}
              </span>
              <span className="text-xs text-[#9CA3AF]">chars</span>
            </div>
          </div>
          {!loading && (
            <div className="flex items-center gap-4 text-[11px] text-[#9CA3AF]">
              <span>{formatDelta(todayCountDelta)}</span>
              <span>{formatDelta(todayCharsDelta, 'chars')}</span>
            </div>
          )}
          <div className="mt-1 flex items-end gap-1.5">
            {bars.map((day, index) => {
              const isToday = index === bars.length - 1
              return (
                <div key={day.key} className="flex flex-col items-center gap-1">
                  <div className="flex h-10 items-end">
                    <div
                      title={`${day.label}: ${day.pttCount}`}
                      className={`w-2.5 rounded-sm transition-all duration-500 ${
                        isToday ? 'bg-[#7C3AED]' : 'bg-[#C4B5FD]'
                      }`}
                      style={{ height: `${day.heightPercent}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-[#9CA3AF]">{day.label}</span>
                </div>
              )
            })}
          </div>
          {error && <p className="text-xs text-red-500">Stats unavailable. Try again later.</p>}
        </div>

        <div className="flex shrink-0 flex-col items-center gap-2">
          <div className="flex items-center justify-center rounded-lg border border-[#E5E7EB] bg-white px-5 py-3">
            <span className="text-base font-semibold text-[#374151]">{hotkey}</span>
          </div>
          <span className="text-[11px] text-[#9CA3AF]">Hold to record</span>
        </div>
      </CardContent>
    </Card>
  )
}
