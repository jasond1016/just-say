import { getDatabase } from './index'
import type { HomeStats, HomeStatsDay, UsageMode } from './types'

interface RecordUsageEventInput {
  mode: UsageMode
  chars?: number
  durationMs?: number
  success?: boolean
  createdAtMs?: number
}

function getCurrentLocalDayBounds(nowMs = Date.now()): { startMs: number; endMs: number } {
  const now = new Date(nowMs)
  const startMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return {
    startMs,
    endMs: startMs + 24 * 60 * 60 * 1000
  }
}

function toLocalDayStartMs(timestampMs: number): number {
  const date = new Date(timestampMs)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export function recordUsageEvent(input: RecordUsageEventInput): void {
  const db = getDatabase()
  const chars = Math.max(0, Math.floor(input.chars || 0))
  const durationMs =
    typeof input.durationMs === 'number' ? Math.max(0, Math.floor(input.durationMs)) : null
  const createdAtMs = Math.floor(input.createdAtMs || Date.now())
  const success = input.success === false ? 0 : 1

  db.prepare(
    `
      INSERT INTO usage_events (mode, chars, duration_ms, success, created_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `
  ).run(input.mode, chars, durationMs, success, createdAtMs)
}

export function getHomeStats(nowMs = Date.now()): HomeStats {
  const db = getDatabase()
  const { startMs, endMs } = getCurrentLocalDayBounds(nowMs)
  const dayMs = 24 * 60 * 60 * 1000
  const rangeStartMs = startMs - 6 * dayMs

  const rows = db
    .prepare(
      `
      SELECT
        created_at_ms,
        chars
      FROM usage_events
      WHERE mode = 'ptt'
        AND success = 1
        AND created_at_ms >= ?
        AND created_at_ms < ?
      ORDER BY created_at_ms ASC
    `
    )
    .all(rangeStartMs, endMs) as Array<{ created_at_ms: number; chars: number }>

  const dailyMap = new Map<number, { ptt_count: number; chars_sum: number }>()

  for (const row of rows) {
    const bucket = toLocalDayStartMs(row.created_at_ms)
    const current = dailyMap.get(bucket) || { ptt_count: 0, chars_sum: 0 }
    current.ptt_count += 1
    current.chars_sum += row.chars || 0
    dailyMap.set(bucket, current)
  }

  const daily: HomeStatsDay[] = []
  for (let i = 0; i < 7; i += 1) {
    const dayStart = rangeStartMs + i * dayMs
    const dayValue = dailyMap.get(dayStart) || { ptt_count: 0, chars_sum: 0 }
    daily.push({
      start_ms: dayStart,
      ptt_count: dayValue.ptt_count,
      chars_sum: dayValue.chars_sum
    })
  }

  const today = daily[daily.length - 1] || { ptt_count: 0, chars_sum: 0 }
  const yesterday = daily[daily.length - 2] || { ptt_count: 0, chars_sum: 0 }

  return {
    todayPttCount: today.ptt_count,
    todayChars: today.chars_sum,
    todayPttDelta: today.ptt_count - yesterday.ptt_count,
    todayCharsDelta: today.chars_sum - yesterday.chars_sum,
    daily
  }
}
