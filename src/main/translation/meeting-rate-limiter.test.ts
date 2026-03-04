import { afterEach, describe, expect, it, vi } from 'vitest'
import { MeetingTranslationRateLimiter } from './meeting-rate-limiter'

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('MeetingTranslationRateLimiter', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('drops oldest queued request when queue is full (drop_oldest)', async () => {
    vi.useFakeTimers()

    const limiter = new MeetingTranslationRateLimiter({
      enabled: true,
      maxRequestsPerMinute: 100,
      maxTokensPerMinute: 100000,
      minRequestIntervalMs: 0,
      maxQueueSize: 1,
      maxQueueWaitMs: 60_000,
      dropPolicy: 'drop_oldest'
    })

    const gate = createDeferred<string>()
    const started: string[] = []
    const completed: string[] = []

    const p1 = limiter.enqueue(100, async () => {
      started.push('p1')
      const value = await gate.promise
      completed.push('p1')
      return value
    })
    await vi.advanceTimersByTimeAsync(0)

    const p2 = limiter.enqueue(100, async () => {
      started.push('p2')
      completed.push('p2')
      return 'two'
    })
    const p3 = limiter.enqueue(100, async () => {
      started.push('p3')
      completed.push('p3')
      return 'three'
    })

    await expect(p2).rejects.toMatchObject({
      name: 'MeetingTranslationRateLimitError',
      code: 'queue_overflow'
    })

    gate.resolve('one')
    await vi.advanceTimersByTimeAsync(0)
    await expect(p1).resolves.toBe('one')
    await vi.advanceTimersByTimeAsync(0)
    await expect(p3).resolves.toBe('three')

    expect(started).toEqual(['p1', 'p3'])
    expect(completed).toEqual(['p1', 'p3'])
    const snapshot = limiter.getSnapshot()
    expect(snapshot.totalEnqueued).toBe(3)
    expect(snapshot.totalExecuted).toBe(2)
    expect(snapshot.totalDroppedOverflow).toBe(1)
    expect(snapshot.maxQueueLength).toBe(1)
  })

  it('enforces min request interval between meeting translation jobs', async () => {
    vi.useFakeTimers()

    const limiter = new MeetingTranslationRateLimiter({
      enabled: true,
      maxRequestsPerMinute: 100,
      maxTokensPerMinute: 100000,
      minRequestIntervalMs: 120,
      maxQueueSize: 8,
      maxQueueWaitMs: 60_000,
      dropPolicy: 'drop_oldest'
    })

    const starts: number[] = []
    const p1 = limiter.enqueue(120, async () => {
      starts.push(Date.now())
      return 'first'
    })
    const p2 = limiter.enqueue(120, async () => {
      starts.push(Date.now())
      return 'second'
    })

    await vi.advanceTimersByTimeAsync(0)
    await expect(p1).resolves.toBe('first')
    expect(starts).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(119)
    expect(starts).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    await expect(p2).resolves.toBe('second')
    expect(starts).toHaveLength(2)
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(120)

    const snapshot = limiter.getSnapshot()
    expect(snapshot.totalWaitEvents).toBeGreaterThan(0)
    expect(snapshot.intervalWaitEvents).toBeGreaterThan(0)
    expect(snapshot.totalWaitMs).toBeGreaterThanOrEqual(100)
  })
})
