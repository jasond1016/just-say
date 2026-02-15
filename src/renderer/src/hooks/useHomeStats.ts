import { useCallback, useEffect, useState } from 'react'

export interface HomeStats {
  todayPttCount: number
  todayChars: number
  todayPttDelta: number
  todayCharsDelta: number
  daily: Array<{
    startMs: number
    pttCount: number
    charsSum: number
  }>
}

const DEFAULT_STATS: HomeStats = {
  todayPttCount: 0,
  todayChars: 0,
  todayPttDelta: 0,
  todayCharsDelta: 0,
  daily: []
}

export function useHomeStats(): {
  stats: HomeStats
  loading: boolean
  error: string | null
  updatedAt: number
  refresh: () => Promise<void>
} {
  const [stats, setStats] = useState<HomeStats>(DEFAULT_STATS)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState(0)

  const loadStats = useCallback(async (showLoading: boolean) => {
    if (showLoading) {
      setLoading(true)
    }

    try {
      const next = await window.api.getHomeStats()
      setStats({
        todayPttCount: next.todayPttCount || 0,
        todayChars: next.todayChars || 0,
        todayPttDelta: next.todayPttDelta || 0,
        todayCharsDelta: next.todayCharsDelta || 0,
        daily: (next.daily || []).map((day) => ({
          startMs: day.start_ms,
          pttCount: day.ptt_count,
          charsSum: day.chars_sum
        }))
      })
      setUpdatedAt(Date.now())
      setError(null)
    } catch (err) {
      console.error('Failed to load home stats:', err)
      setError('Failed to load stats')
    } finally {
      if (showLoading) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    void loadStats(true)
    const unsubscribe = window.api.onHomeStatsUpdated(() => {
      void loadStats(false)
    })
    return () => unsubscribe()
  }, [loadStats])

  const refresh = useCallback(async () => {
    await loadStats(true)
  }, [loadStats])

  return {
    stats,
    loading,
    error,
    updatedAt,
    refresh
  }
}
